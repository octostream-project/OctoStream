package com.octostream.cloudproxy;

import android.util.Log;

import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.Map;
import java.util.concurrent.Executor;

/**
 * Capacitor plugin that runs the Aether binary to create a local proxy
 * for Cloudflare WARP. No VpnService needed — the proxy runs on loopback
 * and only our app uses it.
 *
 * Aether: https://github.com/CluvexStudio/Aether
 * It's a userspace WARP client that exposes SOCKS5 on 127.0.0.1:1819
 * and HTTP CONNECT on 127.0.0.1:1820.
 */
@CapacitorPlugin(name = "CloudProxy")
public class CloudProxyPlugin extends Plugin {
    private static final String TAG = "CloudProxyPlugin";
    private static final String SOCKS_ADDR = "127.0.0.1:1819";
    private static final int SOCKS_PORT = 1819;
    private static final String HTTP_PROXY_ADDR = "127.0.0.1:1820";
    private static final int HTTP_PROXY_PORT = 1820;

    private static Process aetherProcess = null;
    private static volatile boolean connected = false;
    private static volatile boolean connecting = false;
    private static volatile String lastError = null;
    private static long connectionGeneration = 0;
    private static final Object PROCESS_LOCK = new Object();
    private static final Executor DIRECT_EXECUTOR = Runnable::run;
    private boolean antiLeakScriptInstalled = false;

    @Override
    public void load() {
        Log.i(TAG, "CloudProxyPlugin loaded");
    }

    @Override
    protected void handleOnDestroy() {
        // Clean up proxy settings when the app is destroyed
        if (connected || aetherProcess != null) {
            disconnect(false);
        } else {
            clearAppProxy();
        }
        super.handleOnDestroy();
    }

    /**
     * Connects to Cloudflare WARP by starting the Aether binary.
     * No VPN permission needed — just runs a local SOCKS5 proxy.
     */
    @PluginMethod
    public void connect(PluginCall call) {
        Log.i(TAG, "connect() called");

        final long generation;
        synchronized (PROCESS_LOCK) {
            if (connected && aetherProcess != null && aetherProcess.isAlive()) {
                call.resolve(new JSObject().put("status", "connected"));
                return;
            }
            if (connecting) {
                // A connect is already in progress. Don't reject — wait for it
                // to finish so concurrent callers (e.g. App.jsx retry loop +
                // http.js blocked-request path) get the final result instead
                // of a spurious "already in progress" error.
                new Thread(() -> {
                    int waited = 0;
                    while (connecting && waited < 70000) {
                        try { Thread.sleep(500); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
                        waited += 500;
                    }
                    if (connected) {
                        call.resolve(new JSObject().put("status", "connected").put("socks", SOCKS_ADDR).put("http", HTTP_PROXY_ADDR));
                    } else {
                        call.reject("WARP connection failed");
                    }
                }, "aether-connect-wait").start();
                return;
            }
            // Aether can remain alive while its tunnel is down and retrying.
            // Reconnect must stop that stale process first, otherwise a second
            // instance races for ports 1819/1820 and leaks CPU/battery.
            if (aetherProcess != null) stopAether();
            connecting = true;
            lastError = null;
            generation = ++connectionGeneration;
        }

        new Thread(() -> {
            try {
                startAether();
                Process startedProcess = aetherProcess;
                synchronized (PROCESS_LOCK) {
                    if (generation != connectionGeneration) {
                        if (aetherProcess == startedProcess) stopAether();
                        call.reject("WARP connection cancelled");
                        return;
                    }
                }
                // Route all app traffic through WARP (change IP). Resolve only
                // after the WebView proxy and anti-leak hooks are installed.
                setAppProxy(() -> {
                    synchronized (PROCESS_LOCK) {
                        if (generation != connectionGeneration) {
                            call.reject("WARP connection cancelled");
                            return;
                        }
                        connected = aetherProcess != null && aetherProcess.isAlive();
                        connecting = false;
                    }
                    if (connected) {
                        call.resolve(new JSObject()
                            .put("status", "connected")
                            .put("socks", SOCKS_ADDR)
                            .put("http", HTTP_PROXY_ADDR));
                    } else {
                        clearAppProxy();
                        call.reject(lastError != null ? lastError : "WARP process stopped before proxy setup completed");
                    }
                });
            } catch (Exception e) {
                Log.e(TAG, "Failed to start Aether: " + e.getMessage(), e);
                synchronized (PROCESS_LOCK) {
                    if (generation == connectionGeneration) {
                        lastError = e.getMessage();
                        stopAether();
                        connected = false;
                        connecting = false;
                        clearAppProxy();
                    }
                }
                call.reject("Failed to start WARP proxy: " + e.getMessage());
            }
        }, "aether-connect").start();
    }

    /**
     * Disconnects from Cloudflare WARP by stopping the Aether binary.
     * @param keepProxy if true, keep proxy settings pointing to dead port
     *                  (blocks requests instead of leaking real IP).
     *                  Used for battery-save background disconnect.
     */
    public void disconnect(boolean keepProxy) {
        Log.i(TAG, "disconnect() called (keepProxy=" + keepProxy + ")");
        synchronized (PROCESS_LOCK) {
            connectionGeneration++;
            connecting = false;
        }
        stopAether();
        connected = false;
        if (!keepProxy) {
            // User explicitly disconnected → clear proxy (allow direct traffic)
            clearAppProxy();
        } else {
            // Background/battery-save disconnect → keep proxy pointing to dead port
            // so requests FAIL instead of leaking the real IP.
            // ProxyController + System properties stay set to 127.0.0.1:1820
            // which is now dead → all requests fail safely.
            Log.i(TAG, "Proxy kept (dead) to prevent IP leak during reconnect");
        }
    }

    /**
     * Disconnects from Cloudflare WARP (user-initiated).
     * Clears proxy → allows direct traffic.
     */
    @PluginMethod
    public void disconnect(PluginCall call) {
        // stopAether() does process.waitFor(5s) which would block the main
        // (Capacitor plugin) thread → ANR risk. Run on a background thread
        // and resolve immediately so the JS side doesn't wait.
        new Thread(() -> {
            disconnect(false);
            call.resolve(new JSObject().put("status", "disconnected"));
        }, "aether-disconnect").start();
    }

    /**
     * Background/battery-save disconnect.
     * Stops Aether but keeps proxy pointing to dead port → requests fail
     * instead of leaking the real IP during the reconnect window.
     */
    @PluginMethod
    public void disconnectBackground(PluginCall call) {
        new Thread(() -> {
            disconnect(true); // keep proxy (dead) to prevent leaks
            call.resolve(new JSObject().put("status", "disconnected"));
        }, "aether-disconnect-bg").start();
    }

    /**
     * Returns the current connection status and SOCKS5 proxy address.
     */
    @PluginMethod
    public void getStatus(PluginCall call) {
        boolean processAlive = aetherProcess != null && aetherProcess.isAlive();
        boolean isConnected = connected && processAlive && isSocksProxyUp();
        if (connected && !isConnected) {
            connected = false;
        }
        JSObject result = new JSObject();
        result.put("connected", isConnected);
        result.put("connecting", connecting);
        result.put("socks", isConnected ? SOCKS_ADDR : "");
        result.put("http", isConnected ? HTTP_PROXY_ADDR : "");
        result.put("error", lastError != null ? lastError : "");
        call.resolve(result);
    }

    public static String getSocksProxy() {
        return connected ? HTTP_PROXY_ADDR : null;
    }

    /**
     * Routes ALL app traffic through the WARP HTTP proxy.
     * This changes the app's external IP for both:
     * - HttpURLConnection (CapacitorHttp API calls, EPG, etc.)
     * - WebView (fetch, XHR, images loaded via <img> tags)
     * ExoPlayer streams already use the proxy separately.
     */
    private void setAppProxy(Runnable onReady) {
        // 1. System properties for HttpURLConnection (CapacitorHttp)
        // These affect all HTTP/HTTPS requests made via HttpURLConnection
        System.setProperty("http.proxyHost", "127.0.0.1");
        System.setProperty("http.proxyPort", String.valueOf(HTTP_PROXY_PORT));
        System.setProperty("https.proxyHost", "127.0.0.1");
        System.setProperty("https.proxyPort", String.valueOf(HTTP_PROXY_PORT));
        // Don't proxy localhost/127.0.0.1 (app assets, Capacitor bridge) ni la
        // LAN privada: el escaneo/envío a otros OctoStream (192.168.x.x, 10.x.x.x,
        // 172.16-31.x.x, link-local 169.254.x.x) debe ir directo o daría timeout.
        String directHosts = "localhost|127.0.0.1|*.local"
                + "|192.168.*|10.*|169.254.*"
                + "|172.16.*|172.17.*|172.18.*|172.19.*|172.20.*|172.21.*|172.22.*|172.23.*"
                + "|172.24.*|172.25.*|172.26.*|172.27.*|172.28.*|172.29.*|172.30.*|172.31.*"
                + "|*.tdtspain.com|*.tdtchannels.com|*.rtve.es|*.mediaset.net|*.mediasetinfinity.es|dai.google.com|*.doubleclick.net";
        System.setProperty("http.nonProxyHosts", directHosts);
        System.setProperty("https.nonProxyHosts", directHosts);
        Log.i(TAG, "System proxy set: " + HTTP_PROXY_ADDR);

        // 2. WebView proxy via ProxyController (API 29+)
        // This routes fetch/XHR/img requests through the WARP HTTP proxy
        // Must run on a thread with a Looper (main thread)
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            try {
                if (androidx.webkit.WebViewFeature.isFeatureSupported(
                        androidx.webkit.WebViewFeature.PROXY_OVERRIDE)) {
                    ProxyConfig proxyConfig = new ProxyConfig.Builder()
                        .addProxyRule("127.0.0.1:" + HTTP_PROXY_PORT)
                        .addBypassRule("localhost")
                        .addBypassRule("127.0.0.1")
                        .addBypassRule("*.local")
                        // LAN privada: SyncServer/descubrimiento OctoStream va directo
                        .addBypassRule("192.168.*")
                        .addBypassRule("10.*")
                        .addBypassRule("169.254.*")
                        .addBypassRule("172.16.*")
                        .addBypassRule("172.17.*")
                        .addBypassRule("172.18.*")
                        .addBypassRule("172.19.*")
                        .addBypassRule("172.20.*")
                        .addBypassRule("172.21.*")
                        .addBypassRule("172.22.*")
                        .addBypassRule("172.23.*")
                        .addBypassRule("172.24.*")
                        .addBypassRule("172.25.*")
                        .addBypassRule("172.26.*")
                        .addBypassRule("172.27.*")
                        .addBypassRule("172.28.*")
                        .addBypassRule("172.29.*")
                        .addBypassRule("172.30.*")
                        .addBypassRule("172.31.*")
                        .addBypassRule("*.tdtspain.com")
                        .addBypassRule("*.tdtchannels.com")
                        .addBypassRule("*.rtve.es")
                        .addBypassRule("*.mediaset.net")
                        .addBypassRule("*.mediasetinfinity.es")
                        .addBypassRule("dai.google.com")
                        .addBypassRule("*.doubleclick.net")
                        .build();
                    ProxyController.getInstance().setProxyOverride(proxyConfig, DIRECT_EXECUTOR, () -> {
                        Log.i(TAG, "WebView proxy set: " + HTTP_PROXY_ADDR);
                    });
                } else {
                    lastError = "WebView proxy override is not supported on this device";
                    Log.e(TAG, lastError);
                    stopAether();
                }
            } catch (Exception e) {
                lastError = "Failed to set WebView proxy: " + e.getMessage();
                Log.e(TAG, lastError);
                stopAether();
            }

            // 3. Anti-leak: Disable WebRTC in WebView (prevents IP leak via STUN/TURN)
            // WebRTC can bypass the proxy and reveal the real IP address.
            try {
                android.webkit.WebView webView = getBridge().getWebView();
                if (webView != null) {
                    // Disable WebRTC via JavaScript injection
                    String antiLeakScript =
                        "try {" +
                        "  // Disable WebRTC (prevents IP leak via STUN/TURN)\n" +
                        "  if (window.RTCPeerConnection) { window.RTCPeerConnection = undefined; }" +
                        "  if (window.webkitRTCPeerConnection) { window.webkitRTCPeerConnection = undefined; }" +
                        "  if (window.mozRTCPeerConnection) { window.mozRTCPeerConnection = undefined; }" +
                        "  // Disable WebRTC data channels\n" +
                        "  if (window.RTCDataChannel) { window.RTCDataChannel = undefined; }" +
                        "  // Block STUN/TURN requests\n" +
                        "  if (window.RTCIceCandidate) { window.RTCIceCandidate = undefined; }" +
                        "  // Override navigator.mediaDevices.getUserMedia to block WebRTC media\n" +
                        "  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {" +
                        "    navigator.mediaDevices.getUserMedia = function() { return Promise.reject(new Error('WebRTC disabled')); };" +
                        "  }" +
                        "  console.log('[AntiLeak] WebRTC disabled');" +
                        "} catch(e) { console.error('[AntiLeak] Error:', e); }";

                    // Inject on every page load
                    webView.evaluateJavascript(antiLeakScript, null);

                    // Also inject at document start without replacing Capacitor's WebViewClient
                    if (!antiLeakScriptInstalled && androidx.webkit.WebViewFeature.isFeatureSupported(
                            androidx.webkit.WebViewFeature.DOCUMENT_START_SCRIPT)) {
                        androidx.webkit.WebViewCompat.addDocumentStartJavaScript(
                            webView,
                            antiLeakScript,
                            java.util.Collections.singleton("*"));
                        antiLeakScriptInstalled = true;
                    }

                    Log.i(TAG, "WebRTC disabled in WebView (anti-leak)");
                }
            } catch (Exception e) {
                Log.e(TAG, "Failed to disable WebRTC: " + e.getMessage());
            }
            if (onReady != null) onReady.run();
        });
    }

    /**
     * Removes the app-wide proxy routing.
     */
    private void clearAppProxy() {
        // 1. Clear system properties
        System.clearProperty("http.proxyHost");
        System.clearProperty("http.proxyPort");
        System.clearProperty("https.proxyHost");
        System.clearProperty("https.proxyPort");
        System.clearProperty("http.nonProxyHosts");
        System.clearProperty("https.nonProxyHosts");
        Log.i(TAG, "System proxy cleared");

        // 2. Clear WebView proxy (must run on main thread)
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            try {
                if (androidx.webkit.WebViewFeature.isFeatureSupported(
                        androidx.webkit.WebViewFeature.PROXY_OVERRIDE)) {
                    ProxyController.getInstance().clearProxyOverride(DIRECT_EXECUTOR, () -> {
                        Log.i(TAG, "WebView proxy cleared");
                    });
                }
            } catch (Exception e) {
                Log.e(TAG, "Failed to clear WebView proxy: " + e.getMessage());
            }

            // 3. Re-enable WebRTC (restore normal behavior when WARP is off)
            try {
                android.webkit.WebView webView = getBridge().getWebView();
                if (webView != null) {
                    String restoreScript =
                        "try {" +
                        "  // Re-enable WebRTC by restoring native APIs\n" +
                        "  // (they can't be truly restored, but page reload will fix it)\n" +
                        "  console.log('[AntiLeak] WebRTC restrictions removed');" +
                        "} catch(e) {}";
                    webView.evaluateJavascript(restoreScript, null);
                }
            } catch (Exception e) {
                Log.e(TAG, "Failed to restore WebRTC: " + e.getMessage());
            }
        });
    }

    /**
     * Starts the Aether binary as a background process.
     * The binary is bundled as libaether.so in jniLibs.
     */
    private void startAether() throws Exception {
        // Find the aether binary in nativeLibraryDir
        String nativeLibDir = getContext().getApplicationInfo().nativeLibraryDir;
        File executable = new File(nativeLibDir, "libaether.so");
        if (!executable.isFile()) {
            throw new IllegalStateException("Aether binary not found: " + executable.getAbsolutePath());
        }

        Log.i(TAG, "Starting Aether: " + executable.getAbsolutePath());

        ProcessBuilder builder = new ProcessBuilder(executable.getAbsolutePath());
        builder.directory(getContext().getFilesDir());
        builder.redirectErrorStream(true);

        // Environment variables for Aether - optimized for battery
        Map<String, String> env = builder.environment();
        env.put("AETHER_PROTOCOL", "masque");
        // ironclad: full tunnel + real HTTP request per candidate (most secure scan)
        env.put("AETHER_SCAN", "ironclad");
        env.put("AETHER_IP", "v4");
        // aggressive: pads/reshapes handshake to defeat fingerprinting
        env.put("AETHER_NOIZE", "aggressive");
        // Reduce log level to warn (less CPU on log processing)
        env.put("AETHER_LOG_LEVEL", "warn");
        env.put("AETHER_SOCKS", SOCKS_ADDR);
        env.put("AETHER_CONFIG", new File(getContext().getFilesDir(), "aether.toml").getAbsolutePath());
        env.put("TMPDIR", getContext().getCacheDir().getAbsolutePath());
        // Quick reconnect to reuse last known good endpoint
        env.put("AETHER_QUICK_RECONNECT", "1");
        // Use a known good endpoint to skip the 120s scan
        env.put("AETHER_PEER", "162.159.198.1:443");
        // Also start HTTP CONNECT proxy (better for OkHttp - does remote DNS)
        env.put("AETHER_HTTP_PROXY", HTTP_PROXY_ADDR);
        // Enable QUIC v2 opener (helps on networks that block QUIC v1)
        env.put("AETHER_QUIC_V2", "1");
        // Route sniff: read SNI from first bytes for smarter routing
        env.put("AETHER_ROUTE_SNIFF", "1");

        aetherProcess = builder.start();
        Log.i(TAG, "Aether process started");

        // Read logs in a background thread
        new Thread(() -> readAetherLogs(aetherProcess)).start();

        // Wait for the SOCKS5 proxy to come up (check every 500ms for up to 60s)
        // Reduced from 150s to 60s for faster feedback (and battery savings)
        int attempts = 0;
        int maxAttempts = 120; // 60 seconds
        while (!isSocksProxyUp() && attempts < maxAttempts) {
            Thread.sleep(500);
            attempts++;
        }

        if (!isSocksProxyUp()) {
            throw new RuntimeException("Aether proxy not responding (SOCKS " + SOCKS_ADDR + " or HTTP " + HTTP_PROXY_ADDR + ") after " + (attempts * 0.5) + "s");
        }
        Log.i(TAG, "Aether proxies up: SOCKS " + SOCKS_ADDR + ", HTTP " + HTTP_PROXY_ADDR);
    }

    /**
     * Stops the Aether binary.
     */
    private void stopAether() {
        Process process;
        synchronized (PROCESS_LOCK) {
            process = aetherProcess;
            aetherProcess = null;
            connected = false;
        }
        if (process != null) {
            Log.i(TAG, "Stopping Aether process");
            process.destroy();
            try {
                if (!process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS) && process.isAlive()) {
                    process.destroyForcibly();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
            }
        }
    }

    /**
     * Reads Aether logs and logs them.
     * Only logs important lines (not every debug line) to save CPU/battery.
     */
    private void readAetherLogs(Process process) {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                // Only log important lines (errors, warnings, listening status)
                // Skip routine QUIC/MASQUE keepalive/debug lines to save CPU
                if (line.contains("listening") || line.contains("SOCKS") ||
                    line.contains("error") || line.contains("ERROR") ||
                    line.contains("warn") || line.contains("WARN") ||
                    line.contains("exposing")) {
                    Log.d(TAG, "Aether: " + line);
                    // Connection state is owned by connect()/disconnect(); log output
                    // must not resurrect a stopped session asynchronously.
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Aether log reader error: " + e.getMessage());
        }
    }

    /**
     * Checks if the SOCKS5 proxy is responding.
     */
    private boolean isSocksProxyUp() {
        // Check both SOCKS5 (1819) and HTTP CONNECT (1820) proxy ports
        for (int port : new int[]{SOCKS_PORT, HTTP_PROXY_PORT}) {
            try (java.net.Socket socket = new java.net.Socket()) {
                socket.connect(new java.net.InetSocketAddress("127.0.0.1", port), 500);
            } catch (Exception e) {
                return false;
            }
        }
        return true;
    }
}
