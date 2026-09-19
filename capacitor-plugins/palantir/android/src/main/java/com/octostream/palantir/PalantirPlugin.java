package com.octostream.palantir;

import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
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
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Bridge to the Palantir 3 "moria" catalog: a ~250MB SQLite database that ships
 * inside a .zm3 archive (a zip whose local file header was stripped) hosted on
 * GitHub. Queries run natively so the database never enters JS memory.
 */
@CapacitorPlugin(name = "Palantir")
public class PalantirPlugin extends Plugin {
    private static final String TAG = "Palantir";
    private static final int MAX_ROWS = 2000;
    private static final String PREFS = "octostream_palantir";
    private static final String KEY_LAST_UPDATE = "last_update";

    // 42-byte ZIP local file header for the "settings.xml" entry that upstream
    // strips from the .zm3 archive. Prepending it reconstructs a valid zip; the
    // central directory (which carries the real CRC/sizes) is intact.
    private static final String ZM3_HEADER_B64 =
        "UEsDBBQAAAAIAKJchVngR+RlsfTRAQBwSwUMAAAAc2V0dGluZ3MueG1s";

    // Key material for catalog links: AES-OFB, key = bytes[16:48], IV = bytes[0:16].
    private static final String LINK_KEY_B64 =
        "hTh8uRnL5bX8PZC6Tc3t46nVDFfBpB6Tjw3qazQThpexpg8bLdimevNHj5vJR0nP";

    private File dbFile() {
        return new File(getContext().getFilesDir(), "palantir/moria.db");
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void emitProgress(String phase, long received, long total) {
        JSObject ev = new JSObject();
        ev.put("phase", phase);
        ev.put("received", received);
        ev.put("total", total);
        ev.put("percent", total > 0 ? (received * 100 / total) : -1);
        notifyListeners("palantirProgress", ev);
    }

    private String readDbVersion() {
        SQLiteDatabase db = null;
        Cursor c = null;
        try {
            db = SQLiteDatabase.openDatabase(dbFile().getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
            c = db.rawQuery("SELECT version_addon FROM version LIMIT 1", null);
            if (c.moveToFirst()) return c.getString(0);
        } catch (Exception e) {
            Log.w(TAG, "readDbVersion: " + e.getMessage());
        } finally {
            if (c != null) c.close();
            if (db != null) db.close();
        }
        return "";
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        File f = dbFile();
        JSObject r = new JSObject();
        r.put("installed", f.isFile() && f.length() > 1024);
        r.put("sizeBytes", f.isFile() ? f.length() : 0);
        r.put("lastUpdate", prefs().getString(KEY_LAST_UPDATE, ""));
        r.put("version", f.isFile() ? readDbVersion() : "");
        call.resolve(r);
    }

    @PluginMethod
    public void install(PluginCall call) {
        final String urlStr = call.getString("url");
        if (urlStr == null || !urlStr.startsWith("https://")) {
            call.reject("install requires an https:// url");
            return;
        }
        new Thread(() -> {
            File tmp = null;
            File outTmp = null;
            try {
                File dir = new File(getContext().getCacheDir(), "palantir");
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("cannot create cache dir");
                    return;
                }
                tmp = new File(dir, "moria.zm3");

                HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(60000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "OctoStream-Palantir");
                conn.connect();
                if (conn.getResponseCode() != 200) {
                    call.reject("download failed: HTTP " + conn.getResponseCode());
                    return;
                }
                long total = conn.getContentLengthLong();
                try (InputStream in = conn.getInputStream();
                     FileOutputStream fos = new FileOutputStream(tmp)) {
                    fos.write(Base64.decode(ZM3_HEADER_B64, Base64.DEFAULT));
                    byte[] buf = new byte[128 * 1024];
                    long received = 0, lastEmit = 0;
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        fos.write(buf, 0, n);
                        received += n;
                        if (total > 0 && received >= total) break;
                        if (received - lastEmit >= 1024 * 1024 || received == total) {
                            lastEmit = received;
                            emitProgress("download", received, total);
                        }
                    }
                }
                conn.disconnect();

                // Extract the SQLite payload ("settings.xml") from the rebuilt zip.
                File dbDir = dbFile().getParentFile();
                if (!dbDir.exists() && !dbDir.mkdirs()) {
                    call.reject("cannot create db dir");
                    return;
                }
                outTmp = new File(dbDir, "moria.db.tmp");
                try (ZipFile zip = new ZipFile(tmp)) {
                    ZipEntry entry = zip.getEntry("settings.xml");
                    if (entry == null) {
                        call.reject("zm3 archive has no settings.xml entry");
                        return;
                    }
                    try (InputStream zin = zip.getInputStream(entry);
                         FileOutputStream fos = new FileOutputStream(outTmp)) {
                        byte[] buf = new byte[256 * 1024];
                        long written = 0, lastEmit = 0;
                        long entryTotal = entry.getSize();
                        int n;
                        while ((n = zin.read(buf)) != -1) {
                            fos.write(buf, 0, n);
                            written += n;
                            if (written - lastEmit >= 4 * 1024 * 1024) {
                                lastEmit = written;
                                emitProgress("extract", written, entryTotal);
                            }
                        }
                    }
                }
                File target = dbFile();
                if (target.exists() && !target.delete()) {
                    call.reject("cannot replace existing db");
                    return;
                }
                if (!outTmp.renameTo(target)) {
                    call.reject("cannot move db into place");
                    return;
                }
                JSObject r = new JSObject();
                r.put("ok", true);
                r.put("version", readDbVersion());
                call.resolve(r);
            } catch (Exception e) {
                Log.e(TAG, "install failed", e);
                if (outTmp != null) outTmp.delete();
                call.reject("install failed: " + e.getMessage());
            } finally {
                if (tmp != null) tmp.delete();
            }
        }).start();
    }

    @PluginMethod
    public void query(PluginCall call) {
        String sql = call.getString("sql");
        if (sql == null || !sql.trim().toUpperCase().startsWith("SELECT")) {
            call.reject("only SELECT queries are allowed");
            return;
        }
        JSArray args = call.getArray("args");
        String[] bindArgs = new String[args == null ? 0 : args.length()];
        try {
            for (int i = 0; i < bindArgs.length; i++) {
                Object v = args.get(i);
                bindArgs[i] = v == null ? null : String.valueOf(v);
            }
        } catch (Exception e) {
            call.reject("invalid args: " + e.getMessage());
            return;
        }
        SQLiteDatabase db = null;
        Cursor c = null;
        try {
            File f = dbFile();
            if (!f.isFile()) {
                call.reject("database not installed");
                return;
            }
            db = SQLiteDatabase.openDatabase(f.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
            c = db.rawQuery(sql, bindArgs);
            String[] cols = c.getColumnNames();
            JSArray columns = new JSArray();
            for (String col : cols) columns.put(col);
            JSArray rows = new JSArray();
            while (c.moveToNext() && rows.length() < MAX_ROWS) {
                JSArray row = new JSArray();
                for (int i = 0; i < cols.length; i++) {
                    switch (c.getType(i)) {
                        case Cursor.FIELD_TYPE_INTEGER: row.put(c.getLong(i)); break;
                        case Cursor.FIELD_TYPE_FLOAT:   row.put(c.getDouble(i)); break;
                        case Cursor.FIELD_TYPE_STRING:  row.put(c.getString(i)); break;
                        default:                      row.put(JSONObjectNull.NULL); break;
                    }
                }
                rows.put(row);
            }
            JSObject r = new JSObject();
            r.put("columns", columns);
            r.put("rows", rows);
            call.resolve(r);
        } catch (Exception e) {
            Log.e(TAG, "query failed", e);
            call.reject("query failed: " + e.getMessage());
        } finally {
            if (c != null) c.close();
            if (db != null) db.close();
        }
    }

    @PluginMethod
    public void execScript(PluginCall call) {
        String script = call.getString("sql");
        if (script == null || script.trim().isEmpty()) {
            call.reject("empty script");
            return;
        }
        SQLiteDatabase db = null;
        try {
            File f = dbFile();
            if (!f.isFile()) {
                call.reject("database not installed");
                return;
            }
            db = SQLiteDatabase.openDatabase(f.getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE);
            db.beginTransaction();
            try {
                for (String stmt : splitSql(script)) db.execSQL(stmt);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
            JSObject r = new JSObject();
            r.put("ok", true);
            call.resolve(r);
        } catch (Exception e) {
            Log.e(TAG, "execScript failed", e);
            call.reject("execScript failed: " + e.getMessage());
        } finally {
            if (db != null) db.close();
        }
    }

    /** Splits a SQL script on ';' outside strings/comments. */
    private static List<String> splitSql(String script) {
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean inStr = false;
        int n = script.length();
        for (int i = 0; i < n; i++) {
            char ch = script.charAt(i);
            if (inStr) {
                cur.append(ch);
                if (ch == '\'') {
                    if (i + 1 < n && script.charAt(i + 1) == '\'') { cur.append('\''); i++; }
                    else inStr = false;
                }
            } else if (ch == '\'') {
                inStr = true;
                cur.append(ch);
            } else if (ch == '-' && i + 1 < n && script.charAt(i + 1) == '-') {
                while (i < n && script.charAt(i) != '\n') i++;
            } else if (ch == '/' && i + 1 < n && script.charAt(i + 1) == '*') {
                i += 2;
                while (i + 1 < n && !(script.charAt(i) == '*' && script.charAt(i + 1) == '/')) i++;
                i++;
            } else if (ch == ';') {
                String s = cur.toString().trim();
                if (!s.isEmpty()) out.add(s);
                cur.setLength(0);
            } else {
                cur.append(ch);
            }
        }
        String s = cur.toString().trim();
        if (!s.isEmpty()) out.add(s);
        return out;
    }

    @PluginMethod
    public void decryptLinks(PluginCall call) {
        JSArray links = call.getArray("links");
        if (links == null) {
            call.reject("links array required");
            return;
        }
        try {
            byte[] material = Base64.decode(LINK_KEY_B64, Base64.DEFAULT);
            SecretKeySpec key = new SecretKeySpec(Arrays.copyOfRange(material, 16, 48), "AES");
            IvParameterSpec iv = new IvParameterSpec(Arrays.copyOfRange(material, 0, 16));
            Cipher cipher = Cipher.getInstance("AES/OFB/NoPadding");
            JSArray urls = new JSArray();
            for (int i = 0; i < links.length(); i++) {
                String link = links.optString(i, null);
                if (link == null) { urls.put(JSONObjectNull.NULL); continue; }
                if (link.startsWith("http")) { urls.put(link); continue; }
                try {
                    String padded = link;
                    while (padded.length() % 4 != 0) padded += "=";
                    byte[] cipherBytes = Base64.decode(padded, Base64.URL_SAFE);
                    cipher.init(Cipher.DECRYPT_MODE, key, iv);
                    urls.put(new String(cipher.doFinal(cipherBytes), "UTF-8").trim());
                } catch (Exception e) {
                    urls.put(JSONObjectNull.NULL);
                }
            }
            JSObject r = new JSObject();
            r.put("urls", urls);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("decryptLinks failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setLastUpdate(PluginCall call) {
        String date = call.getString("date", "");
        prefs().edit().putString(KEY_LAST_UPDATE, date).apply();
        call.resolve();
    }

    // android.util.Log uses org.json.JSONObject.NULL indirectly via JSArray; keep a
    // tiny holder so we never import org.json types by name elsewhere.
    private static final class JSONObjectNull {
        static final Object NULL = org.json.JSONObject.NULL;
    }
}
