package io.github.agrawalprash.wander;

import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Phone <-> TV link over the home Wi-Fi. The TV runs a tiny HTTP server; the phone
 * finds it on the local network and sends requests to it. Every request carries the
 * pairing code shown on the TV, which the web app checks. Nothing leaves the network.
 */
@CapacitorPlugin(name = "WanderLink")
public class LinkPlugin extends Plugin {
    static final int PORT = 47321;
    private ServerSocket server;
    private final Map<String, Socket> pending = new ConcurrentHashMap<>();

    // ------------------------------------------------------------ TV side

    @PluginMethod
    public void startServer(PluginCall call) {
        try {
            if (server == null || server.isClosed()) {
                server = new ServerSocket();
                server.setReuseAddress(true);
                server.bind(new InetSocketAddress(PORT));
                Thread t = new Thread(this::acceptLoop, "wander-link");
                t.setDaemon(true);
                t.start();
            }
            JSObject r = new JSObject();
            r.put("port", server.getLocalPort());
            r.put("addresses", localAddresses());
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not start the link: " + e.getMessage());
        }
    }

    private void acceptLoop() {
        while (server != null && !server.isClosed()) {
            try {
                Socket s = server.accept();
                new Thread(() -> handle(s)).start();
            } catch (Exception ignored) { }
        }
    }

    private void handle(Socket s) {
        try {
            s.setSoTimeout(15000);
            InputStream in = s.getInputStream();
            ByteArrayOutputStream head = new ByteArrayOutputStream();
            int prev3 = 0, prev2 = 0, prev1 = 0, b;
            while ((b = in.read()) != -1) {
                head.write(b);
                if (prev3 == '\r' && prev2 == '\n' && prev1 == '\r' && b == '\n') break;
                prev3 = prev2; prev2 = prev1; prev1 = b;
                if (head.size() > 16384) break;
            }
            String headers = head.toString("UTF-8");
            String[] lines = headers.split("\r\n");
            String[] first = lines.length > 0 ? lines[0].split(" ") : new String[0];
            String method = first.length > 0 ? first[0] : "";
            String path = first.length > 1 ? first[1] : "";
            int length = 0;
            for (String l : lines) {
                if (l.toLowerCase().startsWith("content-length:")) length = Integer.parseInt(l.substring(15).trim());
            }
            byte[] body = new byte[Math.min(length, 1_000_000)];
            int read = 0;
            while (read < body.length) {
                int n = in.read(body, read, body.length - read);
                if (n < 0) break;
                read += n;
            }
            if ("GET".equals(method) && "/wander/hello".equals(path)) {
                write(s, 200, "{\"app\":\"wander\",\"name\":\"" + Build.MODEL.replace("\"", "") + "\"}");
                return;
            }
            if ("POST".equals(method) && "/wander/message".equals(path)) {
                String id = UUID.randomUUID().toString();
                pending.put(id, s);
                JSObject e = new JSObject();
                e.put("id", id);
                e.put("body", new String(body, 0, read, StandardCharsets.UTF_8));
                notifyListeners("message", e);
                // If the app never answers (e.g. it's closed), don't hang the phone forever.
                new Thread(() -> {
                    try { Thread.sleep(120000); } catch (InterruptedException ignored) { }
                    Socket stale = pending.remove(id);
                    if (stale != null) write(stale, 504, "{\"error\":\"The TV didn't answer in time.\"}");
                }).start();
                return;
            }
            write(s, 404, "{\"error\":\"not found\"}");
        } catch (Exception e) {
            try { s.close(); } catch (Exception ignored) { }
        }
    }

    @PluginMethod
    public void respond(PluginCall call) {
        Socket s = pending.remove(call.getString("id", ""));
        if (s != null) write(s, call.getInt("status", 200), call.getString("body", "{}"));
        call.resolve();
    }

    private static void write(Socket s, int status, String body) {
        try {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            String head = "HTTP/1.1 " + status + " OK\r\nContent-Type: application/json\r\nContent-Length: " + bytes.length
                + "\r\nConnection: close\r\n\r\n";
            OutputStream out = s.getOutputStream();
            out.write(head.getBytes(StandardCharsets.UTF_8));
            out.write(bytes);
            out.flush();
        } catch (Exception ignored) {
        } finally {
            try { s.close(); } catch (Exception ignored) { }
        }
    }

    // ------------------------------------------------------------ phone side

    @PluginMethod
    public void send(PluginCall call) {
        String host = call.getString("host");
        int port = call.getInt("port", PORT);
        String body = call.getString("body", "{}");
        int timeout = call.getInt("timeoutMs", 120000);
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL("http://" + host + ":" + port + "/wander/message").openConnection();
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setConnectTimeout(3000);
                c.setReadTimeout(timeout);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
                int status = c.getResponseCode();
                InputStream in = status < 400 ? c.getInputStream() : c.getErrorStream();
                String text = in == null ? "" : readAll(in);
                JSObject r = new JSObject();
                r.put("status", status);
                r.put("body", text);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Couldn't reach the TV: " + e.getMessage(), "UNREACHABLE");
            }
        }).start();
    }

    /** Looks for Wander TVs on the local network (same /24 subnet). Takes a few seconds. */
    @PluginMethod
    public void discover(PluginCall call) {
        new Thread(() -> {
            JSArray found = new JSArray();
            List<String> prefixes = new ArrayList<>();
            for (Object a : localAddressList()) {
                String ip = (String) a;
                prefixes.add(ip.substring(0, ip.lastIndexOf('.') + 1));
            }
            ExecutorService pool = Executors.newFixedThreadPool(48);
            List<JSObject> hits = Collections.synchronizedList(new ArrayList<>());
            for (String prefix : prefixes) {
                for (int i = 1; i < 255; i++) {
                    final String host = prefix + i;
                    pool.submit(() -> {
                        try (Socket s = new Socket()) {
                            s.connect(new InetSocketAddress(host, PORT), 400);
                        } catch (Exception e) {
                            return;
                        }
                        try {
                            HttpURLConnection c = (HttpURLConnection) new URL("http://" + host + ":" + PORT + "/wander/hello").openConnection();
                            c.setConnectTimeout(1500);
                            c.setReadTimeout(1500);
                            String text = readAll(c.getInputStream());
                            if (text.contains("\"wander\"")) {
                                JSObject o = new JSObject();
                                o.put("host", host);
                                o.put("port", PORT);
                                o.put("hello", text);
                                hits.add(o);
                            }
                        } catch (Exception ignored) { }
                    });
                }
            }
            pool.shutdown();
            try { pool.awaitTermination(20, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
            for (JSObject o : hits) found.put(o);
            JSObject r = new JSObject();
            r.put("found", found);
            r.put("searched", new JSArray(prefixes));
            call.resolve(r);
        }).start();
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    private static List<Object> localAddressList() {
        List<Object> list = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) list.add(a.getHostAddress());
                }
            }
        } catch (Exception ignored) { }
        return list;
    }

    private static JSArray localAddresses() {
        return new JSArray(localAddressList());
    }
}
