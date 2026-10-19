package com.octostream.cloudproxy;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;

/**
 * VpnService propio para RiseupVPN — el motor openvpn corre como proceso
 * (libovpnexec.so extraído de OpenVPN for Android, GPLv2) conectándose a
 * nuestro LocalServerSocket de management. El túnel es sistema-completo:
 * aether/WARP y el resto del tráfico de la app enrutan por él.
 *
 * Protocolo management (mismo que ics-openvpn):
 *   openvpn → "need 'OPENTUN' tun"  → app envía el fd del tun por el socket
 *   openvpn → "need 'PROTECTFD'"    → app hace VpnService.protect(fd)
 *   openvpn → "need 'IFCONFIG' ..." → Builder.addAddress + establish
 *   openvpn → "need 'ROUTE' ..."    → Builder.addRoute
 *   openvpn → ">STATE:...,CONNECTED"→ status
 */
public class OctoVpnService extends VpnService {
    private static final String TAG = "OctoVpnService";
    public static final String ACTION_START = "com.octostream.vpn.START";
    public static final String ACTION_STOP = "com.octostream.vpn.STOP";
    public static final String EXTRA_CONF = "conf_path";
    private static final int NOTIF_ID = 42130;

    private static volatile boolean running = false;
    private static volatile boolean connected = false;
    private static volatile String lastError = "";

    private ParcelFileDescriptor mTun;
    private Process mProcess;
    private OctoMgmtThread mMgmt;

    // Config acumulada que openvpn empuja por management — el Builder es
    // de un solo uso (establish() lo consume), así que se guarda aparte y
    // se aplica sobre un Builder nuevo en cada openTun().
    private final java.util.List<String> mDns = new java.util.ArrayList<>();
    private final java.util.List<int[]> mRoutes = new java.util.ArrayList<>(); // [bits, o1,o2,o3,o4]
    private final java.util.List<String> mRoutes6 = new java.util.ArrayList<>();
    private String mLocalIp = null;
    private int mLocalBits = 32;
    private int mMtu = 0;
    private String mLocalIpV6 = null;

    public static boolean isConnected() { return connected; }
    public static boolean isRunning() { return running; }
    public static String getLastError() { return lastError; }
    public static void setConnectedState(boolean c) { connected = c; }
    public static void setError(String e) { lastError = e; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            // stopVpn hace waitFor(4s) — nunca en el hilo main (ANR).
            new Thread(this::stopVpn, "ovpn-stop").start();
            stopSelf();
            return START_NOT_STICKY;
        }
        String confPath = intent != null ? intent.getStringExtra(EXTRA_CONF) : null;
        if (confPath == null) { stopSelf(); return START_NOT_STICKY; }
        startForegroundWithNotif();
        new Thread(() -> runVpn(confPath), "ovpn-main").start();
        return START_STICKY;
    }

    private void startForegroundWithNotif() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        String chId = "octovpn";
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(chId, "RiseupVPN", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
        }
        Notification.Builder nb = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, chId)
                : new Notification.Builder(this); // ctor de 2 args no existe < 26
        Notification n = nb
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("RiseupVPN activo")
                .setContentText("OctoStream protege la conexión")
                .setOngoing(true)
                .build();
        startForeground(NOTIF_ID, n);
    }

    private void runVpn(String confPath) {
        try {
            // El servicio es singleton — resetear la config acumulada o la
            // sesión anterior deja rutas/DNS/IP fantasma en el nuevo tun.
            mDns.clear(); mRoutes.clear(); mRoutes6.clear();
            mLocalIp = null; mLocalBits = 32; mMtu = 0; mLocalIpV6 = null;
            // Socket de management: LocalServerSocket en el FS de la app —
            // openvpn conecta a él vía la línea `management <path> unix`.
            String sockPath = new File(getCacheDir(), "ovpn-mgmt").getAbsolutePath();
            mMgmt = new OctoMgmtThread(this, sockPath);
            if (!mMgmt.openServer()) {
                lastError = "no se pudo abrir el socket de management";
                stopSelf();
                return;
            }
            // android.conf = conf del usuario sanitizado + management.
            // El conf viene del JS: se eliminan directivas que ejecutan
            // código (up/down/plugin) o abren un management alternativo
            // (conflicto con el nuestro — directiva duplicada).
            File conf = new File(getCacheDir(), "ovpn-android.conf");
            try (FileWriter w = new FileWriter(conf, false)) {
                String userConf = new String(java.nio.file.Files.readAllBytes(new File(confPath).toPath()));
                // El conf crudo lleva la clave privada inline — borrarlo en
                // cuanto se lee (el servicio usa solo la copia saneada).
                new File(confPath).delete();
                w.write(sanitizeConf(userConf));
                w.write("\nmanagement " + sockPath + " unix\n");
                w.write("management-client\n");
                w.write("machine-readable-output\n");
                w.write("management-signal\n");
            }

            String libDir = getApplicationInfo().nativeLibraryDir;
            File exec = new File(libDir, "libovpnexec.so");
            if (!exec.isFile()) {
                lastError = "libovpnexec.so no encontrado";
                Log.e(TAG, lastError + " en " + libDir);
                stopSelf();
                return;
            }
            ProcessBuilder pb = new ProcessBuilder(exec.getAbsolutePath(), "--config", conf.getAbsolutePath());
            pb.environment().put("LD_LIBRARY_PATH", libDir);
            pb.environment().put("TMPDIR", getCacheDir().getAbsolutePath());
            pb.redirectErrorStream(true);
            mProcess = pb.start();
            running = true;
            lastError = "";
            Log.i(TAG, "openvpn lanzado: " + exec.getAbsolutePath());

            // Drenar stdout del proceso (si nadie lo lee, el pipe se llena y se congela).
            new Thread(() -> {
                try (java.io.BufferedReader r = new java.io.BufferedReader(
                        new java.io.InputStreamReader(mProcess.getInputStream()))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        if (line.contains("error") || line.contains("ERROR") || line.contains("warn"))
                            Log.w(TAG, "ovpn: " + line);
                    }
                } catch (Exception ignored) {}
            }, "ovpn-stdout").start();

            // Management thread: acepta la conexión de openvpn y sirve los
            // comandos need 'X'.
            new Thread(mMgmt, "ovpn-mgmt").start();
            mProcess.waitFor();
        } catch (Exception e) {
            lastError = e.getMessage();
            Log.e(TAG, "runVpn failed", e);
        } finally {
            running = false;
            connected = false;
            stopVpn();
            stopSelf();
        }
    }

    private static final java.util.regex.Pattern DANGEROUS = java.util.regex.Pattern.compile(
        "(?im)^\\s*(up|down|ipchange|route-up|route-pre-down|down-pre|client-connect|client-disconnect|learn-address|auth-user-pass-verify|script-security|plugin|tls-verify|client-config-dir|management|management-client|management-query-passwords|management-signal|log-append|syslog)\\b.*$");

    private static String sanitizeConf(String conf) {
        return DANGEROUS.matcher(conf).replaceAll("");
    }

    public ParcelFileDescriptor openTun() {
        try {
            Builder b = new Builder();
            b.setSession("OctoStream RiseupVPN");
            if (mLocalIp != null) b.addAddress(mLocalIp, mLocalBits);
            if (mLocalIpV6 != null) {
                String[] p = mLocalIpV6.split("/");
                b.addAddress(p[0], Integer.parseInt(p[1]));
            }
            b.setMtu(mtu());
            if (mDns.isEmpty()) {
                // Riseup no empuja DNS — los suyos dentro del túnel.
                b.addDnsServer("10.11.12.13").addDnsServer("10.11.12.14");
            } else for (String d : mDns) b.addDnsServer(d);
            for (int[] r : mRoutes) b.addRoute(intsToIp(r), r[0]);
            for (String r6 : mRoutes6) {
                String[] p = r6.split("/");
                b.addRoute(p[0], Integer.parseInt(p[1]));
            }
            if (mRoutes.isEmpty()) b.addRoute("0.0.0.0", 0); // todo por el túnel si el server no empuja
            // Fuga IPv6: sin ruta ::/0 el tráfico v6 del dispositivo sale
            // por la IP real aunque v4 vaya por la VPN. La ruta entra al
            // tun y muere ahí (fail-closed) — Riseup no da v6 por OpenVPN.
            b.addRoute("::", 0);
            // Solo el tráfico de ESTA app va por el túnel — el resto del
            // sistema sigue directo. aether (hijo de la app, mismo uid)
            // enruta igual → la cadena app→aether→Riseup se mantiene.
            b.addAllowedApplication(getPackageName());
            mTun = b.establish();
            return mTun;
        } catch (Exception e) {
            lastError = "openTun: " + e.getMessage();
            return null;
        }
    }

    private int mtu() { return mMtu > 0 ? mMtu : 1500; }
    private static String intsToIp(int[] r) { return r[1] + "." + r[2] + "." + r[3] + "." + r[4]; }

    public void addDns(String dns) { mDns.add(dns); }
    public void addRoute(String ip, String prefix) {
        int bits;
        if (prefix.contains(".")) {
            int m = 0;
            for (String s : prefix.split("\\.")) m += Integer.bitCount(Integer.parseInt(s));
            bits = m;
        } else bits = Integer.parseInt(prefix.trim());
        String[] o = ip.split("\\.");
        mRoutes.add(new int[]{bits, Integer.parseInt(o[0]), Integer.parseInt(o[1]), Integer.parseInt(o[2]), Integer.parseInt(o[3])});
    }
    public void addRouteV6(String ip, String prefix) { mRoutes6.add(ip + "/" + prefix.trim()); }
    /** IFCONFIG: arg2 es netmask (topología subnet) o peer-ip (p2p → /32). */
    public void setLocalIp(String ip, String maskOrPeer, int mtu) {
        mLocalIp = ip;
        if (maskOrPeer.startsWith("255.")) {
            int m = 0;
            for (String s : maskOrPeer.split("\\.")) m += Integer.bitCount(Integer.parseInt(s));
            mLocalBits = m;
        } else mLocalBits = 32;
        if (mtu > 0) mMtu = mtu;
    }
    /** IFCONFIG6: openvpn manda "ip prefix" separados — se unen a ip/prefix. */
    public void setLocalIpV6(String ip, String prefix) { mLocalIpV6 = ip + "/" + prefix.trim(); }
    public void setMtu(int mtu) { if (mtu > 0) mMtu = mtu; }
    public boolean protectFd(int fd) { return protect(fd); }

    private void stopVpn() {
        connected = false;
        running = false;
        if (mMgmt != null) { mMgmt.close(); mMgmt = null; }
        if (mProcess != null) {
            mProcess.destroy();
            try {
                if (!mProcess.waitFor(4, java.util.concurrent.TimeUnit.SECONDS)) mProcess.destroyForcibly();
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                mProcess.destroyForcibly();
            }
            mProcess = null;
        }
        if (mTun != null) { try { mTun.close(); } catch (IOException ignored) {} mTun = null; }
        try {
            if (Build.VERSION.SDK_INT >= 33) stopForeground(STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
        } catch (Exception ignored) {}
    }

    @Override
    public void onDestroy() {
        stopVpn();
        super.onDestroy();
    }
}
