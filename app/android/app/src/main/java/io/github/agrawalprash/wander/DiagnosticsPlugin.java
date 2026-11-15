package io.github.agrawalprash.wander;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.InputDevice;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Collects facts about this device's voice setup so Claude can diagnose problems. Read-only. */
@CapacitorPlugin(
    name = "WanderDiagnostics",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class DiagnosticsPlugin extends Plugin {

    private static final String[] KNOWN_PACKAGES = {
        "com.google.android.katniss",
        "com.google.android.googlequicksearchbox",
        "com.google.android.apps.googleassistant",
        "com.google.android.tvlauncher",
        "com.google.android.apps.tv.launcherx",
        "com.google.android.tts",
        "com.google.android.gms",
        "com.google.android.tv.remote.service",
        "com.google.android.apps.mediashell",
        "com.google.android.youtube.tv",
        "com.google.android.speech.pumpkin",
    };

    private static final String[] HOSTS = {
        "www.google.com",
        "www.googleapis.com",
        "speech.googleapis.com",
        "embeddedassistant.googleapis.com",
        "clients4.google.com",
        "www.gstatic.com",
    };

    @PluginMethod
    public void collect(PluginCall call) {
        new Thread(() -> {
            JSObject r = new JSObject();
            Context ctx = getContext();
            PackageManager pm = ctx.getPackageManager();
            try {
                JSObject device = new JSObject();
                device.put("model", Build.MODEL);
                device.put("manufacturer", Build.MANUFACTURER);
                device.put("brand", Build.BRAND);
                device.put("device", Build.DEVICE);
                device.put("androidVersion", Build.VERSION.RELEASE);
                device.put("sdk", Build.VERSION.SDK_INT);
                device.put("buildFingerprint", Build.FINGERPRINT);
                device.put("securityPatch", Build.VERSION.SDK_INT >= 23 ? Build.VERSION.SECURITY_PATCH : "");
                device.put("locale", Locale.getDefault().toLanguageTag());
                device.put("isTv", pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK));
                device.put("hasMicrophoneFeature", pm.hasSystemFeature(PackageManager.FEATURE_MICROPHONE));
                r.put("device", device);

                ContentResolver cr = ctx.getContentResolver();
                JSObject voice = new JSObject();
                voice.put("assistantSetting", Settings.Secure.getString(cr, "assistant"));
                voice.put("voiceInteractionService", Settings.Secure.getString(cr, "voice_interaction_service"));
                voice.put("voiceRecognitionService", Settings.Secure.getString(cr, "voice_recognition_service"));
                voice.put("recognitionAvailable", SpeechRecognizer.isRecognitionAvailable(ctx));
                voice.put("recognitionServices", resolveList(pm.queryIntentServices(new Intent(RecognitionService.SERVICE_INTERFACE), 0)));
                voice.put("recognizeSpeechActivities", resolveList(pm.queryIntentActivities(new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH), 0)));
                voice.put("assistActivities", resolveList(pm.queryIntentActivities(new Intent(Intent.ACTION_ASSIST), 0)));
                voice.put("voiceCommandActivities", resolveList(pm.queryIntentActivities(new Intent(Intent.ACTION_VOICE_COMMAND), 0)));
                r.put("voice", voice);

                JSArray pkgs = new JSArray();
                for (String p : KNOWN_PACKAGES) pkgs.put(packageInfo(pm, p));
                // Anything else that looks voice- or remote-related.
                try {
                    for (PackageInfo pi : pm.getInstalledPackages(0)) {
                        String n = pi.packageName.toLowerCase(Locale.ROOT);
                        boolean known = false;
                        for (String p : KNOWN_PACKAGES) if (p.equals(pi.packageName)) known = true;
                        if (!known && (n.contains("voice") || n.contains("remote") || n.contains("rcu") || n.contains("speech")
                            || n.contains("assistant") || n.contains("katniss") || n.contains("waipu") || n.contains("sei"))) {
                            pkgs.put(packageInfo(pm, pi.packageName));
                        }
                    }
                } catch (Exception ignored) { }
                r.put("packages", pkgs);

                JSArray inputs = new JSArray();
                AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
                if (am != null && Build.VERSION.SDK_INT >= 23) {
                    for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
                        JSObject o = new JSObject();
                        o.put("id", d.getId());
                        o.put("type", d.getType());
                        o.put("name", String.valueOf(d.getProductName()));
                        inputs.put(o);
                    }
                }
                r.put("audioInputs", inputs);

                JSArray inputDevices = new JSArray();
                for (int id : InputDevice.getDeviceIds()) {
                    InputDevice d = InputDevice.getDevice(id);
                    if (d == null || d.isVirtual()) continue;
                    JSObject o = new JSObject();
                    o.put("name", d.getName());
                    o.put("hasMicrophone", Build.VERSION.SDK_INT >= 23 && d.hasMicrophone());
                    o.put("external", Build.VERSION.SDK_INT >= 29 && d.isExternal());
                    inputDevices.put(o);
                }
                r.put("inputDevices", inputDevices);

                JSArray bt = new JSArray();
                try {
                    BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
                    if (adapter != null) {
                        Set<BluetoothDevice> bonded = adapter.getBondedDevices();
                        for (BluetoothDevice d : bonded) {
                            JSObject o = new JSObject();
                            o.put("name", d.getName());
                            o.put("type", d.getType());
                            bt.put(o);
                        }
                    }
                } catch (SecurityException e) {
                    bt.put("not allowed to read: " + e.getMessage());
                }
                r.put("bluetoothDevices", bt);

                r.put("network", networkInfo(ctx));
                JSArray hosts = new JSArray();
                for (String h : HOSTS) hosts.put(checkHost(h));
                r.put("hosts", hosts);
                r.put("wanderMicPermission", getPermissionState("microphone").toString());
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Collecting diagnostics failed: " + e);
            }
        }).start();
    }

    private JSArray resolveList(List<ResolveInfo> list) {
        JSArray a = new JSArray();
        if (list == null) return a;
        for (ResolveInfo ri : list) {
            if (ri.serviceInfo != null) a.put(ri.serviceInfo.packageName + "/" + ri.serviceInfo.name);
            else if (ri.activityInfo != null) a.put(ri.activityInfo.packageName + "/" + ri.activityInfo.name);
        }
        return a;
    }

    private JSObject packageInfo(PackageManager pm, String p) {
        JSObject o = new JSObject();
        o.put("package", p);
        try {
            PackageInfo info = pm.getPackageInfo(p, 0);
            ApplicationInfo ai = pm.getApplicationInfo(p, 0);
            o.put("installed", true);
            o.put("version", info.versionName);
            o.put("enabled", ai.enabled);
            o.put("label", String.valueOf(pm.getApplicationLabel(ai)));
            o.put("micGranted", pm.checkPermission(Manifest.permission.RECORD_AUDIO, p) == PackageManager.PERMISSION_GRANTED);
            if (Build.VERSION.SDK_INT >= 9) o.put("lastUpdate", info.lastUpdateTime);
        } catch (PackageManager.NameNotFoundException e) {
            o.put("installed", false);
        }
        return o;
    }

    private JSObject networkInfo(Context ctx) {
        JSObject o = new JSObject();
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network n = cm.getActiveNetwork();
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            LinkProperties lp = cm.getLinkProperties(n);
            if (caps != null) {
                o.put("wifi", caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI));
                o.put("ethernet", caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
                o.put("vpn", caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
                o.put("validated", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
            }
            if (lp != null) {
                JSArray dns = new JSArray();
                for (InetAddress a : lp.getDnsServers()) dns.put(a.getHostAddress());
                o.put("dnsServers", dns);
                if (Build.VERSION.SDK_INT >= 28) {
                    o.put("privateDnsActive", lp.isPrivateDnsActive());
                    o.put("privateDnsServer", lp.getPrivateDnsServerName());
                }
            }
        } catch (Exception e) {
            o.put("error", e.toString());
        }
        return o;
    }

    private JSObject checkHost(String host) {
        JSObject o = new JSObject();
        o.put("host", host);
        try {
            JSArray ips = new JSArray();
            for (InetAddress a : InetAddress.getAllByName(host)) ips.put(a.getHostAddress());
            o.put("resolvesTo", ips);
        } catch (Exception e) {
            o.put("dnsError", e.toString());
            return o;
        }
        try {
            long t = System.currentTimeMillis();
            HttpURLConnection c = (HttpURLConnection) new URL("https://" + host + "/generate_204").openConnection();
            c.setConnectTimeout(5000);
            c.setReadTimeout(5000);
            c.setInstanceFollowRedirects(false);
            o.put("httpsStatus", c.getResponseCode());
            o.put("ms", System.currentTimeMillis() - t);
            c.disconnect();
        } catch (Exception e) {
            o.put("httpsError", e.toString());
        }
        return o;
    }

    // ------------------------------------------------------------ live speech test

    @PluginMethod
    public void speechTest(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicPermission");
            return;
        }
        runSpeechTest(call);
    }

    @PermissionCallback
    private void afterMicPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) runSpeechTest(call);
        else {
            JSObject r = new JSObject();
            r.put("ok", false);
            r.put("errorName", "WANDER_MIC_PERMISSION_DENIED");
            call.resolve(r);
        }
    }

    private static String errorName(int e) {
        switch (e) {
            case 1: return "ERROR_NETWORK_TIMEOUT";
            case 2: return "ERROR_NETWORK";
            case 3: return "ERROR_AUDIO";
            case 4: return "ERROR_SERVER";
            case 5: return "ERROR_CLIENT";
            case 6: return "ERROR_SPEECH_TIMEOUT";
            case 7: return "ERROR_NO_MATCH";
            case 8: return "ERROR_RECOGNIZER_BUSY";
            case 9: return "ERROR_INSUFFICIENT_PERMISSIONS";
            case 10: return "ERROR_TOO_MANY_REQUESTS";
            case 11: return "ERROR_SERVER_DISCONNECTED";
            case 12: return "ERROR_LANGUAGE_NOT_SUPPORTED";
            case 13: return "ERROR_LANGUAGE_UNAVAILABLE";
            case 14: return "ERROR_CANNOT_CHECK_SUPPORT";
            default: return "ERROR_" + e;
        }
    }

    private void runSpeechTest(PluginCall call) {
        String language = call.getString("language", "en-US");
        Handler main = new Handler(Looper.getMainLooper());
        main.post(() -> {
            final JSArray events = new JSArray();
            final float[] maxRms = { -100f };
            final boolean[] done = { false };
            final SpeechRecognizer sr;
            try {
                sr = SpeechRecognizer.createSpeechRecognizer(getContext());
            } catch (Exception e) {
                JSObject r = new JSObject();
                r.put("ok", false);
                r.put("errorName", "CREATE_FAILED: " + e);
                call.resolve(r);
                return;
            }
            final Runnable[] finish = new Runnable[1];
            final JSObject result = new JSObject();
            finish[0] = () -> {
                if (done[0]) return;
                done[0] = true;
                result.put("events", events);
                result.put("maxRms", maxRms[0]);
                result.put("language", language);
                try { sr.destroy(); } catch (Exception ignored) { }
                call.resolve(result);
            };
            sr.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) { events.put("ready"); }
                @Override public void onBeginningOfSpeech() { events.put("speech-start"); }
                @Override public void onRmsChanged(float rmsdB) { if (rmsdB > maxRms[0]) maxRms[0] = rmsdB; }
                @Override public void onBufferReceived(byte[] buffer) { }
                @Override public void onEndOfSpeech() { events.put("speech-end"); }
                @Override public void onError(int error) {
                    result.put("ok", false);
                    result.put("error", error);
                    result.put("errorName", errorName(error));
                    finish[0].run();
                }
                @Override public void onResults(Bundle results) {
                    ArrayList<String> m = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    result.put("ok", true);
                    result.put("text", m != null && !m.isEmpty() ? m.get(0) : "");
                    finish[0].run();
                }
                @Override public void onPartialResults(Bundle partialResults) { }
                @Override public void onEvent(int eventType, Bundle params) { }
            });
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
            try {
                sr.startListening(i);
            } catch (Exception e) {
                result.put("ok", false);
                result.put("errorName", "START_FAILED: " + e);
                finish[0].run();
                return;
            }
            main.postDelayed(() -> {
                if (done[0]) return;
                try { sr.cancel(); } catch (Exception ignored) { }
                result.put("ok", false);
                result.put("errorName", "WANDER_TIMEOUT_15S");
                finish[0].run();
            }, 15000);
        });
    }

    // ------------------------------------------------------------ tools for Claude's investigation

    private static final java.util.Set<String> ALLOWED_BINARIES = new java.util.HashSet<>(java.util.Arrays.asList(
        "getprop", "dumpsys", "pm", "settings", "ls", "cat", "ping", "uname", "id", "df", "uptime", "date", "ip", "logcat",
        "ps", "top", "service", "wm", "grep", "head", "tail", "find", "stat", "which"));

    /** Runs one read-only command from an allowlist (no shell, no pipes, no writes). */
    @PluginMethod
    public void runCommand(PluginCall call) {
        String command = call.getString("command", "").trim();
        new Thread(() -> {
            JSObject r = new JSObject();
            r.put("command", command);
            String problem = validate(command);
            if (problem != null) {
                r.put("refused", problem);
                call.resolve(r);
                return;
            }
            try {
                String[] args = command.split("\\s+");
                if (args[0].equals("ping") && !command.contains(" -c ")) {
                    String[] withCount = new String[args.length + 2];
                    withCount[0] = "ping"; withCount[1] = "-c"; withCount[2] = "3";
                    System.arraycopy(args, 1, withCount, 3, args.length - 1);
                    args = withCount;
                }
                if (args[0].equals("logcat")) args = new String[] { "logcat", "-d", "-t", "300" };
                if (args[0].equals("top")) args = new String[] { "top", "-b", "-n", "1", "-m", "25" };
                Process p = new ProcessBuilder(args).redirectErrorStream(false).start();
                StringBuilder out = new StringBuilder();
                StringBuilder err = new StringBuilder();
                Thread to = drain(p.getInputStream(), out);
                Thread te = drain(p.getErrorStream(), err);
                boolean finished = p.waitFor(10, java.util.concurrent.TimeUnit.SECONDS);
                if (!finished) p.destroy();
                to.join(1000);
                te.join(1000);
                r.put("exitCode", finished ? p.exitValue() : -1);
                r.put("timedOut", !finished);
                r.put("stdout", cap(out.toString(), 7000));
                r.put("stderr", cap(err.toString(), 2000));
            } catch (Exception e) {
                r.put("error", e.toString());
            }
            call.resolve(r);
        }).start();
    }

    private static String validate(String command) {
        if (command.isEmpty()) return "empty command";
        if (command.matches(".*[;&|><`$\\\\(){}\\n].*")) return "no shell operators allowed (one plain command only)";
        String[] args = command.split("\\s+");
        String bin = args[0];
        if (!ALLOWED_BINARIES.contains(bin)) return "not on the read-only allowlist: " + ALLOWED_BINARIES;
        if (bin.equals("settings") && (args.length < 2 || !(args[1].equals("get") || args[1].equals("list")))) return "settings: only get/list";
        if (bin.equals("pm") && (args.length < 2 || !(args[1].equals("list") || args[1].equals("path") || args[1].equals("dump")))) return "pm: only list/path/dump";
        if (bin.equals("ip") && (args.length < 2 || !(args[1].equals("addr") || args[1].equals("route") || args[1].equals("link")))) return "ip: only addr/route/link";
        if (bin.equals("service") && (args.length < 2 || !(args[1].equals("list") || args[1].equals("check")))) return "service: only list/check";
        if (bin.equals("wm") && (args.length < 2 || !(args[1].equals("size") || args[1].equals("density")) || args.length > 2)) return "wm: only size/density (read)";
        if (bin.equals("find") && command.contains("-delete")) return "find: no -delete";
        if (bin.equals("find") && command.contains("-exec")) return "find: no -exec";
        if ((bin.equals("cat") || bin.equals("ls") || bin.equals("grep") || bin.equals("head") || bin.equals("tail") || bin.equals("find") || bin.equals("stat")) && args.length > 1) {
            String path = args[args.length - 1];
            if (!(path.startsWith("/proc") || path.startsWith("/sys") || path.startsWith("/system") || path.startsWith("/vendor") || path.startsWith("/product") || path.startsWith("/odm")))
                return "file commands: only paths under /proc, /sys, /system, /vendor, /product, /odm";
        }
        return null;
    }

    private static Thread drain(java.io.InputStream in, StringBuilder sb) {
        Thread t = new Thread(() -> {
            try (java.io.BufferedReader br = new java.io.BufferedReader(new java.io.InputStreamReader(in))) {
                String line;
                while ((line = br.readLine()) != null) {
                    if (sb.length() < 200000) sb.append(line).append('\n');
                }
            } catch (Exception ignored) { }
        });
        t.start();
        return t;
    }

    private static String cap(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max) + "\n…[truncated " + (s.length() - max) + " chars]";
    }

    /** Version, enabled state, and every requested permission with whether it's granted. */
    @PluginMethod
    public void packageDetails(PluginCall call) {
        String pkg = call.getString("package", "");
        JSObject r = new JSObject();
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo pi = pm.getPackageInfo(pkg, PackageManager.GET_PERMISSIONS | PackageManager.GET_SERVICES);
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            r.put("package", pkg);
            r.put("label", String.valueOf(pm.getApplicationLabel(ai)));
            r.put("version", pi.versionName);
            r.put("enabled", ai.enabled);
            r.put("system", (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0);
            r.put("updatedSystemApp", (ai.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0);
            r.put("lastUpdate", pi.lastUpdateTime);
            JSArray perms = new JSArray();
            if (pi.requestedPermissions != null) {
                for (int i = 0; i < pi.requestedPermissions.length; i++) {
                    boolean granted = (pi.requestedPermissionsFlags[i] & PackageInfo.REQUESTED_PERMISSION_GRANTED) != 0;
                    String name = pi.requestedPermissions[i];
                    if (name.contains("AUDIO") || name.contains("MICROPHONE") || name.contains("BLUETOOTH") || name.contains("INTERNET")
                        || name.contains("HOTWORD") || name.contains("VOICE") || name.contains("SPEECH") || name.contains("CAPTURE") || !granted) {
                        perms.put(name.replace("android.permission.", "") + (granted ? " ✓" : " ✗"));
                    }
                }
            }
            r.put("relevantPermissions", perms);
            JSArray services = new JSArray();
            if (pi.services != null) {
                for (android.content.pm.ServiceInfo si : pi.services) {
                    String n = si.name.toLowerCase(Locale.ROOT);
                    if (n.contains("voice") || n.contains("speech") || n.contains("recogn") || n.contains("assist") || n.contains("audio") || n.contains("remote"))
                        services.put(si.name + (si.enabled ? "" : " (disabled)"));
                }
            }
            r.put("voiceRelatedServices", services);
            int state = pm.getApplicationEnabledSetting(pkg);
            r.put("enabledSetting", state);
        } catch (PackageManager.NameNotFoundException e) {
            r.put("installed", false);
        } catch (Exception e) {
            r.put("error", e.toString());
        }
        call.resolve(r);
    }

    /** Which apps handle an intent action (activities and services). */
    @PluginMethod
    public void queryIntent(PluginCall call) {
        String action = call.getString("action", "");
        PackageManager pm = getContext().getPackageManager();
        Intent i = new Intent(action);
        JSObject r = new JSObject();
        r.put("action", action);
        r.put("activities", resolveList(pm.queryIntentActivities(i, PackageManager.MATCH_ALL)));
        r.put("services", resolveList(pm.queryIntentServices(i, PackageManager.MATCH_ALL)));
        ResolveInfo def = pm.resolveActivity(i, PackageManager.MATCH_DEFAULT_ONLY);
        r.put("defaultActivity", def != null && def.activityInfo != null ? def.activityInfo.packageName + "/" + def.activityInfo.name : null);
        call.resolve(r);
    }

    /** Reads one system setting (secure, global or system). */
    @PluginMethod
    public void getSetting(PluginCall call) {
        String table = call.getString("table", "secure");
        String key = call.getString("key", "");
        JSObject r = new JSObject();
        r.put("table", table);
        r.put("key", key);
        try {
            ContentResolver cr = getContext().getContentResolver();
            String v;
            if (table.equals("global")) v = Settings.Global.getString(cr, key);
            else if (table.equals("system")) v = Settings.System.getString(cr, key);
            else v = Settings.Secure.getString(cr, key);
            r.put("value", v);
        } catch (Exception e) {
            r.put("error", e.toString());
        }
        call.resolve(r);
    }

    /** DNS lookup plus an HTTPS request to any URL. */
    @PluginMethod
    public void httpCheck(PluginCall call) {
        String url = call.getString("url", "");
        new Thread(() -> {
            JSObject r = new JSObject();
            r.put("url", url);
            try {
                URL u = new URL(url);
                JSArray ips = new JSArray();
                for (InetAddress a : InetAddress.getAllByName(u.getHost())) ips.put(a.getHostAddress());
                r.put("resolvesTo", ips);
                long t = System.currentTimeMillis();
                HttpURLConnection c = (HttpURLConnection) u.openConnection();
                c.setConnectTimeout(6000);
                c.setReadTimeout(6000);
                c.setInstanceFollowRedirects(false);
                r.put("status", c.getResponseCode());
                r.put("ms", System.currentTimeMillis() - t);
                r.put("server", c.getHeaderField("server"));
                r.put("location", c.getHeaderField("location"));
                c.disconnect();
            } catch (Exception e) {
                r.put("error", e.toString());
            }
            call.resolve(r);
        }).start();
    }

    /** Records a few seconds from an input and reports loudness over time (needs the mic permission). */
    @PluginMethod
    public void audioProbe(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicForProbe");
            return;
        }
        runAudioProbe(call);
    }

    @PermissionCallback
    private void afterMicForProbe(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) runAudioProbe(call);
        else {
            JSObject r = new JSObject();
            r.put("error", "Wander was not allowed to use the microphone.");
            call.resolve(r);
        }
    }

    private void runAudioProbe(PluginCall call) {
        int seconds = Math.max(1, Math.min(call.getInt("seconds", 4), 10));
        int source = call.getInt("source", android.media.MediaRecorder.AudioSource.VOICE_RECOGNITION);
        Integer deviceId = call.getInt("deviceId");
        new Thread(() -> {
            JSObject r = new JSObject();
            android.media.AudioRecord rec = null;
            try {
                int rate = 16000;
                int min = android.media.AudioRecord.getMinBufferSize(rate, android.media.AudioFormat.CHANNEL_IN_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT);
                rec = new android.media.AudioRecord(source, rate, android.media.AudioFormat.CHANNEL_IN_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT, Math.max(min, rate));
                if (rec.getState() != android.media.AudioRecord.STATE_INITIALIZED) {
                    r.put("error", "AudioRecord could not initialise (no usable input?)");
                    call.resolve(r);
                    return;
                }
                if (deviceId != null && Build.VERSION.SDK_INT >= 23) {
                    AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
                    for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_INPUTS)) if (d.getId() == deviceId) rec.setPreferredDevice(d);
                }
                rec.startRecording();
                short[] buf = new short[rate / 4];
                JSArray levels = new JSArray();
                double peak = -120;
                long total = 0;
                for (int i = 0; i < seconds * 4; i++) {
                    int n = rec.read(buf, 0, buf.length);
                    if (n <= 0) { levels.put("read=" + n); continue; }
                    double sum = 0;
                    int max = 0;
                    for (int k = 0; k < n; k++) { sum += (double) buf[k] * buf[k]; max = Math.max(max, Math.abs(buf[k])); }
                    total += n;
                    double rmsDb = 20 * Math.log10(Math.sqrt(sum / n) / 32768.0 + 1e-9);
                    peak = Math.max(peak, 20 * Math.log10(max / 32768.0 + 1e-9));
                    levels.put(Math.round(rmsDb));
                }
                if (Build.VERSION.SDK_INT >= 24 && rec.getRoutedDevice() != null) {
                    r.put("routedDevice", rec.getRoutedDevice().getProductName() + " (type " + rec.getRoutedDevice().getType() + ")");
                }
                r.put("source", source);
                r.put("samples", total);
                r.put("rmsDbPerQuarterSecond", levels);
                r.put("peakDb", Math.round(peak));
                r.put("note", "-90 dB or lower everywhere means silence / no audio reaching the app.");
            } catch (Exception e) {
                r.put("error", e.toString());
            } finally {
                if (rec != null) {
                    try { rec.stop(); } catch (Exception ignored) { }
                    rec.release();
                }
            }
            call.resolve(r);
        }).start();
    }

    // ------------------------------------------------------------ synthetic voice (no need for the owner to speak)

    private interface TtsDone { void done(JSObject result); }

    /** Speaks text through the device's speakers with the system text-to-speech engine. */
    private void speak(String text, String language, TtsDone onDone) {
        final boolean[] finished = { false };
        final android.speech.tts.TextToSpeech[] tts = new android.speech.tts.TextToSpeech[1];
        final JSObject r = new JSObject();
        final long started = System.currentTimeMillis();
        Runnable finish = () -> {
            if (finished[0]) return;
            finished[0] = true;
            r.put("ms", System.currentTimeMillis() - started);
            try { tts[0].shutdown(); } catch (Exception ignored) { }
            onDone.done(r);
        };
        tts[0] = new android.speech.tts.TextToSpeech(getContext(), status -> {
            r.put("initStatus", status == android.speech.tts.TextToSpeech.SUCCESS ? "SUCCESS" : "ERROR " + status);
            if (status != android.speech.tts.TextToSpeech.SUCCESS) { finish.run(); return; }
            r.put("engine", tts[0].getDefaultEngine());
            int lang = tts[0].setLanguage(Locale.forLanguageTag(language));
            r.put("languageResult", lang == android.speech.tts.TextToSpeech.LANG_MISSING_DATA ? "LANG_MISSING_DATA"
                : lang == android.speech.tts.TextToSpeech.LANG_NOT_SUPPORTED ? "LANG_NOT_SUPPORTED" : "OK (" + lang + ")");
            tts[0].setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                @Override public void onStart(String id) { r.put("started", true); }
                @Override public void onDone(String id) { r.put("spoken", true); finish.run(); }
                @Override public void onError(String id) { r.put("spoken", false); r.put("error", "utterance error"); finish.run(); }
                @Override public void onError(String id, int code) { r.put("spoken", false); r.put("error", "utterance error " + code); finish.run(); }
            });
            int q = tts[0].speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "wander-test");
            if (q != android.speech.tts.TextToSpeech.SUCCESS) { r.put("error", "speak() returned " + q); finish.run(); }
        });
        new Handler(Looper.getMainLooper()).postDelayed(() -> { r.put("timeout", true); finish.run(); }, 20000);
    }

    @PluginMethod
    public void speakAloud(PluginCall call) {
        String text = call.getString("text", "This is a Wander speech test.");
        String language = call.getString("language", "en-US");
        new Handler(Looper.getMainLooper()).post(() -> speak(text, language, call::resolve));
    }

    /**
     * Opens the system's own voice-input screen (the same path YouTube uses) and, optionally,
     * speaks a known phrase through the TV after a short delay so nobody has to talk.
     */
    @PluginMethod
    public void systemVoiceTest(PluginCall call) {
        String language = call.getString("language", "en-US");
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        i.putExtra(RecognizerIntent.EXTRA_PROMPT, "Wander voice test: listening…");
        if (i.resolveActivity(getContext().getPackageManager()) == null) {
            JSObject r = new JSObject();
            r.put("error", "No app handles android.speech.action.RECOGNIZE_SPEECH");
            call.resolve(r);
            return;
        }
        String speakText = call.getString("speakText", "");
        int delay = call.getInt("delayMs", 1500);
        if (speakText != null && !speakText.isEmpty()) {
            new Handler(Looper.getMainLooper()).postDelayed(() -> speak(speakText, language, res -> { }), delay);
        }
        startActivityForResult(call, i, "onSystemVoiceResult");
    }

    @com.getcapacitor.annotation.ActivityCallback
    private void onSystemVoiceResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        JSObject r = new JSObject();
        int code = result.getResultCode();
        String name;
        switch (code) {
            case -1: name = "RESULT_OK"; break;
            case 0: name = "RESULT_CANCELED (closed, timed out, or heard nothing)"; break;
            case 1: name = "RESULT_NO_MATCH"; break;
            case 2: name = "RESULT_CLIENT_ERROR"; break;
            case 3: name = "RESULT_SERVER_ERROR"; break;
            case 4: name = "RESULT_NETWORK_ERROR"; break;
            case 5: name = "RESULT_AUDIO_ERROR"; break;
            default: name = "RESULT_" + code;
        }
        r.put("resultCode", code);
        r.put("result", name);
        if (result.getData() != null) {
            ArrayList<String> m = result.getData().getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            r.put("text", m != null && !m.isEmpty() ? m.get(0) : "");
            Bundle extras = result.getData().getExtras();
            if (extras != null) {
                JSArray keys = new JSArray();
                for (String k : extras.keySet()) keys.put(k);
                r.put("extraKeys", keys);
            }
        }
        call.resolve(r);
    }
}
