package dev.n8builds.openping;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.UnknownHostException;
import javax.net.ssl.SSLException;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Is there an OpenPing at this address, new enough for the app? Asks its
 * public /api/auth/status, which every install answers without a sign-in.
 * Runs off the main thread.
 */
public final class Prober {

    /** The app sign-in version the app speaks (APP_SIGNIN_VERSION in src/worker/routes/api-auth.ts). */
    static final int APP_SIGNIN_VERSION = 1;

    private static final int TIMEOUT_MS = 10_000;
    private static final int MAX_BYTES = 64 * 1024;

    public static final class Result {

        public final boolean ok;
        /** On failure: invalid, not_found, unreachable, tls, not_openping, too_old or moved. */
        public final String reason;
        public final boolean hosted;
        /** For "moved": where the address forwards to. */
        public final String location;

        private Result(boolean ok, String reason, boolean hosted, String location) {
            this.ok = ok;
            this.reason = reason;
            this.hosted = hosted;
            this.location = location;
        }

        static Result ok(boolean hosted) {
            return new Result(true, null, hosted, null);
        }

        static Result fail(String reason) {
            return new Result(false, reason, false, null);
        }

        static Result moved(String location) {
            return new Result(false, "moved", false, location);
        }
    }

    private Prober() {}

    public static Result probe(String origin, String userAgent) {
        if (Origins.normalize(origin) == null || !Origins.normalize(origin).equals(origin)) return Result.fail("invalid");
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(origin + "/api/auth/status").openConnection();
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            // A redirect to another address is an answer of its own.
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            if (userAgent != null) connection.setRequestProperty("User-Agent", userAgent);
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                String location = connection.getHeaderField("Location");
                String target = location == null ? null : Origins.normalize(new URL(new URL(origin), location).toString());
                return target != null && !target.equals(origin) ? Result.moved(target) : Result.fail("not_openping");
            }
            if (status != 200) return Result.fail("not_openping");
            JSONObject body = new JSONObject(read(connection.getInputStream()));
            if (!body.has("setupComplete")) return Result.fail("not_openping");
            if (body.optInt("appSignIn", 0) < APP_SIGNIN_VERSION) return Result.fail("too_old");
            return Result.ok(body.has("hosted"));
        } catch (UnknownHostException e) {
            return Result.fail("not_found");
        } catch (SSLException e) {
            return Result.fail("tls");
        } catch (JSONException e) {
            return Result.fail("not_openping");
        } catch (IOException e) {
            return Result.fail("unreachable");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int total = 0;
            int n;
            while ((n = stream.read(buffer)) != -1) {
                total += n;
                // Far bigger than any install's answer: not an OpenPing (and not parsed).
                if (total > MAX_BYTES) return "";
                out.write(buffer, 0, n);
            }
            return out.toString("UTF-8");
        }
    }
}
