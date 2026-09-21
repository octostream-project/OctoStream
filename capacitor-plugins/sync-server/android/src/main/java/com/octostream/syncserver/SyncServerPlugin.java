package com.octostream.syncserver;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.content.Context;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;
import fi.iki.elonen.NanoHTTPD;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Enumeration;
import java.util.UUID;

@CapacitorPlugin(name = "SyncServer")
public class SyncServerPlugin extends Plugin {

    private static final String TAG = "SyncServer";
    private static final int PORT = 8765;
    private static final int DISC_PORT = 8766;

    private SyncHttpServer server;
    private volatile String localData = null;
    private volatile String receivedData = null;

    // ── Identidad del dispositivo (estilo LocalSend) ─────────────────────
    // deviceId (UUID) + alias legible ("Pulpo Sabio") + secreto del que se
    // deriva el fingerprint mostrado al emparejar. Persistidos la primera vez.
    private String deviceId;
    private String deviceAlias;
    private String deviceFingerprint;

    private static final String[] ALIAS_ADJ = {
        "Sabio", "Veloz", "Curioso", "Valiente", "Tranquilo", "Alegre",
        "Astuto", "Noble", "Sereno", "Agil", "Amable", "Brillante",
        "Audaz", "Dormilon", "Fiel", "Inquieto",
    };
    private static final String[] ALIAS_ANIMAL = {
        "Pulpo", "Calamar", "Medusa", "Delfin", "Orca", "Ballena",
        "Cangrejo", "Tortuga", "Tiburon", "Mantarraya", "Foca",
        "Caballito", "Erizo", "Estrella", "Camaron", "Pez Luna",
    };

    private void loadIdentity() {
        if (deviceId != null) return;
        android.content.SharedPreferences p =
            getContext().getSharedPreferences("octostream_sync", Context.MODE_PRIVATE);
        String id = p.getString("device_id", null);
        String alias = p.getString("device_alias", null);
        String secret = p.getString("device_secret", null);
        if (id == null || alias == null || secret == null) {
            id = UUID.randomUUID().toString();
            java.util.Random r = new java.util.Random();
            alias = ALIAS_ANIMAL[r.nextInt(ALIAS_ANIMAL.length)]
                  + " " + ALIAS_ADJ[r.nextInt(ALIAS_ADJ.length)];
            secret = randomHex(32);
            p.edit().putString("device_id", id)
                    .putString("device_alias", alias)
                    .putString("device_secret", secret).apply();
        }
        deviceId = id;
        deviceAlias = alias;
        deviceFingerprint = fingerprintOf(secret);
    }

    private static String randomHex(int len) {
        StringBuilder sb = new StringBuilder(len);
        java.security.SecureRandom r = new java.security.SecureRandom();
        for (int i = 0; i < len; i++) sb.append("0123456789abcdef".charAt(r.nextInt(16)));
        return sb.toString();
    }

    private static String fingerprintOf(String secret) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] h = md.digest(secret.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 4; i++) sb.append(String.format("%02x", h[i]));
            String hex = sb.toString().toUpperCase(java.util.Locale.ROOT);
            return hex.substring(0, 4) + "-" + hex.substring(4); // "A1B2-C3D4"
        } catch (Exception e) {
            return "????-????";
        }
    }

    // ── Dispositivos emparejados por identidad ───────────────────────────
    // deviceId → {alias, token, fingerprint}. El token lo emite ESTE
    // dispositivo al aceptar el emparejamiento y el remoto lo manda como
    // cabecera X-Pair-Token — la autorización ya no depende de la IP (que el
    // DHCP puede reasignar o un equipo de la LAN puede suplantar).
    private final java.util.Map<String, JSONObject> pairedDevices =
            java.util.Collections.synchronizedMap(new java.util.HashMap<>());
    // Emparejamientos pendientes de respuesta del usuario (deviceId → datos).
    private final java.util.Map<String, JSONObject> pendingPairs =
            java.util.Collections.synchronizedMap(new java.util.HashMap<>());
    // deviceIds rechazados esta sesión: respuesta inmediata sin re-notificar.
    private final java.util.Set<String> deniedDevices =
            java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    private boolean pairedLoaded = false;

    private void loadPaired() {
        if (pairedLoaded) return;
        pairedLoaded = true;
        try {
            String raw = getContext().getSharedPreferences("octostream_sync", Context.MODE_PRIVATE)
                    .getString("paired_devices", "{}");
            JSONObject all = new JSONObject(raw);
            for (java.util.Iterator<String> it = all.keys(); it.hasNext();) {
                String k = it.next();
                pairedDevices.put(k, all.getJSONObject(k));
            }
        } catch (Throwable ignored) {}
    }

    private void savePaired() {
        try {
            JSONObject all = new JSONObject();
            synchronized (pairedDevices) {
                for (java.util.Map.Entry<String, JSONObject> e : pairedDevices.entrySet()) {
                    all.put(e.getKey(), e.getValue());
                }
            }
            getContext().getSharedPreferences("octostream_sync", Context.MODE_PRIVATE)
                    .edit().putString("paired_devices", all.toString()).apply();
        } catch (Throwable ignored) {}
    }

    // Autorización: token de emparejamiento (nuevo) o IP en whitelist (legacy,
    // dispositivos emparejados con versiones anteriores).
    private boolean isAuthorized(NanoHTTPD.IHTTPSession session) {
        String devId = session.getHeaders().get("x-device-id");
        String token = session.getHeaders().get("x-pair-token");
        if (devId != null && token != null) {
            loadPaired();
            JSONObject d = pairedDevices.get(devId);
            if (d != null && token.equals(d.optString("token"))) return true;
        }
        return isAllowed(session.getRemoteIpAddress());
    }

    // IPs autorizadas por el usuario (persistidas). Solo ellas pueden usar
    // /play, /stop y /sync — sin esto cualquier equipo de la LAN (o cualquier
    // página web abierta en un navegador de la red, vía CORS *) podía
    // reproducir URLs arbitrarias o leer el historial de este dispositivo.
    // NanoHTTPD atiende cada petición en un hilo distinto: colecciones
    // sincronizadas para evitar races entre peticiones concurrentes.
    private final java.util.Set<String> allowedIps =
            java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    // IPs rechazadas esta sesión: 403 silencioso sin re-notificar a JS.
    private final java.util.Set<String> deniedIps =
            java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    // Cooldown anti-spam: máx. una notificación pairRequest por IP cada 30s.
    private final java.util.Map<String, Long> pairCooldown =
            java.util.Collections.synchronizedMap(new java.util.HashMap<>());
    private boolean prefsLoaded = false;

    private void loadAllowed() {
        if (prefsLoaded) return;
        prefsLoaded = true;
        try {
            String csv = getContext().getSharedPreferences("octostream_sync", Context.MODE_PRIVATE)
                    .getString("allowed_ips", "");
            if (csv != null) {
                for (String ip : csv.split(",")) {
                    if (!ip.isEmpty()) allowedIps.add(ip);
                }
            }
        } catch (Throwable ignored) {}
    }

    private void saveAllowed() {
        try {
            getContext().getSharedPreferences("octostream_sync", Context.MODE_PRIVATE)
                    .edit().putString("allowed_ips", android.text.TextUtils.join(",", allowedIps)).apply();
        } catch (Throwable ignored) {}
    }

    private boolean isAllowed(String ip) {
        loadAllowed();
        return ip != null && allowedIps.contains(ip);
    }

    // Anti-CSRF: un dispositivo ya emparejado puede navegar a una web maliciosa
    // y esa página podría llamar a /play o leer /sync vía CORS *. Los clientes
    // legítimos son la app nativa (sin Origin) y el receptor web servido desde
    // la propia LAN (origen localhost/privado/capacitor). Cualquier otro
    // Origin (p. ej. https://attacker.example) se rechaza.
    private static boolean isLocalOrigin(String origin) {
        if (origin == null || origin.isEmpty()) return true; // clientes nativos/curl
        String o = origin.toLowerCase(java.util.Locale.ROOT);
        if (o.startsWith("capacitor://") || o.startsWith("ionic://")) return true;
        // "null" (iframes sandboxed, data:, redirects opacas) NO es de confianza.
        String host;
        try {
            host = new java.net.URI(o).getHost();
        } catch (Exception e) {
            return false;
        }
        if (host == null) return false;
        host = host.toLowerCase(java.util.Locale.ROOT);
        if (host.equals("localhost") || host.endsWith(".localhost")) return true;
        if (host.startsWith("127.") || host.equals("::1") || host.equals("[::1]")) return true;
        if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
        if (host.matches("^172\\.(1[6-9]|2[0-9]|3[01])\\..*")) return true;
        if (host.startsWith("169.254.") || host.startsWith("fe80:") || host.startsWith("[fe80:")) return true;
        if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("[fc") || host.startsWith("[fd")) return true;
        return false;
    }

    // Avisa a JS de que un dispositivo no emparejado quiere interactuar.
    // JS muestra un diálogo de aceptación y llama a allowDevice().
    private void notifyPairRequest(String ip, String endpoint, String data) {
        long now = System.currentTimeMillis();
        synchronized (pairCooldown) {
            Long last = pairCooldown.get(ip);
            if (last != null && now - last < 30000) return;
            pairCooldown.put(ip, now);
        }
        JSObject ev = new JSObject();
        ev.put("ip", ip);
        ev.put("endpoint", endpoint);
        if (data != null) ev.put("data", data);
        notifyListeners("pairRequest", ev);
    }

    private static NanoHTTPD.Response forbidden() {
        return NanoHTTPD.newFixedLengthResponse(NanoHTTPD.Response.Status.FORBIDDEN, "application/json",
            "{\"ok\":false,\"needsPair\":true}");
    }

    // Simple HTTP server using NanoHTTPD
    private class SyncHttpServer extends NanoHTTPD {
        public SyncHttpServer(int port) {
            super(port);
        }

        @Override
        public Response serve(IHTTPSession session) {
            String uri = session.getUri();
            Method method = session.getMethod();

            Log.i(TAG, "Request: " + method + " " + uri);

            // Anti-CSRF: los endpoints con datos/acciones exigen un Origin
            // local (o ninguno: cliente nativo). /ping queda abierto para
            // descubrimiento — no expone nada sensible.
            String origin = session.getHeaders().get("origin");
            if (!uri.equals("/ping") && !isLocalOrigin(origin)) {
                return newFixedLengthResponse(Response.Status.FORBIDDEN,
                    "application/json", "{\"ok\":false,\"badOrigin\":true}");
            }

            // CORS headers
            Response res;

            // Preflight CORS: sin esto los fetch desde navegador (receptor web)
            // con Content-Type: json fallan antes de llegar al endpoint.
            if (method == Method.OPTIONS) {
                res = newFixedLengthResponse(Response.Status.OK, "text/plain", "");
            } else if (uri.equals("/pair") && method == Method.POST) {
                // Emparejamiento estilo LocalSend: el emisor se presenta con
                // {deviceId, alias, fingerprint}. Si ya está emparejado se le
                // devuelve su token; si no, se notifica pairRequest y el
                // emisor re-pregunta hasta que el usuario acepta o rechaza.
                try {
                    String body = readBody(session);
                    JSONObject j = new JSONObject(body);
                    String devId = j.optString("deviceId", "");
                    if (devId.isEmpty()) {
                        res = newFixedLengthResponse(Response.Status.BAD_REQUEST,
                            "application/json", "{\"ok\":false}");
                    } else {
                        loadPaired();
                        JSONObject known = pairedDevices.get(devId);
                        if (known != null) {
                            JSONObject ok = new JSONObject();
                            ok.put("ok", true);
                            ok.put("token", known.optString("token"));
                            ok.put("deviceId", deviceId);
                            ok.put("alias", deviceAlias);
                            ok.put("fingerprint", deviceFingerprint);
                            res = newFixedLengthResponse(Response.Status.OK,
                                "application/json", ok.toString());
                        } else if (deniedDevices.contains(devId)) {
                            res = newFixedLengthResponse(Response.Status.FORBIDDEN,
                                "application/json", "{\"ok\":false,\"denied\":true}");
                        } else {
                            if (!pendingPairs.containsKey(devId)) {
                                JSONObject pp = new JSONObject();
                                pp.put("ip", session.getRemoteIpAddress());
                                pp.put("alias", j.optString("alias", ""));
                                pp.put("fingerprint", j.optString("fingerprint", ""));
                                pendingPairs.put(devId, pp);
                                JSObject ev = new JSObject();
                                ev.put("ip", session.getRemoteIpAddress());
                                ev.put("endpoint", "pair");
                                ev.put("deviceId", devId);
                                ev.put("alias", j.optString("alias", ""));
                                ev.put("fingerprint", j.optString("fingerprint", ""));
                                notifyListeners("pairRequest", ev);
                            }
                            res = newFixedLengthResponse(Response.Status.ACCEPTED,
                                "application/json", "{\"ok\":false,\"pending\":true}");
                        }
                    }
                } catch (Exception e) {
                    res = newFixedLengthResponse(Response.Status.BAD_REQUEST,
                        "application/json", "{\"ok\":false}");
                }
            } else if (uri.equals("/sync") && method == Method.GET) {
                // Datos privados (historial/favoritos) — token o IP autorizada.
                String remoteIp = session.getRemoteIpAddress();
                if (!isAuthorized(session)) {
                    if (!deniedIps.contains(remoteIp)) notifyPairRequest(remoteIp, "sync", null);
                    res = forbidden();
                } else {
                    String data = getLocalData();
                    res = newFixedLengthResponse(Response.Status.OK, "application/json", data);
                }
            } else if (uri.equals("/sync") && method == Method.POST) {
                // Receive data from the other device
                try {
                    String body = readBody(session);
                    String remoteIp = session.getRemoteIpAddress();
                    if (!isAuthorized(session)) {
                        if (!deniedIps.contains(remoteIp)) notifyPairRequest(remoteIp, "sync", body);
                        res = forbidden();
                    } else {
                        receivedData = body;
                        // Notify JS
                        JSObject ev = new JSObject();
                        ev.put("data", body);
                        notifyListeners("syncDataReceived", ev);
                        res = newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}");
                    }
                } catch (Exception e) {
                    Log.e(TAG, "POST error: " + e.getMessage());
                    res = newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json", "{\"error\":\"" + e.getMessage() + "\"}");
                }
            } else if (uri.equals("/play") && method == Method.POST) {
                // Reproduce un stream recibido de otro OctoStream en la LAN
                try {
                    String body = readBody(session);
                    String remoteIp = session.getRemoteIpAddress();
                    if (!isAuthorized(session)) {
                        // El body va en el evento: si el usuario acepta, JS
                        // reproduce directamente sin reintento del emisor.
                        if (!deniedIps.contains(remoteIp)) notifyPairRequest(remoteIp, "play", body);
                        res = forbidden();
                    } else {
                        JSONObject json = new JSONObject(body);
                        JSObject ev = new JSObject();
                        ev.put("url", json.optString("url"));
                        ev.put("title", json.optString("title"));
                        ev.put("type", json.optString("type", "hls"));
                        ev.put("mode", json.optString("mode", "live"));
                        ev.put("imdbId", json.optString("imdbId"));
                        ev.put("season", json.optInt("season", 0));
                        ev.put("episode", json.optInt("episode", 0));
                        notifyListeners("playReceived", ev);
                        res = newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}");
                    }
                } catch (Exception e) {
                    Log.e(TAG, "play error: " + e.getMessage());
                    res = newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json", "{\"ok\":false}");
                }
            } else if (uri.equals("/stop") && method == Method.POST) {
                if (!isAuthorized(session)) {
                    res = forbidden(); // sin prompt: un stop ajeno no pide pairing
                } else {
                    notifyListeners("stopReceived", new JSObject());
                    res = newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}");
                }
            } else if (uri.equals("/ping") && method == Method.GET) {
                loadIdentity();
                JSONObject pong = new JSONObject();
                try {
                    pong.put("ok", true);
                    pong.put("name", deviceAlias);
                    pong.put("alias", deviceAlias);
                    pong.put("deviceId", deviceId);
                    pong.put("fingerprint", deviceFingerprint);
                    pong.put("model", android.os.Build.MODEL.replace("\"", ""));
                    pong.put("port", PORT);
                } catch (Exception ignored) {}
                res = newFixedLengthResponse(Response.Status.OK, "application/json", pong.toString());
            } else {
                res = newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found");
            }

            // CORS: se refleja el Origin local validado en vez de * (una web
            // externa ya no puede leer /sync ni disparar /play desde el
            // navegador de un equipo emparejado). /ping queda abierto.
            if (uri.equals("/ping")) {
                res.addHeader("Access-Control-Allow-Origin", "*");
            } else if (origin != null) {
                res.addHeader("Access-Control-Allow-Origin", origin);
                res.addHeader("Vary", "Origin");
            }
            res.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.addHeader("Access-Control-Allow-Headers", "Content-Type");
            return res;
        }
    }

    private static String readBody(NanoHTTPD.IHTTPSession session) throws Exception {
        int contentLen;
        try {
            contentLen = Integer.parseInt(session.getHeaders().getOrDefault("content-length", "0"));
        } catch (NumberFormatException e) {
            throw new Exception("Invalid content-length");
        }
        // Cap body size: un Content-Length enorme agotaría la memoria del TV.
        if (contentLen < 0 || contentLen > 4 * 1024 * 1024) {
            throw new Exception("Body too large");
        }
        byte[] buf = new byte[contentLen];
        int read = 0;
        while (read < contentLen) {
            int n = session.getInputStream().read(buf, read, contentLen - read);
            if (n < 0) break;
            read += n;
        }
        return new String(buf, 0, read, "UTF-8");
    }

    private String getLocalData() {
        // The JS side will set this via setLocalData
        if (localData != null) return localData;
        return "{}";
    }

    @PluginMethod
    public void start(PluginCall call) {
        try {
            loadIdentity();
            if (server == null) {
                server = new SyncHttpServer(PORT);
                server.start();
                Log.i(TAG, "Sync server started on port " + PORT);
            }
            startDiscovery();
            JSObject ret = new JSObject();
            ret.put("port", PORT);
            ret.put("ip", getLocalIpAddress());
            ret.put("url", "http://" + getLocalIpAddress() + ":" + PORT);
            ret.put("deviceId", deviceId);
            ret.put("alias", deviceAlias);
            ret.put("fingerprint", deviceFingerprint);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Failed to start server: " + e.getMessage());
            call.reject("Failed to start: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            if (server != null) {
                server.stop();
                server = null;
                Log.i(TAG, "Sync server stopped");
            }
            stopDiscovery();
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to stop: " + e.getMessage());
        }
    }

    // ── Identidad ────────────────────────────────────────────────────────
    @PluginMethod
    public void getDeviceInfo(PluginCall call) {
        loadIdentity();
        JSObject ret = new JSObject();
        ret.put("deviceId", deviceId);
        ret.put("alias", deviceAlias);
        ret.put("fingerprint", deviceFingerprint);
        ret.put("ip", getLocalIpAddress());
        ret.put("port", PORT);
        ret.put("url", "http://" + getLocalIpAddress() + ":" + PORT);
        call.resolve(ret);
    }

    // Respuesta del diálogo de emparejamiento con identidad (endpoint /pair).
    @PluginMethod
    public void answerPair(PluginCall call) {
        String devId = call.getString("deviceId");
        if (devId == null || devId.isEmpty()) {
            call.reject("deviceId is required");
            return;
        }
        boolean allow = call.getBoolean("allow", true);
        JSONObject pp = pendingPairs.remove(devId);
        if (allow) {
            try {
                JSONObject d = new JSONObject();
                d.put("alias", pp != null ? pp.optString("alias") : "");
                d.put("fingerprint", pp != null ? pp.optString("fingerprint") : "");
                d.put("token", randomHex(24));
                d.put("ts", System.currentTimeMillis());
                pairedDevices.put(devId, d);
                savePaired();
            } catch (Exception ignored) {}
        } else {
            deniedDevices.add(devId);
        }
        call.resolve();
    }

    @PluginMethod
    public void getIpAddress(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ip", getLocalIpAddress());
        ret.put("port", PORT);
        ret.put("url", "http://" + getLocalIpAddress() + ":" + PORT);
        call.resolve(ret);
    }

    @PluginMethod
    public void setLocalData(PluginCall call) {
        String data = call.getString("data", "{}");
        localData = data;
        call.resolve();
    }

    @PluginMethod
    public void getReceivedData(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("data", receivedData != null ? receivedData : "{}");
        call.resolve(ret);
    }

    @PluginMethod
    public void clearReceivedData(PluginCall call) {
        receivedData = null;
        call.resolve();
    }

    // Emparejamiento: allow=true → la IP queda autorizada (persistente);
    // allow=false → bloqueada el resto de la sesión sin más prompts.
    @PluginMethod
    public void allowDevice(PluginCall call) {
        String ip = call.getString("ip");
        if (ip == null || ip.isEmpty()) {
            call.reject("ip is required");
            return;
        }
        boolean allow = call.getBoolean("allow", true);
        if (allow) {
            deniedIps.remove(ip);
            allowedIps.add(ip);
            saveAllowed();
        } else {
            deniedIps.add(ip);
        }
        call.resolve();
    }

    @PluginMethod
    public void getPairedDevices(PluginCall call) {
        loadAllowed();
        loadPaired();
        JSObject ret = new JSObject();
        JSONArray arr = new JSONArray();
        try {
            synchronized (pairedDevices) {
                for (java.util.Map.Entry<String, JSONObject> e : pairedDevices.entrySet()) {
                    JSONObject d = new JSONObject();
                    d.put("deviceId", e.getKey());
                    d.put("alias", e.getValue().optString("alias"));
                    d.put("fingerprint", e.getValue().optString("fingerprint"));
                    arr.put(d);
                }
            }
            // Entradas legacy: solo IP, sin identidad.
            synchronized (allowedIps) {
                for (String ip : allowedIps) {
                    JSONObject d = new JSONObject();
                    d.put("ip", ip);
                    arr.put(d);
                }
            }
            ret.put("devices", new com.getcapacitor.JSArray(arr));
        } catch (Exception ignored) {}
        call.resolve(ret);
    }

    @PluginMethod
    public void forgetDevices(PluginCall call) {
        allowedIps.clear();
        deniedIps.clear();
        pairedDevices.clear();
        deniedDevices.clear();
        saveAllowed();
        savePaired();
        call.resolve();
    }

    // ── Descubrimiento UDP (estilo LocalSend) ────────────────────────────
    // Cada dispositivo anuncia {deviceId, alias, fingerprint, port} por
    // broadcast cada ~2.5s; los demás escuchan y responden una vez al ver un
    // dispositivo nuevo (descubrimiento mutuo rápido). Sustituye al barrido
    // de las 254 IPs del /24.
    private DatagramSocket discSocket;
    private Thread announceThread;
    private Thread listenThread;
    private volatile boolean discRunning = false;
    private WifiManager.MulticastLock mcLock;
    private final java.util.Map<String, JSONObject> discovered =
            java.util.Collections.synchronizedMap(new java.util.HashMap<>());
    private final java.util.Map<String, Long> repliedAt =
            java.util.Collections.synchronizedMap(new java.util.HashMap<>());

    private void startDiscovery() {
        if (discRunning) return;
        discRunning = true;
        try {
            discSocket = new DatagramSocket(null);
            discSocket.setReuseAddress(true);
            discSocket.bind(new InetSocketAddress(DISC_PORT));
            discSocket.setBroadcast(true);
            WifiManager wm = (WifiManager) getContext().getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                mcLock = wm.createMulticastLock("octostream_sync");
                mcLock.setReferenceCounted(true);
                mcLock.acquire();
            }
        } catch (Exception e) {
            Log.e(TAG, "discovery socket: " + e.getMessage());
            discRunning = false;
            return;
        }
        announceThread = new Thread(this::announceLoop, "sync-announce");
        listenThread = new Thread(this::listenLoop, "sync-listen");
        announceThread.setDaemon(true);
        listenThread.setDaemon(true);
        listenThread.start();
        announceThread.start();
    }

    private void stopDiscovery() {
        discRunning = false;
        try { if (discSocket != null) discSocket.close(); } catch (Exception ignored) {}
        discSocket = null;
        try { if (mcLock != null && mcLock.isHeld()) mcLock.release(); } catch (Exception ignored) {}
        mcLock = null;
        announceThread = null;
        listenThread = null;
    }

    private byte[] announcement() {
        loadIdentity();
        JSONObject j = new JSONObject();
        try {
            j.put("app", "octostream");
            j.put("v", 1);
            j.put("deviceId", deviceId);
            j.put("alias", deviceAlias);
            j.put("fingerprint", deviceFingerprint);
            j.put("port", PORT);
        } catch (Exception ignored) {}
        return j.toString().getBytes(StandardCharsets.UTF_8);
    }

    private void announceLoop() {
        byte[] payload = announcement();
        while (discRunning) {
            try {
                DatagramPacket p = new DatagramPacket(payload, payload.length,
                        InetAddress.getByName("255.255.255.255"), DISC_PORT);
                discSocket.send(p);
                Thread.sleep(2500);
            } catch (InterruptedException e) {
                break;
            } catch (Exception e) {
                if (!discRunning) break;
                try { Thread.sleep(3000); } catch (InterruptedException ie) { break; }
            }
        }
    }

    private void listenLoop() {
        byte[] buf = new byte[2048];
        while (discRunning) {
            try {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                discSocket.receive(p);
                String msg = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                JSONObject j = new JSONObject(msg);
                if (!"octostream".equals(j.optString("app"))) continue;
                String devId = j.optString("deviceId");
                if (devId.isEmpty() || devId.equals(deviceId)) continue;
                String ip = p.getAddress().getHostAddress();
                int port = j.optInt("port", PORT);
                JSONObject d = new JSONObject();
                d.put("deviceId", devId);
                d.put("alias", j.optString("alias"));
                d.put("fingerprint", j.optString("fingerprint"));
                d.put("ip", ip);
                d.put("port", port);
                d.put("url", "http://" + ip + ":" + port);
                d.put("ts", System.currentTimeMillis());
                boolean isNew = !discovered.containsKey(devId);
                discovered.put(devId, d);
                if (isNew) notifyListeners("deviceFound", JSObject.fromJSONObject(d));
                // Respuesta dirigida una sola vez por dispositivo (o si lleva
                // >45s sin verse): acelera el descubrimiento mutuo sin tormenta
                // de paquetes.
                Long lastReply = repliedAt.get(devId);
                long now = System.currentTimeMillis();
                if (lastReply == null || now - lastReply > 45000) {
                    repliedAt.put(devId, now);
                    byte[] payload = announcement();
                    DatagramPacket reply = new DatagramPacket(payload, payload.length,
                            p.getAddress(), DISC_PORT);
                    discSocket.send(reply);
                }
            } catch (Exception e) {
                if (!discRunning) break;
            }
        }
    }

    @PluginMethod
    public void getDiscoveredDevices(PluginCall call) {
        JSONArray arr = new JSONArray();
        long now = System.currentTimeMillis();
        try {
            synchronized (discovered) {
                for (java.util.Iterator<java.util.Map.Entry<String, JSONObject>> it =
                        discovered.entrySet().iterator(); it.hasNext();) {
                    JSONObject d = it.next().getValue();
                    if (now - d.optLong("ts") > 20000) { it.remove(); continue; }
                    arr.put(d);
                }
            }
        } catch (Exception ignored) {}
        JSObject ret = new JSObject();
        try { ret.put("devices", new com.getcapacitor.JSArray(arr)); } catch (Exception ignored) {}
        call.resolve(ret);
    }

    private String getLocalIpAddress() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface ni = interfaces.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (addr instanceof java.net.Inet4Address && !addr.isLoopbackAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "getLocalIpAddress error: " + e.getMessage());
        }
        return "127.0.0.1";
    }
}
