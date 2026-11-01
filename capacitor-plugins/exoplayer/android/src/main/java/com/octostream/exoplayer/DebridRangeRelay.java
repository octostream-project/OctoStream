package com.octostream.exoplayer;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.Call;
import okhttp3.Headers;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * Bounded, in-memory Range prefetcher for progressive debrid files.
 * The supplied client uses the same WARP/VPS exit as the unlocked URL.
 */
final class DebridRangeRelay implements AutoCloseable {
    private static final String TAG = "DebridRangeRelay";
    private static final int CHUNK = 1024 * 1024;
    private static final Pattern CONTENT_RANGE = Pattern.compile("bytes (\\d+)-(\\d+)/(\\d+)");

    private final String url;
    private final OkHttpClient client;
    private final Headers headers;
    private final long length;
    private final int cacheChunks;
    private final String path = "/media/" + UUID.randomUUID();
    private final ExecutorService downloads = Executors.newFixedThreadPool(6);
    private final ExecutorService connections = Executors.newFixedThreadPool(3);
    private final Map<Long, Future<byte[]>> pending = new ConcurrentHashMap<>();
    private final LinkedHashMap<Long, byte[]> cache = new LinkedHashMap<>(16, 0.75f, true);
    private final java.util.Set<Call> calls = ConcurrentHashMap.newKeySet();
    private final java.util.Set<Socket> sockets = ConcurrentHashMap.newKeySet();
    private final long startedAt = System.nanoTime();
    private final java.util.concurrent.atomic.AtomicLong fetchedBytes = new java.util.concurrent.atomic.AtomicLong();
    private final java.util.concurrent.atomic.AtomicInteger failures = new java.util.concurrent.atomic.AtomicInteger();
    private volatile boolean closed;
    private ServerSocket server;
    private Thread acceptThread;

    private DebridRangeRelay(String url, OkHttpClient client, Headers headers, long length, int cacheChunks) {
        this.url = url;
        this.client = client;
        this.headers = headers;
        this.length = length;
        this.cacheChunks = cacheChunks;
    }

    // Called off the Android UI thread. A 206 for byte zero is required;
    // no Range or unknown length means the existing direct player is safer.
    static DebridRangeRelay probe(String url, OkHttpClient client, Map<String, String> requestHeaders,
            int cacheChunks) throws IOException {
        Headers.Builder safe = new Headers.Builder();
        for (Map.Entry<String, String> entry : requestHeaders.entrySet()) {
            String key = entry.getKey();
            if (key.equalsIgnoreCase("Range") || key.equalsIgnoreCase("Host")
                    || key.equalsIgnoreCase("Accept-Encoding") || key.equalsIgnoreCase("Connection")
                    || key.equalsIgnoreCase("If-Range")) continue;
            safe.add(key, entry.getValue());
        }
        safe.set("Accept-Encoding", "identity");
        Headers headers = safe.build();
        Request request = new Request.Builder().url(url).headers(headers).header("Range", "bytes=0-0").build();
        try (Response response = client.newCall(request).execute()) {
            String encoding = response.header("Content-Encoding", "identity");
            if (!encoding.equalsIgnoreCase("identity")) throw new IOException("Encoded Range unsupported");
            long size = rangeLength(response, 0, 0);
            if (size <= 1 || response.body() == null || response.body().byteStream().read() < 0) {
                throw new IOException("Range probe failed");
            }
            return new DebridRangeRelay(url, client, headers, size, cacheChunks);
        }
    }

    private volatile String localUrl;
    private volatile long lastActivity = System.currentTimeMillis();

    String getSourceUrl() { return url; }
    String getLocalUrl() { return localUrl; }
    // Tres fallos seguidos = el cliente HTTP (proxy/túnel) ya no sirve: no
    // reutilizar este relay, que se cree uno nuevo con un cliente fresco.
    boolean isRunning() {
        return !closed && server != null && !server.isClosed() && failures.get() < 3;
    }
    void touch() { lastActivity = System.currentTimeMillis(); }

    String start() throws IOException {
        server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        acceptThread = new Thread(() -> {
            while (!closed) {
                try {
                    Socket socket = server.accept();
                    sockets.add(socket);
                    connections.execute(() -> serve(socket));
                } catch (Exception e) {
                    if (!closed) Log.w(TAG, "accept failed: " + e.getClass().getSimpleName());
                }
            }
        }, "debrid-range-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        // Watchdog de ocio: el relay sobrevive a reloads del player (caché
        // intacta entre playStream de la misma URL), pero no se queda vivo
        // para siempre si nadie lo usa.
        Thread idle = new Thread(() -> {
            while (!closed) {
                try { Thread.sleep(10_000); } catch (InterruptedException ie) { return; }
                if (sockets.isEmpty()
                        && System.currentTimeMillis() - lastActivity > 90_000) {
                    close();
                    return;
                }
            }
        }, "debrid-range-idle");
        idle.setDaemon(true);
        idle.start();
        localUrl = "http://127.0.0.1:" + server.getLocalPort() + path;
        return localUrl;
    }

    private Response request(long start, long end) throws IOException {
        Request req = new Request.Builder().url(url).headers(headers)
                .header("Range", "bytes=" + start + "-" + end).build();
        Call call = client.newCall(req);
        calls.add(call);
        try {
            return call.execute();
        } finally {
            calls.remove(call);
        }
    }

    private static long rangeLength(Response response, long start, long end) throws IOException {
        String value = response.header("Content-Range", "");
        Matcher match = CONTENT_RANGE.matcher(value);
        if (response.code() != 206 || !match.matches()) throw new IOException("No valid Range response");
        try {
            long actualStart = Long.parseLong(match.group(1));
            long actualEnd = Long.parseLong(match.group(2));
            long total = Long.parseLong(match.group(3));
            if (actualStart != start || actualEnd != end || total <= end) {
                throw new IOException("Incorrect Content-Range");
            }
            return total;
        } catch (NumberFormatException e) {
            throw new IOException("Invalid Content-Range", e);
        }
    }

    private byte[] download(long index) throws IOException {
        long start = index * CHUNK;
        long end = Math.min(length - 1, start + CHUNK - 1);
        try (Response response = request(start, end)) {
            if (rangeLength(response, start, end) != length || response.body() == null) {
                throw new IOException("Range changed or empty");
            }
            int expected = (int) (end - start + 1);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(expected);
            InputStream in = response.body().byteStream();
            byte[] buffer = new byte[32768];
            while (bytes.size() < expected) {
                int count = in.read(buffer, 0, Math.min(buffer.length, expected - bytes.size()));
                if (count < 0) throw new IOException("Truncated Range response");
                bytes.write(buffer, 0, count);
            }
            if (in.read() != -1) throw new IOException("Oversized Range response");
            long total = fetchedBytes.addAndGet(expected);
            if (total / (32L * CHUNK) != (total - expected) / (32L * CHUNK)) {
                double elapsed = Math.max(0.001, (System.nanoTime() - startedAt) / 1_000_000_000.0);
                Log.i(TAG, String.format(Locale.ROOT, "debrid relay: %d MiB, avg %.1f Mbit/s",
                        total / CHUNK, total * 8 / elapsed / 1_000_000));
            }
            return bytes.toByteArray();
        }
    }

    private synchronized Future<byte[]> schedule(long index, boolean speculative) {
        byte[] hit = cache.get(index);
        if (hit != null || closed || index * CHUNK >= length) return null;
        // Futuros ya terminados (prefetch abandonado tras un seek, o fallido):
        // sus datos ya están en caché, no deben ocupar cupo ni quedar rancios.
        pending.values().removeIf(Future::isDone);
        if (speculative && pending.size() >= 8 && !pending.containsKey(index)) return null;
        return pending.computeIfAbsent(index, i -> downloads.submit(() -> {
            byte[] data = download(i);
            synchronized (DebridRangeRelay.this) {
                cache.put(i, data);
                while (cache.size() > cacheChunks) cache.remove(cache.keySet().iterator().next());
            }
            failures.set(0);
            return data;
        }));
    }

    private byte[] chunk(long index) throws Exception {
        synchronized (this) {
            byte[] hit = cache.get(index);
            if (hit != null) return hit;
        }
        Future<byte[]> task = schedule(index, false);
        if (task == null) {
            synchronized (this) {
                byte[] hit = cache.get(index);
                if (hit != null) return hit;
            }
            throw new IOException("Relay stopped");
        }
        try {
            return task.get();
        } catch (Exception e) {
            failures.incrementAndGet();
            throw e;
        } finally {
            pending.remove(index, task);
        }
    }

    private void serve(Socket socket) {
        touch();
        try (Socket s = socket) {
            s.setSoTimeout(30000);
            InputStream in = s.getInputStream();
            ByteArrayOutputStream header = new ByteArrayOutputStream();
            int b, end = 0;
            while (header.size() < 16384 && (b = in.read()) != -1) {
                header.write(b);
                end = b == "\r\n\r\n".charAt(end) ? end + 1 : (b == '\r' ? 1 : 0);
                if (end == 4) break;
            }
            if (end != 4) return;
            String[] lines = header.toString("ISO-8859-1").split("\r\n");
            String[] first = lines[0].split(" ");
            OutputStream out = s.getOutputStream();
            if (first.length < 2 || !("GET".equals(first[0]) || "HEAD".equals(first[0]))
                    || !path.equals(first[1])) {
                status(out, "404 Not Found");
                return;
            }
            long start = 0, last = length - 1;
            boolean partial = false;
            for (String line : lines) {
                if (!line.regionMatches(true, 0, "Range:", 0, 6)) continue;
                Matcher range = Pattern.compile("bytes=(\\d+)-(\\d*)", Pattern.CASE_INSENSITIVE)
                        .matcher(line.substring(6).trim());
                if (!range.matches()) { status(out, "416 Range Not Satisfiable"); return; }
                try {
                    start = Long.parseLong(range.group(1));
                    if (!range.group(2).isEmpty()) last = Long.parseLong(range.group(2));
                } catch (NumberFormatException e) {
                    status(out, "416 Range Not Satisfiable");
                    return;
                }
                partial = true;
            }
            if (start < 0 || start >= length || last < start) {
                status(out, "416 Range Not Satisfiable");
                return;
            }
            last = Math.min(last, length - 1);
            long pos = start;
            // Fetch the first chunk before sending 200/206, so a dead proxy
            // returns an HTTP error instead of a valid but empty video.
            byte[] firstChunk = "HEAD".equals(first[0]) ? null : chunk(pos / CHUNK);
            String reply = "HTTP/1.1 " + (partial ? "206 Partial Content" : "200 OK")
                    + "\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes"
                    + "\r\nContent-Length: " + (last - start + 1)
                    + (partial ? "\r\nContent-Range: bytes " + start + "-" + last + "/" + length : "")
                    + "\r\nConnection: close\r\n\r\n";
            out.write(reply.getBytes(StandardCharsets.ISO_8859_1));
            if ("HEAD".equals(first[0])) return;
            while (pos <= last && !closed) {
                long index = pos / CHUNK;
                byte[] data = index == start / CHUNK ? firstChunk : chunk(index);
                int offset = (int) (pos % CHUNK);
                int count = (int) Math.min(last - pos + 1, data.length - offset);
                if (count <= 0) throw new IOException("Invalid chunk offset");
                out.write(data, offset, count);
                pos += count;
                for (long next = index + 1; next <= index + 6 && next * CHUNK <= last; next++) {
                    schedule(next, true);
                }
            }
        } catch (Exception e) {
            if (!closed) Log.d(TAG, "client closed: " + e.getClass().getSimpleName());
        } finally {
            sockets.remove(socket);
        }
    }

    private static void status(OutputStream out, String code) throws IOException {
        out.write(("HTTP/1.1 " + code + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .getBytes(StandardCharsets.ISO_8859_1));
    }

    @Override
    public void close() {
        closed = true;
        try { if (server != null) server.close(); } catch (IOException ignored) {}
        for (Socket socket : sockets) try { socket.close(); } catch (IOException ignored) {}
        for (Call call : calls) call.cancel();
        client.dispatcher().cancelAll();
        for (Future<byte[]> task : pending.values()) task.cancel(true);
        downloads.shutdownNow();
        connections.shutdownNow();
        synchronized (this) { cache.clear(); }
        pending.clear();
    }
}
