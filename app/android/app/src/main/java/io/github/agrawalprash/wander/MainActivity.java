package io.github.agrawalprash.wander;

import android.content.pm.ActivityInfo;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DevicePlugin.class);
        registerPlugin(UpdaterPlugin.class);
        registerPlugin(VoicePlugin.class);
        super.onCreate(savedInstanceState);
        if (bridge != null) {
            bridge.getWebView().setWebChromeClient(new FullscreenChromeClient(bridge));
        }
    }

    /**
     * Remote mic/search buttons arrive here. We pass them to the web app so it can
     * start voice input. (Some remotes send these straight to Google Assistant
     * instead, in which case they never reach us; Settings has a test for that.)
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        boolean voiceKey = code == KeyEvent.KEYCODE_SEARCH || code == KeyEvent.KEYCODE_VOICE_ASSIST || code == KeyEvent.KEYCODE_ASSIST;
        if (voiceKey && bridge != null) {
            if (event.getAction() == KeyEvent.ACTION_UP) {
                com.getcapacitor.PluginHandle h = bridge.getPlugin("WanderVoice");
                if (h != null) ((VoicePlugin) h.getInstance()).relayVoiceKey(code);
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    /**
     * Capacitor's default chrome client immediately cancels HTML5 fullscreen,
     * which makes the YouTube player's fullscreen button do nothing. This one
     * shows the video full screen in landscape and restores the app afterwards.
     */
    private class FullscreenChromeClient extends BridgeWebChromeClient {
        private View customView;
        private CustomViewCallback customViewCallback;
        private final OnBackPressedCallback backCallback = new OnBackPressedCallback(false) {
            @Override
            public void handleOnBackPressed() {
                onHideCustomView();
            }
        };

        FullscreenChromeClient(Bridge bridge) {
            super(bridge);
            getOnBackPressedDispatcher().addCallback(MainActivity.this, backCallback);
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            ViewGroup decor = (ViewGroup) getWindow().getDecorView();
            decor.addView(view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), decor);
            controller.hide(WindowInsetsCompat.Type.systemBars());
            controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            backCallback.setEnabled(true);
        }

        @Override
        public void onHideCustomView() {
            if (customView == null) return;
            ViewGroup decor = (ViewGroup) getWindow().getDecorView();
            decor.removeView(customView);
            WindowCompat.getInsetsController(getWindow(), decor)
                .show(WindowInsetsCompat.Type.systemBars());
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            backCallback.setEnabled(false);
            if (customViewCallback != null) customViewCallback.onCustomViewHidden();
            customView = null;
            customViewCallback = null;
        }
    }
}
