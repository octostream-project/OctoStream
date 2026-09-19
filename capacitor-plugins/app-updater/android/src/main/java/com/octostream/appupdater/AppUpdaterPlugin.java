package com.octostream.appupdater;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
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

    @PluginMethod
    public void getAppVersion(PluginCall call) {
        try {
            Context ctx = getContext();
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            JSObject ret = new JSObject();
            ret.put("versionCode", code);
            ret.put("versionName", pi.versionName != null ? pi.versionName : "");
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
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            ctx.startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "installApk failed", e);
            call.reject("install failed: " + e.getMessage(), e);
        }
    }
}
