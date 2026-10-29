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

    /** The sign-in coming back from the browser, the "Switch OpenPing" shortcut. */
    private void handleIntent(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
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
    public void onPushRequested(String origin, RemoteBridge.Reply reply) {
        try {
            reply.send(new JSONObject().put("type", "push.error").put("reason", "unavailable"));
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
        return false;
    }

    InstallStore store() {
        return store;
    }

    /** What to do on an install, signed in, before the app signs out of it (none yet: push adds one). */
    ServerSignOut.BeforeSignOut beforeSignOut(String origin) {
        return null;
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, StandardCharsets.UTF_8.name());
        } catch (java.io.UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }
}
