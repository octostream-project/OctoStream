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

import de.blinkt.openvpn.api.IOpenVPNAPIService;
import de.blinkt.openvpn.api.IOpenVPNStatusCallback;

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

    private static volatile Process aetherProcess = null;
    private static volatile boolean connected = false;
    private static volatile boolean connecting = false;
    private static volatile long connectingSince = 0;
    private static volatile int statusMisses = 0;
    // Protocolo que funcionó la última vez — se prueba primero en la
    // siguiente conexión. "masque" es preferido (se disfraza de HTTPS/443);
    // en redes que filtran el data-plane QUIC cae a "wg" automáticamente.
    private static volatile String preferredProtocol = "masque";
    private static volatile String lastError = null;
    private static long connectionGeneration = 0;
    private static final Object PROCESS_LOCK = new Object();
    private static final Executor DIRECT_EXECUTOR = Runnable::run;
    private boolean antiLeakScriptInstalled = false;
    private androidx.webkit.ScriptHandler antiLeakScriptHandler = null;

    // ─── RiseupVPN vía API remota de OpenVPN for Android ────────────────────
    // La app oficial (de.blinkt.openvpn) expone IOpenVPNAPIService por bind:
    // podemos importar el .ovpn generado y arrancar/parar el túnel real —
    // VPN sistema-completo gestionada desde OctoStream sin engine propio.
    // aether/WARP y el resto del tráfico enrutan por la VPN (VpnService
    // intercepta todo el tráfico de las apps).
    private static final String OVPN_PKG = "de.blinkt.openvpn";
    private volatile IOpenVPNAPIService mOvpnApi = null;
    private volatile boolean mOvpnConnected = false;
    private volatile String mPendingOvpnConf = null;
    private android.content.ServiceConnection mOvpnConn = null;

    private boolean isOvpnAppInstalled() {
        try {
            getContext().getPackageManager().getPackageInfo(OVPN_PKG, 0);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private final IOpenVPNStatusCallback mOvpnStatusCb = new IOpenVPNStatusCallback.Stub() {
        @Override
        public void newStatus(String uuid, String state, String message, String level) {
            mOvpnConnected = "CONNECTED".equals(state);
        }
    };

    // Serializa el bind a la API remota: dos riseupConnect paralelos creaban
    // dos bindService y el segundo sobrescribía mOvpnConn sin unbind del
    // primero — fuga de ServiceConnection. Los callers que llegan con un bind
    // en curso se encolan y se sirven todos en onServiceConnected.
    private final Object mOvpnLock = new Object();
    private final java.util.List<Runnable> mOvpnReadyQueue = new java.util.ArrayList<>();

    private void bindOvpnApi(Runnable onReady) {
        synchronized (mOvpnLock) {
            if (mOvpnApi != null) { onReady.run(); return; }
            mOvpnReadyQueue.add(onReady);
            if (mOvpnConn != null) return; // bind en curso
            android.content.Context ctx = getContext();
            final android.content.Context appCtx = ctx.getApplicationContext();
            mOvpnConn = new android.content.ServiceConnection() {
                @Override public void onServiceConnected(android.content.ComponentName n, android.os.IBinder b) {
                    mOvpnApi = IOpenVPNAPIService.Stub.asInterface(b);
                    try { mOvpnApi.registerStatusCallback(mOvpnStatusCb); } catch (Exception ignored) {}
                    java.util.List<Runnable> q;
                    synchronized (mOvpnLock) {
                        q = new java.util.ArrayList<>(mOvpnReadyQueue);
                        mOvpnReadyQueue.clear();
                    }
                    for (Runnable r : q) r.run();
                }
                @Override public void onServiceDisconnected(android.content.ComponentName n) {
                    mOvpnApi = null;
                }
            };
            try {
                android.content.Intent intent = new android.content.Intent(IOpenVPNAPIService.class.getName());
                intent.setPackage(OVPN_PKG);
                if (!appCtx.bindService(intent, mOvpnConn, android.content.Context.BIND_AUTO_CREATE)) {
                    mOvpnApi = null;
                    mOvpnConn = null;
                    throw new IllegalStateException("bind rechazado");
                }
            } catch (Exception e) {
                mOvpnApi = null;
                try { appCtx.unbindService(mOvpnConn); } catch (Exception ignored) {}
                mOvpnConn = null;
                // Los callers encolados reciben su onReady con api nula — su
                // propio try/catch rechaza la llamada en vez de colgarla.
                java.util.List<Runnable> q = new java.util.ArrayList<>(mOvpnReadyQueue);
                mOvpnReadyQueue.clear();
                for (Runnable r : q) { try { r.run(); } catch (Exception ignored) {} }
                throw e;
            }
        }
    }

    /** Motor embebido: true si libovpnexec.so viene en jniLibs. */
    private boolean hasEmbeddedOvpn() {
        return new File(getContext().getApplicationInfo().nativeLibraryDir, "libovpnexec.so").isFile();
    }

    /**
     * Conecta el túnel RiseupVPN con el .ovpn generado en JS.
     * Motor embebido primero (VpnService propio + libovpnexec.so); si el
     * binario falta, fallback a la API remota de OpenVPN for Android.
     * @param call {config: string} — contenido .ovpn con PEMs inline.
     *   status: connected | need-vpn-permission | consent (API remota)
     */
    @PluginMethod
    public void riseupConnect(PluginCall call) {
        final String conf = call.getString("config");
        if (conf == null || conf.isEmpty()) {
            call.reject("config required");
            return;
        }
        if (hasEmbeddedOvpn()) {
            riseupConnectEmbedded(call, conf);
            return;
        }
        if (!isOvpnAppInstalled()) {
            call.reject("no-openvpn-app");
            return;
        }
        mPendingOvpnConf = conf;
        new Thread(() -> {
            try {
                bindOvpnApi(() -> doOvpnConnect(call));
            } catch (Exception e) {
                call.reject("bind a OpenVPN falló: " + e.getMessage());
            }
        }, "ovpn-bind").start();
    }

    /** Motor embebido: VpnService propio + proceso libovpnexec.so. */
    private void riseupConnectEmbedded(PluginCall call, String conf) {
        android.content.Context ctx = getContext();
        // Permiso VPN del sistema (una sola vez por app). El intent del
        // diálogo se lanza vía startActivityForResult del plugin — lanzarlo
        // con startActivity() desde el contexto de la app se lo traga en
        // varios ROMs (MIUI, Android TV) y el diálogo nunca aparecía.
        android.content.Intent prepare = android.net.VpnService.prepare(ctx);
        if (prepare != null) {
            mPendingOvpnConf = conf;
            mPendingEmbeddedCall = call;
            startActivityForResult(call, prepare, "ovpnPermResult");
            return;
        }
        doStartEmbedded(call, conf);
    }

    private volatile PluginCall mPendingEmbeddedCall = null;

    /** Resultado del diálogo de permiso VPN del sistema. */
    @com.getcapacitor.annotation.ActivityCallback
    private void ovpnPermResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        PluginCall pending = mPendingEmbeddedCall;
        mPendingEmbeddedCall = null;
        if (pending == null) return; // call ya resuelta — no rechazar dos veces
        if (result.getResultCode() == android.app.Activity.RESULT_OK
                && mPendingOvpnConf != null) {
            doStartEmbedded(pending, mPendingOvpnConf);
        } else {
            pending.reject("Permiso VPN denegado");
        }
    }

    private void doStartEmbedded(PluginCall call, String conf) {
        android.content.Context ctx = getContext();
        try {
            // Riseup y WARP/aether son EXCLUYENTES: si aether sigue activo
            // envuelve el tráfico en MASQUE→Cloudflare y la IP de salida
            // que ven los servicios es WARP, no la de Riseup. Al arrancar
            // el túnel, aether se desconecta (en bg — stopAether espera
            // al proceso y no puede bloquear este hilo).
            new Thread(() -> disconnect(false), "aether-stop").start();
            File confFile = new File(ctx.getCacheDir(), "riseup-user.ovpn");
            java.io.FileWriter w = new java.io.FileWriter(confFile, false);
            w.write(conf);
            w.close();
            android.content.Intent intent = new android.content.Intent(ctx, OctoVpnService.class);
            intent.setAction(OctoVpnService.ACTION_START);
            intent.putExtra(OctoVpnService.EXTRA_CONF, confFile.getAbsolutePath());
            if (android.os.Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent);
            else ctx.startService(intent);
            call.resolve(new JSObject().put("status", "connected"));
        } catch (Exception e) {
            Log.e(TAG, "riseupConnectEmbedded failed", e);
            call.reject("riseupConnectEmbedded: " + e.getMessage());
        }
    }

    private void doOvpnConnect(PluginCall call) {
        try {
            // Consentimiento de API remota (una sola vez por app): prepare()
            // devuelve un Intent de confirmación del lado de OpenVPN.
            android.content.Intent perm = mOvpnApi.prepare(getContext().getPackageName());
            if (perm != null) {
                perm.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(perm);
                call.resolve(new JSObject().put("status", "consent"));
                return;
            }
            // Permiso VPN del sistema (una sola vez).
            android.content.Intent vpnPerm = mOvpnApi.prepareVPNService();
            if (vpnPerm != null) {
                vpnPerm.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(vpnPerm);
                call.resolve(new JSObject().put("status", "need-vpn-permission"));
                return;
            }
            // startVPN con el config inline — no guarda perfil en la app.
            mOvpnApi.startVPN(mPendingOvpnConf);
            mOvpnConnected = true;
            call.resolve(new JSObject().put("status", "connected"));
        } catch (Exception e) {
            Log.e(TAG, "riseupConnect failed", e);
            call.reject("riseupConnect: " + e.getMessage());
        }
    }

    @PluginMethod
    public void riseupDisconnect(PluginCall call) {
        try {
            if (hasEmbeddedOvpn() || OctoVpnService.isRunning()) {
                android.content.Intent intent = new android.content.Intent(getContext(), OctoVpnService.class);
                intent.setAction(OctoVpnService.ACTION_STOP);
                getContext().startService(intent);
            }
            if (mOvpnApi != null) mOvpnApi.disconnect();
            mOvpnConnected = false;
            call.resolve(new JSObject().put("status", "disconnected"));
        } catch (Exception e) {
            call.reject("riseupDisconnect: " + e.getMessage());
        }
    }

    @PluginMethod
    public void riseupTunnelStatus(PluginCall call) {
        JSObject ret = new JSObject();
        boolean embedded = hasEmbeddedOvpn();
        ret.put("installed", embedded || isOvpnAppInstalled());
        ret.put("embedded", embedded);
        ret.put("connected", embedded ? OctoVpnService.isConnected() : mOvpnConnected);
        ret.put("connecting", OctoVpnService.isRunning() && !OctoVpnService.isConnected());
        ret.put("error", OctoVpnService.getLastError());
        ret.put("hasEngine", embedded || mOvpnApi != null);
        call.resolve(ret);
    }

    @Override
    public void load() {
        Log.i(TAG, "CloudProxyPlugin loaded");
    }

    @Override
    protected void handleOnDestroy() {
        // NO apagar el túnel Riseup aquí: handleOnDestroy dispara también en
        // recreaciones de Activity (rotación, config change) y al minimizar,
        // y matar el servicio tumba la VPN sin que el usuario lo pida. Solo
        // el toggle de Settings (ACTION_STOP → enabled=false) la para. Si el
        // SO mata el proceso, START_STICKY + conf cacheado lo reaniman.
        try {
            if (mOvpnConn != null) {
                getContext().getApplicationContext().unbindService(mOvpnConn);
                mOvpnConn = null; mOvpnApi = null;
            }
        } catch (Exception ignored) {}
        // Capacitor can destroy/recreate its Activity for configuration
        // changes or while Android backgrounds the app. Do not tear WARP
        // down in those cases: only stop it when the Activity is actually
        // finishing (the user explicitly closed the app). Android also
        // reaps app child processes if it kills the whole process.
        android.app.Activity activity = getActivity();
        if (activity != null && activity.isFinishing()) {
            new Thread(() -> {
                if (connected || aetherProcess != null) disconnect(false);
                else clearAppProxy();
            }, "aether-destroy").start();
        } else {
            Log.i(TAG, "Activity destroyed but not finishing; keeping WARP alive");
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

        // Exclusión mutua: si el túnel Riseup está vivo, conectar aether
        // lo para (si no, la IP de salida sería WARP, no Riseup).
        if (OctoVpnService.isRunning()) {
            android.content.Intent stop = new android.content.Intent(getContext(), OctoVpnService.class);
            stop.setAction(OctoVpnService.ACTION_STOP);
            getContext().startService(stop);
        }

        final long generation;
        final boolean needsStop;
        // La sonda de sockets (hasta ~1s) NO puede ir dentro del lock —
        // bloquearía a getStatus/getHttpProxy y al propio wait-path.
        boolean fastAlive;
        synchronized (PROCESS_LOCK) {
            fastAlive = connected && aetherProcess != null && aetherProcess.isAlive();
        }
        // Fast-path: no basta con que el proceso viva — verifica que el
        // túnel responde, si no un túnel medio muerto devolvería
        // "connected" sin reconectar nada.
        if (fastAlive && isSocksProxyUp()) {
            call.resolve(new JSObject().put("status", "connected"));
            return;
        }
        synchronized (PROCESS_LOCK) {
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
            // IMPORTANTE: no llamar a stopAether() dentro del lock — hace
            // process.waitFor(5s) y bloquearía el hilo del bridge hasta 5s.
            needsStop = aetherProcess != null;
            connecting = true;
            connectingSince = System.currentTimeMillis();
            statusMisses = 0;
            lastError = null;
            generation = ++connectionGeneration;
        }

        new Thread(() -> {
            try {
                // Parar el proceso viejo fuera del lock y del hilo del bridge:
                // waitFor(5s) aquí es tolerable (hilo propio), no en el caller.
                if (needsStop) stopAether();
                // Fallback de protocolo: el data-plane QUIC de MASQUE es
                // filtrado por algunos ISP (handshake ok, tráfico descartado
                // → scan de 120s sin gateway). Si el protocolo preferido no
                // levanta los proxies a tiempo, se reintenta con el otro
                // (WireGuard clásico valida en ~10s cuando UDP pasa).
                String first = preferredProtocol;
                String second = "masque".equals(first) ? "wg" : "masque";
                try {
                    startAether(first);
                } catch (Exception firstErr) {
                    Log.w(TAG, "Aether " + first + " failed (" + firstErr.getMessage() + ") — retrying with " + second);
                    stopAether();
                    startAether(second);
                    preferredProtocol = second;
                }
                Process startedProcess = aetherProcess;
                boolean cancelled;
                synchronized (PROCESS_LOCK) {
                    cancelled = generation != connectionGeneration;
                }
                if (cancelled) {
                    // Esta conexión fue reemplazada — matar NUESTRO proceso
                    // (waitFor fuera del lock, como en el resto de rutas).
                    synchronized (PROCESS_LOCK) {
                        if (aetherProcess == startedProcess) aetherProcess = null;
                    }
                    if (startedProcess != null) {
                        try {
                            startedProcess.destroy();
                            if (!startedProcess.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
                                    && startedProcess.isAlive()) {
                                startedProcess.destroyForcibly();
                            }
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            startedProcess.destroyForcibly();
                        }
                    }
                    call.reject("WARP connection cancelled");
                    return;
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
                boolean own;
                synchronized (PROCESS_LOCK) {
                    own = generation == connectionGeneration;
                    if (own) {
                        lastError = e.getMessage();
                        connected = false;
                        connecting = false;
                    }
                }
                // stopAether (waitFor 5s) y clearAppProxy FUERA del lock —
                // retener PROCESS_LOCK segundos congela el fast-path de
                // connect() y las sondas de ExoPlayer.
                if (own) {
                    stopAether();
                    clearAppProxy();
                }
                call.reject("Failed to start WARP proxy: " + e.getMessage());
            }
        }, "aether-connect").start();
    }

    /**
     * Escribe un perfil OpenVPN (.ovpn) en el cache interno y lo abre con
     * el cliente OpenVPN del sistema (OpenVPN Connect / OpenVPN for Android
     * registran la extensión .ovpn). RiseupVPN como capa VPN alternativa —
     * el túnel corre sistema-completo en el cliente del usuario, no dentro
     * de la app (sin motor OpenVPN propio).
     * @param call {config: string (contenido .ovpn), name?: string}
     */
    @PluginMethod
    public void exportOvpn(PluginCall call) {
        String config = call.getString("config");
        if (config == null || config.isEmpty()) {
            call.reject("config required");
            return;
        }
        String name = call.getString("name");
        if (name == null || name.isEmpty()) name = "riseup-ovpn.conf";
        if (!name.endsWith(".conf") && !name.endsWith(".ovpn")) name += ".ovpn";
        try {
            android.content.Context ctx = getContext();
            File out = new File(ctx.getCacheDir(), name);
            java.io.FileOutputStream fos = new java.io.FileOutputStream(out);
            fos.write(config.getBytes("UTF-8"));
            fos.close();
            android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(
                    ctx, ctx.getPackageName() + ".fileprovider", out);
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/x-openvpn-profile");
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                    | android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
                ctx.startActivity(intent);
            } catch (android.content.ActivityNotFoundException noView) {
                // Sin app que entienda .ovpn → compartir genérico (el usuario
                // puede guardarlo o mandarlo a su cliente OpenVPN).
                android.content.Intent share = new android.content.Intent(android.content.Intent.ACTION_SEND);
                share.setType("application/x-openvpn-profile");
                share.putExtra(android.content.Intent.EXTRA_STREAM, uri);
                share.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                        | android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
                ctx.startActivity(android.content.Intent.createChooser(share, null)
                        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            }
            JSObject ret = new JSObject();
            ret.put("opened", true);
            ret.put("name", name);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "exportOvpn failed", e);
            call.reject("exportOvpn failed: " + e.getMessage(), e);
        }
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
        // connecting tiene un límite interno de ~60s (startAether); un true
        // más viejo que eso es estado corrupto (un connect cancelado o un
        // hilo muerto) — se limpia solo para que los reintentos funcionen.
        if (connecting && System.currentTimeMillis() - connectingSince > 75000) {
            synchronized (PROCESS_LOCK) { connecting = false; }
        }
        boolean processAlive = aetherProcess != null && aetherProcess.isAlive();
        boolean probeUp = connected && processAlive && isSocksProxyUp();
        // Un fallo transitorio de la sonda no debe tumbar la sesión: en
        // hardware lento el socket de 500ms falla a veces y un solo miss
        // antes dejaba connected=false para siempre aunque el túnel siguiera
        // vivo (overlay "Conectando WARP" permanente). Exige 3 sondeos
        // fallidos seguidos (~30s) para dar el túnel por caído.
        if (connected && !processAlive) {
            synchronized (PROCESS_LOCK) {
                connected = false;
                statusMisses = 0;
            }
        } else if (connected && !probeUp) {
            if (++statusMisses >= 3) {
                synchronized (PROCESS_LOCK) {
                    connected = false;
                    statusMisses = 0;
                }
            }
        } else if (probeUp) {
            statusMisses = 0;
        }
        // El estado reportado es el creído (con histéresis), no la sonda
        // instantánea — evita parpadeo del overlay ante misses sueltos.
        boolean isConnected = connected && processAlive;
        JSObject result = new JSObject();
        result.put("connected", isConnected);
        result.put("connecting", connecting);
        result.put("socks", isConnected ? SOCKS_ADDR : "");
        result.put("http", isConnected ? HTTP_PROXY_ADDR : "");
        result.put("error", lastError != null ? lastError : "");
        call.resolve(result);
    }

    /**
     * Devuelve el proxy HTTP CONNECT local ("127.0.0.1:1820") o null si WARP
     * no está conectado. A pesar del nombre legacy {@code getSocksProxy}, los
     * consumidores (ExoPlayer DataSource, OkHttp) lo usan como Proxy.Type.HTTP.
     */
    public static String getHttpProxy() {
        return connected ? HTTP_PROXY_ADDR : null;
    }

    /** La dirección del proxy local aunque el estado esté marcado caído —
     * para URLs que DEBEN salir por WARP (ligadas a la IP del túnel). */
    public static String getHttpProxyAddr() {
        return HTTP_PROXY_ADDR;
    }

    /**
     * Sonda barata del puerto HTTP CONNECT local (400ms). La usa ExoPlayer
     * antes de rutar un stream por WARP: 'connected' tiene histéresis (~30s)
     * y un túnel muerto haría colgar y fallar cada servidor hasta reiniciar.
     */
    public static boolean isLocalProxyUp() {
        // Un TCP connect a loopback de 400ms puede fallar aunque el proxy
        // siga vivo si aether tiene la cola de accept saturada (túnel
        // reconectando con CONNECTs pendientes). Un reintento corto separa
        // "muerto de verdad" (connection refused, instantáneo) de un
        // momento de saturación — antes un solo timeout marcaba todo el
        // estado WARP caído hasta reabrir la app.
        for (int attempt = 0; attempt < 2; attempt++) {
            try (java.net.Socket s = new java.net.Socket()) {
                s.connect(new java.net.InetSocketAddress("127.0.0.1", HTTP_PROXY_PORT), 400);
                return true;
            } catch (Exception e) {
                if (attempt == 0) {
                    try { Thread.sleep(200); } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        return false;
                    }
                }
            }
        }
        return false;
    }

    /** Marca la sesión como caída desde fuera (sonda del puerto falló). */
    public static void markDisconnected() {
        synchronized (PROCESS_LOCK) {
            connected = false;
            statusMisses = 0;
        }
        // CRÍTICO: también limpiar el proxy del sistema. Si solo se cambia el
        // flag, http.proxyHost sigue apuntando al listener muerto y TODA la
        // red "directa" (DefaultHttpDataSource del stream, CapacitorHttp) va
        // igualmente al puerto muerto — bytes truncados que se manifestaban
        // como errores de decoder (FfmpegAudioRenderer audio/ac3). El
        // fail-closed de JS no se rompe: waitForWarp ya gatea las peticiones.
        System.clearProperty("http.proxyHost");
        System.clearProperty("http.proxyPort");
        System.clearProperty("https.proxyHost");
        System.clearProperty("https.proxyPort");
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            try {
                if (androidx.webkit.WebViewFeature.isFeatureSupported(
                        androidx.webkit.WebViewFeature.PROXY_OVERRIDE)) {
                    ProxyController.getInstance().clearProxyOverride(DIRECT_EXECUTOR, () -> {});
                }
            } catch (Exception ignored) {}
        });
    }

    /** @deprecated usar {@link #getHttpProxy()} — nunca devolvió el puerto SOCKS. */
    @Deprecated
    public static String getSocksProxy() {
        return getHttpProxy();
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
                + "|*.tdtspain.com|*.tdtchannels.com|*.rtve.es|*.mediaset.net|*.mediasetinfinity.es"
                + "|*.atresplayer.com|*.atresmedia.com|dai.google.com|*.doubleclick.net";
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
                        // Atresmedia igual que RTVE/Mediaset: sus URLs de
                        // directo van ligadas a la IP que resuelve — por
                        // WARP la firma no casa con la IP de reproducción.
                        .addBypassRule("*.atresplayer.com")
                        .addBypassRule("*.atresmedia.com")
                        .addBypassRule("dai.google.com")
                        .addBypassRule("*.doubleclick.net")
                        .build();
                    ProxyController.getInstance().setProxyOverride(proxyConfig, DIRECT_EXECUTOR, () -> {
                        Log.i(TAG, "WebView proxy set: " + HTTP_PROXY_ADDR);
                    });
                } else {
                    lastError = "WebView proxy override is not supported on this device";
                    Log.e(TAG, lastError);
                    // waitFor(5s) en main thread = ANR — teardown en background.
                    new Thread(this::stopAether, "aether-stop").start();
                }
            } catch (Exception e) {
                lastError = "Failed to set WebView proxy: " + e.getMessage();
                Log.e(TAG, lastError);
                new Thread(this::stopAether, "aether-stop").start();
            }

            // 3. Anti-leak: Disable WebRTC in WebView (prevents IP leak via STUN/TURN)
            // WebRTC can bypass the proxy and reveal the real IP address.
            try {
                android.webkit.WebView webView = getBridge().getWebView();
                if (webView != null) {
                    webView.evaluateJavascript(ANTI_LEAK_SCRIPT, null);
                    if (!antiLeakScriptInstalled
                            && androidx.webkit.WebViewFeature.isFeatureSupported(
                                androidx.webkit.WebViewFeature.DOCUMENT_START_SCRIPT)) {
                        antiLeakScriptHandler = androidx.webkit.WebViewCompat.addDocumentStartJavaScript(
                            webView, ANTI_LEAK_SCRIPT, java.util.Collections.singleton("*"));
                    }
                    antiLeakScriptInstalled = true;
                    Log.i(TAG, "WebRTC disabled in WebView (anti-leak)");
                }
            } catch (Exception e) {
                Log.e(TAG, "Failed to disable WebRTC: " + e.getMessage());
            }
            if (onReady != null) onReady.run();
        });
    }

    /**
     * Script anti-leak compartido: neutraliza RTCPeerConnection y getUserMedia
     * para que ningún documento (incluidos embeds de terceros) pueda revelar
     * la IP real vía STUN/TURN mientras WARP está activo.
     * Expuesto como static para que otros plugins (ExoPlayer: embed/relay
     * WebViews) apliquen la misma protección a sus WebViews auxiliares.
     */
    public static final String ANTI_LEAK_SCRIPT =
        "try {" +
        "  if (window.RTCPeerConnection) { window.RTCPeerConnection = undefined; }" +
        "  if (window.webkitRTCPeerConnection) { window.webkitRTCPeerConnection = undefined; }" +
        "  if (window.mozRTCPeerConnection) { window.mozRTCPeerConnection = undefined; }" +
        "  if (window.RTCDataChannel) { window.RTCDataChannel = undefined; }" +
        "  if (window.RTCIceCandidate) { window.RTCIceCandidate = undefined; }" +
        "  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {" +
        "    navigator.mediaDevices.getUserMedia = function() { return Promise.reject(new Error('WebRTC disabled')); };" +
        "  }" +
        "} catch(e) {}";

    /**
     * Aplica el blindaje anti-leak a un WebView cualquiera.
     * {@code documentStart}=true lo inyecta también al inicio de cada documento
     * (persiste entre navegaciones); debe llamarse una sola vez por WebView.
     */
    public static void applyAntiLeak(android.webkit.WebView webView, boolean documentStart) {
        if (webView == null) return;
        webView.evaluateJavascript(ANTI_LEAK_SCRIPT, null);
        if (documentStart && androidx.webkit.WebViewFeature.isFeatureSupported(
                androidx.webkit.WebViewFeature.DOCUMENT_START_SCRIPT)) {
            androidx.webkit.WebViewCompat.addDocumentStartJavaScript(
                webView,
                ANTI_LEAK_SCRIPT,
                java.util.Collections.singleton("*"));
        }
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

            // 3. Quitar el script anti-leak inyectado al inicio de cada
            // documento — si no se retira, el ScriptHandler sigue deshabilitando
            // WebRTC en TODAS las navegaciones futuras aunque WARP esté apagado
            // (rompía embeds con WebRTC hasta reiniciar la app).
            try {
                if (antiLeakScriptHandler != null) {
                    antiLeakScriptHandler.remove();
                    antiLeakScriptHandler = null;
                }
                antiLeakScriptInstalled = false;
            } catch (Exception e) {
                Log.e(TAG, "Failed to remove anti-leak script: " + e.getMessage());
            }
        });
    }

    /**
     * Starts the Aether binary as a background process.
     * The binary is bundled as libaether.so in jniLibs.
     */
    private void startAether(String protocol) throws Exception {
        // Orphan cleanup: a previous libaether process can outlive the app
        // (Android doesn't always reap children on process death) and keep
        // ports 1819/1820 bound — every subsequent connect() would then time
        // out forever. killall works without root for same-uid processes.
        if (aetherProcess == null && isSocksProxyUp()) {
            Log.w(TAG, "Stale Aether holding proxy ports — killing orphan");
            try {
                new ProcessBuilder("killall", "-9", "libaether.so").start()
                    .waitFor(3, java.util.concurrent.TimeUnit.SECONDS);
            } catch (Exception e) {
                Log.w(TAG, "killall libaether failed: " + e.getMessage());
            }
            for (int i = 0; i < 20 && isSocksProxyUp(); i++) {
                try { Thread.sleep(150); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
            }
        }

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
        env.put("AETHER_PROTOCOL", protocol);
        boolean isMasque = "masque".equals(protocol);
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
        if (isMasque) {
            // Endpoint MASQUE fijado para saltarse el scan de 120s — solo vale
            // para QUIC/443; en WG los endpoints son otros puertos (908…).
            env.put("AETHER_PEER", "162.159.198.1:443");
            // Enable QUIC v2 opener (helps on networks that block QUIC v1)
            env.put("AETHER_QUIC_V2", "1");
        }
        // Also start HTTP CONNECT proxy (better for OkHttp - does remote DNS)
        env.put("AETHER_HTTP_PROXY", HTTP_PROXY_ADDR);
        // Route sniff: read SNI from first bytes for smarter routing
        env.put("AETHER_ROUTE_SNIFF", "1");

        final Process spawned = builder.start();
        Log.i(TAG, "Aether process started");

        // Registrar el proceso y comprobar cancelación ATÓMICAMENTE: si
        // disconnect() corre entre el builder.start() y la asignación, su
        // stopAether() ya leyó aetherProcess (viejo/nulo) y NADIE mataría al
        // proceso recién creado → aether huérfano con los puertos ocupados
        // y el túnel vivo aunque la app crea que WARP está apagado.
        synchronized (PROCESS_LOCK) {
            if (!connecting) {
                spawned.destroy();
                aetherProcess = null;
                throw new InterruptedException("connect cancelled");
            }
            aetherProcess = spawned;
        }

        // Read logs in a background thread. OJO: capturar el proceso local,
        // no el campo — si un connect posterior lo reemplaza, este hilo debe
        // seguir drenando ESTE proceso; si nadie drena su stdout el pipe de
        // 64KB se llena y el hijo se congela escribiendo (zombie colgado).
        new Thread(() -> readAetherLogs(spawned), "aether-logs").start();

        // Wait for the SOCKS5 proxy to come up. MASQUE va rápido cuando su
        // peer fijado valida (~5-10s); si en ~35s no hay proxies el protocolo
        // está filtrado y no merece quemar los 120s del scan — se corta y el
        // caller cae al otro protocolo. WG recibe más margen porque escanea
        // endpoints propios (~10s típico, hasta ~60s).
        int attempts = 0;
        int maxAttempts = isMasque ? 70 : 120; // 35s masque / 60s wg
        while (!isSocksProxyUp() && attempts < maxAttempts) {
            synchronized (PROCESS_LOCK) {
                if (!connecting) throw new InterruptedException("connect cancelled");
            }
            Process p = aetherProcess;
            if (p == null || !p.isAlive()) break;
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
    // TV georestricted domains use the physical network; other app traffic
    // goes through the Aether/WARP HTTP proxy.
    private static final java.util.regex.Pattern GEO_HOST = java.util.regex.Pattern.compile(
        "(^|\\.)(" +
        "tdtspain\\.com|tdtchannels\\.com|rtve\\.es|mediaset\\.net|mediasetinfinity\\.es|" +
        "atresplayer\\.com|atresmedia\\.com|dai\\.google\\.com|doubleclick\\.net)$",
        java.util.regex.Pattern.CASE_INSENSITIVE);

    public static boolean isGeoBypassHost(String url) {
        try {
            String host = android.net.Uri.parse(url).getHost();
            return host != null && GEO_HOST.matcher(host).find();
        } catch (Exception e) { return false; }
    }

    /** Rede física (WiFi/dados/ethernet) — nunca a própria VPN. */
    public static android.net.Network physicalNetwork(android.content.Context ctx) {
        try {
            android.net.ConnectivityManager cm =
                (android.net.ConnectivityManager) ctx.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
            if (cm == null) return null;
            android.net.Network cell = null;
            for (android.net.Network n : cm.getAllNetworks()) {
                android.net.NetworkCapabilities nc = cm.getNetworkCapabilities(n);
                // Sin NET_CAPABILITY_INTERNET la red no vale — la IMS
                // (ipsec91, VoWiFi) tiene TRANSPORT_CELLULAR pero no
                // INTERNET y atarle los sockets mata el stream.
                if (nc == null || nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)
                    || !nc.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue;
                if (nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
                    || nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)) return n;
                if (cell == null && nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)) cell = n;
            }
            return cell; // WiFi/ethernet primero; celular de respaldo
        } catch (Exception ignored) {}
        return null;
    }

    public static javax.net.SocketFactory physicalSocketFactory(android.content.Context ctx) {
        android.net.Network n = physicalNetwork(ctx);
        return n == null ? null : n.getSocketFactory();
    }

    /**
     * Fetch fora do túnel: para hosts com geobloqueio a ligação é aberta
     * na rede física (requer allowBypass no VpnService.Builder).
     */
    @PluginMethod
    public void directFetch(PluginCall call) {
        final String url = call.getString("url");
        final String method = call.getString("method", "GET");
        final JSObject headers = call.getObject("headers");
        final Object data = call.getData() != null ? call.getData().opt("data") : null;
        final String responseType = call.getString("responseType", "text");
        // bypassVpn (resolve TDT): URLs assinadas ligam-se ao IP que resolve —
        // qualquer host pode precisar de sair pela rede física.
        final boolean bypassVpn = call.getBoolean("bypassVpn", false);
        if (url == null || (!bypassVpn && !isGeoBypassHost(url))) {
            call.reject("directFetch: host not in geo-bypass list");
            return;
        }
        new Thread(() -> {
            java.net.HttpURLConnection c = null;
            try {
                android.net.Network net = physicalNetwork(getContext());
                java.net.URL u = new java.net.URL(url);
                c = (java.net.HttpURLConnection) (net != null ? net.openConnection(u) : u.openConnection());
                int ct = call.getInt("connectTimeout", 15000);
                int rt = call.getInt("readTimeout", 20000);
                c.setConnectTimeout(ct); c.setReadTimeout(rt);
                c.setInstanceFollowRedirects(true);
                c.setRequestMethod(method);
                if (headers != null) {
                    java.util.Iterator<String> it = headers.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        try { c.setRequestProperty(k, headers.getString(k)); } catch (Exception ignored) {}
                    }
                }
                if (data != null && !"GET".equalsIgnoreCase(method)) {
                    byte[] bytes = String.valueOf(data).getBytes("UTF-8");
                    c.setDoOutput(true);
                    c.getOutputStream().write(bytes);
                }
                int code = c.getResponseCode();
                java.io.InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                try {
                    if (in != null) {
                        byte[] buf = new byte[16384]; int n;
                        // Tope de 8 MB: una respuesta gigante inflaba el
                        // buffer sin límite (OOM) y `in` nunca se cerraba.
                        while ((n = in.read(buf)) > 0 && bos.size() < 8 * 1024 * 1024)
                            bos.write(buf, 0, n);
                    }
                } finally {
                    try { if (in != null) in.close(); } catch (Exception ignored) {}
                }
                byte[] raw = bos.toByteArray();
                JSObject ret = new JSObject();
                ret.put("status", code);
                JSObject hh = new JSObject();
                for (java.util.Map.Entry<String, java.util.List<String>> e : c.getHeaderFields().entrySet()) {
                    if (e.getKey() != null && e.getValue() != null && !e.getValue().isEmpty())
                        hh.put(e.getKey(), e.getValue().get(0));
                }
                ret.put("headers", hh);
                ret.put("url", c.getURL().toString());
                ret.put("data", "blob".equals(responseType)
                    ? android.util.Base64.encodeToString(raw, android.util.Base64.NO_WRAP)
                    : new String(raw, java.nio.charset.StandardCharsets.UTF_8));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("directFetch: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        }, "direct-fetch").start();
    }

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
