package dev.n8builds.openping;

import android.app.PendingIntent;
import android.content.Intent;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * An alert from an install (a data message, src/worker/notifications/push/fcm.ts):
 * shown as a notification whether the app is open or not, and a tap opens
 * the page it is about, in that install.
 */
public class AlertMessagingService extends FirebaseMessagingService {

    static final String EXTRA_URL = "dev.n8builds.openping.URL";
    static final String EXTRA_ORIGIN = "dev.n8builds.openping.ORIGIN";

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
        Intent open = new Intent(this, MainActivity.class)
            .putExtra(EXTRA_URL, url)
            .putExtra(EXTRA_ORIGIN, origin)
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
