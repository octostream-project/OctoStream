package com.octostream.torrentengine;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.util.Log;

import com.frostwire.jlibtorrent.FileStorage;
import com.frostwire.jlibtorrent.Priority;
import com.frostwire.jlibtorrent.SessionHandle;
import com.frostwire.jlibtorrent.SessionManager;
import com.frostwire.jlibtorrent.SessionParams;
import com.frostwire.jlibtorrent.SettingsPack;
import com.frostwire.jlibtorrent.TorrentHandle;
import com.frostwire.jlibtorrent.TorrentInfo;
import com.frostwire.jlibtorrent.TorrentStatus;
import com.frostwire.jlibtorrent.swig.settings_pack;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * P2P torrent streaming engine: jlibtorrent session + local HTTP server on
 * 127.0.0.1 that feeds ExoPlayer. Ranged requests gate on piece availability;
 * missing pieces get deadline-boosted so playback starts while the rest of the
 * file downloads in the background.
 */
@CapacitorPlugin(name = "TorrentEngine", permissions = {
        // Escritura fuera del sandbox para la carpeta de descarga elegida:
        // WRITE_EXTERNAL_STORAGE cubre API <= 29 (permiso runtime); en API
        // 30+ se usa el ajuste "Acceso a todos los archivos" (MANAGE_*).
        @Permission(alias = "storageWrite", strings = {
                Manifest.permission.WRITE_EXTERNAL_STORAGE })
})
public class TorrentEnginePlugin extends Plugin {

    private static final String TAG = "TorrentEngine";

    private static final int METADATA_TIMEOUT_S = 90;
    private static final int TORRENT_DL_TIMEOUT_MS = 30000;
    private static final int PIECE_TIMEOUT_MS = 60000;
    private static final int WINDOW_BYTES = 96 * 1024 * 1024;
    private static final int CHUNK = 128 * 1024;
    private static final int MAX_TORRENT_BYTES = 20 * 1024 * 1024;
    // Caché persistente de descargas parciales (tipo Stremio): los datos
    // sobreviven a stop() y reanudan al volver a abrir el mismo torrent.
    // Se poda por antigüedad y por tamaño total para no llenar el box.
    private static final long CACHE_MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000;
    private static final long CACHE_MAX_BYTES = 3L * 1024 * 1024 * 1024;
    // Caché de TorrentInfo para listFiles→start: sin ella el picker de
    // archivos pagaba el fetchMagnet (~hasta 90s) dos veces seguidas.
    private static final long TI_CACHE_MS = 5L * 60 * 1000;

    private SessionManager session;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    // Active torrent state (null when idle)
    private TorrentHandle th;
    private TorrentInfo torrentInfo;
    private File saveDir;
    private File mediaFile;
    private long fileOffset;
    private long fileSize;
    private int pieceLength;
    private int lastFilePiece;
    private int selectedFileIndex = -1;

    // HTTP server
    private ServerSocket serverSocket;
    private Thread acceptThread;
    private ExecutorService pool;
    private int port = -1;

    // Deadline window bookkeeping
    private final Object windowLock = new Object();
    private final Set<Integer> deadlinePieces = new HashSet<>();
    private int windowPieces = 16;
    private volatile long servedPos = 0;
    private volatile boolean running = false;
    private Runnable progressRunnable;

    // Caché de TorrentInfo (listFiles → start comparten el fetch)
    private TorrentInfo cachedTi;
    private String cachedTiUrl;
    private long cachedTiAt;

    private TorrentInfo fetchTorrentInfo(String url, SessionManager sm) throws Exception {
        if (cachedTi != null && url.equals(cachedTiUrl)
                && System.currentTimeMillis() - cachedTiAt < TI_CACHE_MS) {
            return cachedTi;
        }
        TorrentInfo ti;
        if (url.startsWith("magnet:")) {
            Log.i(TAG, "fetching magnet metadata…");
            byte[] data = sm.fetchMagnet(url, METADATA_TIMEOUT_S);
            if (data == null || data.length == 0) throw new Exception("Timeout obteniendo metadatos del magnet");
            ti = TorrentInfo.bdecode(data);
        } else {
            ti = TorrentInfo.bdecode(downloadTorrentFile(url));
        }
        cachedTi = ti;
        cachedTiUrl = url;
        cachedTiAt = System.currentTimeMillis();
        return ti;
    }

    /**
     * Lista los archivos de vídeo de un torrent para que el usuario elija
     * (packs de temporada con varios .mkv). Solo lee metadatos — el TorrentInfo
     * queda cacheado y start() lo reutiliza si llega con fileIndex.
     */
    @PluginMethod
    public void listFiles(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        new Thread(() -> {
            try {
                SessionManager sm = ensureSession();
                TorrentInfo ti = fetchTorrentInfo(url, sm);
                FileStorage fs = ti.files();
                int n = fs.numFiles();
                JSArray files = new JSArray();
                for (int i = 0; i < n; i++) {
                    if (!isVideoFile(fs.fileName(i).toLowerCase(Locale.ROOT))) continue;
                    JSObject f = new JSObject();
                    f.put("index", i);
                    f.put("name", fs.filePath(i));
                    f.put("size", fs.fileSize(i));
                    files.put(f);
                }
                JSObject ret = new JSObject();
                ret.put("files", files);
                ret.put("infoHash", ti.infoHash().toHex());
                ret.put("numFiles", n);
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "listFiles failed", e);
                call.reject("Torrent: " + e.getMessage());
            }
        }, "torrent-list").start();
    }

    private synchronized SessionManager ensureSession() {
        if (session == null) session = new SessionManager();
        if (!session.isRunning()) {
            SettingsPack sp = new SettingsPack();
            // Streaming en TV: suficiente subida para reciprocidad tit-for-tat
            // sin quemar datos; 64 conexiones bastan para una descarga
            // secuencial y ahorran CPU/memoria frente al default.
            sp.uploadRateLimit(256 * 1024);
            sp.connectionsLimit(128);
            sp.setBoolean(settings_pack.bool_types.enable_dht.swigValue(), true);
            sp.setBoolean(settings_pack.bool_types.enable_lsd.swigValue(), true);
            sp.setBoolean(settings_pack.bool_types.enable_upnp.swigValue(), false);
            sp.setBoolean(settings_pack.bool_types.enable_natpmp.swigValue(), false);
            session.start(new SessionParams(sp));
            Log.i(TAG, "torrent session started");
        }
        return session;
    }

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        final Integer season = call.getInt("season");
        final Integer episode = call.getInt("episode");
        final Integer fileIndexArg = call.getInt("fileIndex");
        final String torrentUrl = url;

        new Thread(() -> {
            try {
                SessionManager sm = ensureSession();
                stopTorrentInternal();

                startProgressPoll();

                // 1. Obtain TorrentInfo (cached si listFiles lo trajo justo antes)
                TorrentInfo ti = fetchTorrentInfo(torrentUrl, sm);
                torrentInfo = ti;
                FileStorage fs = ti.files();

                // 2. Pick the file to stream — el usuario pudo haber elegido
                // uno concreto vía listFiles (fileIndex); si no, auto-pick.
                int idx = (fileIndexArg != null && fileIndexArg >= 0 && fileIndexArg < fs.numFiles())
                        ? fileIndexArg
                        : pickFileIndex(fs, season, episode);
                if (idx < 0) throw new Exception("El torrent no contiene un archivo de vídeo");
                selectedFileIndex = idx;
                fileOffset = fs.fileOffset(idx);
                fileSize = fs.fileSize(idx);
                pieceLength = ti.pieceLength();
                lastFilePiece = (int) ((fileOffset + fileSize - 1) / pieceLength);
                windowPieces = Math.max(8, Math.min(90, (int) (WINDOW_BYTES / pieceLength)));

                // 3. Add torrent with file priorities (only selected file)
                Priority[] pri = new Priority[fs.numFiles()];
                Arrays.fill(pri, Priority.IGNORE);
                pri[idx] = Priority.NORMAL;
                saveDir = new File(getContext().getExternalCacheDir() != null
                        ? getContext().getExternalCacheDir() : getContext().getCacheDir(), "torrents");
                saveDir.mkdirs();
                evictSaveDir(saveDir);

                sm.download(ti, saveDir, null, pri, null);

                // Wait for the handle to appear
                th = null;
                for (int i = 0; i < 100 && th == null; i++) {
                    th = sm.find(ti.infoHash());
                    if (th == null) Thread.sleep(100);
                }
                if (th == null) throw new Exception("No se pudo añadir el torrent a la sesión");
                th.resume();

                mediaFile = new File(saveDir, fs.filePath(idx));
                // Path traversal: filePath viene de metadatos del torrent.
                // libtorrent sanea "..", pero verificamos contención real —
                // el servidor local serviría cualquier archivo del dispositivo.
                String canonSave = saveDir.getCanonicalPath();
                if (!mediaFile.getCanonicalPath().startsWith(canonSave + File.separator)) {
                    throw new Exception("ruta de archivo fuera del directorio de descarga");
                }
                Log.i(TAG, "streaming file " + fs.filePath(idx) + " (" + fileSize + " bytes, pieceLen " + pieceLength + ")");

                // 4. Local HTTP server
                startHttpServer();
                running = true;

                JSObject ret = new JSObject();
                ret.put("url", "http://127.0.0.1:" + port + "/stream");
                ret.put("fileName", fs.fileName(idx));
                ret.put("sizeBytes", fileSize);
                ret.put("infoHash", ti.infoHash().toHex());
                ret.put("fileIndex", idx);
                ret.put("numFiles", fs.numFiles());
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "start failed", e);
                stopProgressPoll();
                cleanupTorrent();
                call.reject("Torrent: " + e.getMessage());
            }
        }, "torrent-start").start();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopTorrentInternal();
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(currentStatus());
    }

    // ------------------------------------------------------------------
    // Descarga offline: baja el archivo elegido al directorio persistente
    // <external-files>/downloads (no caché — no lo toca evictSaveDir).
    // Comparte el slot del motor: iniciar un stream otra descarga lo para.
    // El progreso sale por los eventos 'torrentProgress' de startProgressPoll.
    // ------------------------------------------------------------------

    // Carpeta de descarga elegida por el usuario. Dos modos:
    //  - "download_dir" (ruta real): ideal para jlibtorrent — exige all-files
    //    (API 30+) o WRITE_EXTERNAL_STORAGE (API <= 29).
    //  - "download_tree" (URI SAF): funciona sin permisos especiales; las
    //    descargas HTTP van directas vía ContentResolver y los torrents se
    //    copian al terminar desde el directorio interno.
    private static final String PREFS = "octostream_torrent_engine";

    private File downloadsDir() {
        String custom = getContext().getSharedPreferences(PREFS, 0)
                .getString("download_dir", null);
        if (custom != null) {
            File d = new File(custom);
            if (d.isDirectory() && d.canWrite()) return d;
        }
        File base = getContext().getExternalFilesDir(null);
        if (base == null) base = getContext().getFilesDir();
        return new File(base, "downloads");
    }

    private Uri downloadTree() {
        String t = getContext().getSharedPreferences(PREFS, 0)
                .getString("download_tree", null);
        return t != null ? Uri.parse(t) : null;
    }

    /** Carpeta de descarga actual + si es personalizada + acceso all-files. */
    @PluginMethod
    public void getDownloadDir(PluginCall call) {
        String custom = getContext().getSharedPreferences(PREFS, 0)
                .getString("download_dir", null);
        File d = downloadsDir();
        JSObject ret = new JSObject();
        ret.put("path", d.getAbsolutePath());
        ret.put("custom", custom != null && d.getAbsolutePath().equals(custom));
        boolean access = Build.VERSION.SDK_INT >= 30
                ? Environment.isExternalStorageManager()
                : getPermissionState("storageWrite") == PermissionState.GRANTED;
        ret.put("allFilesAccess", access);
        ret.put("treeMode", downloadTree() != null);
        call.resolve(ret);
    }

    /** Vuelve al directorio privado de la app. */
    @PluginMethod
    public void resetDownloadDir(PluginCall call) {
        getContext().getSharedPreferences(PREFS, 0).edit()
                .remove("download_dir").remove("download_tree").apply();
        call.resolve();
    }

    /**
     * Selector de carpeta (SAF OPEN_DOCUMENT_TREE). Siempre va directo al
     * picker del sistema — sin pantallas de ajustes: en varios Android
     * (GrapheneOS/Storage Scopes, algunos fabricantes) la pantalla de
     * "acceso a todos los archivos" no existe o no devuelve resultado y
     * la llamada quedaba colgada. Si all-files está concedido, el modo de
     * ruta real se activa solo en pickDownloadDirResult.
     */
    @PluginMethod
    public void pickDownloadDir(PluginCall call) {
        if (Build.VERSION.SDK_INT < 30
                && getPermissionState("storageWrite") != PermissionState.GRANTED) {
            requestPermissionForAlias("storageWrite", call, "storagePermCallback");
            return;
        }
        launchDirPicker(call);
    }

    @PermissionCallback
    private void storagePermCallback(PluginCall call) {
        if (call == null) return;
        // Concedido o no, el picker se abre igualmente: sin permiso de
        // escritura se entra en modo SAF (funciona igual para descargas).
        launchDirPicker(call);
    }

    private void launchDirPicker(PluginCall call) {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(call, intent, "pickDownloadDirResult");
        } catch (Exception e) {
            // Sin DocumentsUI o intent no resoluble: reject siempre — una
            // llamada que no se resuelve deja la UI girando para siempre.
            call.reject("No hay selector de carpetas disponible: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void pickDownloadDirResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        try {
            Uri uri = result != null && result.getData() != null ? result.getData().getData() : null;
            if (uri == null) { call.reject("cancelled"); return; }
            try {
                getContext().getContentResolver().takePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) {}
            storeDownloadDir(uri, call);
        } catch (Throwable t) {
            // El callback nunca puede escapar sin resolver/rechazar.
            call.reject("No se pudo usar la carpeta: " + t.getMessage());
        }
    }

    /**
     * Persiste la carpeta elegida con un picker externo (el SAF tree picker
     * vive en el plugin exoplayer — su activity-result está probado en
     * dispositivos donde el de este plugin no devuelve resultado). Acepta
     * "treeUri" (content://.../tree/...): si hay acceso a rutas reales se
     * guarda la ruta; si no, la URI SAF en modo árbol.
     */
    @PluginMethod
    public void setDownloadDir(PluginCall call) {
        String treeUri = call.getString("treeUri");
        if (treeUri == null || !treeUri.startsWith("content://")) {
            call.reject("treeUri inválida");
            return;
        }
        try {
            storeDownloadDir(Uri.parse(treeUri), call);
        } catch (Throwable t) {
            call.reject("No se pudo usar la carpeta: " + t.getMessage());
        }
    }

    private void storeDownloadDir(Uri uri, PluginCall call) {
        String path = treeUriToPath(uri);
        boolean rawAccess = Build.VERSION.SDK_INT >= 30
                ? Environment.isExternalStorageManager()
                : getPermissionState("storageWrite") == PermissionState.GRANTED;
        android.content.SharedPreferences.Editor ed =
                getContext().getSharedPreferences(PREFS, 0).edit();
        JSObject ret = new JSObject();
        if (path != null && rawAccess) {
            File dir = new File(path);
            dir.mkdirs();
            if (!dir.isDirectory() || !dir.canWrite()) {
                call.reject("Sin permiso de escritura en esa carpeta");
                return;
            }
            ed.putString("download_dir", path).remove("download_tree").apply();
            ret.put("path", path);
            ret.put("treeMode", false);
        } else {
            // Modo SAF: sin acceso a rutas reales — la URI persistida basta
            // para leer/escribir vía ContentResolver.
            ed.putString("download_tree", uri.toString()).remove("download_dir").apply();
            ret.put("path", uri.toString());
            ret.put("treeMode", true);
        }
        ret.put("custom", true);
        call.resolve(ret);
    }

    // content://…/tree/primary:Descargas/X → /storage/emulated/0/Descargas/X
    // …/tree/ABCD-1234:X → /storage/ABCD-1234/X (SD/USB OTG).
    private static String treeUriToPath(Uri uri) {
        try {
            String docId = DocumentsContract.getTreeDocumentId(uri);
            if (docId == null) return null;
            String[] parts = docId.split(":", 2);
            String rel = parts.length > 1 ? parts[1] : "";
            if ("primary".equalsIgnoreCase(parts[0])) {
                return new File(Environment.getExternalStorageDirectory(), rel).getAbsolutePath();
            }
            File vol = new File("/storage/" + parts[0]);
            if (vol.isDirectory()) return new File(vol, rel).getAbsolutePath();
        } catch (Throwable ignored) {}
        return null;
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        final Integer season = call.getInt("season");
        final Integer episode = call.getInt("episode");
        final Integer fileIndexArg = call.getInt("fileIndex");
        final String torrentUrl = url;

        new Thread(() -> {
            try {
                SessionManager sm = ensureSession();
                stopTorrentInternal();
                startProgressPoll();

                TorrentInfo ti = fetchTorrentInfo(torrentUrl, sm);
                torrentInfo = ti;
                FileStorage fs = ti.files();
                int idx = (fileIndexArg != null && fileIndexArg >= 0 && fileIndexArg < fs.numFiles())
                        ? fileIndexArg
                        : pickFileIndex(fs, season, episode);
                if (idx < 0) throw new Exception("El torrent no contiene un archivo de vídeo");
                selectedFileIndex = idx;
                fileOffset = fs.fileOffset(idx);
                fileSize = fs.fileSize(idx);
                pieceLength = ti.pieceLength();
                lastFilePiece = (int) ((fileOffset + fileSize - 1) / pieceLength);

                File dir = downloadsDir();
                dir.mkdirs();
                saveDir = dir;

                // Si ya está completo en disco, no añadir nada a la sesión.
                mediaFile = new File(dir, fs.filePath(idx));
                String canonSave = dir.getCanonicalPath();
                if (!mediaFile.getCanonicalPath().startsWith(canonSave + File.separator)) {
                    throw new Exception("ruta de archivo fuera del directorio de descarga");
                }
                if (mediaFile.exists() && mediaFile.length() == fileSize) {
                    JSObject done = new JSObject();
                    done.put("name", fs.filePath(idx));
                    done.put("path", mediaFile.getAbsolutePath());
                    done.put("sizeBytes", fileSize);
                    done.put("infoHash", ti.infoHash().toHex());
                    done.put("fileIndex", idx);
                    done.put("complete", true);
                    call.resolve(done);
                    return;
                }

                Priority[] pri = new Priority[fs.numFiles()];
                Arrays.fill(pri, Priority.IGNORE);
                pri[idx] = Priority.NORMAL;
                sm.download(ti, dir, null, pri, null);

                th = null;
                for (int i = 0; i < 100 && th == null; i++) {
                    th = sm.find(ti.infoHash());
                    if (th == null) Thread.sleep(100);
                }
                if (th == null) throw new Exception("No se pudo añadir el torrent a la sesión");
                th.resume();

                JSObject ret = new JSObject();
                ret.put("name", fs.filePath(idx));
                ret.put("path", mediaFile.getAbsolutePath());
                ret.put("sizeBytes", fileSize);
                ret.put("infoHash", ti.infoHash().toHex());
                ret.put("fileIndex", idx);
                ret.put("complete", false);
                call.resolve(ret);

                // Modo SAF: el motor solo puede escribir en disco real, así
                // que el archivo baja al interno y al completarse se copia
                // al árbol elegido por el usuario y se borra el original.
                final Uri tree = downloadTree();
                final File src = mediaFile;
                if (tree != null) {
                    new Thread(() -> {
                        try {
                            for (;;) {
                                TorrentHandle h = th;
                                if (h == null || !h.isValid() || httpDlCancel) return;
                                if (h.status().progress() >= 1.0f) break;
                                Thread.sleep(2000);
                            }
                            android.content.ContentResolver cr = getContext().getContentResolver();
                            Uri parent = DocumentsContract.buildDocumentUriUsingTree(
                                    tree, DocumentsContract.getTreeDocumentId(tree));
                            String outName = src.getName();
                            Uri doc = DocumentsContract.createDocument(
                                    cr, parent, "application/octet-stream", outName);
                            if (doc == null) return;
                            try (InputStream cin = new java.io.FileInputStream(src);
                                 java.io.OutputStream cout = cr.openOutputStream(doc, "w")) {
                                byte[] cb = new byte[128 * 1024];
                                int crd;
                                while ((crd = cin.read(cb)) >= 0) cout.write(cb, 0, crd);
                            }
                            src.delete();
                        } catch (Throwable t) {
                            Log.e(TAG, "copia a carpeta SAF fallida (queda en interno)", t);
                        }
                    }, "torrent-tree-copy").start();
                }
            } catch (Exception e) {
                Log.e(TAG, "download failed", e);
                cleanupTorrent();
                call.reject("Torrent: " + e.getMessage());
            }
        }, "torrent-download").start();
    }

    /** Lista los vídeos completados o en progreso del directorio de descargas. */
    @PluginMethod
    public void listDownloads(PluginCall call) {
        JSArray files = new JSArray();
        try {
            collectVideoFiles(downloadsDir(), downloadsDir(), files);
            collectTreeVideos(files);
        } catch (Throwable ignored) {}
        call.resolve(new JSObject().put("files", files));
    }

    // Vídeos dentro del árbol SAF elegido (modo sin all-files): se listan
    // por DocumentsContract y su "path" es la URI content:// — playLocalFile
    // ya sabe reproducir esas URIs.
    private void collectTreeVideos(JSArray out) {
        Uri tree = downloadTree();
        if (tree == null) return;
        try {
            android.content.ContentResolver cr = getContext().getContentResolver();
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(
                    tree, DocumentsContract.getTreeDocumentId(tree));
            try (android.database.Cursor c = cr.query(children, new String[] {
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_MIME_TYPE }, null, null, null)) {
                if (c == null) return;
                while (c.moveToNext()) {
                    String name = c.getString(1);
                    long size = c.getLong(2);
                    if (name == null || !isVideoFile(name.toLowerCase(Locale.ROOT)) || size <= 0) continue;
                    Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0));
                    JSObject o = new JSObject();
                    o.put("name", name);
                    o.put("path", doc.toString());
                    o.put("size", size);
                    out.put(o);
                }
            }
        } catch (Throwable ignored) {}
    }

    private void collectVideoFiles(File root, File dir, JSArray out) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File f : children) {
            if (f.isDirectory()) { collectVideoFiles(root, f, out); continue; }
            String name = f.getName().toLowerCase(Locale.ROOT);
            if (!isVideoFile(name) || f.length() <= 0) continue;
            JSObject o = new JSObject();
            String rel = root.toURI().relativize(f.toURI()).getPath();
            o.put("name", rel != null ? rel : f.getName());
            o.put("path", f.getAbsolutePath());
            o.put("size", f.length());
            out.put(o);
        }
    }

    /** Borra un archivo del directorio de descargas (path de listDownloads). */
    @PluginMethod
    public void deleteDownload(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("path is required");
            return;
        }
        try {
            // URIs SAF (modo árbol): se borran por DocumentsContract.
            if (path.startsWith("content://")) {
                boolean deleted = DocumentsContract.deleteDocument(
                        getContext().getContentResolver(), Uri.parse(path));
                call.resolve(new JSObject().put("deleted", deleted));
                return;
            }
            File dir = downloadsDir();
            File f = new File(path);
            String canonSave = dir.getCanonicalPath();
            // Misma contención que en start(): nunca borrar fuera de downloads/.
            if (!f.getCanonicalPath().startsWith(canonSave + File.separator)) {
                call.reject("ruta fuera del directorio de descargas");
                return;
            }
            boolean deleted = f.exists() && f.delete();
            // Limpiar carpetas vacías del pack.
            File parent = f.getParentFile();
            while (parent != null && !parent.getCanonicalPath().equals(canonSave)) {
                if (!parent.delete()) break;
                parent = parent.getParentFile();
            }
            call.resolve(new JSObject().put("deleted", deleted));
        } catch (Exception e) {
            call.reject("delete failed: " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------
    // Descarga directa http(s): enlaces de vídeo progresivo (mp4/mkv/debrid
    // desbloqueado). Mismo directorio y eventos 'torrentProgress' que la
    // descarga torrent. HLS (m3u8) no aplica — solo archivos completos.
    // El .part evita que listDownloads lo muestre hasta terminar.
    // ------------------------------------------------------------------

    private volatile boolean httpDlCancel = false;

    private static String sanitizeName(String name) {
        if (name == null) return null;
        // Sin separadores de ruta ni caracteres que rompen filesystems.
        String s = name.replaceAll("[\\\\/:*?\"<>|]", " ").trim().replaceAll("\\s+", " ");
        if (s.isEmpty() || s.equals(".") || s.equals("..")) return null;
        if (s.length() > 120) s = s.substring(0, 120).trim();
        return s;
    }

    private static String basenameFromUrl(String url) {
        try {
            String p = new URL(url).getPath();
            int i = p.lastIndexOf('/');
            String b = i >= 0 ? p.substring(i + 1) : p;
            b = java.net.URLDecoder.decode(b, "UTF-8");
            return b.isEmpty() ? null : b;
        } catch (Throwable e) {
            return null;
        }
    }

    private static String extOf(String name) {
        int i = name != null ? name.lastIndexOf('.') : -1;
        return (i > 0 && i < name.length() - 1) ? name.substring(i + 1).toLowerCase(Locale.ROOT) : null;
    }

    private void emitHttpProgress(String state, double progress, long done, long total, long rate, String fileName) {
        JSObject o = new JSObject();
        o.put("state", state);
        o.put("progress", progress);
        o.put("downloadRate", rate);
        o.put("uploadRate", 0);
        o.put("peers", 0);
        o.put("seeds", 0);
        o.put("totalDone", done);
        o.put("totalSize", total);
        o.put("fileName", fileName);
        try { notifyListeners("torrentProgress", o); } catch (Throwable ignored) {}
    }

    @PluginMethod
    public void downloadHttp(PluginCall call) {
        final String url = call.getString("url");
        final String nameArg = call.getString("name");
        final JSObject headers = call.getObject("headers");
        if (url == null || (!url.startsWith("http://") && !url.startsWith("https://"))) {
            call.reject("url http(s) requerida");
            return;
        }

        new Thread(() -> {
            try {
                // Mismo slot único que download(): una cosa bajando a la vez.
                stopTorrentInternal();
                httpDlCancel = false;

                String fname = sanitizeName(nameArg);
                if (fname == null) fname = sanitizeName(basenameFromUrl(url));
                if (fname == null) fname = "video";
                // Extensión de vídeo garantizada (debrid URLs suelen acabar sin ella).
                String urlExt = extOf(sanitizeName(basenameFromUrl(url)));
                String nameExt = extOf(fname);
                if (nameExt == null || !isVideoFile("x." + nameExt)) {
                    fname = fname.replaceAll("\\.[^.]*$", "")
                            + "." + (urlExt != null && isVideoFile("x." + urlExt) ? urlExt : "mp4");
                }

                final Uri tree = downloadTree();
                File out = null;
                File part = null;
                Uri partDoc = null;
                if (tree != null) {
                    // Modo SAF: .part para no listar descargas a medias, y
                    // renameDocument al final (mismo patrón que el archivo).
                    android.content.ContentResolver cr = getContext().getContentResolver();
                    Uri parent = DocumentsContract.buildDocumentUriUsingTree(
                            tree, DocumentsContract.getTreeDocumentId(tree));
                    partDoc = DocumentsContract.createDocument(
                            cr, parent, "application/octet-stream", fname + ".part");
                    if (partDoc == null) throw new Exception("no se pudo crear el archivo en la carpeta elegida");
                } else {
                    File dir = downloadsDir();
                    dir.mkdirs();
                    out = new File(dir, fname);
                    String canonSave = dir.getCanonicalPath();
                    if (!out.getCanonicalPath().startsWith(canonSave + File.separator)) {
                        throw new Exception("ruta de archivo fuera del directorio de descarga");
                    }
                    part = new File(dir, fname + ".part");
                }

                // Conexión (respeta el proxy de sistema — WARP — vía propiedades Java).
                HttpURLConnection conn = null;
                String current = url;
                for (int hop = 0; hop <= 5; hop++) {
                    URL u = new URL(current);
                    conn = (HttpURLConnection) u.openConnection();
                    conn.setInstanceFollowRedirects(true);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
                    if (headers != null) {
                        java.util.Iterator<String> keys = headers.keys();
                        while (keys.hasNext()) {
                            String k = keys.next();
                            try {
                                String v = headers.getString(k);
                                if (v != null) conn.setRequestProperty(k, v);
                            } catch (Throwable ignored) {}
                        }
                    }
                    int code = conn.getResponseCode();
                    if (code >= 300 && code < 400) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (loc == null) throw new Exception("redirect sin Location");
                        current = new URL(new URL(current), loc).toString();
                        conn = null;
                        continue;
                    }
                    if (code < 200 || code >= 300) throw new Exception("HTTP " + code);
                    break;
                }
                if (conn == null) throw new Exception("demasiados redirects");

                long total = conn.getContentLengthLong();
                if (out != null && out.exists() && total > 0 && out.length() == total) {
                    conn.disconnect();
                    JSObject done = new JSObject();
                    done.put("name", fname);
                    done.put("path", out.getAbsolutePath());
                    done.put("sizeBytes", out.length());
                    done.put("complete", true);
                    call.resolve(done);
                    return;
                }
                if (out != null && out.exists()) out.delete();
                if (part != null && part.exists()) part.delete();

                emitHttpProgress("downloading", 0, 0, Math.max(total, 0), 0, fname);
                call.resolve(new JSObject()
                        .put("name", fname)
                        .put("path", tree != null ? partDoc.toString() : out.getAbsolutePath())
                        .put("sizeBytes", Math.max(total, 0))
                        .put("complete", false));

                InputStream in = conn.getInputStream();
                java.io.OutputStream fos = tree != null
                        ? getContext().getContentResolver().openOutputStream(partDoc, "w")
                        : new java.io.FileOutputStream(part);
                if (fos == null) throw new Exception("no se pudo abrir el destino de la descarga");
                byte[] buf = new byte[64 * 1024];
                long doneBytes = 0, lastEmit = 0, lastBytes = 0;
                int r;
                try {
                    while ((r = in.read(buf)) >= 0) {
                        if (httpDlCancel) throw new Exception("descarga cancelada");
                        fos.write(buf, 0, r);
                        doneBytes += r;
                        long now = System.currentTimeMillis();
                        if (now - lastEmit >= 1000) {
                            long rate = (doneBytes - lastBytes) * 1000 / Math.max(now - lastEmit, 1);
                            double prog = total > 0 ? Math.min(doneBytes / (double) total, 1.0) : 0;
                            emitHttpProgress("downloading", prog, doneBytes, Math.max(total, 0), rate, fname);
                            lastEmit = now; lastBytes = doneBytes;
                        }
                    }
                    fos.flush();
                } finally {
                    try { fos.close(); } catch (Throwable ignored) {}
                    conn.disconnect();
                }
                if (total > 0 && doneBytes < total) throw new Exception("descarga incompleta: " + doneBytes + " de " + total);
                if (tree != null) {
                    DocumentsContract.renameDocument(
                            getContext().getContentResolver(), partDoc, fname);
                } else if (!part.renameTo(out)) {
                    // renameTo falla en algunos filesystems: copiar + borrar.
                    try (InputStream pin = new java.io.FileInputStream(part);
                         java.io.FileOutputStream pout = new java.io.FileOutputStream(out)) {
                        byte[] cb = new byte[64 * 1024];
                        int cr;
                        while ((cr = pin.read(cb)) >= 0) pout.write(cb, 0, cr);
                    }
                    part.delete();
                }
                emitHttpProgress("finished", 1.0, doneBytes, Math.max(total, doneBytes), 0, fname);
            } catch (Exception e) {
                Log.e(TAG, "downloadHttp failed", e);
                emitHttpProgress("error", 0, 0, 0, 0, "");
                call.reject("Descarga: " + e.getMessage());
            }
        }, "http-download").start();
    }

    @Override
    protected void handleOnPause() {
        // App en background: pausar el swarm. ExoPlayer ya pausó el vídeo;
        // seguir descargando/subiendo quemaría datos y batería.
        try {
            TorrentHandle handle = th;
            if (handle != null && handle.isValid()) handle.pause();
        } catch (Throwable ignored) {}
        super.handleOnPause();
    }

    @Override
    protected void handleOnResume() {
        try {
            TorrentHandle handle = th;
            if (handle != null && handle.isValid()) handle.resume();
        } catch (Throwable ignored) {}
        super.handleOnResume();
    }

    @Override
    protected void handleOnDestroy() {
        stopTorrentInternal();
        try {
            if (session != null) { session.stop(); session = null; }
        } catch (Throwable ignored) {}
        super.handleOnDestroy();
    }

    // ------------------------------------------------------------------
    // Torrent lifecycle
    // ------------------------------------------------------------------

    private void stopTorrentInternal() {
        running = false;
        httpDlCancel = true;
        stopProgressPoll();
        cleanupTorrent();
    }

    private void cleanupTorrent() {
        try {
            if (serverSocket != null) { serverSocket.close(); }
        } catch (Throwable ignored) {}
        serverSocket = null;
        try {
            if (acceptThread != null) { acceptThread.interrupt(); }
        } catch (Throwable ignored) {}
        acceptThread = null;
        try {
            if (pool != null) { pool.shutdownNow(); }
        } catch (Throwable ignored) {}
        pool = null;
        synchronized (windowLock) { deadlinePieces.clear(); }
        try {
            if (session != null && th != null && th.isValid()) {
                // Sin DELETE_FILES: las piezas parciales quedan en caché y la
                // próxima apertura del mismo torrent reanuda al instante
                // (comportamiento tipo Stremio). evictSaveDir() poda por
                // antigüedad/tamaño en el siguiente start().
                session.remove(th);
            }
        } catch (Throwable e) {
            Log.w(TAG, "remove torrent failed: " + e.getMessage());
        }
        th = null;
        torrentInfo = null;
        mediaFile = null;
        selectedFileIndex = -1;
        servedPos = 0;
    }

    private int pickFileIndex(FileStorage fs, Integer season, Integer episode) {
        int n = fs.numFiles();
        int best = -1;
        int bestScore = -1;
        for (int i = 0; i < n; i++) {
            String name = fs.fileName(i).toLowerCase(Locale.ROOT);
            if (!isVideoFile(name)) continue;
            int score = 1;
            if (season != null && episode != null) {
                if (name.matches("(?s).*s0*" + season + "e0*" + episode + "[^0-9].*")) score += 100;
                else if (name.matches("(?s).*[ .\\-_]0*" + season + "x0*" + episode + "[^0-9].*")) score += 100;
                else if (name.matches("(?s).*cap[ií]tulo?[ .\\-_]*0*" + episode + "[^0-9].*")) score += 40;
                else if (season == 1 && name.matches("(?s).*[ .\\-_]e?0*" + episode + "[ .\\-_].*")) score += 10;
            }
            if (score > bestScore || (score == bestScore && best >= 0 && fs.fileSize(i) > fs.fileSize(best))) {
                best = i;
                bestScore = score;
            }
        }
        if (best < 0) {
            // No video files — fall back to the largest file in the torrent
            for (int i = 0; i < n; i++) {
                if (best < 0 || fs.fileSize(i) > fs.fileSize(best)) best = i;
            }
        }
        return best;
    }

    private static void deleteEmptyDirs(File dir) {
        File[] children = dir.listFiles();
        if (children != null) {
            for (File c : children) {
                if (c.isDirectory()) deleteEmptyDirs(c);
            }
        }
        File[] left = dir.listFiles();
        if (left == null || left.length == 0) dir.delete();
    }

    private static long dirSize(File f) {
        if (f.isFile()) return f.length();
        long total = 0;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) total += dirSize(c);
        return total;
    }

    private static void deleteRecursive(File f) {
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteRecursive(c);
        }
        f.delete();
    }

    // Poda de la caché de torrents: borra entradas con más de CACHE_MAX_AGE_MS
    // y luego las más viejas hasta quedar por debajo de CACHE_MAX_BYTES.
    private static void evictSaveDir(File dir) {
        try {
            File[] entries = dir.listFiles();
            if (entries == null) return;
            long now = System.currentTimeMillis();
            long total = 0;
            java.util.List<File> kept = new java.util.ArrayList<>();
            for (File e : entries) {
                if (now - e.lastModified() > CACHE_MAX_AGE_MS) {
                    deleteRecursive(e);
                } else {
                    kept.add(e);
                    total += dirSize(e);
                }
            }
            kept.sort((a, b) -> Long.compare(a.lastModified(), b.lastModified()));
            for (File e : kept) {
                if (total <= CACHE_MAX_BYTES) break;
                total -= dirSize(e);
                deleteRecursive(e);
            }
        } catch (Throwable t) {
            Log.w(TAG, "cache eviction failed: " + t.getMessage());
        }
    }

    private static boolean isVideoFile(String name) {
        return name.matches(".*\\.(mp4|mkv|avi|m4v|wmv|mov|ts|mpg|mpeg|webm|flv|vob|m2ts)$");
    }

    private byte[] downloadTorrentFile(String url) throws Exception {
        HttpURLConnection conn = null;
        try {
            URL u = new URL(url);
            String proto = u.getProtocol();
            if (!proto.equals("http") && !proto.equals("https")) {
                throw new Exception("esquema no permitido: " + proto);
            }
            conn = (HttpURLConnection) u.openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(TORRENT_DL_TIMEOUT_MS);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
            conn.setRequestProperty("Accept", "application/x-bittorrent,application/octet-stream,*/*");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 400) throw new Exception("HTTP " + code + " descargando el .torrent");
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int total = 0, r;
            while ((r = in.read(buf)) >= 0) {
                total += r;
                if (total > MAX_TORRENT_BYTES) throw new Exception(".torrent demasiado grande");
                bos.write(buf, 0, r);
            }
            byte[] data = bos.toByteArray();
            if (data.length < 20 || data[0] != 'd') throw new Exception("El archivo descargado no es un .torrent válido");
            return data;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    // ------------------------------------------------------------------
    // Piece scheduling
    // ------------------------------------------------------------------

    private void updateWindow(int startPiece) {
        synchronized (windowLock) {
            for (int p : deadlinePieces) {
                if (p < startPiece || p >= startPiece + windowPieces) {
                    try {
                        th.resetPieceDeadline(p);
                        th.piecePriority(p, Priority.NORMAL);
                    } catch (Throwable ignored) {}
                }
            }
            deadlinePieces.clear();
            for (int i = 0; i < windowPieces; i++) {
                int p = startPiece + i;
                if (p > lastFilePiece) break;
                try {
                    if (!th.havePiece(p)) {
                        th.piecePriority(p, Priority.SEVEN);
                        th.setPieceDeadline(p, i * 100);
                        deadlinePieces.add(p);
                    }
                } catch (Throwable ignored) {}
            }
        }
    }

    private boolean ensurePiece(int piece) throws InterruptedException {
        TorrentHandle handle = th;
        if (handle == null || !handle.isValid()) return false;
        if (handle.havePiece(piece)) return true;
        updateWindow(piece);
        long deadline = System.currentTimeMillis() + PIECE_TIMEOUT_MS;
        while (running) {
            if (handle.havePiece(piece)) return true;
            if (System.currentTimeMillis() > deadline) {
                Log.w(TAG, "piece " + piece + " timed out");
                return false;
            }
            Thread.sleep(40);
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Local HTTP server (Range-aware, piece-gated)
    // ------------------------------------------------------------------

    private void startHttpServer() throws Exception {
        final ServerSocket ss = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        serverSocket = ss;
        port = ss.getLocalPort();
        final ExecutorService exec = Executors.newFixedThreadPool(8);
        pool = exec;
        running = true;
        acceptThread = new Thread(() -> {
            // Capturar ss/exec: cleanupTorrent() anula los campos mientras este
            // hilo sigue en el while — usar los campos provocaba un NPE fatal.
            while (!ss.isClosed()) {
                try {
                    Socket s = ss.accept();
                    exec.execute(() -> handleConnection(s));
                } catch (Exception e) {
                    if (!ss.isClosed()) Log.w(TAG, "accept failed: " + e.getMessage());
                }
            }
        }, "torrent-http-accept");
        acceptThread.start();
        Log.i(TAG, "torrent http server on 127.0.0.1:" + port);
    }

    private void handleConnection(Socket s) {
        try (Socket socket = s) {
            socket.setSoTimeout(30000);
            InputStream in = socket.getInputStream();
            // Read request headers (cap 16KB)
            ByteArrayOutputStream headerBuf = new ByteArrayOutputStream();
            int b;
            int matched = 0;
            byte[] end = {'\r', '\n', '\r', '\n'};
            while (headerBuf.size() < 16384 && (b = in.read()) >= 0) {
                headerBuf.write(b);
                matched = (b == end[matched]) ? matched + 1 : (b == '\r' ? 1 : 0);
                if (matched == 4) break;
            }
            String headers = headerBuf.toString("ISO-8859-1");
            String[] lines = headers.split("\r\n");
            if (lines.length == 0) return;
            String[] req = lines[0].split(" ");
            if (req.length < 2 || !req[0].equalsIgnoreCase("GET")) {
                writeResponse(socket, 405, null, 0, 0, 0);
                return;
            }

            long rangeStart = 0;
            long rangeEnd = fileSize - 1;
            for (String line : lines) {
                if (line.regionMatches(true, 0, "Range:", 0, 6)) {
                    String v = line.substring(6).trim();
                    if (v.startsWith("bytes=")) {
                        String[] parts = v.substring(6).split("-", 2);
                        try {
                            if (!parts[0].isEmpty()) rangeStart = Long.parseLong(parts[0].trim());
                            if (parts.length > 1 && !parts[1].isEmpty()) rangeEnd = Long.parseLong(parts[1].trim());
                        } catch (NumberFormatException ignored) {}
                    }
                }
            }
            if (rangeStart < 0) rangeStart = 0;
            if (rangeEnd >= fileSize) rangeEnd = fileSize - 1;
            if (rangeStart > rangeEnd || mediaFile == null || !mediaFile.exists() && !waitForFile()) {
                writeResponse(socket, 416, null, 0, 0, 0);
                return;
            }
            servedPos = rangeStart;

            java.io.OutputStream out = socket.getOutputStream();
            writeResponse(socket, 206, out == null ? null : out, rangeStart, rangeEnd, fileSize);

            RandomAccessFile raf = new RandomAccessFile(mediaFile, "r");
            try {
                byte[] buf = new byte[CHUNK];
                long pos = rangeStart;
                int lastWindowStart = -1;
                while (pos <= rangeEnd && running) {
                    int piece = (int) ((fileOffset + pos) / pieceLength);
                    if (!ensurePiece(piece)) break;
                    if (piece != lastWindowStart) {
                        lastWindowStart = piece;
                        updateWindow(piece);
                    }
                    long pieceFileEnd = Math.min(fileSize, ((long) (piece + 1) * pieceLength) - fileOffset);
                    long chunkEnd = Math.min(rangeEnd, Math.min(pos + CHUNK - 1, pieceFileEnd - 1));
                    int len = (int) (chunkEnd - pos + 1);
                    if (len <= 0) break;
                    raf.seek(pos);
                    raf.readFully(buf, 0, len);
                    out.write(buf, 0, len);
                    out.flush();
                    pos = chunkEnd + 1;
                    servedPos = pos;
                }
            } finally {
                raf.close();
            }
        } catch (Exception e) {
            // Client disconnects and piece timeouts are normal — log short
            if (running) Log.d(TAG, "conn closed: " + e.getMessage());
        }
    }

    // Media files only materialize once their first piece lands
    private boolean waitForFile() {
        long deadline = System.currentTimeMillis() + PIECE_TIMEOUT_MS;
        while (running && mediaFile != null && !mediaFile.exists()) {
            if (System.currentTimeMillis() > deadline) return false;
            try { Thread.sleep(100); } catch (InterruptedException e) { return false; }
        }
        return mediaFile != null && mediaFile.exists();
    }

    private void writeResponse(Socket socket, int code, java.io.OutputStream out,
                             long rangeStart, long rangeEnd, long total) {
        try {
            java.io.OutputStream o = out != null ? out : socket.getOutputStream();
            String status = code == 206 ? "206 Partial Content" : code == 200 ? "200 OK" : code == 416 ? "416 Range Not Satisfiable" : "405 Method Not Allowed";
            StringBuilder sb = new StringBuilder();
            sb.append("HTTP/1.1 ").append(status).append("\r\n");
            if (code == 206 || code == 200) {
                sb.append("Content-Type: video/mp4\r\n");
                sb.append("Accept-Ranges: bytes\r\n");
                sb.append("Content-Length: ").append(rangeEnd - rangeStart + 1).append("\r\n");
                if (code == 206) sb.append("Content-Range: bytes ").append(rangeStart).append('-').append(rangeEnd).append('/').append(total).append("\r\n");
            }
            sb.append("Connection: close\r\n\r\n");
            o.write(sb.toString().getBytes("ISO-8859-1"));
            o.flush();
        } catch (Exception ignored) {}
    }

    // ------------------------------------------------------------------
    // Progress events
    // ------------------------------------------------------------------

    private void startProgressPoll() {
        stopProgressPoll();
        progressRunnable = new Runnable() {
            @Override
            public void run() {
                try {
                    notifyListeners("torrentProgress", currentStatus());
                } catch (Throwable ignored) {}
                // 2s bastan: la UI de predescarga no necesita más frecuencia y
                // el watchdog de 0 peers usa umbral de 75s.
                mainHandler.postDelayed(this, 2000);
            }
        };
        mainHandler.postDelayed(progressRunnable, 2000);
    }

    private void stopProgressPoll() {
        if (progressRunnable != null) {
            mainHandler.removeCallbacks(progressRunnable);
            progressRunnable = null;
        }
    }

    private JSObject currentStatus() {
        JSObject o = new JSObject();
        TorrentHandle handle = th;
        if (handle == null || !handle.isValid()) {
            o.put("state", torrentInfo == null ? "metadata" : "connecting");
            o.put("progress", 0);
            o.put("downloadRate", 0);
            o.put("uploadRate", 0);
            o.put("peers", 0);
            o.put("seeds", 0);
            o.put("totalDone", 0);
            o.put("totalSize", 0);
            o.put("fileName", "");
            return o;
        }
        try {
            TorrentStatus st = handle.status();
            o.put("state", st.state() != null ? st.state().name().toLowerCase(Locale.ROOT) : "unknown");
            o.put("progress", st.progress());
            o.put("downloadRate", st.downloadRate());
            o.put("uploadRate", st.uploadRate());
            o.put("peers", st.numPeers());
            o.put("seeds", st.numSeeds());
            o.put("totalDone", st.totalDone());
            o.put("totalSize", fileSize);
            o.put("fileName", mediaFile != null ? mediaFile.getName() : "");
        } catch (Throwable e) {
            o.put("state", "error");
            o.put("progress", 0);
            o.put("downloadRate", 0);
            o.put("uploadRate", 0);
            o.put("peers", 0);
            o.put("seeds", 0);
            o.put("totalDone", 0);
            o.put("totalSize", fileSize);
            o.put("fileName", "");
        }
        return o;
    }
}
