package com.octostream.cloudproxy;

import java.net.Authenticator;
import java.net.PasswordAuthentication;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Credencial aleatoria por arranque para los proxies loopback del VPS
 * (SshDirectProxy :2830, SocksAuthProxy :2831). Vive solo en memoria — si
 * otra app del dispositivo intenta usar los puertos recibe 407/0x01 porque
 * no conoce el token. Los clientes legítimos se autentican solos:
 * HttpURLConnection vía Authenticator por defecto (tras un 407) y las
 * conexiones SOCKS de java.net (OkHttp incluido) vía las propiedades
 * java.net.socks.username/password.
 */
final class ProxyAuth {
    private static volatile String user;
    private static volatile String pass;

    private ProxyAuth() {}

    static synchronized void init() {
        if (user != null) return;
        SecureRandom r = new SecureRandom();
        byte[] u = new byte[9];
        byte[] p = new byte[24];
        r.nextBytes(u);
        r.nextBytes(p);
        user = "octo-" + hex(u);
        pass = hex(p);
        final String u0 = user;
        final String p0 = pass;
        // Authenticator global: solo responde a retos de PROXY (nunca a auth
        // de origen), así HttpURLConnection (directFetch, descargas) reintenta
        // con credenciales cuando SshDirectProxy devuelve 407.
        Authenticator.setDefault(new Authenticator() {
            @Override
            protected PasswordAuthentication getPasswordAuthentication() {
                // Responder a cualquier reto de PROXY: el token solo sale si
                // un servidor proxy lo pide (407) y los únicos proxies que
                // retan son los nuestros en loopback. getRequestingSite()
                // puede devolver null en el bridge okhttp de Android.
                if (getRequestorType() == RequestorType.PROXY) {
                    return new PasswordAuthentication(u0, p0.toCharArray());
                }
                return null;
            }
        });
        // java.net SOCKS (OkHttp con Proxy.Type.SOCKS → RFC 1929 en el front).
        System.setProperty("java.net.socks.username", u0);
        System.setProperty("java.net.socks.password", p0);
    }

    /** Verificación del header "Proxy-Authorization: Basic base64(u:p)". */
    static boolean checkBasic(String header) {
        if (user == null || header == null) return false;
        String expect = "Basic " + Base64.getEncoder().encodeToString(
                (user + ":" + pass).getBytes(StandardCharsets.UTF_8));
        return MessageDigest.isEqual(
                expect.getBytes(StandardCharsets.UTF_8),
                header.trim().getBytes(StandardCharsets.UTF_8));
    }

    /** Verificación RFC 1929 (SOCKS5 username/password). */
    static boolean checkSocks(String u, String p) {
        if (user == null || u == null || p == null) return false;
        return MessageDigest.isEqual(u.getBytes(StandardCharsets.UTF_8),
                        user.getBytes(StandardCharsets.UTF_8))
                && MessageDigest.isEqual(p.getBytes(StandardCharsets.UTF_8),
                        pass.getBytes(StandardCharsets.UTF_8));
    }

    /** Header que OkHttp (proxyAuthenticator) adjunta cuando le retan. */
    static String basicHeader() {
        if (user == null) return "";
        return "Basic " + Base64.getEncoder().encodeToString(
                (user + ":" + pass).getBytes(StandardCharsets.UTF_8));
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 0xF, 16))
                .append(Character.forDigit(x & 0xF, 16));
        return sb.toString();
    }
}
