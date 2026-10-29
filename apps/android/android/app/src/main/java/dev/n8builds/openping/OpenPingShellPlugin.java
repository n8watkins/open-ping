package dev.n8builds.openping;

import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * What the app's own screens (apps/android/src/shell.ts) ask the native side.
 * Capacitor's bridge, and so this plugin, exists only on those screens
 * (https://localhost), never on an install's pages.
 */
@CapacitorPlugin(name = "OpenPingShell")
public class OpenPingShellPlugin extends Plugin {

    private final ExecutorService network = Executors.newSingleThreadExecutor();

    private MainActivity shell() {
        return (MainActivity) getActivity();
    }

    private JSObject state() {
        InstallStore store = shell().store();
        JSObject state = new JSObject();
        state.put("installs", store.toJson());
        String active = store.active();
        state.put("active", active != null ? active : JSONObject.NULL);
        state.put("version", BuildConfig.VERSION_NAME);
        return state;
    }

    /** The origin a call names, exactly as an install's origin, or null (and the call rejected). */
    private String originOf(PluginCall call) {
        String origin = call.getString("origin");
        String normalized = Origins.normalize(origin);
        if (normalized == null || !normalized.equals(origin)) {
            call.reject("Not an install address", "invalid");
            return null;
        }
        return origin;
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void probe(PluginCall call) {
        String origin = originOf(call);
        if (origin == null) return;
        String userAgent = getBridge().getWebView().getSettings().getUserAgentString();
        network.execute(() -> {
            Prober.Result result = Prober.probe(origin, userAgent);
            JSObject answer = new JSObject();
            answer.put("ok", result.ok);
            if (result.ok) {
                answer.put("origin", origin);
                answer.put("hosted", result.hosted);
            } else {
                answer.put("reason", result.reason);
                if (result.location != null) answer.put("location", result.location);
            }
            call.resolve(answer);
        });
    }

    @PluginMethod
    public void add(PluginCall call) {
        String origin = originOf(call);
        if (origin == null) return;
        shell().store().add(origin, Boolean.TRUE.equals(call.getBoolean("hosted", false)));
        call.resolve(state());
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String origin = originOf(call);
        if (origin == null) return;
        shell().store().remove(origin);
        getBridge().executeOnMainThread(() -> {
            // Signed out of it on this phone: its session cookie and its saved data go.
            CookieManager cookies = CookieManager.getInstance();
            cookies.setCookie(origin, "op_session=; Max-Age=0; Path=/; Secure; HttpOnly");
            cookies.flush();
            WebStorage.getInstance().deleteOrigin(origin);
            call.resolve(state());
        });
    }

    @PluginMethod
    public void open(PluginCall call) {
        String origin = originOf(call);
        if (origin == null) return;
        String path = call.getString("path", "/");
        getBridge().executeOnMainThread(() -> {
            shell().openInstall(origin, path);
            call.resolve();
        });
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("Only https links", "invalid");
            return;
        }
        getBridge().executeOnMainThread(() -> {
            shell().openExternally(Uri.parse(url));
            call.resolve();
        });
    }
}
