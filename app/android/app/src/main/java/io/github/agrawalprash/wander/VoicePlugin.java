package io.github.agrawalprash.wander;

import android.app.Activity;
import android.content.Intent;
import android.speech.RecognizerIntent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;

/**
 * Voice input through the device's speech recogniser (Google's on Android TV and phones).
 * Also relays the remote's search/mic button to the web app as a "voiceKey" event.
 */
@CapacitorPlugin(name = "WanderVoice")
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
}
