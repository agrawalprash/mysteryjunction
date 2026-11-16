package io.github.agrawalprash.wander;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Voice input through the device's speech recogniser (Google's on Android TV and phones).
 * Also relays the remote's search/mic button to the web app as a "voiceKey" event.
 */
@CapacitorPlugin(
    name = "WanderVoice",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class VoicePlugin extends Plugin {

    @PluginMethod
    public void listen(PluginCall call) {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, call.getString("language", "en-US"));
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, call.getString("prompt", "What are you in the mood for?"));
        if (intent.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("This device has no voice recognition service.", "NO_RECOGNIZER");
            return;
        }
        startActivityForResult(call, intent, "onResult");
    }

    @ActivityCallback
    private void onResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Nothing was heard.", "NO_SPEECH");
            return;
        }
        ArrayList<String> matches = result.getData().getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        JSObject r = new JSObject();
        r.put("text", matches != null && !matches.isEmpty() ? matches.get(0) : "");
        call.resolve(r);
    }

    /** Called by MainActivity when a voice/search key arrives from the remote. */
    void relayVoiceKey(int keyCode) {
        JSObject e = new JSObject();
        e.put("keyCode", keyCode);
        notifyListeners("voiceKey", e);
    }

    // ------------------------------------------------------------ hold to talk
    // Listens in the background (no system dialog) from holdStart until holdStop, like a
    // walkie-talkie: words appear live as "partial" events and the final text comes back on release.

    private SpeechRecognizer holdRecognizer;
    private PluginCall stopCall;
    private String finalText;
    private String holdError;
    private boolean finished;

    @PluginMethod
    public void holdStart(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicForHold");
            return;
        }
        beginHold(call);
    }

    @PermissionCallback
    private void afterMicForHold(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) beginHold(call);
        else call.reject("Wander needs microphone permission for hold-to-talk.", "NO_PERMISSION");
    }

    private void beginHold(PluginCall call) {
        String language = call.getString("language", "en-US");
        new Handler(Looper.getMainLooper()).post(() -> {
            endRecognizer();
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("This device has no speech recognition service.", "NO_RECOGNIZER");
                return;
            }
            finalText = null;
            holdError = null;
            finished = false;
            stopCall = null;
            holdRecognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            holdRecognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) { notifyListeners("holdReady", new JSObject()); }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float rmsdB) { }
                @Override public void onBufferReceived(byte[] buffer) { }
                @Override public void onEndOfSpeech() { }
                @Override public void onError(int error) {
                    holdError = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                        ? "Didn't catch that." : "Speech recognition error " + error;
                    done();
                }
                @Override public void onResults(Bundle results) {
                    ArrayList<String> m = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    finalText = m != null && !m.isEmpty() ? m.get(0) : "";
                    done();
                }
                @Override public void onPartialResults(Bundle partial) {
                    ArrayList<String> m = partial.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (m != null && !m.isEmpty()) {
                        JSObject e = new JSObject();
                        e.put("text", m.get(0));
                        notifyListeners("holdPartial", e);
                    }
                }
                @Override public void onEvent(int eventType, Bundle params) { }
            });
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            // Don't stop on pauses while the button is held; releasing ends it.
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 6000L);
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 6000L);
            holdRecognizer.startListening(i);
            call.resolve();
        });
    }

    /** Release: stop listening and return what was said. */
    @PluginMethod
    public void holdStop(PluginCall call) {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (finished || holdRecognizer == null) {
                resolveStop(call);
                return;
            }
            stopCall = call;
            holdRecognizer.stopListening();
            // If the recogniser never answers, don't hang.
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                if (stopCall == call) {
                    holdError = holdError != null ? holdError : "No answer from speech recognition.";
                    done();
                }
            }, 8000);
        });
    }

    @PluginMethod
    public void holdCancel(PluginCall call) {
        new Handler(Looper.getMainLooper()).post(() -> {
            stopCall = null;
            endRecognizer();
            call.resolve();
        });
    }

    private void done() {
        finished = true;
        if (stopCall != null) {
            PluginCall c = stopCall;
            stopCall = null;
            resolveStop(c);
        }
        // Not from inside the recogniser's own callback.
        new Handler(Looper.getMainLooper()).post(this::endRecognizer);
    }

    private void resolveStop(PluginCall c) {
        JSObject r = new JSObject();
        r.put("text", finalText != null ? finalText : "");
        if (holdError != null && (finalText == null || finalText.isEmpty())) r.put("error", holdError);
        c.resolve(r);
    }

    private void endRecognizer() {
        if (holdRecognizer != null) {
            try { holdRecognizer.destroy(); } catch (Exception ignored) { }
            holdRecognizer = null;
        }
    }
}
