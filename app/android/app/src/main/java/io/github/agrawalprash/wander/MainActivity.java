package io.github.agrawalprash.wander;

import android.content.pm.ActivityInfo;
import android.os.Bundle;
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
        super.onCreate(savedInstanceState);
        if (bridge != null) {
            bridge.getWebView().setWebChromeClient(new FullscreenChromeClient(bridge));
        }
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
