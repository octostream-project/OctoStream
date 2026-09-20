package com.octostream.appupdater;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.Log;
import android.util.SparseArray;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * In-app updater: downloads an APK to the app cache and launches the system
 * package installer via FileProvider. The install itself always requires user
 * confirmation in the Android dialog — there is no silent install without
 * system privileges.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private static final String TAG = "AppUpdater";
    private static final String ACTION_INSTALL_RESULT =
            "com.octostream.appupdater.INSTALL_RESULT";

    private final SparseArray<PluginCall> mPendingInstalls = new SparseArray<>();
    private BroadcastReceiver mInstallReceiver;

    @Override
    public void load() {
        mInstallReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                handleInstallStatus(ctx, intent);
            }
        };
        final IntentFilter filter = new IntentFilter(ACTION_INSTALL_RESULT);
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= 33) {
            ctx.registerReceiver(mInstallReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            ctx.registerReceiver(mInstallReceiver, filter);
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (mInstallReceiver != null) {
            try {
                getContext().unregisterReceiver(mInstallReceiver);
            } catch (Exception ignored) {
            }
            mInstallReceiver = null;
        }
    }

    private void handleInstallStatus(Context ctx, Intent intent) {
        final int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS,
                PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // El sistema pide confirmación: lanzar el diálogo de instalación.
            final Intent confirm = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                    : intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    ctx.startActivity(confirm);
                    return;
                } catch (Exception e) {
                    Log.e(TAG, "cannot launch install confirmation", e);
                }
            }
            // No se pudo mostrar la confirmación: liberar la llamada pendiente.
            final int pendingSession = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
            final PluginCall pendingCall = mPendingInstalls.get(pendingSession);
            if (pendingCall != null) {
                mPendingInstalls.remove(pendingSession);
                pendingCall.reject("install failed: cannot show confirmation");
            }
            return;
        }
        final int sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
        final String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        Log.d(TAG, "install session " + sessionId + " status=" + status + " msg=" + message);

        JSObject ev = new JSObject();
        ev.put("status", status);
        ev.put("message", message != null ? message : "");
        notifyListeners("installResult", ev);

        final PluginCall call = mPendingInstalls.get(sessionId);
        if (call != null) {
            mPendingInstalls.remove(sessionId);
            if (status == PackageInstaller.STATUS_SUCCESS) {
                JSObject ret = new JSObject();
                ret.put("installed", true);
                call.resolve(ret);
            } else if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
                JSObject ret = new JSObject();
                ret.put("aborted", true);
                call.resolve(ret);
            } else {
                call.reject("install failed: " + message);
            }
        }
    }

    @PluginMethod
    public void getAppVersion(PluginCall call) {
        try {
            Context ctx = getContext();
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            JSObject ret = new JSObject();
            ret.put("versionCode", code);
            ret.put("versionName", pi.versionName != null ? pi.versionName : "");
            // ABIs soportados por el dispositivo (orden de preferencia) para
            // elegir el APK correcto cuando el manifiesto publica apkUrls{}.
            ret.put("abis", TextUtils.join(",", Build.SUPPORTED_ABIS));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("getAppVersion failed", e);
        }
    }

    @PluginMethod
    public void canInstallUnknownApps(PluginCall call) {
        boolean allowed = Build.VERSION.SDK_INT < 26
                || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject ret = new JSObject();
        ret.put("allowed", allowed);
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            Context ctx = getContext();
            if (Build.VERSION.SDK_INT >= 26) {
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + ctx.getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("openInstallSettings failed", e);
        }
    }

    @PluginMethod
    public void downloadApk(PluginCall call) {
        final String urlStr = call.getString("url");
        final String expectedSha = call.getString("sha256");
        if (urlStr == null || !urlStr.startsWith("https://")) {
            call.reject("downloadApk requires an https:// url");
            return;
        }
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                Context ctx = getContext();
                File dir = new File(ctx.getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("cannot create updates dir");
                    return;
                }
                File out = new File(dir, "update.apk");

                conn = (HttpURLConnection) new URL(urlStr).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "OctoStream-Updater");
                conn.connect();
                if (conn.getResponseCode() != 200) {
                    call.reject("download failed: HTTP " + conn.getResponseCode());
                    return;
                }
                long total = conn.getContentLengthLong();
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                try (InputStream in = conn.getInputStream();
                     FileOutputStream fos = new FileOutputStream(out)) {
                    byte[] buf = new byte[64 * 1024];
                    long received = 0;
                    long lastEmit = 0;
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        fos.write(buf, 0, n);
                        if (expectedSha != null) md.update(buf, 0, n);
                        received += n;
                        // Si conocemos Content-Length, corta al llegar: una
                        // conexión keep-alive puede no cerrar nunca y read()
                        // se quedaría bloqueado en el 100% indefinidamente.
                        if (total > 0 && received >= total) break;
                        if (received - lastEmit >= 512 * 1024 || received == total) {
                            lastEmit = received;
                            JSObject ev = new JSObject();
                            ev.put("received", received);
                            ev.put("total", total);
                            ev.put("percent", total > 0 ? (received * 100 / total) : -1);
                            notifyListeners("downloadProgress", ev);
                        }
                    }
                    fos.flush();
                }
                if (expectedSha != null) {
                    StringBuilder hex = new StringBuilder();
                    for (byte b : md.digest()) hex.append(String.format("%02x", b));
                    if (!hex.toString().equalsIgnoreCase(expectedSha)) {
                        out.delete();
                        call.reject("sha256 mismatch");
                        return;
                    }
                }
                JSObject ret = new JSObject();
                ret.put("path", out.getAbsolutePath());
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "downloadApk failed", e);
                call.reject("download failed: " + e.getMessage(), e);
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("path required");
            return;
        }
        try {
            Context ctx = getContext();
            File apk = new File(path);
            if (!apk.exists()) {
                call.reject("apk not found");
                return;
            }
            if (Build.VERSION.SDK_INT >= 26
                    && !ctx.getPackageManager().canRequestPackageInstalls()) {
                JSObject ret = new JSObject();
                ret.put("needsPermission", true);
                call.resolve(ret);
                return;
            }
            try {
                // Camino principal: sesión propia de PackageInstaller. Equivale
                // a lo que hace "pm install" (que funciona en ROMs donde el
                // instalador gráfico falla al stagear, p.ej. algunas builds de
                // Android TV) y además nos devuelve el resultado real.
                installViaSession(ctx, apk, call);
            } catch (Exception sessionErr) {
                Log.e(TAG, "session install failed, falling back to ACTION_VIEW", sessionErr);
                Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                ctx.startActivity(intent);
                call.resolve();
            }
        } catch (Exception e) {
            Log.e(TAG, "installApk failed", e);
            call.reject("install failed: " + e.getMessage(), e);
        }
    }

    private void installViaSession(Context ctx, File apk, PluginCall call) throws Exception {
        PackageInstaller installer = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(ctx.getPackageName());
        params.setSize(apk.length());
        int sessionId = installer.createSession(params);
        PackageInstaller.Session session = installer.openSession(sessionId);
        try {
            try (OutputStream out = session.openWrite("base.apk", 0, apk.length());
                 InputStream in = new FileInputStream(apk)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                }
                session.fsync(out);
            }
            Intent statusIntent = new Intent(ACTION_INSTALL_RESULT)
                    .setPackage(ctx.getPackageName());
            PendingIntent pending = PendingIntent.getBroadcast(
                    ctx, sessionId, statusIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
            mPendingInstalls.put(sessionId, call);
            session.commit(pending.getIntentSender());
        } finally {
            session.close();
        }
    }
}
