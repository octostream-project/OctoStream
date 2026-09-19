package com.octostream.torrentengine;

import android.os.Handler;
import android.os.Looper;
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

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
@CapacitorPlugin(name = "TorrentEngine")
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
        final String torrentUrl = url;

        new Thread(() -> {
            try {
                SessionManager sm = ensureSession();
                stopTorrentInternal();

                startProgressPoll();

                // 1. Obtain TorrentInfo
                TorrentInfo ti;
                if (torrentUrl.startsWith("magnet:")) {
                    Log.i(TAG, "fetching magnet metadata…");
                    byte[] data = sm.fetchMagnet(torrentUrl, METADATA_TIMEOUT_S);
                    if (data == null || data.length == 0) throw new Exception("Timeout obteniendo metadatos del magnet");
                    ti = TorrentInfo.bdecode(data);
                } else {
                    byte[] data = downloadTorrentFile(torrentUrl);
                    ti = TorrentInfo.bdecode(data);
                }
                torrentInfo = ti;
                FileStorage fs = ti.files();

                // 2. Pick the file to stream
                int idx = pickFileIndex(fs, season, episode);
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
