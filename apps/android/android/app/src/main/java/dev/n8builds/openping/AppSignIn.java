package dev.n8builds.openping;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import androidx.browser.customtabs.CustomTabColorSchemeParams;
import androidx.browser.customtabs.CustomTabsIntent;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Signing in through the phone's browser (src/worker/routes/app-signin.ts in
 * the repository root, docs/ANDROID.md):
 *
 * 1. start() opens {install}/auth/app/start?challenge=S256(verifier)&state=...
 *    in a Custom Tab, after saving the verifier and state here.
 * 2. The person signs in there however the install allows (passkey, GitHub,
 *    email link, OpenPing Hosted) and taps "Open the OpenPing app".
 * 3. The browser opens dev.n8builds.openping:/signed-in?code&state&origin;
 *    finish() checks the state and origin against what start() saved.
 * 4. MainActivity posts the code and the verifier to {install}/auth/app/exchange
 *    from the web view, which then has its own session.
 */
public final class AppSignIn {

    public static final String SCHEME = "dev.n8builds.openping";
    public static final String CALLBACK_PATH = "/signed-in";

    /** The server keeps a pending sign-in 15 minutes; this side allows a little more. */
    private static final long MAX_AGE_MS = 20 * 60 * 1000;
    private static final String PREFS = "openping_signin";
    private static final String KEY = "pending";

    /** A sign-in the browser finished: what the web view posts to the install. */
    public static final class Grant {

        public final String origin;
        public final String code;
        public final String verifier;

        Grant(String origin, String code, String verifier) {
            this.origin = origin;
            this.code = code;
            this.verifier = verifier;
        }

        /** The form body for POST /auth/app/exchange. */
        public byte[] exchangeBody() {
            return ("code=" + encode(code) + "&verifier=" + encode(verifier)).getBytes(StandardCharsets.US_ASCII);
        }

        public String exchangeUrl() {
            return origin + "/auth/app/exchange";
        }
    }

    private final SharedPreferences prefs;

    public AppSignIn(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Open the install's sign-in in a Custom Tab. False when no browser could open it. */
    @SuppressLint("ApplySharedPref") // commit(): see below
    public boolean start(Activity activity, String origin) {
        String verifier = Pkce.randomToken();
        String state = Pkce.randomToken();
        try {
            JSONObject pending = new JSONObject()
                .put("origin", origin)
                .put("verifier", verifier)
                .put("state", state)
                .put("at", System.currentTimeMillis());
            // commit(), not apply(): the process may be gone by the time the browser comes back.
            prefs.edit().putString(KEY, pending.toString()).commit();
        } catch (JSONException e) {
            return false;
        }
        Uri url = Uri.parse(origin + "/auth/app/start")
            .buildUpon()
            .appendQueryParameter("challenge", Pkce.challenge(verifier))
            .appendQueryParameter("state", state)
            .build();
        CustomTabsIntent tab = new CustomTabsIntent.Builder()
            .setDefaultColorSchemeParams(
                new CustomTabColorSchemeParams.Builder().setToolbarColor(0xFF0B1220).setNavigationBarColor(0xFF0B1220).build()
            )
            .setShowTitle(true)
            .setUrlBarHidingEnabled(false)
            .build();
        try {
            // Without a Custom Tabs browser this opens the default browser.
            tab.launchUrl(activity, url);
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        }
    }

    /** True for the app's sign-in callback (whether or not it is valid). */
    public static boolean isCallback(Uri data) {
        return data != null && SCHEME.equals(data.getScheme()) && CALLBACK_PATH.equals(data.getPath());
    }

    /**
     * The grant in a callback, or null when it doesn't match the sign-in this
     * app started (another app's, an old one, or a forged link). A callback
     * that doesn't match leaves the pending sign-in alone, so an unsolicited
     * one can't cancel the real one; the matching one uses it up, at once and
     * on disk, so it can't be used twice.
     */
    @SuppressLint("ApplySharedPref")
    public Grant finish(Uri data) {
        if (!isCallback(data)) return null;
        String saved = prefs.getString(KEY, null);
        if (saved == null) return null;
        try {
            JSONObject pending = new JSONObject(saved);
            String origin = pending.getString("origin");
            if (System.currentTimeMillis() - pending.getLong("at") > MAX_AGE_MS) {
                prefs.edit().remove(KEY).commit();
                return null;
            }
            String state = data.getQueryParameter("state");
            String code = data.getQueryParameter("code");
            String from = Origins.normalize(data.getQueryParameter("origin"));
            if (state == null || code == null || !state.equals(pending.getString("state"))) return null;
            if (from == null || !from.equals(origin)) return null;
            prefs.edit().remove(KEY).commit();
            return new Grant(origin, code, pending.getString("verifier"));
        } catch (JSONException e) {
            prefs.edit().remove(KEY).commit();
            return null;
        }
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8");
        } catch (java.io.UnsupportedEncodingException e) {
            throw new IllegalStateException("UTF-8 is always available", e);
        }
    }
}
