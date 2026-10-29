package dev.n8builds.openping;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * An alert from an install (a data message, src/worker/notifications/push/fcm.ts):
 * shown as a notification whether the app is open or not, and a tap opens
 * the page it is about, in that install.
 */
public class AlertMessagingService extends FirebaseMessagingService {

    /** The one extra a notification's tap carries: a one-time nonce (takeTap). */
    static final String EXTRA_ALERT = "dev.n8builds.openping.ALERT";

    private static final String TAPS = "openping_alert_taps";
    /** Notifications whose taps are remembered; older ones open the install's start page. */
    private static final int MAX_TAPS = 50;

    /** Where a tapped notification goes. */
    static final class Tap {

        final String url;
        final String origin;

        Tap(String url, String origin) {
            this.url = url;
            this.origin = origin;
        }
    }

    /** Remember where the notification with {@code nonce} goes. */
    private static synchronized void putTap(Context context, String nonce, String url, String origin) {
        SharedPreferences prefs = context.getSharedPreferences(TAPS, Context.MODE_PRIVATE);
        try {
            JSONArray taps = new JSONArray(prefs.getString("taps", "[]"));
            taps.put(new JSONObject().put("nonce", nonce).put("url", url).put("origin", origin));
            JSONArray kept = new JSONArray();
            for (int i = Math.max(0, taps.length() - MAX_TAPS); i < taps.length(); i++) kept.put(taps.get(i));
            prefs.edit().putString("taps", kept.toString()).apply();
        } catch (JSONException e) {
            prefs.edit().remove("taps").apply();
        }
    }

    /** The tap for {@code nonce}, used up; null for one this app didn't post (or long ago). */
    static synchronized Tap takeTap(Context context, String nonce) {
        SharedPreferences prefs = context.getSharedPreferences(TAPS, Context.MODE_PRIVATE);
        try {
            JSONArray taps = new JSONArray(prefs.getString("taps", "[]"));
            JSONArray kept = new JSONArray();
            Tap found = null;
            for (int i = 0; i < taps.length(); i++) {
                JSONObject tap = taps.getJSONObject(i);
                if (found == null && nonce.equals(tap.optString("nonce"))) {
                    found = new Tap(tap.getString("url"), tap.getString("origin"));
                } else {
                    kept.put(tap);
                }
            }
            prefs.edit().putString("taps", kept.toString()).apply();
            return found;
        } catch (JSONException e) {
            return null;
        }
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        if (!"alert".equals(data.get("kind"))) return;
        String origin = Origins.normalize(data.get("origin"));
        String url = data.get("url");
        String title = data.get("title");
        if (origin == null || title == null) return;
        // Only an install this phone has added, and only a page on it.
        if (new InstallStore(this).get(origin) == null) return;
        if (url == null || !Origins.isOn(url, origin)) url = origin + "/";

        Push.ensureChannel(this);
        String nonce = Pkce.randomToken();
        putTap(this, nonce, url, origin);
        Intent open = new Intent(this, MainActivity.class)
            .putExtra(EXTRA_ALERT, nonce)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        String tag = data.get("tag") != null ? data.get("tag") : url;
        PendingIntent tap = PendingIntent.getActivity(
            this,
            (origin + tag).hashCode(),
            open,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        String body = data.get("body") != null ? data.get("body") : "";
        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, Push.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ContextCompat.getColor(this, R.color.accent))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setSubText(origin.replaceFirst("^https://", ""))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true)
            .setContentIntent(tap);
        if (!Push.permitted(this)) return;
        try {
            // One notification per incident (tag): its recovery replaces its alert.
            NotificationManagerCompat.from(this).notify(origin + "|" + tag, 1, notification.build());
        } catch (SecurityException e) {
            // Permission taken away between the check and here.
        }
    }

    @Override
    public void onNewToken(String token) {
        // Nothing to send from here: the install needs a signed-in page to
        // register a token, so the web app sends the new one the next time it
        // opens (refreshAppPush in src/client/lib/app-push.ts).
    }
}
