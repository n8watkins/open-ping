package dev.n8builds.openping;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.Locale;

/**
 * Push notifications through Firebase Cloud Messaging (docs/ANDROID.md, "Push
 * notifications"). Android's web view has no Web Push, so the app asks FCM for
 * a token and the install's page registers it with the install, which sends
 * through FCM (src/worker/notifications/push/fcm.ts).
 *
 * Firebase is set up from build settings (FIREBASE_PROJECT_ID, FIREBASE_APP_ID,
 * FIREBASE_API_KEY, FIREBASE_SENDER_ID, from the environment or gradle
 * properties), not a committed google-services.json. A build without them has
 * no push and says so; everything else works.
 */
public final class Push {

    /** The one notification channel: incidents, recoveries and the other alerts. */
    public static final String CHANNEL_ID = "alerts";

    public interface TokenCallback {
        void onToken(String token);

        /** unavailable (no Firebase in this build), denied or failed. */
        void onError(String reason);
    }

    private Push() {}

    /** True when this build has Firebase settings. */
    public static boolean configured() {
        return !BuildConfig.FIREBASE_PROJECT_ID.isEmpty()
            && !BuildConfig.FIREBASE_APP_ID.isEmpty()
            && !BuildConfig.FIREBASE_API_KEY.isEmpty()
            && !BuildConfig.FIREBASE_SENDER_ID.isEmpty();
    }

    /** Start Firebase (once per process). False without Firebase settings. */
    public static synchronized boolean init(Context context) {
        if (!configured()) return false;
        if (!FirebaseApp.getApps(context).isEmpty()) return true;
        FirebaseOptions options = new FirebaseOptions.Builder()
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
            .setApplicationId(BuildConfig.FIREBASE_APP_ID)
            .setApiKey(BuildConfig.FIREBASE_API_KEY)
            .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
            .build();
        FirebaseApp.initializeApp(context, options);
        return true;
    }

    /** Whether the phone lets OpenPing show notifications right now. */
    public static boolean permitted(Context context) {
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }

    /** True when the app must ask for the permission first (Android 13 and later). */
    public static boolean needsPermissionPrompt(Context context) {
        return Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED;
    }

    /** The FCM token, once notifications are allowed. */
    public static void token(Context context, TokenCallback callback) {
        if (!init(context)) {
            callback.onError("unavailable");
            return;
        }
        if (!permitted(context)) {
            callback.onError("denied");
            return;
        }
        FirebaseMessaging.getInstance()
            .getToken()
            .addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) callback.onToken(task.getResult());
                else callback.onError("failed");
            });
    }

    /** The channel Android lists under the app's notification settings. */
    public static void ensureChannel(Context context) {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.channel_alerts),
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription(context.getString(R.string.channel_alerts_description));
        channel.enableVibration(true);
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    /** The phone's name for the device list: "Google Pixel 8". */
    public static String deviceName() {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String model = Build.MODEL == null ? "" : Build.MODEL;
        if (model.toLowerCase(Locale.ROOT).startsWith(maker.toLowerCase(Locale.ROOT))) return model;
        String brand = maker.isEmpty() ? "" : maker.substring(0, 1).toUpperCase(Locale.ROOT) + maker.substring(1);
        return (brand + " " + model).trim();
    }
}
