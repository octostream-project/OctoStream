package com.octostream.cloudproxy;

import static org.junit.Assert.assertEquals;

import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;

import org.junit.Test;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

public final class SshDirectProxyAuthTest {
    @Test
    public void rejectsConnectWithoutCredentialsBeforeOpeningSshChannel() throws Exception {
        ProxyAuth.init();
        int port;
        try (ServerSocket reservation = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            port = reservation.getLocalPort();
        }

        Session disconnectedSession = new JSch().getSession("unused", "127.0.0.1", 22);
        SshDirectProxy proxy = new SshDirectProxy(disconnectedSession, port);
        try {
            proxy.start();
            for (String auth : new String[] { "", "Proxy-Authorization: Basic invalid\r\n" }) {
                try (Socket client = new Socket("127.0.0.1", port)) {
                    client.setSoTimeout(2000);
                    OutputStream out = client.getOutputStream();
                    out.write(("CONNECT example.com:443 HTTP/1.1\r\n"
                            + "Host: example.com:443\r\n" + auth + "\r\n")
                            .getBytes(StandardCharsets.ISO_8859_1));
                    out.flush();

                    String status = new BufferedReader(new InputStreamReader(
                            client.getInputStream(), StandardCharsets.ISO_8859_1)).readLine();
                    assertEquals("HTTP/1.1 407 Proxy Authentication Required", status);
                }
            }
        } finally {
            proxy.close();
            disconnectedSession.disconnect();
        }
    }
}
