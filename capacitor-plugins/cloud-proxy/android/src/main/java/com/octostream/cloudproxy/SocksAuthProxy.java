package com.octostream.cloudproxy;

import android.util.Log;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Front SOCKS5 en el puerto estable (2831) que EXIGE auth RFC 1929 y
 * encamina a un upstream SOCKS sin auth en un puerto efímero (el -D del
 * openssh nativo). Así el SOCKS del túnel no queda abierto a cualquier app
 * local: sin el token por-arranque de ProxyAuth el handshake muere en 0xFF
 * o en auth 0x01. Los clientes legítimos autentican solos vía
 * java.net.socks.username/password (OkHttp, HttpURLConnection).
 *
 * Flujo por conexión:
 *   client → greeting/method 0x02 → RFC1929 auth → request (CONNECT)
 *   front  → upstream handshake no-auth reenviando el mismo destino
 *   front  → respuesta upstream verbatim al client → pipe bidireccional
 */
final class SocksAuthProxy implements AutoCloseable {
    private static final String TAG = "SocksAuthProxy";
    private static final int HANDSHAKE_MS = 15000;
    private static final int IDLE_MS = 0; // el hilo vive lo que viva la sesión

    private final int port;
    private final int upstreamPort;
    private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
    private final ExecutorService pool = new ThreadPoolExecutor(0, 32, 30L, TimeUnit.SECONDS,
            new SynchronousQueue<>(), r -> {
                Thread t = new Thread(r, "socks-auth-conn");
                t.setDaemon(true);
                return t;
            });
    private volatile boolean running;
    private ServerSocket server;
    private Thread acceptThread;

    SocksAuthProxy(int port, int upstreamPort) {
        this.port = port;
        this.upstreamPort = upstreamPort;
    }

    void start() throws IOException {
        ProxyAuth.init();
        server = new ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"));
        running = true;
        acceptThread = new Thread(() -> {
            while (running) {
                try {
                    Socket client = server.accept();
                    sockets.add(client);
                    try {
                        pool.execute(() -> serve(client));
                    } catch (RejectedExecutionException full) {
                        sockets.remove(client);
                        try { client.close(); } catch (IOException ignored) {}
                    }
                } catch (Exception e) {
                    if (running) Log.w(TAG, "accept failed: " + e.getClass().getSimpleName());
                }
            }
        }, "socks-auth-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    boolean isRunning() {
        return running && server != null && !server.isClosed();
    }

    private void serve(Socket client) {
        Socket upstream = null;
        try {
            client.setSoTimeout(HANDSHAKE_MS);
            InputStream in = client.getInputStream();
            OutputStream out = client.getOutputStream();

            // Greeting: VER=5, NMETHODS, methods — exigimos auth user/pass.
            byte[] g = readN(in, 2);
            if (g == null || g[0] != 0x05) return;
            int nMethods = g[1] & 0xFF;
            if (readN(in, nMethods) == null) return;
            out.write(new byte[] { 0x05, 0x02 });
            out.flush();

            // RFC 1929: VER=1, ULEN, uname, PLEN, passwd.
            byte[] a = readN(in, 2);
            if (a == null || a[0] != 0x01) return;
            byte[] u = readN(in, a[1] & 0xFF);
            byte[] plen = readN(in, 1);
            byte[] p = plen == null ? null : readN(in, plen[0] & 0xFF);
            if (u == null || p == null) return;
            boolean ok = ProxyAuth.checkSocks(
                    new String(u, StandardCharsets.UTF_8),
                    new String(p, StandardCharsets.UTF_8));
            out.write(new byte[] { 0x01, (byte) (ok ? 0x00 : 0x01) });
            out.flush();
            if (!ok) {
                Log.w(TAG, "SOCKS auth rechazada (token incorrecto)");
                return;
            }

            // Request: VER=5, CMD, RSV, ATYP, DST — solo soportamos CONNECT.
            byte[] req = readN(in, 4);
            if (req == null || req[0] != 0x05 || req[1] != 0x01) { failReply(out, 0x07); return; }
            int atyp = req[3] & 0xFF;
            int addrLen = atyp == 0x01 ? 4 : atyp == 0x03 ? -1 : atyp == 0x04 ? 16 : -2;
            byte[] rest;
            if (addrLen == -1) {
                byte[] l = readN(in, 1);
                if (l == null) return;
                rest = concat(l, readN(in, (l[0] & 0xFF) + 2));
            } else if (addrLen > 0) {
                rest = readN(in, addrLen + 2);
            } else {
                failReply(out, 0x08);
                return;
            }
            if (rest == null) return;
            byte[] fullReq = concat(req, rest);

            // Handshake no-auth contra el upstream (ssh -D efímero).
            upstream = new Socket();
            sockets.add(upstream);
            upstream.connect(new java.net.InetSocketAddress("127.0.0.1", upstreamPort), HANDSHAKE_MS);
            OutputStream upOut = upstream.getOutputStream();
            InputStream upIn = upstream.getInputStream();
            upOut.write(new byte[] { 0x05, 0x01, 0x00 });
            upOut.flush();
            byte[] sel = readN(upIn, 2);
            if (sel == null || sel[0] != 0x05 || sel[1] != 0x00) { failReply(out, 0x05); return; }
            upOut.write(fullReq);
            upOut.flush();
            byte[] rep = readN(upIn, 4);
            if (rep == null || rep[0] != 0x05) { failReply(out, 0x05); return; }
            int repAtyp = rep[3] & 0xFF;
            int repLen = repAtyp == 0x01 ? 4 : repAtyp == 0x03 ? -1 : repAtyp == 0x04 ? 16 : -2;
            byte[] repRest;
            if (repLen == -1) {
                byte[] l = readN(upIn, 1);
                repRest = concat(l, readN(upIn, (l[0] & 0xFF) + 2));
            } else if (repLen > 0) {
                repRest = readN(upIn, repLen + 2);
            } else {
                failReply(out, 0x05);
                return;
            }
            if (repRest == null) { failReply(out, 0x05); return; }
            // Verbatim al client — incluye el código de éxito/error del upstream.
            out.write(concat(rep, repRest));
            out.flush();
            if (rep[1] != 0x00) return;

            client.setSoTimeout(IDLE_MS);
            upstream.setSoTimeout(IDLE_MS);
            pipe(client, upstream, in, upIn, out, upOut);
        } catch (Exception e) {
            if (running) Log.d(TAG, "conn closed: " + e.getClass().getSimpleName());
        } finally {
            sockets.remove(client);
            if (upstream != null) { sockets.remove(upstream); try { upstream.close(); } catch (Exception ignored) {} }
            try { client.close(); } catch (Exception ignored) {}
        }
    }

    /** client→upstream y upstream→client; la primera dirección que cierra tumba ambas. */
    private void pipe(Socket client, Socket upstream, InputStream cIn, InputStream uIn,
            OutputStream cOut, OutputStream uOut) {
        Thread down = new Thread(() -> {
            try {
                byte[] buf = new byte[32768];
                int n;
                while ((n = uIn.read(buf)) >= 0) {
                    cOut.write(buf, 0, n);
                    cOut.flush();
                }
            } catch (Exception ignored) {
            } finally {
                try { client.close(); } catch (Exception ignored) {}
                try { upstream.close(); } catch (Exception ignored) {}
            }
        }, "socks-auth-down");
        down.setDaemon(true);
        down.start();
        try {
            byte[] buf = new byte[32768];
            int n;
            while ((n = cIn.read(buf)) >= 0) {
                uOut.write(buf, 0, n);
                uOut.flush();
            }
        } catch (Exception ignored) {
        } finally {
            try { client.close(); } catch (Exception ignored) {}
            try { upstream.close(); } catch (Exception ignored) {}
        }
    }

    private static void failReply(OutputStream out, int code) {
        try {
            out.write(new byte[] { 0x05, (byte) code, 0x00, 0x01, 0, 0, 0, 0, 0, 0 });
            out.flush();
        } catch (Exception ignored) {}
    }

    private static byte[] readN(InputStream in, int n) throws IOException {
        if (n <= 0) return new byte[0];
        byte[] b = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(b, off, n - off);
            if (r < 0) throw new EOFException();
            off += r;
        }
        return b;
    }

    private static byte[] concat(byte[] a, byte[] b) {
        if (a == null) return null;
        if (b == null) return a;
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    @Override
    public void close() {
        running = false;
        pool.shutdownNow();
        try { if (server != null) server.close(); } catch (IOException ignored) {}
        for (Socket s : sockets) try { s.close(); } catch (Exception ignored) {}
        sockets.clear();
    }
}
