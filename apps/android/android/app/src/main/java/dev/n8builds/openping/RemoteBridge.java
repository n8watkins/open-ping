package dev.n8builds.openping;

import android.net.Uri;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * window.OpenPingApp on the open install's pages, and on no other site's: a
 * WebMessageListener limited to that one origin (src/client/lib/native-app.ts
 * in the repository root). It is the only way an install's page reaches the
 * app; Capacitor's own bridge exists only on the app's screens.
 */
public final class RemoteBridge {

    /** What an install's page can ask for. Called on the main thread. */
    public interface Host {
        void onSignInRequested(String origin);

        void onSwitchRequested();

        /**
         * A push token for the page, through {@code reply}. With {@code ask},
         * Android may ask the person for notification permission first;
         * without it, only when notifications are already allowed.
         */
        void onPushRequested(String origin, Reply reply, boolean ask);

        String appVersion();

        boolean pushAvailable();
    }

    /** A way to answer the page that asked. */
    public interface Reply {
        void send(JSONObject message);
    }

    private static final String OBJECT_NAME = "OpenPingApp";

    private final WebView webView;
    private final Host host;
    private String origin;

    public RemoteBridge(WebView webView, Host host) {
        this.webView = webView;
        this.host = host;
    }

    /** True when this WebView can give pages the bridge at all. */
    public static boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
    }

    /**
     * Offer the bridge to {@code installOrigin}'s pages from the next page load
     * on (null: to none). Call it before loading the install.
     */
    public void attach(String installOrigin) {
        if (!supported()) return;
        if (installOrigin != null && installOrigin.equals(origin)) return;
        if (origin != null) WebViewCompat.removeWebMessageListener(webView, OBJECT_NAME);
        origin = installOrigin;
        if (installOrigin == null) return;
        WebViewCompat.addWebMessageListener(webView, OBJECT_NAME, Collections.singleton(installOrigin), this::onMessage);
    }

    private void onMessage(WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy proxy) {
        // Only the install's own top-level page, never a frame inside it.
        String from = Origins.of(sourceOrigin.toString());
        if (!isMainFrame || origin == null || !origin.equals(from)) return;
        String data = message.getData();
        if (data == null || data.length() > 4096) return;
        String type;
        try {
            type = new JSONObject(data).optString("type");
        } catch (JSONException e) {
            return;
        }
        Reply reply = (answer) -> {
            // Always true here: this listener exists only where it is (attach()).
            if (supported()) proxy.postMessage(answer.toString());
        };
        switch (type) {
            case "hello":
                try {
                    reply.send(new JSONObject().put("type", "info").put("version", host.appVersion()).put("push", host.pushAvailable()));
                } catch (JSONException ignored) {
                    // Plain values.
                }
                break;
            case "signin":
                host.onSignInRequested(origin);
                break;
            case "switch":
                host.onSwitchRequested();
                break;
            case "push.register":
                host.onPushRequested(origin, reply, true);
                break;
            case "push.refresh":
                host.onPushRequested(origin, reply, false);
                break;
            default:
                break;
        }
    }
}
