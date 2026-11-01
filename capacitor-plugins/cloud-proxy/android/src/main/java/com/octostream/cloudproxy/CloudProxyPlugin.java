package com.octostream.cloudproxy;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Log;

import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.Executor;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Capacitor plugin that runs the Aether binary to create a local proxy
 * for Cloudflare WARP. No VpnService needed â€” the proxy runs on loopback
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
    // Forwards SSH al VPS (salida solo-debrid): 127.0.0.1:2819â†’VPS:1819
    // (SOCKS5) y 127.0.0.1:2820â†’VPS:1820 (HTTP CONNECT). Van por puertos
    // separados porque el aether local ocupa 1819/1820 â€” ambos transportes
    // conviven y el VPS (cuota limitada) solo ve trÃ¡fico debrid; fÃºtbol,
    // YouTube y servidores gratuitos salen por WARP local.
    // Puertos locales de los forwards -L: efÃ­meros (0 = aÃºn sin bind). AsÃ­ no
    // quedan proxies sin auth en puertos documentados alcanzables por otras
    // apps; las puertas estables (:2830/:2831) son las que exigen credencial.
    private static volatile int vpsSocksPort = 0;
    private static volatile int vpsHttpPort = 0;
    // Proxy directo por canales SSH "direct-tcpip": la conexion sale del VPS
    // con su IP publica SIN pasar por el aether remoto (un tunel menos).
    // Si el sshd no permite direct-tcpip se usa el forward 2820 de siempre.
    private static final int VPS_DIRECT_PORT = 2830;
    // El doble salto puede gastar hasta 180s en gool + otros 180s en mim;
    // con edge pegajoso hay ademÃ¡s un reintento de gool sin pin. Este lÃ­mite
    // debe ser mayor que el handshake completo o getStatus()/connect waiter
    // lo declaran "stale" y cancelan justamente la conexiÃ³n que estÃ¡ avanzando.
    private static final long EXIT_CONNECT_MAX_MS = 600_000L;

    private static volatile Process aetherProcess = null;
    private static volatile boolean connected = false;
    private static volatile boolean connecting = false;
    private static volatile long connectingSince = 0;
    private static volatile int statusMisses = 0;
    // Protocolo que funcionÃ³ la Ãºltima vez â€” se prueba primero en la
    // siguiente conexiÃ³n. Siempre doble salto (gool â†’ mim); si gool no
    // sostiene el tÃºnel se escala a mim automÃ¡ticamente.
    private static volatile String preferredProtocol = "gool";
    // Protocolo que corre el proceso aether actual â€” MASQUE a veces no
    // sostiene el tÃºnel bajo carga ("tunnel ended: Operation not
    // permitted" en bucle cada ~2s) mientras sus puertos locales siguen
    // aceptando: la escalada a wg del arranque nunca se disparaba porque
    // startAether ya habÃ­a "tenido Ã©xito". Tras varias muertes seguidas
    // se reinicia con el otro protocolo.
    private volatile String currentProtocol = null;
    private volatile int tunnelFailStreak = 0;
    private volatile long lastTunnelFailAt = 0;
    private volatile boolean protocolSwitching = false;
    private static volatile String lastError = null;
    // UbicaciÃ³n de salida WARP: "auto" = el colo mÃ¡s cercano (tu paÃ­s);
    // "random" = otro paÃ­s cualquiera (gool/mim: segundo salto dentro de
    // WARP â†’ Cloudflare asigna otra salida); o un cÃ³digo ISO "DE","NL"â€¦
    // verificado por aether con AETHER_EXIT_LOC (rechaza salidas que no
    // coincidan). Persistido para que reconexiones y el guardiÃ¡n usen el
    // mismo modo.
    private static final String PREFS_WARP = "octostream_warp";
    private static volatile String exitLoc = null;
    // Exit real observado tras conectar (trace a travÃ©s del propio SOCKS).
    private static volatile String sessionExitIp = "";
    private static volatile String sessionExitCountry = "";
    private static volatile String sessionExitColo = "";
    private String warpExitLoc() {
        if (exitLoc != null) return exitLoc;
        try {
            exitLoc = getContext().getSharedPreferences(PREFS_WARP, 0)
                    .getString("exit_loc", "auto");
        } catch (Throwable t) { exitLoc = "auto"; }
        return exitLoc;
    }
    private void setWarpExitLoc(String v) {
        exitLoc = (v == null || v.isEmpty()) ? "auto" : v;
        try {
            getContext().getSharedPreferences(PREFS_WARP, 0).edit()
                    .putString("exit_loc", exitLoc).apply();
        } catch (Throwable ignored) {}
    }
    // Siempre doble salto (gool â†’ mim = Cloudflareâ†’Cloudflare): la IP sale
    // enmascarada detrÃ¡s de un segundo hop WARP en todo arranque de aether,
    // no solo cuando el usuario fija ubicaciÃ³n. warpExitLoc sigue decidiendo
    // el spec de paÃ­s (AETHER_EXIT_LOC) cuando hay uno fijado.
    private boolean exitMode() { return true; }
    private String exitSpec() { return "random".equals(warpExitLoc()) ? "" : warpExitLoc(); }

    // WARP remoto: usar un proxy externo accesible en :1819/:1820 o, con
    // usuario SSH, el proxy del VPS alcanzado por port-forward. "" = local.
    private static volatile String remoteIp = null;
    // Remoto-via-SSH: si hay usuario SSH configurado, el host remoto se
    // alcanza por un tÃºnel SSH (JSch) que hace port-forward de
    // 127.0.0.1:1819/1820 al proxy loopback del VPS â€” sin Tailscale ni
    // apps extra. El host remoto es entonces la IP PÃšBLICA del VPS.
    private static volatile String remoteSshUser = null;
    private static volatile String remoteSshPass = null;
    private static volatile Integer remoteSshPort = null;
    private static volatile Session sshSession = null;
    private static volatile SshDirectProxy directProxy = null;
    // Cliente openssh nativo (binario Termux en assets): cripto en C con
    // aceleracion ARMv8 en vez de JSch (Java puro). SOCKS -D en 2831 = canales
    // direct-tcpip saliendo con la IP del VPS; el path JSch queda de respaldo.
    private static final int NATIVE_SSH_PORT = 2831;
    private static volatile Process nativeSsh = null;
    private static volatile int nativeSshPort = 0;
    private static volatile boolean nativeSshUp = false;
    private static final java.util.concurrent.atomic.AtomicBoolean nativeSshStarting =
            new java.util.concurrent.atomic.AtomicBoolean(false);
    private static volatile int nativeSshRestarts = 0;

    public static boolean isNativeSshUp() {
        Process p = nativeSsh;
        return nativeSshUp && p != null && processAlive(p) && nativeSshPort > 0;
    }
    // Solo se anuncia si el proxy directo JSch tambiÃ©n vive: unlock/descarga
    // (2830) y reproducciÃ³n (2831) comparten asÃ­ la misma salida â€” la IP
    // pÃºblica del VPS. Sin Ã©l, el forward 2820 sale por el aether remoto y
    // una URL desbloqueada ahÃ­ darÃ­a 403 al reproducirla por 2831.
    public static String getVpsSocksAddr() {
        // debrid_direct: el media también sale por la IP de casa — si solo el
        // unlock fuera directo, el mismatch IP-bound daría 403 al reproducir.
        if (debridDirect) return null;
        SshDirectProxy dp = directProxy;
        return isNativeSshUp() && dp != null && dp.isRunning()
                ? "127.0.0.1:" + nativeSshPort : null;
    }
    // true mientras el modo remoto activo es SSH (proxyHostâ†’127.0.0.1).
    private static volatile boolean sshMode = false;
    // Host key SSH pendiente de confirmaciÃ³n por el usuario (TOFU con
    // huella): la primera clave vista â€”o una que cambiaâ€” se aparca aquÃ­ y
    // la sesiÃ³n se rechaza; trustRemoteHost() la fija tras el OK explÃ­cito.
    private static volatile String pendingHostKeyHost = null;
    private static volatile String pendingHostKeyB64 = null;
    private static volatile boolean pendingHostKeyChanged = false;
    private String warpRemote() {
        if (remoteIp != null) return remoteIp;
        try {
            android.content.SharedPreferences p = getContext().getSharedPreferences(PREFS_WARP, 0);
            remoteIp = p.getString("remote", "");
            debridDirect = p.getBoolean("debrid_direct", false);
        } catch (Throwable t) { remoteIp = ""; }
        return remoteIp;
    }
    private void setWarpRemote(String v) {
        remoteIp = v == null ? "" : v.trim();
        try {
            getContext().getSharedPreferences(PREFS_WARP, 0).edit()
                    .putString("remote", remoteIp).apply();
        } catch (Throwable ignored) {}
    }
    private String sshUser() {
        if (remoteSshUser != null) return remoteSshUser;
        try {
            remoteSshUser = getContext().getSharedPreferences(PREFS_WARP, 0)
                    .getString("remote_ssh_user", "");
        } catch (Throwable t) { remoteSshUser = ""; }
        return remoteSshUser;
    }
    // --- Secreto en reposo (Android Keystore) ---
    // La clave AES-GCM vive en el AndroidKeyStore (TEE/hardware cuando el
    // dispositivo lo tiene): SharedPreferences solo guarda
    // "enc:v1:<b64(iv+ct)>" â€” el texto plano nunca toca disco. Valores
    // legacy sin prefijo se tratan como claro y se re-cifran al leerlos.
    private static final String KEYSTORE_ALIAS = "octo_ssh_secret";
    private static final String ENC_PREFIX = "enc:v1:";

    private static SecretKey secretKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry e = ks.getEntry(KEYSTORE_ALIAS, null);
        if (e instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) e).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KEYSTORE_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    private String encryptSecret(String plain) {
        if (plain == null || plain.isEmpty()) return "";
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            byte[] blob = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, blob, 0, iv.length);
            System.arraycopy(ct, 0, blob, iv.length, ct.length);
            return ENC_PREFIX + android.util.Base64.encodeToString(blob, android.util.Base64.NO_WRAP);
        } catch (Throwable t) {
            // Keystore no disponible (dispositivo raro): guardar en claro
            // antes que perder la credencial â€” el tÃºnel debe arrancar.
            Log.w(TAG, "SSH secret encrypt unavailable â€” storing legacy plaintext");
            return plain;
        }
    }

    private String decryptSecret(String stored) {
        if (stored == null || stored.isEmpty()) return "";
        if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy claro
        try {
            byte[] blob = android.util.Base64.decode(
                    stored.substring(ENC_PREFIX.length()), android.util.Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, secretKey(),
                    new GCMParameterSpec(128, Arrays.copyOfRange(blob, 0, 12)));
            return new String(c.doFinal(Arrays.copyOfRange(blob, 12, blob.length)),
                    StandardCharsets.UTF_8);
        } catch (Throwable t) {
            // Keystore invalidado (app restaurada en otro dispositivo): el
            // blob ya no descifra â€” "" fuerza a re-introducir la clave.
            Log.w(TAG, "SSH secret decrypt failed â€” credential needs re-entry");
            return "";
        }
    }

    private String sshPass() {
        if (remoteSshPass != null) return remoteSshPass;
        try {
            String stored = getContext().getSharedPreferences(PREFS_WARP, 0)
                    .getString("remote_ssh_pass", "");
            remoteSshPass = decryptSecret(stored);
            // MigraciÃ³n perezosa: el valor viejo en claro se re-cifra al
            // leerlo â€” prefs solo conserva el blob cifrado.
            if (!remoteSshPass.isEmpty() && stored != null && !stored.startsWith(ENC_PREFIX)) {
                getContext().getSharedPreferences(PREFS_WARP, 0).edit()
                        .putString("remote_ssh_pass", encryptSecret(remoteSshPass)).apply();
            }
        } catch (Throwable t) { remoteSshPass = ""; }
        return remoteSshPass;
    }
    private int sshPort() {
        if (remoteSshPort != null) return remoteSshPort;
        try {
            remoteSshPort = getContext().getSharedPreferences(PREFS_WARP, 0)
                    .getInt("remote_ssh_port", 22);
        } catch (Throwable t) { remoteSshPort = 22; }
        return remoteSshPort;
    }
    private void setSshCreds(String user, String pass, int port) {
        remoteSshUser = user == null ? "" : user.trim();
        remoteSshPass = pass == null ? "" : pass;
        remoteSshPort = port > 0 && port < 65536 ? port : 22;
        try {
            getContext().getSharedPreferences(PREFS_WARP, 0).edit()
                    .putString("remote_ssh_user", remoteSshUser)
                    .putString("remote_ssh_pass", encryptSecret(remoteSshPass))
                    .putInt("remote_ssh_port", remoteSshPort)
                    .apply();
        } catch (Throwable ignored) {}
    }
    // El remoto es SSH si hay host + usuario configurados.
    private boolean sshRemote() {
        return !warpRemote().isEmpty() && !sshUser().isEmpty();
    }
    // Host key SSH del VPS (TOFU con confirmaciÃ³n: la primera vista queda
    // pendiente hasta que el usuario acepta la huella; si luego cambia la
    // conexiÃ³n se rechaza â€” MITM visible).
    private String storedHostKey(String host) {
        try {
            return getContext().getSharedPreferences(PREFS_WARP, 0)
                    .getString("remote_ssh_hostkey_" + host, "");
        } catch (Throwable t) { return ""; }
    }
    private void saveHostKey(String host, String b64) {
        try {
            getContext().getSharedPreferences(PREFS_WARP, 0).edit()
                    .putString("remote_ssh_hostkey_" + host, b64).apply();
        } catch (Throwable ignored) {}
    }
    // Host del proxy efectivo: el remoto si hay uno configurado, localhost
    // en modo local. Los puertos son fijos (1819 SOCKS / 1820 HTTP).
    private static String proxyHost() {
        // Modo SSH: los forwards viven en loopback local.
        if (sshMode) return "127.0.0.1";
        String r = remoteIp;
        return (r == null || r.isEmpty()) ? "127.0.0.1" : r;
    }
    private static String proxyAddrHost() {
        String host = proxyHost();
        return host.indexOf(':') >= 0 ? "[" + host + "]" : host;
    }
    private static String socksAddr() { return proxyAddrHost() + ":" + SOCKS_PORT; }
    private static String httpProxyAddr() { return proxyAddrHost() + ":" + HTTP_PROXY_PORT; }

    // Exit pegajoso: el edge interior que usÃ³ el Ãºltimo gool bueno. Al
    // fijarlo con AETHER_WIW_INNER_PEER la salida vuelve al mismo colo/
    // pool â€” la IP visible se mantiene entre sesiones en vez de rotar.
    private static volatile String wiwInner = null;
    private String wiwInner() {
        if (wiwInner != null) return wiwInner;
        try {
            wiwInner = getContext().getSharedPreferences(PREFS_WARP, 0)
                    .getString("wiw_inner", "");
        } catch (Throwable t) { wiwInner = ""; }
        return wiwInner;
    }
    private void setWiwInner(String v) {
        wiwInner = v == null ? "" : v;
        try {
            getContext().getSharedPreferences(PREFS_WARP, 0).edit()
                    .putString("wiw_inner", wiwInner).apply();
        } catch (Throwable ignored) {}
    }
    // Tras un gool bueno, aether persiste "assigned_endpoint" en su
    // *gool*.toml â€” lo memorizamos para fijarlo en el prÃ³ximo arranque.
    private void learnInnerPeer() {
        try {
            File dir = getContext().getFilesDir();
            File[] files = dir.listFiles((d, n) -> n.contains("gool") && n.endsWith(".toml"));
            if (files == null) return;
            for (File f : files) {
                java.io.BufferedReader br = new java.io.BufferedReader(new java.io.FileReader(f));
                String line;
                while ((line = br.readLine()) != null) {
                    line = line.trim();
                    if (line.startsWith("assigned_endpoint")) {
                        String v = line.substring(line.indexOf('=') + 1)
                                .trim().replace("\"", "");
                        if (!v.isEmpty()) {
                            setWiwInner(v.contains(":") ? v : v + ":2408");
                            Log.i(TAG, "sticky exit: inner peer " + wiwInner());
                        }
                        break;
                    }
                }
                br.close();
            }
        } catch (Throwable t) {
            Log.w(TAG, "learnInnerPeer: " + t.getMessage());
        }
    }
    // Kill-switch estricto (ajuste del usuario): en vez de abrir la red al
    // detectar el tÃºnel caÃ­do, el proxy se queda apuntando al puerto muerto
    // y TODA peticiÃ³n falla hasta reconectar â€” cero fugas a costa de que la
    // app se quede "sin internet" esos segundos (como disconnectBackground).
    private static volatile boolean strictKill = false;
    // MÃ©tricas de sesiÃ³n para el indicador WARP de Ajustes.
    private static volatile int sessionReconnects = 0;
    private static volatile long connectedSince = 0;
    private static long connectionGeneration = 0;
    private static final Object PROCESS_LOCK = new Object();
    private static final Executor DIRECT_EXECUTOR = Runnable::run;
    private boolean antiLeakScriptInstalled = false;
    private androidx.webkit.ScriptHandler antiLeakScriptHandler = null;
    // Foreground real de la app (handleOnResume/Pause) â€” el guardiÃ¡n solo
    // se arranca con la app en background o al entrar en Ã©l.
    private volatile boolean appInForeground = true;

    @Override
    public void load() {
        // Credencial loopback por-arranque: disponible antes de que cualquier
        // proxy o cliente la necesite (java.net.socks.* ya queda sembrado).
        ProxyAuth.init();
        Log.i(TAG, "CloudProxyPlugin loaded");
    }

    /** Header Proxy-Authorization para clientes OkHttp (proxyAuthenticator). */
    public static String getProxyAuthHeader() {
        ProxyAuth.init();
        return ProxyAuth.basicHeader();
    }

    // GuardiÃ¡n FGS solo en segundo plano: el phantom process killer mata a
    // los hijos que queman CPU cuando la app estÃ¡ cacheada â€” en foreground
    // la app ya tiene prioridad y el servicio solo gastaba baterÃ­a y dejaba
    // una notificaciÃ³n permanente mientras el usuario navega.
    @Override
    protected void handleOnPause() {
        appInForeground = false;
        // En modo SSH el aether local tambiÃ©n corre (salida del trÃ¡fico
        // general) â€” solo el modo remoto plano se queda sin guardiÃ¡n.
        if ((connected || connecting) && (warpRemote().isEmpty() || sshRemote())) startAetherGuard();
        super.handleOnPause();
    }

    @Override
    protected void handleOnResume() {
        appInForeground = true;
        // En foreground el proceso de la app ya tiene prioridad â€” el
        // guardiÃ¡n solo hace falta contra el phantom kill en background.
        // Pararlo aquÃ­ quita la notificaciÃ³n permanente y el gasto de
        // baterÃ­a mientras el usuario usa la app.
        stopAetherGuard();
        super.handleOnResume();
    }

    @Override
    protected void handleOnDestroy() {
        // Capacitor can destroy/recreate its Activity for configuration
        // changes or while Android backgrounds the app. Do not tear WARP
        // down in those cases: only stop it when the Activity is actually
        // finishing (the user explicitly closed the app). Android also
        // reaps app child processes if it kills the whole process.
        android.app.Activity activity = getActivity();
        // isFinishing() miente en relanzamientos de foldables/display: la
        // instancia vieja "termina" pero la tarea sigue y la Activity se
        // recrea (matÃ¡bamos WARP al rotar/plegar). isChangingConfigurations()
        // distingue el relaunch del cierre real.
        if (activity != null && activity.isFinishing() && !activity.isChangingConfigurations()) {
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
     * No VPN permission needed â€” just runs a local SOCKS5 proxy.
     */
    @PluginMethod
    public void connect(PluginCall call) {
        Log.i(TAG, "connect() called");
        // exitLoc opcional ("auto"|"random"|"DE"|â€¦): se persiste â€” las
        // reconexiones automÃ¡ticas (JS retry, guardiÃ¡n, escalada) leen la
        // preferencia guardada, asÃ­ que solo hace falta mandarla una vez.
        String reqExit = call.getString("exitLoc");
        if (reqExit != null && !reqExit.isEmpty()) setWarpExitLoc(reqExit);

        final long generation;
        final boolean needsStop;
        // La sonda de sockets (hasta ~1s) NO puede ir dentro del lock â€”
        // bloquearÃ­a a getStatus/getHttpProxy y al propio wait-path.
        boolean fastAlive;
        synchronized (PROCESS_LOCK) {
            Session ssh = sshSession;
            // Con VPS configurado el plano SSH también debe estar vivo para el
            // fast-path — si no, un "connected" por WARP solo dejaría el VPS
            // muerto para siempre (el plano SSH nunca se reintentaba).
            fastAlive = connected && (sshRemote()
                ? sshMode && ssh != null && ssh.isConnected()
                    && aetherProcess != null && aetherProcess.isAlive()
                : warpRemote().isEmpty()
                    ? aetherProcess != null && aetherProcess.isAlive()
                    : true);
        }
        // Fast-path: no basta con que el proceso/sesiÃ³n viva â€” verifica que
        // el tÃºnel responde, si no un tÃºnel medio muerto devolverÃ­a
        // "connected" sin reconectar nada. En modo SSH ambos planos deben
        // estar arriba: el aether local (trÃ¡fico general) y el forward al
        // VPS (debrid).
        if (fastAlive && isSocksProxyUp() && isTunnelAlive()
                && (!sshMode
                    || (isSocksProxyUp("127.0.0.1", vpsSocksPort, vpsHttpPort)
                        && isTunnelAlive("127.0.0.1", vpsSocksPort)))) {
            call.resolve(new JSObject().put("status", "connected"));
            return;
        }
        synchronized (PROCESS_LOCK) {
            if (connecting) {
                // A connect is already in progress. Don't reject â€” wait for it
                // to finish so concurrent callers (e.g. App.jsx retry loop +
                // http.js blocked-request path) get the final result instead
                // of a spurious "already in progress" error.
                new Thread(() -> {
                    int waited = 0;
                    long maxWait = exitMode() ? EXIT_CONNECT_MAX_MS : 70000L;
                    while (connecting && waited < maxWait) {
                        try { Thread.sleep(500); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
                        waited += 500;
                    }
                    if (connected) {
                        call.resolve(new JSObject().put("status", "connected").put("socks", socksAddr()).put("http", httpProxyAddr()));
                    } else {
                        call.reject("WARP connection failed");
                    }
                }, "aether-connect-wait").start();
                return;
            }
            // Aether can remain alive while its tunnel is down and retrying.
            // Reconnect must stop that stale process first, otherwise a second
            // instance races for ports 1819/1820 and leaks CPU/battery.
            // IMPORTANTE: no llamar a stopAether() dentro del lock â€” hace
            // process.waitFor(5s) y bloquearÃ­a el hilo del bridge hasta 5s.
            needsStop = aetherProcess != null;
            connecting = true;
            connectingSince = System.currentTimeMillis();
            statusMisses = 0;
            lastError = null;
            generation = ++connectionGeneration;
            if (needsStop) sessionReconnects++; // reconexiÃ³n sobre sesiÃ³n viva
        }

        // GuardiÃ¡n foreground: el proceso de la app pasa a estado
        // foreground ANTES del scan de gateways â€” es ahÃ­ donde aether
        // quema CPU y el phantom killer lo liquidaba (~2s tras arrancar).
        // Solo si la app estÃ¡ en background (o se va durante el scan â€”
        // handleOnPause lo cubre por connecting=true); en foreground no
        // hace falta y solo dejaba notificaciÃ³n permanente. En modo remoto
        // no hay proceso local que proteger.
        if (!appInForeground && warpRemote().isEmpty()) startAetherGuard();

        new Thread(() -> {
            try {
                // Parar el proceso viejo fuera del lock y del hilo del bridge:
                // waitFor(5s) aquÃ­ es tolerable (hilo propio), no en el caller.
                if (needsStop && !stopAether(generation)) {
                    throw new InterruptedException("connect cancelled");
                }
                // Igual con una sesiÃ³n SSH zombi: puede seguir viva con el
                // estado marcado caÃ­do; si no se cierra antes, el nuevo
                // forward choca en 127.0.0.1:1819/1820 con EADDRINUSE.
                if (!stopSshTunnel(generation)) {
                    throw new InterruptedException("connect cancelled");
                }
                // MODO REMOTO PLANO (legacy): un proxy externo ya accesible
                // en :1819/:1820 da salida a TODO el trÃ¡fico â€” no hay
                // aether local en este modo.
                if (!warpRemote().isEmpty() && !sshRemote()) {
                    currentProtocol = "remote";
                    boolean up = false;
                    for (int i = 0; i < 30 && !up; i++) {
                        synchronized (PROCESS_LOCK) {
                            if (!connecting) throw new InterruptedException("connect cancelled");
                        }
                        up = isSocksProxyUp() && isTunnelAlive();
                        if (!up) Thread.sleep(500);
                    }
                    if (!up) {
                        throw new RuntimeException("Proxy remoto " + warpRemote() + " no responde en :1819/:1820");
                    }
                    setAppProxy(() -> {
                        synchronized (PROCESS_LOCK) {
                            if (generation != connectionGeneration) {
                                call.reject("WARP connection cancelled");
                                return;
                            }
                            connected = true;
                            connecting = false;
                            connectedSince = System.currentTimeMillis();
                        }
                        refreshExitInfo();
                        call.resolve(new JSObject()
                            .put("status", "connected")
                            .put("socks", socksAddr())
                            .put("http", httpProxyAddr()));
                    });
                    return;
                }
                // MODO SSH (VPS con cuota limitada): forwards dedicados
                // 127.0.0.1:2819/2820 â†’ proxy del VPS. Solo los los usa el
                // trÃ¡fico debrid (API AllDebrid + enlaces desbloqueados,
                // que van IP-bound a la salida que desbloqueÃ³); el resto
                // sigue por el aether local que arranca debajo en
                // 1819/1820 â€” el VPS no recibe el volumen de fÃºtbol,
                // YouTube ni servidores gratuitos.
                boolean sshPlaneUp = false;
                if (sshRemote()) {
                    try {
                        sshMode = true;
                        // Sin credenciales no insistir: una tormenta de
                        // auth-failures dispara el fail2ban del VPS.
                        File idKeyFile = new File(getContext().getFilesDir(), "ssh/id_rsa");
                        boolean keyAuth = idKeyFile.exists() && idKeyFile.length() > 0;
                        if (sshUser() == null || sshUser().isEmpty()
                                || (!keyAuth && (sshPass() == null || sshPass().isEmpty()))) {
                            throw new RuntimeException("SSH: falta usuario o contraseÃ±a â€” configÃºralos en Ajustes â†’ Red");
                        }
                        startSshTunnel(generation);
                        boolean up = false;
                        for (int i = 0; i < 30 && !up; i++) {
                            synchronized (PROCESS_LOCK) {
                                if (!connecting) throw new InterruptedException("connect cancelled");
                            }
                            up = isSocksProxyUp("127.0.0.1", vpsSocksPort, vpsHttpPort)
                                    && isTunnelAlive("127.0.0.1", vpsSocksPort);
                            if (!up) Thread.sleep(500);
                        }
                        if (!up) {
                            throw new RuntimeException("TÃºnel SSH a " + warpRemote() + " caÃ­do o proxy del VPS no responde");
                        }
                        sshPlaneUp = true;
                    } catch (InterruptedException ie) {
                        throw ie;
                    } catch (Exception e) {
                        // Plano VPS caÃ­do no tumba el plano WARP: aether
                        // arranca igual y el estado informa el error.
                        Log.e(TAG, "SSH plane failed (aether continues): " + e.getMessage());
                        lastError = "VPS: " + e.getMessage();
                        sshMode = false;
                        try { stopSshTunnel(generation); } catch (Exception ignored) {}
                    }
                }
                // Cadena siempre de doble salto Cloudflareâ†’Cloudflare:
                // gool (WireGuard dentro de WARP â€” la salida la da el salto
                // interior) â†’ mim (MASQUE dentro de MASQUE). El Ãºltimo que
                // funcione queda como preferido para la sesiÃ³n.
                // masque-h2 primero: MASQUE sobre HTTP/2 en TCP 443 con peer
                // fijado — el doble salto UDP (gool/mim) daba timeouts de
                // dataplane constantes en redes flojas. Fallback a la cadena
                // doble si el peer h2 no responde.
                String[] chain = { "masque-h2", "masque", "mim", "gool" };
                preferredProtocol = "masque-h2";
                int startIdx = 0;
                for (int i = 0; i < chain.length; i++) {
                    if (chain[i].equals(preferredProtocol)) { startIdx = i; break; }
                }
                Exception lastErr = null;
                boolean started = false;
                for (int i = 0; i < chain.length && !started; i++) {
                    String proto = chain[(startIdx + i) % chain.length];
                    boolean unpinnedRetry = false;
                    while (true) {
                        try {
                            startAether(proto, generation);
                            started = true;
                            preferredProtocol = proto;
                            break;
                } catch (Exception err) {
                    lastErr = err;
                    Log.w(TAG, "Aether " + proto + " failed (" + err.getMessage() + ") â€” trying next");
                    if (!stopAether(generation)) {
                        throw new InterruptedException("connect cancelled");
                    }
                            // Sticky exit: si el edge interior fijado muriÃ³,
                            // una segunda oportunidad sin Ã©l antes de caer
                            // al siguiente protocolo de la cadena.
                            if ("gool".equals(proto) && !unpinnedRetry && !wiwInner().isEmpty()) {
                                Log.w(TAG, "pinned inner peer dead â€” retrying gool unpinned");
                                setWiwInner("");
                                unpinnedRetry = true;
                                continue;
                            }
                            break;
                        }
                    }
                }
                // Memoria del edge interior que funcionÃ³ (salida pegajosa).
                if (started && "gool".equals(preferredProtocol)) learnInnerPeer();
                if (!started) {
                    // Plano WARP caÃ­do con VPS vivo: sesiÃ³n degradada â€”
                    // connected por el plano SSH, error visible, el proxy
                    // del sistema queda apuntando al puerto muerto
                    // (fail-closed: las peticiones fallan, nunca salen
                    // en claro por la IP fÃ­sica).
                    if (sshPlaneUp) {
                        Log.e(TAG, "Aether plane failed (SSH continues): "
                                + (lastErr != null ? lastErr.getMessage() : "?"));
                        lastError = "WARP: " + (lastErr != null ? lastErr.getMessage() : "no aether protocol worked");
                    } else {
                        throw lastErr != null ? lastErr
                                : new RuntimeException("no aether protocol worked");
                    }
                }
                Process startedProcess = aetherProcess;
                boolean cancelled;
                synchronized (PROCESS_LOCK) {
                    cancelled = generation != connectionGeneration;
                }
                if (cancelled) {
                    // Esta conexiÃ³n fue reemplazada â€” matar NUESTRO proceso
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
                        if (connected) connectedSince = System.currentTimeMillis();
                    }
                    if (connected) {
                        refreshExitInfo();
                        call.resolve(new JSObject()
                            .put("status", "connected")
                            .put("socks", socksAddr()).put("http", httpProxyAddr()));
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
                // stopAether (waitFor 5s) y clearAppProxy FUERA del lock â€”
                // retener PROCESS_LOCK segundos congela el fast-path de
                // connect() y las sondas de ExoPlayer.
                if (own) {
                    stopSshTunnel(generation);
                    stopAether(generation);
                    // Con kill-switch estricto el proxy muerto se conserva
                    // (fail-closed) â€” sin Ã©l se abre la red para no dejar
                    // la app colgada si el usuario decide seguir sin WARP.
                    if (!strictKill) clearAppProxy();
                    stopAetherGuard();
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
        final long generation;
        synchronized (PROCESS_LOCK) {
            generation = ++connectionGeneration;
            connecting = false;
            connected = false;
        }
        stopSshTunnel(generation);
        stopAether(generation);
        synchronized (PROCESS_LOCK) {
            if (generation != connectionGeneration) return;
        }
        stopAetherGuard();
        if (!keepProxy) {
            // User explicitly disconnected â†’ clear proxy (allow direct traffic)
            clearAppProxy();
        } else {
            // Background/battery-save disconnect â†’ keep proxy pointing to dead port
            // so requests FAIL instead of leaking the real IP.
            // ProxyController + System properties stay set to 127.0.0.1:1820
            // which is now dead â†’ all requests fail safely.
            Log.i(TAG, "Proxy kept (dead) to prevent IP leak during reconnect");
        }
    }

    /**
     * Disconnects from Cloudflare WARP (user-initiated).
     * Clears proxy â†’ allows direct traffic.
     */
    @PluginMethod
    public void disconnect(PluginCall call) {
        // stopAether() does process.waitFor(5s) which would block the main
        // (Capacitor plugin) thread â†’ ANR risk. Run on a background thread
        // and resolve immediately so the JS side doesn't wait.
        new Thread(() -> {
            disconnect(false);
            call.resolve(new JSObject().put("status", "disconnected"));
        }, "aether-disconnect").start();
    }

    /**
     * Background/battery-save disconnect.
     * Stops Aether but keeps proxy pointing to dead port â†’ requests fail
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
        // connecting tiene un lÃ­mite interno de ~60s (startAether; ~180s en
        // modo doble salto gool/mim); un true mÃ¡s viejo que eso es estado
        // corrupto (un connect cancelado o un hilo muerto) â€” se limpia
        // solo para que los reintentos funcionen.
        long connectStale = exitMode() ? EXIT_CONNECT_MAX_MS : 75000;
        if (connecting && System.currentTimeMillis() - connectingSince > connectStale) {
            synchronized (PROCESS_LOCK) { connecting = false; }
        }
        Session ssh = sshSession;
        boolean processAlive = sshMode
                ? ssh != null && ssh.isConnected()
                    && aetherProcess != null && aetherProcess.isAlive()
                : !warpRemote().isEmpty()
                    || (aetherProcess != null && aetherProcess.isAlive());
        // Puerto + data-plane: un aether zombi escucha en 1819/1820 con el
        // tÃºnel muerto â€” solo el handshake SOCKS real distingue ambos casos.
        boolean probeUp = connected && processAlive && isSocksProxyUp() && isTunnelAlive();
        // Un fallo transitorio de la sonda no debe tumbar la sesiÃ³n: en
        // hardware lento el socket de 500ms falla a veces y un solo miss
        // antes dejaba connected=false para siempre aunque el tÃºnel siguiera
        // vivo (overlay "Conectando WARP" permanente). Exige 3 sondeos
        // fallidos seguidos (~30s) para dar el tÃºnel por caÃ­do.
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
        // El estado reportado es el creÃ­do (con histÃ©resis), no la sonda
        // instantÃ¡nea â€” evita parpadeo del overlay ante misses sueltos.
        boolean isConnected = connected && processAlive;
        JSObject result = new JSObject();
        result.put("connected", isConnected);
        result.put("connecting", connecting);
        result.put("socks", isConnected ? socksAddr() : "");
        result.put("http", isConnected ? httpProxyAddr() : "");
        result.put("error", lastError != null ? lastError : "");
        // Para el indicador UI: transporte activo (masque/masque-h2/wg),
        // si el guardiÃ¡n foreground estÃ¡ arriba y racha de muertes del
        // tÃºnel (0 = estable; crece mientras se decide la escalada).
        result.put("protocol", currentProtocol != null ? currentProtocol : "");
        result.put("guard", AetherGuardService.isRunning());
        result.put("tunnelFails", tunnelFailStreak);
        result.put("strict", strictKill);
        result.put("reconnects", sessionReconnects);
        result.put("uptimeMs", isConnected && connectedSince > 0
                ? System.currentTimeMillis() - connectedSince : 0);
        // UbicaciÃ³n de salida: modo pedido (auto/random/ISO) + exit real
        // observado por el trace (ip paÃ­s y colo) cuando ya se midiÃ³.
        result.put("exitLoc", warpExitLoc());
        result.put("exitIp", sessionExitIp);
        result.put("exitCountry", sessionExitCountry);
        result.put("exitColo", sessionExitColo);
        // Modo remoto: proxy externo legacy o VPS por tÃºnel SSH.
        result.put("remote", warpRemote());
        result.put("ssh", sshRemote());
        // Forward SSH al VPS vivo (salida dedicada a trÃ¡fico debrid).
        result.put("vps", sshMode && ssh != null && ssh.isConnected());
        call.resolve(result);
    }

    /**
     * Devuelve el proxy HTTP CONNECT local ("127.0.0.1:1820") o null si WARP
     * no estÃ¡ conectado. A pesar del nombre legacy {@code getSocksProxy}, los
     * consumidores (ExoPlayer DataSource, OkHttp) lo usan como Proxy.Type.HTTP.
     */
    public static String getHttpProxy() {
        return connected ? httpProxyAddr() : null;
    }

    /** La direcciÃ³n del proxy efectivo (local o remoto) aunque el estado
     * estÃ© marcado caÃ­do â€” para URLs que DEBEN salir por WARP. */
    public static String getHttpProxyAddr() {
        return httpProxyAddr();
    }

    /**
     * Proxy HTTP del VPS (forward SSH 127.0.0.1:2820) para trÃ¡fico debrid.
     * Null sin sesiÃ³n SSH viva â€” el caller cae al proxy WARP normal, nunca
     * a la red fÃ­sica (un enlace desbloqueado IP-bound a la salida del VPS
     * puede fallar por WARP, pero jamÃ¡s sale en claro).
     */
    public static String getVpsHttpProxyAddr() {
        Session s = sshSession;
        if (!(sshMode && s != null && s.isConnected())) return null;
        SshDirectProxy dp = directProxy;
        if (dp != null && dp.isRunning()) return "127.0.0.1:" + VPS_DIRECT_PORT;
        return vpsHttpPort > 0 ? "127.0.0.1:" + vpsHttpPort : null;
    }

    /** A debrid URL stays bound to the VPS even while SSH reconnects. */
    public static boolean isDebridVpsConfigured() {
        return remoteIp != null && !remoteIp.isEmpty()
                && remoteSshUser != null && !remoteSshUser.isEmpty();
    }

    // Pref por dispositivo: debrid directo por la IP de casa, sin VPS/WARP.
    private static volatile boolean debridDirect = false;

    public static boolean isDebridDirect() { return debridDirect; }

    public static String getDebridHttpProxyAddr() {
        if (debridDirect) return null;
        return isDebridVpsConfigured()
                ? getVpsHttpProxyAddr() : getHttpProxyAddr();
    }

    /** Cheap routing check for debrid API calls; getStatus probes WARP TLS. */
    @PluginMethod
    public void getDebridRoute(PluginCall call) {
        boolean ssh = sshRemote();
        call.resolve(new JSObject().put("ssh", ssh)
                .put("vps", ssh && getVpsHttpProxyAddr() != null)
                .put("direct", debridDirect));
    }

    /** Binario openssh nativo (assets/ssh/<abi>): toda la cripto SSH pasa a
     *  C con aceleracion ARMv8 â€” JSch sigue gestionando sesion/hostkey y
     *  los forwards ligeros; el media debrid sale por su -D (SOCKS 2831). */
    private void ensureNativeSsh(Session s) {
        if (nativeSshUp || nativeSsh != null) return;
        if (!nativeSshStarting.compareAndSet(false, true)) return;
        new Thread(() -> {
            Process spawned = null;
            try {
                // SELinux solo permite exec() desde nativeLibraryDir: el
                // binario viaja como libssh.so en jniLibs (igual que aether).
                File bin = new File(getContext().getApplicationInfo()
                        .nativeLibraryDir, "libssh.so");
                if (!bin.exists()) {
                    Log.w(TAG, "libssh.so not bundled for this ABI");
                    return;
                }
                File dir = new File(getContext().getFilesDir(), "ssh");
                dir.mkdirs();
                // Sus deps no pueden llamarse *.so en jniLibs (los SONAMEs
                // son libcrypto.so.3, libkrb5.so.3...): assets -> filesDir +
                // LD_LIBRARY_PATH. Las que acaban en .so van en jniLibs.
                String abi = android.os.Build.SUPPORTED_ABIS[0];
                String[] libs = getContext().getAssets().list("ssh/" + abi);
                // Recopiar si cambiÃ³ la versiÃ³n de la app: unas libs viejas
                // con un ssh nuevo (o al revÃ©s) no enlazan.
                File stamp = new File(dir, ".libs-version");
                String ver = String.valueOf(getContext().getPackageManager()
                        .getPackageInfo(getContext().getPackageName(), 0).versionCode);
                boolean fresh = stamp.exists() && ver.equals(readSmallFile(stamp));
                if (libs != null) for (String l : libs) {
                    File f = new File(dir, l);
                    if (!fresh || !f.exists()) copyAsset("ssh/" + abi + "/" + l, f);
                }
                if (!fresh) {
                    try (java.io.FileOutputStream o = new java.io.FileOutputStream(stamp)) {
                        o.write(ver.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
                    }
                }
                File key = new File(dir, "id_rsa");
                if (!key.exists() && !installSshKey(s, key)) return;
                // known_hosts sembrado con la clave que JSch ya fijÃ³ (TOFU
                // confirmado por el usuario): el ssh nativo NUNCA aprende
                // una clave por su cuenta (sin ventana MITM).
                String hostKeyAlg = writeKnownHosts(new File(dir, "known_hosts"));
                if (hostKeyAlg == null) {
                    Log.w(TAG, "native ssh skipped: host key not pinned yet");
                    return;
                }
                // El -D escucha en un puerto efímero y sin auth; el único
                // punto de entrada es SocksAuthProxy (:2831), que exige la
                // credencial por-arranque (RFC 1929) y encamina aquí.
                int dPort;
                try (java.net.ServerSocket free = new java.net.ServerSocket(
                        0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
                    dPort = free.getLocalPort();
                }
                ProcessBuilder pb = new ProcessBuilder(bin.getAbsolutePath(),
                        "-i", key.getAbsolutePath(), "-N",
                        "-o", "BatchMode=yes",
                        "-o", "IdentitiesOnly=yes",
                        "-o", "StrictHostKeyChecking=yes",
                        "-o", "HostKeyAlgorithms=" + hostKeyAlg,
                        "-o", "UserKnownHostsFile=" + new File(dir, "known_hosts").getAbsolutePath(),
                        "-o", "ExitOnForwardFailure=yes",
                        "-o", "ConnectTimeout=10",
                        "-o", "Compression=no",
                        "-o", "ServerAliveInterval=30",
                        "-D", "127.0.0.1:" + dPort,
                        "-p", String.valueOf(sshPort()), sshUser() + "@" + warpRemote());
                pb.environment().put("LD_LIBRARY_PATH", dir.getAbsolutePath()
                        + ":" + getContext().getApplicationInfo().nativeLibraryDir);
                pb.environment().put("HOME", dir.getAbsolutePath());
                pb.redirectErrorStream(true);
                spawned = pb.start();
                nativeSsh = spawned;
                final Process proc = spawned;
                // Drenar la salida (un pipe lleno bloquearÃ­a al ssh) sin
                // volcarla a logcat: puede nombrar host/usuario.
                Thread drain = new Thread(() -> {
                    try (InputStream in = proc.getInputStream()) {
                        byte[] sink = new byte[1024];
                        while (in.read(sink) >= 0) { /* descartar */ }
                    } catch (Exception ignored) {}
                }, "native-ssh-drain");
                drain.setDaemon(true);
                drain.start();
                for (int i = 0; i < 40; i++) {
                    if (!processAlive(proc)) {
                        Log.w(TAG, "native ssh exited early (code " + proc.exitValue() + "), JSch path kept");
                        if (nativeSsh == proc) nativeSsh = null;
                        return;
                    }
                    try (java.net.Socket test = new java.net.Socket()) {
                        test.connect(new java.net.InetSocketAddress("127.0.0.1", dPort), 200);
                        nativeSshPort = dPort;
                        nativeSshUp = true;
                        Log.i(TAG, "native openssh -D up (ephemeral :" + dPort
                                + "): debrid exits VPS IP (C crypto)");
                        spawned = null;
                        watchNativeSsh(proc, s);
                        return;
                    } catch (Exception e) { Thread.sleep(300); }
                }
                Log.w(TAG, "native ssh did not open its SOCKS port in time, JSch path kept");
            } catch (Exception e) {
                Log.w(TAG, "native ssh unavailable, JSch path kept: " + e.getMessage());
            } finally {
                if (spawned != null) {
                    spawned.destroyForcibly();
                    if (nativeSsh == spawned) { nativeSsh = null; nativeSshUp = false; }
                }
                nativeSshStarting.set(false);
            }
        }, "native-ssh").start();
    }

    /** Si el ssh nativo muere (red, VPS reiniciado) deja de anunciarse su
     *  SOCKS â€” el media cae al forward JSch, nunca a un puerto muerto â€” y se
     *  relanza unas pocas veces mientras la sesiÃ³n JSch siga viva. */
    private void watchNativeSsh(Process proc, Session s) {
        Thread t = new Thread(() -> {
            try { proc.waitFor(); } catch (InterruptedException ie) { return; }
            if (nativeSsh != proc) return;
            nativeSsh = null;
            nativeSshUp = false;
            nativeSshPort = 0;
            Log.w(TAG, "native ssh exited (code " + proc.exitValue() + ")");
            if (sshSession == s && s.isConnected() && nativeSshRestarts++ < 5) {
                try { Thread.sleep(3000); } catch (InterruptedException ie) { return; }
                if (sshSession == s && s.isConnected()) ensureNativeSsh(s);
            }
        }, "native-ssh-watch");
        t.setDaemon(true);
        t.start();
    }

    /** Escribe known_hosts con la clave de host ya confirmada por el usuario
     *  (la misma que usa JSch). Devuelve su algoritmo, o null si no hay. */
    private String writeKnownHosts(File kh) {
        try {
            String host = warpRemote();
            String b64 = storedHostKey(host);
            if (b64 == null || b64.isEmpty()) return null;
            byte[] blob = android.util.Base64.decode(b64, android.util.Base64.NO_WRAP);
            if (blob.length < 8) return null;
            int len = ((blob[0] & 0xff) << 24) | ((blob[1] & 0xff) << 16)
                    | ((blob[2] & 0xff) << 8) | (blob[3] & 0xff);
            if (len <= 0 || len > blob.length - 4) return null;
            String type = new String(blob, 4, len, java.nio.charset.StandardCharsets.US_ASCII);
            String field = sshPort() == 22 ? host : "[" + host + "]:" + sshPort();
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(kh, false)) {
                out.write((field + " " + type + " " + b64 + "\n")
                        .getBytes(java.nio.charset.StandardCharsets.US_ASCII));
            }
            return type;
        } catch (Exception e) {
            return null;
        }
    }

    private static String readSmallFile(File f) {
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            byte[] b = new byte[64];
            int n = in.read(b);
            return n > 0 ? new String(b, 0, n, java.nio.charset.StandardCharsets.US_ASCII).trim() : "";
        } catch (Exception e) {
            return "";
        }
    }

    // Process.isAlive() es API 26; minSdk es 24.
    private static boolean processAlive(Process p) {
        try { p.exitValue(); return false; }
        catch (IllegalThreadStateException running) { return true; }
    }

    private static void stopNativeSsh() {
        Process p = nativeSsh;
        nativeSsh = null;
        nativeSshUp = false;
        nativeSshPort = 0;
        if (p != null) p.destroyForcibly();
    }

    private void copyAsset(String name, File dst) throws java.io.IOException {
        try (java.io.InputStream in = getContext().getAssets().open(name);
             java.io.FileOutputStream out = new java.io.FileOutputStream(dst)) {
            byte[] buf = new byte[65536]; int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }
    /** Genera un par RSA local y publica la pub en authorized_keys del VPS
     *  por la sesion JSch ya autenticada. Una sola vez por dispositivo. */
    private boolean installSshKey(Session s, File key) {
        try {
            com.jcraft.jsch.KeyPair kp = com.jcraft.jsch.KeyPair.genKeyPair(
                    new com.jcraft.jsch.JSch(), com.jcraft.jsch.KeyPair.RSA, 3072);
            kp.writePrivateKey(key.getAbsolutePath());
            key.setReadable(true, true);
            String b64 = android.util.Base64.encodeToString(
                    kp.getPublicKeyBlob(), android.util.Base64.NO_WRAP);
            String line = "ssh-rsa " + b64 + " octostream-native";
            com.jcraft.jsch.ChannelExec ch =
                    (com.jcraft.jsch.ChannelExec) s.openChannel("exec");
            ch.setCommand("mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && " +
                    "(grep -qF '" + b64 + "' ~/.ssh/authorized_keys || " +
                    "echo '" + line + "' >> ~/.ssh/authorized_keys) && " +
                    "chmod 600 ~/.ssh/authorized_keys");
            ch.connect(8000);
            long deadline = System.currentTimeMillis() + 8000;
            while (!ch.isClosed() && System.currentTimeMillis() < deadline) Thread.sleep(100);
            ch.disconnect();
            Log.i(TAG, "native ssh pubkey installed on VPS");
            return true;
        } catch (Exception e) {
            Log.w(TAG, "installSshKey failed: " + e.getMessage());
            key.delete();
            return false;
        }
    }

    /** Sonda end-to-end del forward SSH al VPS (SOCKS+TLS real), paralela
     *  a {@link #isLocalProxyUp()} pero sobre los puertos dedicados. */
    public static boolean isVpsProxyUp() {
        Session s = sshSession;
        if (!(sshMode && s != null && s.isConnected())) return false;
        SshDirectProxy dp = directProxy;
        int httpPort = (dp != null && dp.isRunning()) ? VPS_DIRECT_PORT : vpsHttpPort;
        try (java.net.Socket sock = new java.net.Socket()) {
            sock.connect(new java.net.InetSocketAddress("127.0.0.1", httpPort), 400);
        } catch (Exception e) {
            return false;
        }
        return isTunnelAlive("127.0.0.1", vpsSocksPort);
    }

    /**
     * Sonda barata del puerto HTTP CONNECT local (400ms). La usa ExoPlayer
     * antes de rutar un stream por WARP: 'connected' tiene histÃ©resis (~30s)
     * y un tÃºnel muerto harÃ­a colgar y fallar cada servidor hasta reiniciar.
     */
    public static boolean isLocalProxyUp() {
        // Un TCP connect a loopback de 400ms puede fallar aunque el proxy
        // siga vivo si aether tiene la cola de accept saturada (tÃºnel
        // reconectando con CONNECTs pendientes). Un reintento corto separa
        // "muerto de verdad" (connection refused, instantÃ¡neo) de un
        // momento de saturaciÃ³n â€” antes un solo timeout marcaba todo el
        // estado WARP caÃ­do hasta reabrir la app.
        for (int attempt = 0; attempt < 2; attempt++) {
            try (java.net.Socket s = new java.net.Socket()) {
                s.connect(new java.net.InetSocketAddress(proxyHost(), HTTP_PROXY_PORT),
                        proxyHost().equals("127.0.0.1") ? 400 : 1500);
                // Puerto arriba no basta: tÃºnel zombi (acepta CONNECT que
                // nunca salen). El handshake SOCKS e2e es la prueba real â€”
                // un stream enrutado a un tÃºnel muerto colgaba ~15s.
                return isTunnelAlive();
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

    /**
     * Sonda end-to-end del data-plane: handshake SOCKS5 REAL a travÃ©s de
     * aether hacia cloudflare.com:443 (DNS remoto en el extremo WARP â€” sin
     * fuga DNS local). Los puertos locales de un aether zombi siguen
     * aceptando conexiones con el tÃºnel muerto; solo una conexiÃ³n que
     * atraviesa el tÃºnel prueba que sigue vivo. Es el port del
     * isAetherTunnelAlive() de electron/main.cjs â€” hasta ahora Android
     * solo miraba puertos y un tÃºnel colgado se reportaba "connected".
     */
    public static boolean isTunnelAlive() {
        return isTunnelAlive(proxyHost(), SOCKS_PORT);
    }

    /** Variante por host/puerto: sonda tambiÃ©n los forwards SSH del VPS
     *  (127.0.0.1:2819) sin tocar el plano del trÃ¡fico general. */
    public static boolean isTunnelAlive(String proxyAddr, int proxyPort) {
        java.net.Socket s = null;
        javax.net.ssl.SSLSocket tls = null;
        try {
            s = new java.net.Socket();
            s.connect(new java.net.InetSocketAddress(proxyAddr, proxyPort), 1200);
            s.setSoTimeout(1800);
            java.io.OutputStream out = s.getOutputStream();
            java.io.InputStream in = s.getInputStream();
            // SOCKS5 greeting: versiÃ³n 5, 1 mÃ©todo, sin auth.
            out.write(new byte[] { 0x05, 0x01, 0x00 });
            out.flush();
            if (in.read() != 0x05 || in.read() != 0x00) return false;
            // CONNECT cloudflare.com:443 â€” ATYP dominio (0x03).
            byte[] host = "cloudflare.com".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
            java.io.ByteArrayOutputStream req = new java.io.ByteArrayOutputStream();
            req.write(new byte[] { 0x05, 0x01, 0x00, 0x03, (byte) host.length });
            req.write(host);
            req.write(new byte[] { 0x01, (byte) 0xBB });
            out.write(req.toByteArray());
            out.flush();
            // Respuesta: VER REP RSV ATYP BND.ADDR BND.PORT â€” REP 0x00 = Ã©xito.
            if (in.read() != 0x05) return false;
            int rep = in.read();
            if (in.read() < 0) return false; // RSV
            int atyp = in.read();
            int skip = atyp == 0x01 ? 4
                    : atyp == 0x03 ? (in.read() & 0xff)
                    : atyp == 0x04 ? 16 : -1;
            if (skip < 0) return false;
            for (int i = 0; i < skip + 2; i++) {
                if (in.read() < 0) return false;
            }
            if (rep != 0x00) return false;

            // A successful SOCKS CONNECT alone can be returned before the
            // upstream tunnel is actually passing data. Complete TLS and read
            // the HTTP status line so zombie listeners do not report healthy.
            tls = (javax.net.ssl.SSLSocket)
                    ((javax.net.ssl.SSLSocketFactory) javax.net.ssl.SSLSocketFactory.getDefault())
                            .createSocket(s, "cloudflare.com", 443, true);
            tls.setSoTimeout(3500);
            javax.net.ssl.SSLParameters sslParams = tls.getSSLParameters();
            sslParams.setEndpointIdentificationAlgorithm("HTTPS");
            tls.setSSLParameters(sslParams);
            tls.startHandshake();
            tls.getOutputStream().write(
                    ("GET /cdn-cgi/trace HTTP/1.1\r\n"
                    + "Host: cloudflare.com\r\n"
                    + "Connection: close\r\n\r\n")
                    .getBytes(java.nio.charset.StandardCharsets.US_ASCII));
            String status = new java.io.BufferedReader(new java.io.InputStreamReader(
                    tls.getInputStream(), java.nio.charset.StandardCharsets.US_ASCII)).readLine();
            if (status == null || !status.matches("HTTP/\\d(?:\\.\\d)? [23]\\d\\d(?: .*)?")) {
                return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            try { if (tls != null) tls.close(); } catch (Exception ignored) {}
            try { if (s != null) s.close(); } catch (Exception ignored) {}
        }
    }

    /** Activa/desactiva el kill-switch estricto (fail-closed total). */
    @PluginMethod
    public void setStrictMode(PluginCall call) {
        strictKill = call.getBoolean("enabled", false);
        Log.i(TAG, "strict kill-switch: " + strictKill);
        call.resolve(new JSObject().put("enabled", strictKill));
    }

    /**
     * Host del proxy remoto/VPS a usar en vez del aether local
     * ("" = modo local). Se aplica en el prÃ³ximo connect() â€” el caller debe
     * reconectar si hay tÃºnel vivo.
     */
    @PluginMethod
    public void setRemoteHost(PluginCall call) {
        String raw = call.getString("host", "");
        int embeddedPort = remotePortFromRaw(raw);
        String host = normalizeRemoteHost(raw);
        if (!host.isEmpty() && !isValidRemoteHost(host)) {
            call.reject("host invÃ¡lido â€” usa la IP o dominio del VPS");
            return;
        }
        setWarpRemote(host);
        // "host:2222" / "ssh://user@host:2222" tambiÃ©n fija el puerto SSH;
        // el puerto del proxy remoto sigue siendo el estÃ¡ndar 1819/1820.
        if (embeddedPort > 0) setSshCreds(sshUser(), sshPass(), embeddedPort);
        Log.i(TAG, "remote WARP host: " + (host.isEmpty() ? "(local)" : host));
        call.resolve(new JSObject().put("remote", warpRemote()));
    }

    private static int remotePortFromRaw(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return -1;
        try {
            if (s.contains("://")) {
                int p = new URI(s).getPort();
                return p > 0 && p < 65536 ? p : -1;
            }
            int at = s.lastIndexOf('@');
            if (at >= 0) s = s.substring(at + 1);
            int cut = s.length();
            for (char c : new char[] { '/', '?', '#' }) {
                int i = s.indexOf(c);
                if (i >= 0 && i < cut) cut = i;
            }
            s = s.substring(0, cut);
            if (s.startsWith("[")) {
                int end = s.indexOf(']');
                if (end < 0 || end + 1 >= s.length() || s.charAt(end + 1) != ':') return -1;
                s = s.substring(end + 2);
            } else {
                int colon = s.lastIndexOf(':');
                if (colon <= 0 || colon != s.indexOf(':')) return -1;
                s = s.substring(colon + 1);
            }
            int p = Integer.parseInt(s);
            return p > 0 && p < 65536 ? p : -1;
        } catch (Exception e) {
            return -1;
        }
    }

    /** Tolera valores copiados tipo URL, user@host o host:puerto. */
    private static String normalizeRemoteHost(String raw) {
        String host = raw == null ? "" : raw.trim();
        if (host.isEmpty()) return "";
        if (host.contains("://")) {
            try {
                URI uri = new URI(host);
                if (uri.getHost() != null) host = uri.getHost();
            } catch (Exception ignored) {}
        }
        int at = host.lastIndexOf('@');
        if (at >= 0) host = host.substring(at + 1);
        int cut = host.length();
        for (char c : new char[] { '/', '?', '#' }) {
            int i = host.indexOf(c);
            if (i >= 0 && i < cut) cut = i;
        }
        host = host.substring(0, cut).trim();
        if (host.startsWith("[")) {
            int end = host.indexOf(']');
            if (end > 1) host = host.substring(1, end);
        } else {
            int colon = host.indexOf(':');
            if (colon > 0 && colon == host.lastIndexOf(':')
                    && host.substring(colon + 1).matches("\\d{1,5}")) {
                host = host.substring(0, colon);
            }
        }
        return host.endsWith(".") ? host.substring(0, host.length() - 1) : host;
    }

    private static boolean isValidRemoteHost(String host) {
        if (host.length() > 253) return false;
        if (host.indexOf(':') >= 0) {
            try { return InetAddress.getByName(host) instanceof Inet6Address; }
            catch (Exception e) { return false; }
        }
        if (host.matches("(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)")) {
            return true;
        }
        for (String label : host.split("\\.", -1)) {
            if (!label.matches("[A-Za-z0-9](?:[A-Za-z0-9\\-]{0,61}[A-Za-z0-9])?")) return false;
        }
        return true;
    }

    /**
     * Credenciales SSH del remoto: con usuario+clave el modo remoto abre un
     * tÃºnel SSH al VPS (port-forward loopback al proxy) en vez de esperar
     * un proxy plano en la LAN. user "" = remoto plano (LAN).
     * La clave NO se loguea.
     */
    @PluginMethod
    public void setRemoteSsh(PluginCall call) {
        String user = call.getString("user", "");
        user = user == null ? "" : user.trim();
        String pass = call.getString("pass", "");
        int port = call.getInt("port", 22);
        if (!user.isEmpty() && !user.matches("[0-9a-zA-Z._\\-]{1,32}")) {
            call.reject("usuario invÃ¡lido");
            return;
        }
        if (port <= 0 || port > 65535) port = 22;
        setSshCreds(user, pass == null ? "" : pass, port);
        // Cambio de host/usuario â†’ olvidar la host key vieja es peligroso
        // (la invalidarÃ­a un MITM); se conserva hasta que el usuario la
        // resetee cambiando el host.
        Log.i(TAG, "remote SSH: " + (user.isEmpty() ? "(desactivado)" : user + "@:" + port));
        call.resolve(new JSObject().put("ssh", !user.isEmpty()));
    }

    /**
     * Credenciales SSH guardadas del remoto. La clave sale descifrada del
     * blob cifrado con Android Keystore â€” solo la propia app la lee (para
     * repintar el formulario de Ajustes sin localStorage).
     */
    @PluginMethod
    public void getRemoteSsh(PluginCall call) {
        call.resolve(new JSObject()
                .put("user", sshUser())
                .put("pass", sshPass())
                .put("port", sshPort()));
    }

    /**
     * Confirma la host key SSH pendiente para el remoto actual (TOFU):
     * la fija en prefs y devuelve su huella. Rechaza si no hay pendiente
     * para ese host â€” nunca fija una clave distinta de la que el usuario
     * vio en el diÃ¡logo de confirmaciÃ³n.
     */
    @PluginMethod
    public void trustRemoteHost(PluginCall call) {
        String host = warpRemote();
        String b64;
        synchronized (PROCESS_LOCK) {
            if (pendingHostKeyHost == null || !pendingHostKeyHost.equals(host)
                    || pendingHostKeyB64 == null) {
                call.reject("no hay clave de host pendiente de confirmaciÃ³n");
                return;
            }
            b64 = pendingHostKeyB64;
            pendingHostKeyHost = null;
            pendingHostKeyB64 = null;
            pendingHostKeyChanged = false;
        }
        saveHostKey(host, b64);
        Log.i(TAG, "SSH host key pinned by user for " + host);
        call.resolve(new JSObject().put("trusted", true).put("fingerprint", keyFingerprint(b64)));
    }

    /**
     * Host key SSH aparcada a la espera de confirmaciÃ³n del usuario, si
     * existe. El auto-connect rechaza con SSH_HOST_KEY_* sin UI â€” este
     * mÃ©todo permite a Ajustes mostrar el diÃ¡logo de aceptaciÃ³n cuando
     * el usuario acude a "confirmar la huella" desde cualquier aviso.
     */
    @PluginMethod
    public void getPendingHostKey(PluginCall call) {
        JSObject r = new JSObject();
        synchronized (PROCESS_LOCK) {
            if (pendingHostKeyHost != null && pendingHostKeyB64 != null) {
                r.put("host", pendingHostKeyHost);
                r.put("fingerprint", keyFingerprint(pendingHostKeyB64));
                r.put("changed", pendingHostKeyChanged);
            }
        }
        call.resolve(r);
    }

    /** Marca la sesiÃ³n como caÃ­da desde fuera (sonda del puerto fallÃ³). */
    public static void markDisconnected() {
        synchronized (PROCESS_LOCK) {
            connected = false;
            statusMisses = 0;
        }
        if (strictKill) {
            // Fail-closed: el proxy sigue apuntando al puerto muerto â€” las
            // peticiones FALLAN en vez de salir por la IP real hasta que
            // el tÃºnel reconecte.
            Log.i(TAG, "markDisconnected: kill-switch estricto â€” proxy muerto conservado");
            return;
        }
        // CRÃTICO: tambiÃ©n limpiar el proxy del sistema. Si solo se cambia el
        // flag, http.proxyHost sigue apuntando al listener muerto y TODA la
        // red "directa" (DefaultHttpDataSource del stream, CapacitorHttp) va
        // igualmente al puerto muerto â€” bytes truncados que se manifestaban
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

    /** @deprecated usar {@link #getHttpProxy()} â€” nunca devolviÃ³ el puerto SOCKS. */
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
        System.setProperty("http.proxyHost", proxyHost());
        System.setProperty("http.proxyPort", String.valueOf(HTTP_PROXY_PORT));
        System.setProperty("https.proxyHost", proxyHost());
        System.setProperty("https.proxyPort", String.valueOf(HTTP_PROXY_PORT));
        // Don't proxy localhost/127.0.0.1 (app assets, Capacitor bridge) ni la
        // LAN privada: el escaneo/envÃ­o a otros OctoStream (192.168.x.x, 10.x.x.x,
        // 172.16-31.x.x, link-local 169.254.x.x) debe ir directo o darÃ­a timeout.
        String directHosts = "localhost|127.0.0.1|*.local"
                + "|192.168.*|10.*|169.254.*"
                + "|172.16.*|172.17.*|172.18.*|172.19.*|172.20.*|172.21.*|172.22.*|172.23.*"
                + "|172.24.*|172.25.*|172.26.*|172.27.*|172.28.*|172.29.*|172.30.*|172.31.*";
        System.setProperty("http.nonProxyHosts", directHosts);
        System.setProperty("https.nonProxyHosts", directHosts);
        Log.i(TAG, "System proxy set: " + httpProxyAddr());

        // 2. WebView proxy via ProxyController (API 29+)
        // This routes fetch/XHR/img requests through the WARP HTTP proxy
        // Must run on a thread with a Looper (main thread)
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            try {
                if (androidx.webkit.WebViewFeature.isFeatureSupported(
                        androidx.webkit.WebViewFeature.PROXY_OVERRIDE)) {
                    ProxyConfig proxyConfig = new ProxyConfig.Builder()
                        .addProxyRule(proxyAddrHost() + ":" + HTTP_PROXY_PORT)
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
                        .build();
                    ProxyController.getInstance().setProxyOverride(proxyConfig, DIRECT_EXECUTOR, () -> {
                        Log.i(TAG, "WebView proxy set: " + httpProxyAddr());
                    });
                } else {
                    lastError = "WebView proxy override is not supported on this device";
                    Log.e(TAG, lastError);
                    // waitFor(5s) en main thread = ANR â€” teardown en background.
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
     * para que ningÃºn documento (incluidos embeds de terceros) pueda revelar
     * la IP real vÃ­a STUN/TURN mientras WARP estÃ¡ activo.
     * Expuesto como static para que otros plugins (ExoPlayer: embed/relay
     * WebViews) apliquen la misma protecciÃ³n a sus WebViews auxiliares.
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
     * {@code documentStart}=true lo inyecta tambiÃ©n al inicio de cada documento
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
            // documento â€” si no se retira, el ScriptHandler sigue deshabilitando
            // WebRTC en TODAS las navegaciones futuras aunque WARP estÃ© apagado
            // (rompÃ­a embeds con WebRTC hasta reiniciar la app).
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
    private void startAether(String protocol, long generation) throws Exception {
        synchronized (PROCESS_LOCK) {
            if (!connecting || generation != connectionGeneration) {
                throw new InterruptedException("connect cancelled");
            }
        }
        // Orphan cleanup: a previous libaether process can outlive the app
        // (Android doesn't always reap children on process death) and keep
        // ports 1819/1820 bound â€” every subsequent connect() would then time
        // out forever. killall works without root for same-uid processes.
        if (aetherProcess == null && isSocksProxyUp()) {
            Log.w(TAG, "Stale Aether holding proxy ports â€” killing orphan");
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
        // "masque-h2" = MASQUE sobre HTTP/2 (TCP 443): parece HTTPS normal y
        // sobrevive a redes que bloquean o ahogan UDP/QUIC. El protocolo que
        // recibe el binario sigue siendo "masque".
        boolean isH2 = "masque-h2".equals(protocol);
        boolean isMasque = isH2 || "masque".equals(protocol);
        // Doble salto (IP del primer paÃ­s del usuario enmascarada detrÃ¡s de
        // otra salida Cloudflare): gool = WireGuard-en-WARP, mim =
        // MASQUE-en-MASQUE. El binario los resuelve como protocolos propios.
        boolean isExitChain = "gool".equals(protocol) || "mim".equals(protocol);
        env.put("AETHER_PROTOCOL", isH2 ? "masque" : protocol);
        if (isExitChain) {
            String spec = exitSpec();
            // Con paÃ­s fijado, aether valida el exit contra cdn-cgi/trace y
            // rechaza/reintenta salidas que no coincidan (DE, DE,NL, !ES).
            if (!spec.isEmpty()) env.put("AETHER_EXIT_LOC", spec);
            // Exit pegajoso: reutilizar el edge interior que funcionÃ³ la
            // Ãºltima vez â†’ mismo colo/pool de salida entre sesiones.
            String inner = wiwInner();
            if (!inner.isEmpty()) env.put("AETHER_WIW_INNER_PEER", inner);
            sessionExitCountry = "";
            sessionExitIp = "";
            sessionExitColo = "";
        }
        // ironclad: full tunnel + real HTTP request per candidate (most secure scan)
        env.put("AETHER_SCAN", "ironclad");
        env.put("AETHER_IP", "v4");
        // aggressive: pads/reshapes handshake to defeat fingerprinting
        env.put("AETHER_NOIZE", "aggressive");
        // Reduce log level to warn (less CPU on log processing)
        env.put("AETHER_LOG_LEVEL", "warn");
        // Solo loopback: ningÃºn tÃºnel local se expone a la LAN.
        env.put("AETHER_SOCKS", SOCKS_ADDR);
        env.put("AETHER_CONFIG", new File(getContext().getFilesDir(), "aether.toml").getAbsolutePath());
        env.put("TMPDIR", getContext().getCacheDir().getAbsolutePath());
        // Quick reconnect to reuse last known good endpoint
        env.put("AETHER_QUICK_RECONNECT", "1");
        if (isH2) {
            // Transporte HTTP/2 sobre TCP con peer fijado (sin scan).
            env.put("AETHER_MASQUE_HTTP2", "1");
            env.put("AETHER_MASQUE_H2_PEER", "162.159.198.1:443");
        } else if (isMasque) {
            // Endpoint MASQUE fijado para saltarse el scan de 120s â€” solo vale
            // para QUIC/443; en WG los endpoints son otros puertos (908â€¦).
            env.put("AETHER_PEER", "162.159.198.1:443");
            // Enable QUIC v2 opener (helps on networks that block QUIC v1)
            env.put("AETHER_QUIC_V2", "1");
        }
        // Also start HTTP CONNECT proxy (better for OkHttp - does remote DNS)
        env.put("AETHER_HTTP_PROXY", HTTP_PROXY_ADDR);
        // Route sniff: read SNI from first bytes for smarter routing
        env.put("AETHER_ROUTE_SNIFF", "1");

        currentProtocol = protocol;
        tunnelFailStreak = 0;
        final Process spawned = builder.start();
        Log.i(TAG, "Aether process started");

        // Registrar el proceso y comprobar cancelaciÃ³n ATÃ“MICAMENTE: si
        // disconnect() corre entre el builder.start() y la asignaciÃ³n, su
        // stopAether() ya leyÃ³ aetherProcess (viejo/nulo) y NADIE matarÃ­a al
        // proceso reciÃ©n creado â†’ aether huÃ©rfano con los puertos ocupados
        // y el tÃºnel vivo aunque la app crea que WARP estÃ¡ apagado.
        synchronized (PROCESS_LOCK) {
            if (!connecting || generation != connectionGeneration) {
                spawned.destroy();
                throw new InterruptedException("connect cancelled");
            }
            aetherProcess = spawned;
        }

        // Read logs in a background thread. OJO: capturar el proceso local,
        // no el campo â€” si un connect posterior lo reemplaza, este hilo debe
        // seguir drenando ESTE proceso; si nadie drena su stdout el pipe de
        // 64KB se llena y el hijo se congela escribiendo (zombie colgado).
        new Thread(() -> readAetherLogs(spawned), "aether-logs").start();

        // CÃ³digo de salida al morir: 137=SIGKILL (phantom killer de Android
        // mata los hijos que queman CPU con la app en segundo plano),
        // 143=SIGTERM (nuestro destroy), 0/otro = saliÃ³ solo. El phantom
        // kill es invisible en logcat si no â€” el proceso desaparece sin
        // log y sin tombstone.
        new Thread(() -> {
            try {
                int code = spawned.waitFor();
                Log.w(TAG, "Aether process exited, code=" + code);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            }
        }, "aether-exit-watch").start();

        // Wait for the SOCKS5 proxy to come up. MASQUE va rÃ¡pido cuando su
        // peer fijado valida (~5-10s); si en ~35s no hay proxies el protocolo
        // estÃ¡ filtrado y no merece quemar los 120s del scan â€” se corta y el
        // caller cae al otro protocolo. WG recibe mÃ¡s margen porque escanea
        // endpoints propios (~10s tÃ­pico, hasta ~60s). gool/mim = dos
        // provisiones + scan exterior + dial interior (~2-3min la primera
        // vez; el quick-reconnect reutiliza peers conocidos las siguientes).
        int attempts = 0;
        int maxAttempts = isExitChain ? 360 : (isMasque ? 70 : 120); // 180s exit / 35s masque / 60s wg
        while (!isSocksProxyUp() && attempts < maxAttempts) {
            synchronized (PROCESS_LOCK) {
                if (!connecting || generation != connectionGeneration) {
                    throw new InterruptedException("connect cancelled");
                }
            }
            Process p = aetherProcess;
            if (p == null || !p.isAlive()) break;
            Thread.sleep(500);
            attempts++;
        }

        if (!isSocksProxyUp()) {
            throw new RuntimeException("Aether proxy not responding (SOCKS " + socksAddr() + " or HTTP " + httpProxyAddr() + ") after " + (attempts * 0.5) + "s");
        }
        // Puerto arriba no basta: algunos arranques exponen los listeners
        // antes de que el data-plane responda. Esperar un handshake SOCKS
        // e2e evita marcar "connected" sobre un tÃºnel zombi.
        for (int i = 0; i < 30 && !isTunnelAlive(); i++) {
            synchronized (PROCESS_LOCK) {
                if (!connecting || generation != connectionGeneration) {
                    throw new InterruptedException("connect cancelled");
                }
            }
            Process p = aetherProcess;
            if (p == null || !p.isAlive()) break;
            Thread.sleep(500);
        }
        if (!isTunnelAlive()) {
            throw new RuntimeException("Aether tunnel not passing traffic through SOCKS " + socksAddr());
        }
        Log.i(TAG, "Aether proxies up: SOCKS " + socksAddr() + ", HTTP " + httpProxyAddr());
    }

    /**
     * Consulta la IP de salida A TRAVÃ‰S del propio SOCKS5 del tÃºnel y la
     * cachea para getStatus. En modo SSH se usa un endpoint IPv4 para que
     * la UI muestre la IPv4 pÃºblica del VPS en vez de una salida IPv6.
     */
    private void refreshExitInfo() {
        new Thread(() -> {
            java.net.HttpURLConnection c = null;
            try {
                Session sshSess = sshSession;
                boolean ssh = sshMode && sshSess != null && sshSess.isConnected();
                // Con VPS activo la salida reportada es la del forward SSH
                // (2819) â€” la IP que verÃ¡n los servicios debrid. El trÃ¡fico
                // general sigue saliendo por el aether local (1819).
                java.net.Proxy p = new java.net.Proxy(java.net.Proxy.Type.SOCKS,
                        new java.net.InetSocketAddress("127.0.0.1",
                                ssh ? vpsSocksPort : SOCKS_PORT));
                String traceUrl = ssh
                        ? "https://api.ipify.org?format=text"
                        : "https://cloudflare.com/cdn-cgi/trace";
                c = (java.net.HttpURLConnection)
                        new java.net.URL(traceUrl).openConnection(p);
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                java.io.InputStream in = c.getInputStream();
                byte[] buf = new byte[8192];
                int n = in.read(buf);
                String body = n > 0 ? new String(buf, 0, n) : "";
                if (ssh) {
                    sessionExitIp = body.trim();
                    sessionExitCountry = "";
                    sessionExitColo = "";
                } else {
                    for (String line : body.split("\n")) {
                        if (line.startsWith("ip=")) sessionExitIp = line.substring(3).trim();
                        else if (line.startsWith("loc=")) sessionExitCountry = line.substring(4).trim();
                        else if (line.startsWith("colo=")) sessionExitColo = line.substring(5).trim();
                    }
                }
                Log.i(TAG, "WARP exit: ip=" + sessionExitIp + " loc=" + sessionExitCountry
                        + " colo=" + sessionExitColo);
            } catch (Throwable t) {
                Log.w(TAG, "exit trace failed: " + t.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        }, "aether-exit-trace").start();
    }

    /** Sube el guardiÃ¡n foreground â€” inmune a phantom-kill de aether. */
    private void startAetherGuard() {
        try {
            android.content.Context ctx = getContext();
            android.content.Intent i = new android.content.Intent(ctx, AetherGuardService.class);
            if (android.os.Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception e) {
            // Sin el guardiÃ¡n aether funciona igual â€” solo vuelve a ser
            // vulnerable al phantom killer en segundo plano. No es fatal.
            Log.w(TAG, "aether guard no pudo arrancar: " + e.getMessage());
        }
    }

    private void stopAetherGuard() {
        try {
            android.content.Context ctx = getContext();
            android.content.Intent i = new android.content.Intent(ctx, AetherGuardService.class);
            i.setAction(AetherGuardService.ACTION_STOP);
            ctx.startService(i);
        } catch (Exception ignored) {}
    }

    /** Mata al proceso aether desde fuera del plugin (AetherGuardService
     * onTaskRemoved: el usuario cerrÃ³ la app de recents). */
    public static void killAetherProcess() {
        Process p;
        Session ssh;
        synchronized (PROCESS_LOCK) {
            p = aetherProcess;
            aetherProcess = null;
            ssh = sshSession;
            sshSession = null;
            sshMode = false;
            SshDirectProxy dp = directProxy;
            directProxy = null;
            if (dp != null) dp.close();
            stopNativeSsh();
            connectionGeneration++;
            connected = false;
            connecting = false;
            statusMisses = 0;
        }
        if (ssh != null) {
            try { if (vpsSocksPort > 0) ssh.delPortForwardingL("127.0.0.1", vpsSocksPort); } catch (Throwable ignored) {}
            try { if (vpsHttpPort > 0) ssh.delPortForwardingL("127.0.0.1", vpsHttpPort); } catch (Throwable ignored) {}
            try { ssh.disconnect(); } catch (Throwable ignored) {}
            vpsSocksPort = 0;
            vpsHttpPort = 0;
        }
        if (p != null) {
            p.destroy();
            try {
                if (!p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS) && p.isAlive()) {
                    p.destroyForcibly();
                }
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                p.destroyForcibly();
            }
        }
    }

    /**
     * Stops the Aether binary.
     */
    /**
     * TÃºnel SSH al VPS remoto (modo remoto-via-SSH): sesiÃ³n JSch con
     * port-forward local 127.0.0.1:1819/1820 â†’ 127.0.0.1 del VPS, donde
     * vive el proxy compartido. Auth por contraseÃ±a + host key TOFU
     * guardada en prefs (si la clave del servidor cambia se rechaza).
     */
    private void startSshTunnel(long generation) throws Exception {
        String host = warpRemote();
        String user = sshUser();
        Log.i(TAG, "SSH tunnel: " + user + "@" + host + ":" + sshPort());
        JSch jsch = new JSch();
        jsch.setHostKeyRepository(new TofuHostKeys(host));
        // Auth por clave si existe la identidad nativa (permite clonar la
        // config VPS a otro dispositivo sin re-escribir la contraseÃ±a â€” la
        // pubkey ya estÃ¡ en authorized_keys del servidor).
        File idKey = new File(getContext().getFilesDir(), "ssh/id_rsa");
        if (idKey.exists() && idKey.length() > 0) {
            try { jsch.addIdentity(idKey.getAbsolutePath()); }
            catch (Exception e) { Log.w(TAG, "ssh identity unusable: " + e.getMessage()); }
        }
        final Session s = jsch.getSession(user, host, sshPort());
        s.setPassword(sshPass());
        // promptYesNo=false â†’ ningÃºn prompt interactivo se auto-acepta: un
        // host key distinto rechaza la conexiÃ³n en vez de pasar un MITM.
        s.setUserInfo(new com.jcraft.jsch.UserInfo() {
            public String getPassphrase() { return null; }
            public String getPassword() { return sshPass(); }
            public boolean promptPassword(String m) { return true; }
            public boolean promptPassphrase(String m) { return false; }
            public boolean promptYesNo(String m) { return false; }
            public void showMessage(String m) {}
        });
        s.setServerAliveInterval(15000);
        s.setServerAliveCountMax(4);
        s.setDaemonThread(true);
        try {
            s.connect(12000);
        } catch (Exception e) {
            // Clave de host no fijada o cambiada â†’ error accionable con la
            // huella para que la UI pida confirmaciÃ³n antes de confiar
            // (TOFU visible â€” nunca se acepta una clave nueva en silencio).
            String hkErr = pendingHostKeyError(host);
            if (hkErr != null) throw new RuntimeException(hkErr);
            throw e;
        }
        synchronized (PROCESS_LOCK) {
            if (!connecting || generation != connectionGeneration) {
                s.disconnect();
                throw new InterruptedException("connect cancelled");
            }
            // Bind forwards while holding the generation lock. Otherwise a
            // cancelled handshake could briefly claim the ports and make the
            // replacement connection fail with EADDRINUSE.
            // Forwards en puertos DEDICADOS (2819/2820 â†’ VPS:1819/1820):
            // el aether local usa 1819/1820 para el trÃ¡fico general, asÃ­
            // que ambos transportes conviven sin chocar.
            // Forwards en puertos efímeros: no quedan proxies sin auth en
            // puertos conocidos al alcance de otras apps del dispositivo.
            vpsSocksPort = s.setPortForwardingL("127.0.0.1", 0, "127.0.0.1", SOCKS_PORT);
            vpsHttpPort = s.setPortForwardingL("127.0.0.1", 0, "127.0.0.1", HTTP_PROXY_PORT);
            sshSession = s;
            // Debrid directo al VPS sin aether remoto: si el sshd permite
            // direct-tcpip, todo el trafico debrid (API + streams + relay)
            // sale con la IP publica del VPS directamente. El forward 2820
            // queda como respaldo para sshd con forwarding restringido.
            if (SshDirectProxy.supports(s)) {
                try {
                    SshDirectProxy proxy = new SshDirectProxy(s, VPS_DIRECT_PORT);
                    proxy.start();
                    directProxy = proxy;
                    Log.i(TAG, "SSH direct-tcpip proxy up: debrid exits VPS IP (no remote aether)");
                } catch (Exception e) {
                    Log.w(TAG, "direct proxy start failed, using forward: " + e.getMessage());
                }
                ensureNativeSsh(s);
            } else {
                Log.w(TAG, "sshd denies direct-tcpip; debrid keeps VPS proxy forward");
            }
        }
        // SesiÃ³n SSH muerta â†’ misma ruta que aether muerto: marca la sesiÃ³n
        // caÃ­da y el guardiÃ¡n reconecta (fail-closed si strictKill).
        new Thread(() -> {
            while (sshSession == s && s.isConnected()) {
                try { Thread.sleep(2000); } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            if (sshSession == s && connected) {
                Log.w(TAG, "SSH session dropped");
                markDisconnected();
            }
        }, "ssh-watch").start();
    }

    private void stopSshTunnel() {
        stopSshTunnel(-1);
    }

    private boolean stopSshTunnel(long expectedGeneration) {
        Session s;
        synchronized (PROCESS_LOCK) {
            if (expectedGeneration >= 0 && expectedGeneration != connectionGeneration) return false;
            s = sshSession;
            sshSession = null;
            sshMode = false;
            SshDirectProxy dp = directProxy;
            directProxy = null;
            if (dp != null) dp.close();
            nativeSshRestarts = 0;
            stopNativeSsh();
        }
        if (s != null) {
            try { if (vpsSocksPort > 0) s.delPortForwardingL("127.0.0.1", vpsSocksPort); } catch (Throwable ignored) {}
            try { if (vpsHttpPort > 0) s.delPortForwardingL("127.0.0.1", vpsHttpPort); } catch (Throwable ignored) {}
            try { s.disconnect(); } catch (Throwable ignored) {}
            vpsSocksPort = 0;
            vpsHttpPort = 0;
        }
        return true;
    }

    /** Huella OpenSSH-style de una clave de host b64 ("SHA256:â€¦"). */
    private static String keyFingerprint(String b64) {
        try {
            byte[] key = android.util.Base64.decode(b64, android.util.Base64.NO_WRAP);
            byte[] d = MessageDigest.getInstance("SHA-256").digest(key);
            return "SHA256:" + android.util.Base64.encodeToString(d, android.util.Base64.NO_WRAP)
                    .replace("=", "");
        } catch (Exception e) { return ""; }
    }

    /**
     * "SSH_HOST_KEY_*:<huella>" si el Ãºltimo handshake dejÃ³ una clave
     * pendiente para este host; null en cualquier otro fallo.
     */
    private String pendingHostKeyError(String host) {
        synchronized (PROCESS_LOCK) {
            if (pendingHostKeyHost == null || !pendingHostKeyHost.equals(host)
                    || pendingHostKeyB64 == null) return null;
            return (pendingHostKeyChanged ? "SSH_HOST_KEY_CHANGED:" : "SSH_HOST_KEY_UNKNOWN:")
                    + keyFingerprint(pendingHostKeyB64);
        }
    }

    /**
     * Host-key store TOFU en SharedPreferences. Nada se fija en silencio:
     * una clave nueva (o distinta de la guardada) se aparca como pendiente
     * y la conexiÃ³n se rechaza hasta que trustRemoteHost() la confirma.
     */
    private class TofuHostKeys implements com.jcraft.jsch.HostKeyRepository {
        private final String host;
        TofuHostKeys(String host) { this.host = host; }
        public int check(String h, byte[] key) {
            String b64 = android.util.Base64.encodeToString(key, android.util.Base64.NO_WRAP);
            String stored = storedHostKey(host);
            if (stored.equals(b64)) return OK;
            synchronized (PROCESS_LOCK) {
                pendingHostKeyHost = host;
                pendingHostKeyB64 = b64;
                pendingHostKeyChanged = !stored.isEmpty();
            }
            if (stored.isEmpty()) {
                Log.i(TAG, "SSH host key unknown for " + host + " â€” pending user confirmation");
                return NOT_INCLUDED;
            }
            Log.e(TAG, "SSH host key CHANGED for " + host + " â€” possible MITM, rejecting");
            return CHANGED;
        }
        public void add(com.jcraft.jsch.HostKey hk, com.jcraft.jsch.UserInfo ui) {}
        public void remove(String h, String type) {}
        public void remove(String h, String type, byte[] key) {}
        public String getKnownHostsRepositoryID() { return "octo-tofu"; }
        public com.jcraft.jsch.HostKey[] getHostKey() { return new com.jcraft.jsch.HostKey[0]; }
        public com.jcraft.jsch.HostKey[] getHostKey(String h, String type) {
            return new com.jcraft.jsch.HostKey[0];
        }
    }

    private void stopAether() {
        stopAether(-1);
    }

    private boolean stopAether(long expectedGeneration) {
        Process process;
        synchronized (PROCESS_LOCK) {
            if (expectedGeneration >= 0 && expectedGeneration != connectionGeneration) return false;
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
        return true;
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
                // TÃºnel muerto a mitad de sesiÃ³n: los puertos del proxy
                // siguen aceptando aunque el data-plane estÃ© caÃ­do â€” es el
                // caso que corrompÃ­a los streams "directos" y el que nunca
                // disparaba la escalada de protocolo.
                if (line.contains("tunnel ended") || line.contains("tunnel failed")) {
                    onTunnelDied(process);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Aether log reader error: " + e.getMessage());
        }
    }

    /**
     * Escalada de protocolo a mitad de sesiÃ³n: si el tÃºnel MASQUE se muere
     * repetidamente (racha de "tunnel ended/failed"), los proxies locales
     * quedan como listeners zombis â€” aceptan CONNECTs que nunca llegan al
     * upstream. El fallback masqueâ†’wg del arranque no cubre este caso, asÃ­
     * que aquÃ­ se reinicia aether con el siguiente protocolo de la cadena
     * (masque â†’ masque-h2 â†’ wg). En wg no hay mÃ¡s escalones â€” si Ã©l tambiÃ©n
     * tormenta se queda reintentando internamente, sin ping-pong.
     */
    private void onTunnelDied(Process process) {
        boolean ours;
        final long generation;
        synchronized (PROCESS_LOCK) {
            // Solo cuenta el proceso actual: logs de un proceso ya
            // sustituido o un connect() en vuelo no deben disparar nada.
            // NO exigir connected: la sonda de puertos marca
            // markDisconnected() en cuanto el tÃºnel se atraganta, y era
            // justo ese el caso que debe escalar â€” si la marca bloquea la
            // escalada, el estado queda "caÃ­do" con el tÃºnel zombi.
            ours = aetherProcess == process && !connecting;
            generation = connectionGeneration;
        }
        if (!ours) return;
        long now = System.currentTimeMillis();
        if (now - lastTunnelFailAt > 60000) tunnelFailStreak = 0;
        lastTunnelFailAt = now;
        tunnelFailStreak++;
        // ~5 muertes (~10s de tÃºnel invÃ¡lido) bastan para rendirse.
        if (tunnelFailStreak < 5 || protocolSwitching) return;
        // Siguiente escalÃ³n de la cadena doble-salto: gool â†’ mim.
        // En mim no hay mÃ¡s adonde escalar.
        final String next = "gool".equals(currentProtocol) ? "mim" : null;
        if (next == null) return;
        protocolSwitching = true;
        preferredProtocol = next;
        Log.w(TAG, currentProtocol + " tunnel can't hold (" + tunnelFailStreak
                + " deaths) â€” restarting aether with " + next);
        new Thread(() -> {
            try {
                synchronized (PROCESS_LOCK) {
                    if (generation != connectionGeneration || aetherProcess != process) return;
                    // startAether aborta si connecting=false (connect
                    // cancelado); mantenerlo true durante el swap y que
                    // getStatus informe "connecting", no "down".
                    connecting = true;
                    connectingSince = System.currentTimeMillis();
                }
                if (!stopAether(generation)) return;
                startAether(next, generation);
                synchronized (PROCESS_LOCK) {
                    connected = aetherProcess != null && aetherProcess.isAlive();
                    connecting = false;
                }
                if (connected) {
                    connectedSince = System.currentTimeMillis();
                    sessionReconnects++;
                    refreshExitInfo();
                    if ("gool".equals(next)) learnInnerPeer();
                    Log.i(TAG, "Aether restarted with " + next + " after tunnel storm");
                } else {
                    markDisconnected();
                }
            } catch (Exception e) {
                Log.e(TAG, "Protocol switch to " + next + " failed: " + e.getMessage());
                synchronized (PROCESS_LOCK) { connecting = false; }
                markDisconnected();
            } finally {
                protocolSwitching = false;
                tunnelFailStreak = 0;
            }
        }, "aether-protocol-switch").start();
    }

    /**
     * Checks if the SOCKS5 proxy is responding.
     */
    // TV georestricted domains use the physical network; other app traffic
    // goes through the Aether/WARP HTTP proxy.
    private static final java.util.regex.Pattern GEO_HOST = java.util.regex.Pattern.compile(
        "(^|\\.)(" +
        "tdtspain\\.com|tdtchannels\\.com|rtve\\.es|mediaset\\.net|mediasetinfinity\\.es|" +
        "atresplayer\\.com|atresmedia\\.com|dai\\.google\\.com|doubleclick\\.net|" +
        // YouTube: la IP que resuelve (NewPipe, red fÃ­sica) debe ser la misma
        // que reproduce (googlevideo firma la URL con esa IP); por el tÃºnel
        // ademÃ¡s YouTube dispara el bot-check LOGIN_REQUIRED.
        "youtube\\.com|youtu\\.be|youtube-nocookie\\.com|googlevideo\\.com|" +
        "youtubei\\.googleapis\\.com|youtube\\.googleapis\\.com|ytimg\\.com|ggpht\\.com)$",
        java.util.regex.Pattern.CASE_INSENSITIVE);

    public static boolean isGeoBypassHost(String url) {
        try {
            String host = android.net.Uri.parse(url).getHost();
            return host != null && GEO_HOST.matcher(host).find();
        } catch (Exception e) { return false; }
    }

    /** Rede fÃ­sica (WiFi/dados/ethernet) â€” nunca a prÃ³pria VPN. */
    public static android.net.Network physicalNetwork(android.content.Context ctx) {
        try {
            android.net.ConnectivityManager cm =
                (android.net.ConnectivityManager) ctx.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
            if (cm == null) return null;
            android.net.Network cell = null;
            for (android.net.Network n : cm.getAllNetworks()) {
                android.net.NetworkCapabilities nc = cm.getNetworkCapabilities(n);
                // Sin NET_CAPABILITY_INTERNET la red no vale â€” la IMS
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
     * Fetch fora do tÃºnel: para hosts com geobloqueio a ligaÃ§Ã£o Ã© aberta
     * na rede fÃ­sica (requer allowBypass no VpnService.Builder).
     */
    @PluginMethod
    public void directFetch(PluginCall call) {
        final String url = call.getString("url");
        final String method = call.getString("method", "GET");
        final JSObject headers = call.getObject("headers");
        final Object data = call.getData() != null ? call.getData().opt("data") : null;
        final String responseType = call.getString("responseType", "text");
        // bypassVpn (resolve TDT): URLs assinadas ligam-se ao IP que resolve â€”
        // qualquer host pode precisar de sair pela rede fÃ­sica.
        final boolean bypassVpn = call.getBoolean("bypassVpn", false);
        // vps=true: peticiÃ³n debrid â€” sale por el forward SSH al VPS
        // (2820). No exige host de la lista geo ni red fÃ­sica: sin VPS
        // configurado cae al proxy por defecto (aether), nunca en claro.
        final boolean vps = call.getBoolean("vps", false);
        if (url == null || (!vps && !bypassVpn && !isGeoBypassHost(url))) {
            call.reject("directFetch: host not in geo-bypass list");
            return;
        }
        new Thread(() -> {
            java.net.HttpURLConnection c = null;
            try {
                // No silent exit-IP change when SSH drops: a URL unlocked via
                // the VPS cannot be fetched via WARP without an IP mismatch.
                if (vps && !debridDirect && sshRemote() && getVpsHttpProxyAddr() == null) {
                    call.reject("VPS SSH no conectado; reintenta cuando vuelva");
                    return;
                }
                android.net.Network net = physicalNetwork(getContext());
                int ct = call.getInt("connectTimeout", 15000);
                int rt = call.getInt("readTimeout", 20000);
                // Redirects manuales acotados: instanceFollowRedirects no
                // tiene lÃ­mite y un bucle 301/302 colgaba el hilo. MÃ¡x. 5
                // saltos; cada Location se re-abre en la misma red fÃ­sica.
                String current = url;
                int hops = 0;
                int code;
                // Proxy del VPS para vps=true: solo con sesiÃ³n SSH viva;
                // si no, u.openConnection() usa el proxy del sistema
                // (aether). La red fÃ­sica queda reservada al bypass geo.
                String vpsProxyAddr = vps && !debridDirect ? getVpsHttpProxyAddr() : null;
                java.net.Proxy vpsProxy = null;
                boolean authProxy = false;
                if (vpsProxyAddr != null) {
                    String[] proxyParts = vpsProxyAddr.split(":", 2);
                    vpsProxy = new java.net.Proxy(java.net.Proxy.Type.HTTP,
                            new java.net.InetSocketAddress(proxyParts[0],
                                    Integer.parseInt(proxyParts[1])));
                    // SshDirectProxy (:2830) exige Proxy-Authorization; el
                    // bridge okhttp de HttpURLConnection copia las cabeceras
                    // de usuario en el CONNECT, así que la auth llega a la
                    // primera sin depender del reintento 407 → Authenticator.
                    // SOLO a :2830: en el forward aether la cabecera saldría
                    // del túnel hacia el origen (fuga del token).
                    authProxy = "2830".equals(proxyParts[1]);
                }
                for (;;) {
                    java.net.URL u = new java.net.URL(current);
                    if (c != null) c.disconnect();
                    c = (java.net.HttpURLConnection) (vps && !debridDirect
                            ? (vpsProxy != null ? u.openConnection(vpsProxy) : u.openConnection())
                            : (net != null ? net.openConnection(u) : u.openConnection()));
                    c.setConnectTimeout(ct); c.setReadTimeout(rt);
                    c.setInstanceFollowRedirects(false);
                    c.setRequestMethod(method);
                    if (authProxy) c.setRequestProperty(
                            "Proxy-Authorization", getProxyAuthHeader());
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
                    code = c.getResponseCode();
                    if (code < 300 || code >= 400 || ++hops > 5) break;
                    String loc = c.getHeaderField("Location");
                    if (loc == null || loc.isEmpty()) break;
                    current = new java.net.URL(u, loc).toString();
                }
                java.io.InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                try {
                    if (in != null) {
                        byte[] buf = new byte[16384]; int n;
                        // Tope de 8 MB: una respuesta gigante inflaba el
                        // buffer sin lÃ­mite (OOM) y `in` nunca se cerraba.
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
        return isSocksProxyUp(proxyHost(), SOCKS_PORT, HTTP_PROXY_PORT);
    }

    // Variante por host/puertos: sonda tambiÃ©n los forwards SSH del VPS
    // (127.0.0.1:2819/2820) sin tocar el plano del trÃ¡fico general.
    private boolean isSocksProxyUp(String host, int... ports) {
        // Check both SOCKS5 (1819) and HTTP CONNECT (1820) proxy ports on
        // the effective host (loopback, LAN remote, or SSH forward).
        int timeout = "127.0.0.1".equals(host) ? 500 : 1500;
        for (int port : ports) {
            try (java.net.Socket socket = new java.net.Socket()) {
                socket.connect(new java.net.InetSocketAddress(host, port), timeout);
            } catch (Exception e) {
                return false;
            }
        }
        return true;
    }
}

