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
}
