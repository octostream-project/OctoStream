package com.octostream.exoplayer;

import com.sun.net.httpserver.HttpServer;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.OkHttpClient;

/** Standalone JVM regression check, invoked by verifyDebridRangeRelay. */
public final class DebridRangeRelayCheck {
    private static final int CHUNK = 1024 * 1024;

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static HttpURLConnection connect(String url, String range) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection(Proxy.NO_PROXY);
        c.setConnectTimeout(3000);
        c.setReadTimeout(15000);
        if (range != null) c.setRequestProperty("Range", range);
        return c;
    }

    private static byte[] slice(byte[] bytes, long start, int count) {
        return Arrays.copyOfRange(bytes, (int) start, (int) start + count);
    }

    public static void main(String[] args) throws Exception {
        byte[] media = new byte[5 * CHUNK + 17];
        for (int i = 0; i < media.length; i++) media[i] = (byte) (i % 251);
        Map<String, Boolean> ranges = new ConcurrentHashMap<>();
        AtomicInteger active = new AtomicInteger();
        AtomicInteger peak = new AtomicInteger();
        HttpServer upstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 8);
        upstream.setExecutor(Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "fake-cdn");
            t.setDaemon(true);
            return t;
        }));
        upstream.createContext("/range", ex -> {
            String range = ex.getRequestHeaders().getFirst("Range");
            if (!"session=secret".equals(ex.getRequestHeaders().getFirst("Cookie"))
                    || range == null || !range.matches("bytes=\\d+-\\d+")) {
                ex.sendResponseHeaders(403, -1);
                ex.close();
                return;
            }
            ranges.put(range, true);
            int inFlight = active.incrementAndGet();
            peak.accumulateAndGet(inFlight, Math::max);
            try {
                String[] positions = range.substring(6).split("-");
                int start = Integer.parseInt(positions[0]);
                int end = Integer.parseInt(positions[1]);
                if (start >= media.length || end >= media.length) {
                    ex.sendResponseHeaders(416, -1);
                    ex.close();
                    return;
                }
                if (start > 0 && start < 3 * CHUNK) {
                    try { Thread.sleep(100); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                }
                ex.getResponseHeaders().set("Content-Range",
                        "bytes " + start + "-" + end + "/" + media.length);
                ex.sendResponseHeaders(206, end - start + 1);
                ex.getResponseBody().write(media, start, end - start + 1);
                ex.close();
            } finally {
                active.decrementAndGet();
            }
        });
        upstream.createContext("/no-range", ex -> {
            ex.sendResponseHeaders(200, 1);
            ex.getResponseBody().write(0);
            ex.close();
        });
        upstream.start();
        OkHttpClient client = new OkHttpClient.Builder().proxy(Proxy.NO_PROXY).build();
        String base = "http://127.0.0.1:" + upstream.getAddress().getPort();
        try {
            try {
                DebridRangeRelay.probe(base + "/no-range", client, Map.of("Cookie", "session=secret"));
                throw new AssertionError("Server without Range should fall back");
            } catch (java.io.IOException expected) { /* direct player fallback */ }

            try (DebridRangeRelay relay = DebridRangeRelay.probe(
                    base + "/range", client, Map.of("Cookie", "session=secret"))) {
                String local = relay.start();
                HttpURLConnection seek = connect(local, "bytes=" + (3 * CHUNK + 13) + "-"
                        + (3 * CHUNK + 90));
                check(seek.getResponseCode() == 206, "seek must return 206");
                check(seek.getHeaderField("Content-Range").endsWith("/" + media.length),
                        "content length after seek");
                check(Arrays.equals(seek.getInputStream().readAllBytes(),
                        slice(media, 3L * CHUNK + 13, 78)), "seek bytes");
                seek.disconnect();

                HttpURLConnection forward = connect(local, "bytes=0-" + (3 * CHUNK - 1));
                check(forward.getResponseCode() == 206, "forward must return 206");
                try (InputStream stream = forward.getInputStream()) {
                    check(Arrays.equals(stream.readAllBytes(), slice(media, 0, 3 * CHUNK)),
                            "sequential bytes across chunks");
                }
                forward.disconnect();
                check(ranges.containsKey("bytes=" + CHUNK + "-" + (2 * CHUNK - 1)),
                        "next chunk should be fetched ahead");
                check(peak.get() >= 2, "prefetch should use parallel upstream requests");

                HttpURLConnection invalid = connect(local, "bytes=" + media.length + "-");
                check(invalid.getResponseCode() == 416, "out of bounds must return 416");
                invalid.disconnect();
                HttpURLConnection unknown = connect(local + "/other", null);
                check(unknown.getResponseCode() == 404, "unknown path must not proxy");
                unknown.disconnect();
            }
        } finally {
            upstream.stop(0);
        }
        System.out.println("DebridRangeRelay: Range, seek, prefetch, auth and fallback OK");
    }
}
