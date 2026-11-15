package io.github.agrawalprash.wander;

import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Tells the web app whether it is running on a TV, so it can switch to the remote-control layout. */
@CapacitorPlugin(name = "WanderDevice")
public class DevicePlugin extends Plugin {
    @PluginMethod
    public void info(PluginCall call) {
        Context ctx = getContext();
        UiModeManager ui = (UiModeManager) ctx.getSystemService(Context.UI_MODE_SERVICE);
        boolean tv = (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
            || ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
        JSObject result = new JSObject();
        result.put("isTv", tv);
        call.resolve(result);
    }
}
