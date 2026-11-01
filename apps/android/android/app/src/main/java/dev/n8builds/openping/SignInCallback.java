package dev.n8builds.openping;

import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;

/**
 * The browser sign-in's callback, as the app receives it:
 * dev.n8builds.openping:/signed-in?code=...&state=...&origin=...
 *
 * The finish page (src/worker/routes/app-signin.ts) opens it as an Android
 * intent URL restricted to this app's package where the browser supports
 * them, and as the plain link otherwise; Android delivers the same URI either
 * way, so this is the one shape to read. Plain Java (java.net.URI, not
 * android.net.Uri) so the JVM unit tests cover it.
 */
public final class SignInCallback {

    public final String code;
    public final String state;
    /** The origin parameter as sent; AppSignIn normalizes and checks it. */
    public final String origin;

    private SignInCallback(String code, String state, String origin) {
        this.code = code;
        this.state = state;
        this.origin = origin;
    }

    /** True for a URI on the callback path (whether or not its parameters are usable). */
    public static boolean isCallback(String uri) {
        URI parsed = parseUri(uri);
        return parsed != null && AppSignIn.SCHEME.equals(parsed.getScheme()) && AppSignIn.CALLBACK_PATH.equals(parsed.getPath()) && parsed.getRawAuthority() == null;
    }

    /** The callback's parameters, or null when {@code uri} isn't the callback or lacks the code or the state. */
    public static SignInCallback parse(String uri) {
        if (!isCallback(uri)) return null;
        String query = parseUri(uri).getRawQuery();
        if (query == null) return null;
        String code = null;
        String state = null;
        String origin = null;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq <= 0) continue;
            String key = decode(pair.substring(0, eq));
            String value = decode(pair.substring(eq + 1));
            if (key == null || value == null) return null;
            // A repeated parameter is never guessed at.
            if (key.equals("code")) {
                if (code != null) return null;
                code = value;
            } else if (key.equals("state")) {
                if (state != null) return null;
                state = value;
            } else if (key.equals("origin")) {
                if (origin != null) return null;
                origin = value;
            }
        }
        if (code == null || state == null) return null;
        return new SignInCallback(code, state, origin);
    }

    private static URI parseUri(String uri) {
        if (uri == null) return null;
        try {
            return new URI(uri);
        } catch (URISyntaxException e) {
            return null;
        }
    }

    private static String decode(String value) {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (UnsupportedEncodingException | IllegalArgumentException e) {
            return null;
        }
    }
}
