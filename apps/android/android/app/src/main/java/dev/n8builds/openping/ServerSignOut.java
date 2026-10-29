package dev.n8builds.openping;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Removing an install from the app signs this phone out of it on the install
 * too: with the web view's session cookie, read the CSRF token (GET
 * /api/auth/me), run the steps that need a session (forgetting this phone's
 * notifications), then POST /api/auth/logout. Best effort, off the main
 * thread: an install that can't be reached keeps the session until it
 * expires, and the owner can sign it out in Settings.
 */
public final class ServerSignOut {

    /** Signed-in calls to make before the session ends: (connection maker, CSRF token). */
    public interface BeforeSignOut {
        void run(Session session) throws IOException, JSONException;
    }

    /** A signed-in caller for one install. */
    public static final class Session {

        private final String origin;
        private final String cookie;
        private final String userAgent;
        private final String csrf;

        Session(String origin, String cookie, String userAgent, String csrf) {
            this.origin = origin;
            this.cookie = cookie;
            this.userAgent = userAgent;
            this.csrf = csrf;
        }

        /** Send `method path` with `json` (or no body); the status code. */
        public int call(String method, String path, JSONObject json) throws IOException {
            HttpURLConnection c = open(origin + path, cookie, userAgent);
            c.setRequestMethod(method);
            c.setRequestProperty("x-csrf-token", csrf);
            if (json != null) {
                byte[] body = json.toString().getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = c.getOutputStream()) {
                    out.write(body);
                }
            }
            try {
                return c.getResponseCode();
            } finally {
                c.disconnect();
            }
        }
    }

    private static final int TIMEOUT_MS = 8_000;

    private ServerSignOut() {}

    public static void run(String origin, String cookie, String userAgent, BeforeSignOut before) {
        if (cookie == null || cookie.isEmpty()) return;
        try {
            String csrf = csrfToken(origin, cookie, userAgent);
            if (csrf == null) return;
            Session session = new Session(origin, cookie, userAgent, csrf);
            if (before != null) {
                try {
                    before.run(session);
                } catch (IOException | JSONException e) {
                    // Still sign out.
                }
            }
            session.call("POST", "/api/auth/logout", null);
        } catch (IOException e) {
            // Offline or gone: the session expires on its own.
        }
    }

    private static String csrfToken(String origin, String cookie, String userAgent) throws IOException {
        HttpURLConnection c = open(origin + "/api/auth/me", cookie, userAgent);
        try {
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream()) {
                byte[] bytes = new byte[16 * 1024];
                int total = 0;
                int n;
                while (total < bytes.length && (n = in.read(bytes, total, bytes.length - total)) != -1) total += n;
                JSONObject me = new JSONObject(new String(bytes, 0, total, StandardCharsets.UTF_8));
                return me.optBoolean("authenticated") ? me.optString("csrf", null) : null;
            } catch (JSONException e) {
                return null;
            }
        } finally {
            c.disconnect();
        }
    }

    private static HttpURLConnection open(String url, String cookie, String userAgent) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(TIMEOUT_MS);
        c.setReadTimeout(TIMEOUT_MS);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("Cookie", cookie);
        c.setRequestProperty("Accept", "application/json");
        if (userAgent != null) c.setRequestProperty("User-Agent", userAgent);
        return c;
    }
}
