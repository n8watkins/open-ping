package dev.n8builds.openping;

import android.net.Uri;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Capacitor's web view client, plus the shell's rules: what may load inside
 * the app (NavigationPolicy), and the offline screen when an install's page
 * can't load.
 */
public final class ShellWebViewClient extends BridgeWebViewClient {

    /** The shell, as this client needs it. Called on the main thread. */
    public interface Host {
        /** The install that is open, or null on the app's own screens. */
        String installOrigin();

        void openExternally(Uri url);

        void showOffline(String failedUrl, String reason);

        void onPageFinished(String url);
    }

    private final Host host;

    public ShellWebViewClient(Bridge bridge, Host host) {
        super(bridge);
        this.host = host;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        // Frames inside an install's page load as the page asked; they never
        // get the bridge (RemoteBridge checks for the main frame).
        if (!request.isForMainFrame()) return false;
        Uri url = request.getUrl();
        switch (NavigationPolicy.decide(url.toString(), view.getUrl(), host.installOrigin())) {
            case IN_APP:
                return false;
            case EXTERNAL:
                host.openExternally(url);
                return true;
            case BLOCK:
            default:
                return true;
        }
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        host.onPageFinished(url);
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        super.onReceivedError(view, request, error);
        if (!request.isForMainFrame()) return;
        String url = request.getUrl().toString();
        if (Origins.isOn(url, NavigationPolicy.LOCAL_ORIGIN)) return;
        host.showOffline(url, "network");
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        // Never proceed past a bad certificate. Only the install's own one
        // stops the page; another site's image or script just doesn't load.
        handler.cancel();
        if (Origins.isOn(error.getUrl(), host.installOrigin())) host.showOffline(error.getUrl(), "certificate");
    }
}
