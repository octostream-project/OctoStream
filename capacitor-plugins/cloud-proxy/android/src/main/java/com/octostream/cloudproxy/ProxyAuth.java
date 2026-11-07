package com.octostream.cloudproxy;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Per-process credentials for the loopback VPS HTTP proxy (:2830).
 * Clients attach the token only to the local direct proxy; the native
 * OpenSSH SOCKS listener stays on an ephemeral port because Android's
 * java.net/OkHttp SOCKS stack cannot do RFC1929 auth.
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
