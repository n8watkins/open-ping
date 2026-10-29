package dev.n8builds.openping;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.splashscreen.SplashScreen;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The OpenPing app: one web view that shows either the app's own screens
 * (the install picker and the offline screen, bundled, at https://localhost)
 * or the install that is open, loaded from its own address. Every change to
 * an install's web app reaches the app with no app update.
 *
 * See docs/ANDROID.md in the repository root.
 */
public class MainActivity extends BridgeActivity implements ShellWebViewClient.Host, RemoteBridge.Host {

    private InstallStore store;
    private AppSignIn signIn;
    private RemoteBridge remote;

    /** The install on screen, or null on the app's own screens. */
    private String installOrigin;
    /** The next page to finish starts a fresh back stack (a switch, the offline screen). */
    private boolean clearHistoryOnFinish;
    /** The picker was opened from an install, so back returns to it. */
    private boolean pickerFromInstall;
    /** An intent that arrived before the web view was ready. */
    private Intent waitingIntent;
    /** The page waiting for an answer to "turn on notifications", while Android asks. */
    private RemoteBridge.Reply waitingPushReply;
    private String waitingPushOrigin;

    private final ActivityResultLauncher<String> notificationPermission = registerForActivityResult(
        new ActivityResultContracts.RequestPermission(),
        granted -> {
            RemoteBridge.Reply reply = waitingPushReply;
            String origin = waitingPushOrigin;
            waitingPushReply = null;
            waitingPushOrigin = null;
            if (reply != null) sendToken(origin, reply);
        }
    );

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        store = new InstallStore(this);
        signIn = new AppSignIn(this);
        registerPlugin(OpenPingShellPlugin.class);
        super.onCreate(savedInstanceState);

        WebView webView = bridge.getWebView();
        configure(webView);
        remote = new RemoteBridge(webView, this);
        bridge.setWebViewClient(new ShellWebViewClient(bridge, this));
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (!goBack()) {
                    // Nothing left inside the app: leave it the usual way.
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            }
        });

        if (waitingIntent != null) {
            Intent intent = waitingIntent;
            waitingIntent = null;
            handleIntent(intent);
        }
    }

    private void configure(WebView webView) {
        WebSettings settings = webView.getSettings();
        // Installs are web pages: no files from the phone, no extra windows.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setUserAgentString(
            WebSettings.getDefaultUserAgent(this) + " OpenPingApp/" + BuildConfig.VERSION_NAME + " (Android)"
        );
        // Passkeys inside the web view, for installs that link this app in
        // /.well-known/assetlinks.json (ANDROID_APP_LINKS). Sign-in itself
        // always works through the browser without it.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP);
        }
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (remote == null) {
            // BridgeActivity passes the launch intent on during super.onCreate().
            waitingIntent = intent;
            return;
        }
        handleIntent(intent);
    }

    @Override
    public void onPause() {
        super.onPause();
        // Keep the sessions the web view holds even if the process is stopped.
        CookieManager.getInstance().flush();
    }

    /** A tapped notification, the sign-in coming back from the browser, the "Switch OpenPing" shortcut. */
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String alertNonce = intent.getStringExtra(AlertMessagingService.EXTRA_ALERT);
        if (alertNonce != null) {
            // Handled once, not again after a rotation. The page comes from
            // the notification this app posted (by its one-time nonce), never
            // from the intent, which any app could send to this activity.
            intent.removeExtra(AlertMessagingService.EXTRA_ALERT);
            AlertMessagingService.Tap tap = AlertMessagingService.takeTap(this, alertNonce);
            if (tap != null && store.get(tap.origin) != null && Origins.isOn(tap.url, tap.origin)) {
                openInstall(tap.origin, tap.url.substring(tap.origin.length()));
            }
            return;
        }
        Uri data = intent.getData();
        if (data == null) return;
        if (AppSignIn.isCallback(data)) {
            AppSignIn.Grant grant = signIn.finish(data);
            if (grant == null || store.get(grant.origin) == null) {
                Toast.makeText(this, R.string.signin_mismatch, Toast.LENGTH_LONG).show();
                return;
            }
            if (!RemoteBridge.supported()) {
                showUnsupportedWebView();
                return;
            }
            // The web view's own session: post the code and the verifier.
            show(grant.origin);
            bridge.getWebView().postUrl(grant.exchangeUrl(), grant.exchangeBody());
            return;
        }
        if (AppSignIn.SCHEME.equals(data.getScheme()) && "/switch".equals(data.getPath())) {
            showPicker();
        }
    }

    // --- Moving between installs and the app's screens -------------------------

    /** Load {@code path} of a known install. Main thread. */
    void openInstall(String origin, String path) {
        if (store.get(origin) == null) return;
        if (!RemoteBridge.supported()) {
            showUnsupportedWebView();
            return;
        }
        show(origin);
        bridge.getWebView().loadUrl(origin + safePath(path));
    }

    /** Make {@code origin} the install on screen, before anything of it loads. */
    private void show(String origin) {
        installOrigin = origin;
        pickerFromInstall = false;
        store.markOpened(origin);
        remote.attach(origin);
        clearHistoryOnFinish = true;
    }

    /** The list of installs. Main thread. */
    void showPicker() {
        pickerFromInstall = installOrigin != null;
        leaveInstall();
        bridge.getWebView().loadUrl(bridge.getLocalUrl() + "/#/picker");
    }

    /**
     * This phone's web view is too old to give an install's pages only their
     * own bridge: Capacitor would then fall back to a JavaScript interface on
     * every page and frame, so no install loads until it is updated.
     */
    private void showUnsupportedWebView() {
        leaveInstall();
        bridge.getWebView().loadUrl(bridge.getLocalUrl() + "/#/webview");
    }

    private void leaveInstall() {
        installOrigin = null;
        remote.attach(null);
        clearHistoryOnFinish = true;
    }

    /** Back inside the app; false when there is nowhere left to go. */
    private boolean goBack() {
        WebView webView = bridge.getWebView();
        if (webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        if (installOrigin != null && store.list().size() > 1) {
            showPicker();
            return true;
        }
        String active = store.active();
        if (installOrigin == null && pickerFromInstall && active != null) {
            openInstall(active, "/");
            return true;
        }
        return false;
    }

    private static String safePath(String path) {
        if (path == null || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return "/";
        return path;
    }

    // --- ShellWebViewClient.Host -------------------------------------------------

    @Override
    public String installOrigin() {
        return installOrigin;
    }

    @Override
    public void openExternally(Uri url) {
        Intent intent = new Intent(Intent.ACTION_VIEW, url);
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public void showOffline(String failedUrl, String reason) {
        if (installOrigin == null || !Origins.isOn(failedUrl, installOrigin)) return;
        leaveInstall();
        String screen = "/#/offline?url=" + encode(failedUrl) + "&reason=" + encode(reason);
        bridge.getWebView().loadUrl(bridge.getLocalUrl() + screen);
    }

    @Override
    public void onPageFinished(String url) {
        if (!clearHistoryOnFinish) return;
        clearHistoryOnFinish = false;
        bridge.getWebView().clearHistory();
    }

    // --- RemoteBridge.Host ---------------------------------------------------------

    @Override
    public void onSignInRequested(String origin) {
        if (!signIn.start(this, origin)) Toast.makeText(this, R.string.no_browser, Toast.LENGTH_LONG).show();
    }

    @Override
    public void onSwitchRequested() {
        showPicker();
    }

    @Override
    public void onPushRequested(String origin, RemoteBridge.Reply reply, boolean ask) {
        if (!Push.configured()) {
            pushError(reply, "unavailable");
            return;
        }
        if (Push.needsPermissionPrompt(this)) {
            if (!ask) {
                pushError(reply, "denied");
                return;
            }
            // One question at a time; a second tap answers the first.
            if (waitingPushReply != null) pushError(waitingPushReply, "failed");
            waitingPushReply = reply;
            waitingPushOrigin = origin;
            notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS);
            return;
        }
        sendToken(origin, reply);
    }

    private void sendToken(String origin, RemoteBridge.Reply reply) {
        Push.token(this, new Push.TokenCallback() {
            @Override
            public void onToken(String token) {
                String previous = Push.rememberToken(MainActivity.this, origin, token);
                try {
                    JSONObject answer = new JSONObject()
                        .put("type", "push.token")
                        .put("token", token)
                        .put("projectId", BuildConfig.FIREBASE_PROJECT_ID)
                        .put("device", Push.deviceName());
                    if (previous != null) answer.put("previousToken", previous);
                    reply.send(answer);
                } catch (JSONException ignored) {
                    // Plain values.
                }
            }

            @Override
            public void onError(String reason) {
                pushError(reply, reason);
            }
        });
    }

    private static void pushError(RemoteBridge.Reply reply, String reason) {
        try {
            reply.send(new JSONObject().put("type", "push.error").put("reason", reason));
        } catch (JSONException ignored) {
            // Plain values.
        }
    }

    @Override
    public String appVersion() {
        return BuildConfig.VERSION_NAME;
    }

    @Override
    public boolean pushAvailable() {
        return Push.configured();
    }

    InstallStore store() {
        return store;
    }

    /** Before the app signs out of an install: forget this phone's notifications there. */
    ServerSignOut.BeforeSignOut beforeSignOut(String origin) {
        String token = Push.tokenFor(this, origin);
        Push.forgetToken(this, origin);
        if (token == null) return null;
        return session -> session.call("DELETE", "/api/push/fcm", new JSONObject().put("token", token));
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, StandardCharsets.UTF_8.name());
        } catch (java.io.UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }
}
