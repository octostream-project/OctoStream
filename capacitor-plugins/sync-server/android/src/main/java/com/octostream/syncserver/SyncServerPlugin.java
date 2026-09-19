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

import org.json.JSONObject;
import fi.iki.elonen.NanoHTTPD;

import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Enumeration;

@CapacitorPlugin(name = "SyncServer")
public class SyncServerPlugin extends Plugin {

    private static final String TAG = "SyncServer";
    private static final int PORT = 8765;

    private SyncHttpServer server;
    private volatile String localData = null;
    private volatile String receivedData = null;

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
            } else if (uri.equals("/sync") && method == Method.GET) {
                // Datos privados (historial/favoritos) — solo IPs autorizadas.
                String remoteIp = session.getRemoteIpAddress();
                if (!isAllowed(remoteIp)) {
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
                    if (!isAllowed(remoteIp)) {
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
                    if (!isAllowed(remoteIp)) {
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
                if (!isAllowed(session.getRemoteIpAddress())) {
                    res = forbidden(); // sin prompt: un stop ajeno no pide pairing
                } else {
                    notifyListeners("stopReceived", new JSObject());
                    res = newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}");
                }
            } else if (uri.equals("/ping") && method == Method.GET) {
                res = newFixedLengthResponse(Response.Status.OK, "application/json",
                    "{\"ok\":true,\"name\":\"OctoStream\",\"model\":\"" + android.os.Build.MODEL.replace("\"", "") + "\"}");
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
            if (server == null) {
                server = new SyncHttpServer(PORT);
                server.start();
                Log.i(TAG, "Sync server started on port " + PORT);
            }
            JSObject ret = new JSObject();
            ret.put("port", PORT);
            ret.put("ip", getLocalIpAddress());
            ret.put("url", "http://" + getLocalIpAddress() + ":" + PORT);
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
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to stop: " + e.getMessage());
        }
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
        JSObject ret = new JSObject();
        java.util.List<String> snapshot;
        synchronized (allowedIps) { snapshot = new java.util.ArrayList<>(allowedIps); }
        ret.put("devices", new com.getcapacitor.JSArray(snapshot));
        call.resolve(ret);
    }

    @PluginMethod
    public void forgetDevices(PluginCall call) {
        allowedIps.clear();
        deniedIps.clear();
        saveAllowed();
        call.resolve();
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
