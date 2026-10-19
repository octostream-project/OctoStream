package com.octostream.cloudproxy;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Method;

/**
 * Management socket de openvpn — port simplificado del
 * OpenVpnManagementThread de ics-openvpn (GPLv2). Sirve los comandos
 * "need 'X'" del proceso openvpn: OPENTUN (tun fd por ancillary),
 * PROTECTFD (sockets de openvpn protegidos del propio túnel),
 * IFCONFIG/ROUTE/DNS (config del Builder) y eventos de estado.
 */
public class OctoMgmtThread implements Runnable {
    private static final String TAG = "OctoMgmtThread";
    private final OctoVpnService mService;
    private final String mSockPath;
    private LocalServerSocket mServer;
    private LocalSocket mClient;
    private OutputStream mOut;
    private volatile boolean mClosed = false;

    public OctoMgmtThread(OctoVpnService svc, String sockPath) {
        mService = svc;
        mSockPath = sockPath;
    }

    public boolean openServer() {
        try {
            // El socket file sobrevive a un crash del proceso → EADDRINUSE
            // en la reconexión. Borrarlo antes de bind.
            new java.io.File(mSockPath).delete();
            LocalSocket s = new LocalSocket();
            s.bind(new LocalSocketAddress(mSockPath, LocalSocketAddress.Namespace.FILESYSTEM));
            mServer = new LocalServerSocket(s.getFileDescriptor());
            new java.io.File(mSockPath).deleteOnExit();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "openServer failed", e);
            return false;
        }
    }

    private void sendCmd(String cmd) {
        try {
            if (mOut != null) { mOut.write((cmd + "\n").getBytes()); mOut.flush(); }
        } catch (Exception e) {
            Log.w(TAG, "mgmt write failed: " + e.getMessage());
        }
    }

    @Override
    public void run() {
        try {
            mClient = mServer.accept();
            mOut = mClient.getOutputStream();
            InputStream in = mClient.getInputStream();
            BufferedReader reader = new BufferedReader(new InputStreamReader(in));
            sendCmd("state on");
            sendCmd("log on");
            sendCmd("bytecount 5");
            sendCmd("hold release");
            String line;
            while (!mClosed && (line = reader.readLine()) != null) {
                handle(line);
            }
        } catch (Exception e) {
            if (!mClosed) Log.e(TAG, "mgmt thread error", e);
        }
    }

    private void handle(String line) {
        if (line.startsWith(">STATE:")) {
            // machine-readable: >STATE:ts,STATE,...
            String state = line.split(",").length > 1 ? line.split(",")[1] : "";
            if ("CONNECTED".equals(state)) OctoVpnService.setConnectedState(true);
            else if ("EXITING".equals(state) || "DISCONNECTED".equals(state)) OctoVpnService.setConnectedState(false);
        } else if (line.contains("Need '") || line.contains("need '")) {
            // openvpn emite ">PASSWORD:Need 'X' valor" — N mayúscula en
            // las peticiones; matchear ambas por robustez.
            processNeed(line);
        } else if (line.startsWith("SUCCESS:")) {
            Log.d(TAG, "mgmt: " + line);
        } else if (line.startsWith("ERROR:") || line.contains("AUTH_FAILED")) {
            OctoVpnService.setError(line);
            Log.e(TAG, "mgmt: " + line);
        }
    }

    private void processNeed(String arg) {
        int p1 = arg.indexOf('\'');
        int p2 = arg.indexOf('\'', p1 + 1);
        if (p1 < 0 || p2 < 0) return;
        String needed = arg.substring(p1 + 1, p2);
        // El valor va DESPUÉS de la segunda comilla: "Need 'X' valor".
        // (extraer por ':' partía el prefijo PASSWORD: y dejaba el 'Need'
        // dentro — el tun/DNS nunca se habrían configurado).
        String extra = arg.substring(p2 + 1).trim();
        String status = "ok";
        switch (needed) {
            case "PROTECTFD": {
                FileDescriptor fd = pollAncillary();
                if (fd != null) protectFd(fd);
                else status = "cancel"; // sin fd → openvpn no puede proteger su socket
                break;
            }
            case "DNSSERVER":
                mService.addDns(extra);
                break;
            case "DNSDOMAIN":
                break;
            case "ROUTE": {
                String[] parts = extra.split(" ");
                if (parts.length >= 2) mService.addRoute(parts[0], parts[1]);
                break;
            }
            case "ROUTE6": {
                String[] parts = extra.split(" ");
                if (parts.length >= 2) mService.addRouteV6(parts[0], parts[1]);
                break;
            }
            case "IFCONFIG": {
                String[] parts = extra.split(" ");
                int mtu = parts.length > 2 ? Integer.parseInt(parts[2]) : 0;
                if (parts.length >= 2) mService.setLocalIp(parts[0], parts[1], mtu);
                break;
            }
            case "IFCONFIG6": {
                String[] parts = extra.split(" ");
                if (parts.length >= 2) mService.setLocalIpV6(parts[0], parts[1]);
                break;
            }
            case "PERSIST_TUN_ACTION":
                status = "ok";
                break;
            case "OPENTUN":
                if (!sendTunFd(extra)) status = "cancel";
                break;
            default:
                Log.w(TAG, "unknown need '" + needed + "'");
                return;
        }
        sendCmd("needok '" + needed + "' " + status);
    }

    private boolean sendTunFd(String extra) {
        if (!"tun".equals(extra.trim())) {
            Log.e(TAG, "OPENTUN pidió '" + extra + "' — solo tun soportado");
            return false;
        }
        ParcelFileDescriptor pfd = mService.openTun();
        if (pfd == null) return false;
        try {
            // Replicar el fd en un FileDescriptor propio para mandarlo por
            // el LocalSocket (setFileDescriptorsForSend → SCM_RIGHTS).
            int fdint = pfd.getFd();
            FileDescriptor fdtosend = new FileDescriptor();
            Method setInt = FileDescriptor.class.getDeclaredMethod("setInt$", int.class);
            setInt.setAccessible(true);
            setInt.invoke(fdtosend, fdint);
            mClient.setFileDescriptorsForSend(new FileDescriptor[]{fdtosend});
            // El byte de payload es lo que arrastra el fd ancillary.
            mClient.getOutputStream().write(32);
            mClient.getOutputStream().flush();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "sendTunFd failed", e);
            return false;
        }
    }

    private FileDescriptor pollAncillary() {
        try {
            // El fd llega adjunto al byte de la línea need 'PROTECTFD' que
            // el BufferedReader ya consumió — NO hay que leer más del
            // stream (se comería comandos de management).
            FileDescriptor[] fds = mClient.getAncillaryFileDescriptors();
            if (fds != null && fds.length > 0) return fds[0];
        } catch (Exception e) {
            Log.w(TAG, "ancillary read: " + e.getMessage());
        }
        return null;
    }

    private void protectFd(FileDescriptor fd) {
        try {
            Method getInt = FileDescriptor.class.getDeclaredMethod("getInt$");
            getInt.setAccessible(true);
            int fdint = (Integer) getInt.invoke(fd);
            boolean ok = mService.protectFd(fdint);
            if (!ok) Log.w(TAG, "protect() rechazado");
            android.system.Os.close(fd);
        } catch (Exception e) {
            Log.w(TAG, "protectFd: " + e.getMessage());
        }
    }

    public void close() {
        mClosed = true;
        try { if (mClient != null) mClient.close(); } catch (Exception ignored) {}
        try { if (mServer != null) mServer.close(); } catch (Exception ignored) {}
    }
}
