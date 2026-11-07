package com.octostream.cloudproxy;

import android.util.Log;

import com.jcraft.jsch.Channel;
import com.jcraft.jsch.ChannelDirectTCPIP;
import com.jcraft.jsch.Session;

import java.io.ByteArrayOutputStream;
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
 * Mini HTTP CONNECT proxy bound to loopback that tunnels every connection
 * through a JSch "direct-tcpip" channel. Traffic exits the VPS with its own
 * public IP — no WARP/aether hop on the remote side — while unlock and
 * playback keep sharing the same exit (IP-bound debrid links stay valid).
 * Plain-HTTP absolute-URI requests are also handled for http:// sources.
 */
final class SshDirectProxy implements AutoCloseable {
    private static final String TAG = "SshDirectProxy";
    private static final int HEAD_LIMIT = 32768;
    private static final int CHANNEL_CONNECT_MS = 10000;
    private static final int SOCKET_TIMEOUT_MS = 30000;

    private final Session session;
    private final int port;
    private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
    private final Set<Channel> channels = ConcurrentHashMap.newKeySet();
    // Tope de conexiones simultáneas: sin él un cliente local (cualquier app
    // puede llegar a 127.0.0.1) podía agotar hilos y memoria del proceso.
    private final ExecutorService pool = new ThreadPoolExecutor(0, 64, 30L, TimeUnit.SECONDS,
            new SynchronousQueue<>(), r -> {
                Thread t = new Thread(r, "ssh-direct-conn");
                t.setDaemon(true);
                return t;
            });
    private volatile boolean running;
    private ServerSocket server;
    private Thread acceptThread;

    SshDirectProxy(Session session, int port) {
        this.session = session;
        this.port = port;
    }

    /** A direct-tcpip probe channel proves the sshd allows outbound
     *  forwarding (AllowTcpForwarding + PermitOpen). Cheap: opens and closes
     *  a channel to the sshd itself, no data leaves the VPS. */
    static boolean supports(Session session) {
        Channel probe = null;
        try {
            probe = session.openChannel("direct-tcpip");
            ChannelDirectTCPIP ch = (ChannelDirectTCPIP) probe;
            ch.setHost("127.0.0.1");
            ch.setPort(22);
            probe.connect(5000);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "direct-tcpip unavailable: " + e.getMessage());
            return false;
        } finally {
            if (probe != null) {
                try { probe.disconnect(); } catch (Exception ignored) {}
            }
        }
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
        }, "ssh-direct-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    boolean isRunning() {
        return running && server != null && !server.isClosed() && session.isConnected();
    }

    private void serve(Socket client) {
        Channel channel = null;
        try {
            client.setSoTimeout(SOCKET_TIMEOUT_MS);
            InputStream in = client.getInputStream();
            OutputStream out = client.getOutputStream();
            ByteArrayOutputStream head = readHead(in);
            if (head == null) return;
            String text = head.toString(StandardCharsets.ISO_8859_1.name());
            String[] lines = text.split("\r\n");
            String first = lines[0];
            if (!hasProxyAuth(lines)) {
                out.write(("HTTP/1.1 407 Proxy Authentication Required\r\n"
                        + "Proxy-Authenticate: Basic realm=\"octostream\"\r\n"
                        + "Content-Length: 0\r\nConnection: close\r\n\r\n")
                        .getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
                return;
            }
            boolean isConnect = first.regionMatches(true, 0, "CONNECT ", 0, 8);
            String host;
            int targetPort;
            if (isConnect) {
                String hp = first.substring(8, first.indexOf(' ', 8)).trim();
                int colon = hp.lastIndexOf(':');
                host = colon > 0 ? hp.substring(0, colon) : hp;
                targetPort = colon > 0 ? Integer.parseInt(hp.substring(colon + 1)) : 443;
            } else {
                // Absolute-URI form (http://host[:port]/path) or Host header.
                String[] hostPort = absoluteHost(lines, first);
                if (hostPort == null) { reply(out, "400 Bad Request"); return; }
                host = hostPort[0];
                targetPort = Integer.parseInt(hostPort[1]);
            }
            channel = session.openChannel("direct-tcpip");
            channels.add(channel);
            ChannelDirectTCPIP ch = (ChannelDirectTCPIP) channel;
            ch.setHost(host);
            ch.setPort(targetPort);
            // Channel→client pumped by JSch itself; client→channel we pump
            // below so the request head can be rewritten first.
            channel.setOutputStream(out);
            channel.connect(CHANNEL_CONNECT_MS);
            if (isConnect) {
                out.write("HTTP/1.1 200 Connection Established\r\n\r\n"
                        .getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
            } else {
                // Tunnel the rewritten request: strip scheme://authority from
                // the request line so the origin sees origin-form.
                String origin = first.substring(0, first.indexOf(' ') + 1)
                        + pathOf(first) + first.substring(first.lastIndexOf(' '));
                OutputStream chOut = channel.getOutputStream();
                chOut.write(origin.getBytes(StandardCharsets.ISO_8859_1));
                for (int i = 1; i < lines.length; i++) {
                    // La credencial del proxy es hop-by-hop: jamás sale del
                    // dispositivo dentro del túnel hacia el origen.
                    if (lines[i].regionMatches(true, 0, "Proxy-", 0, 6)) continue;
                    chOut.write("\r\n".getBytes(StandardCharsets.ISO_8859_1));
                    chOut.write(lines[i].getBytes(StandardCharsets.ISO_8859_1));
                }
                chOut.write("\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                chOut.flush();
            }
            OutputStream chOut = channel.getOutputStream();
            byte[] buf = new byte[32768];
            int n;
            while ((n = in.read(buf)) >= 0) {
                chOut.write(buf, 0, n);
                chOut.flush();
            }
        } catch (Exception e) {
            if (running) {
                try { reply(client.getOutputStream(), "502 Bad Gateway"); }
                catch (Exception ignored) {}
                Log.d(TAG, "channel closed: " + e.getClass().getSimpleName());
            }
        } finally {
            if (channel != null) {
                channels.remove(channel);
                try { channel.disconnect(); } catch (Exception ignored) {}
            }
            sockets.remove(client);
            try { client.close(); } catch (Exception ignored) {}
        }
    }

    private static boolean hasProxyAuth(String[] lines) {
        for (String line : lines) {
            if (line.regionMatches(true, 0, "Proxy-Authorization:", 0, 20)) {
                return ProxyAuth.checkBasic(line.substring(20));
            }
        }
        return false;
    }

    private static ByteArrayOutputStream readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int b, end = 0;
        while (head.size() < HEAD_LIMIT && (b = in.read()) != -1) {
            head.write(b);
            end = b == "\r\n\r\n".charAt(end) ? end + 1 : (b == '\r' ? 1 : 0);
            if (end == 4) return head;
        }
        return null;
    }

    private static String[] absoluteHost(String[] lines, String first) {
        String target = null;
        int sp1 = first.indexOf(' ');
        int sp2 = first.indexOf(' ', sp1 + 1);
        if (sp1 > 0 && sp2 > sp1) {
            String uri = first.substring(sp1 + 1, sp2);
            if (uri.regionMatches(true, 0, "http://", 0, 7)) {
                String auth = uri.substring(7);
                int slash = auth.indexOf('/');
                if (slash >= 0) auth = auth.substring(0, slash);
                target = auth;
            }
        }
        if (target == null) {
            for (String line : lines) {
                if (line.regionMatches(true, 0, "Host:", 0, 5)) {
                    target = line.substring(5).trim();
                    break;
                }
            }
        }
        if (target == null || target.isEmpty()) return null;
        int colon = target.lastIndexOf(':');
        if (colon > 0 && target.substring(colon + 1).matches("\\d+")) {
            return new String[] { target.substring(0, colon), target.substring(colon + 1) };
        }
        return new String[] { target, "80" };
    }

    private static String pathOf(String requestLine) {
        int sp1 = requestLine.indexOf(' ');
        int sp2 = requestLine.indexOf(' ', sp1 + 1);
        String uri = requestLine.substring(sp1 + 1, sp2);
        if (uri.regionMatches(true, 0, "http://", 0, 7)) {
            int slash = uri.indexOf('/', 7);
            return slash >= 0 ? uri.substring(slash) : "/";
        }
        return uri;
    }

    private static void reply(OutputStream out, String status) throws IOException {
        out.write(("HTTP/1.1 " + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    @Override
    public void close() {
        running = false;
        pool.shutdownNow();
        try { if (server != null) server.close(); } catch (IOException ignored) {}
        for (Channel ch : channels) try { ch.disconnect(); } catch (Exception ignored) {}
        for (Socket s : sockets) try { s.close(); } catch (Exception ignored) {}
        channels.clear();
        sockets.clear();
    }
}
