package dev.n8builds.openping;

import java.util.Locale;

/**
 * What a page may navigate the web view to. Inside the app only two places
 * load: this app's own screens (https://localhost, from those screens only)
 * and the install that is open. Web links go to the phone's browser, a few
 * well-known schemes (mail, phone) to their apps, and everything else nowhere.
 */
public final class NavigationPolicy {

    public enum Decision {
        /** Load it in the web view. */
        IN_APP,
        /** Hand it to the phone (the browser, the mail app). */
        EXTERNAL,
        /** Do nothing. */
        BLOCK,
    }

    /** The origin Capacitor serves the app's own screens from. */
    public static final String LOCAL_ORIGIN = "https://localhost";

    private NavigationPolicy() {}

    /**
     * @param url where the page wants to go (a main-frame navigation)
     * @param currentUrl where the web view is now
     * @param installOrigin the open install's origin, or null on the app's own screens
     */
    public static Decision decide(String url, String currentUrl, String installOrigin) {
        if (url == null) return Decision.BLOCK;
        String scheme = schemeOf(url);
        if (scheme.equals("about")) return url.equals("about:blank") ? Decision.IN_APP : Decision.BLOCK;
        if (scheme.equals("https") || scheme.equals("http")) {
            if (Origins.isOn(url, LOCAL_ORIGIN)) {
                // Only the app's own screens move between themselves; an
                // install's page can't open them.
                return Origins.isOn(currentUrl, LOCAL_ORIGIN) ? Decision.IN_APP : Decision.BLOCK;
            }
            if (installOrigin != null && Origins.isOn(url, installOrigin)) return Decision.IN_APP;
            return Decision.EXTERNAL;
        }
        switch (scheme) {
            case "mailto":
            case "tel":
            case "sms":
                return Decision.EXTERNAL;
            default:
                // intent:, file:, content:, javascript:, data:, blob:, and this
                // app's own scheme (only the browser may send the sign-in back).
                return Decision.BLOCK;
        }
    }

    private static String schemeOf(String url) {
        int colon = url.indexOf(':');
        return colon <= 0 ? "" : url.substring(0, colon).toLowerCase(Locale.ROOT);
    }
}
