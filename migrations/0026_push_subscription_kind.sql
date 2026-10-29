-- The OpenPing Android app (docs/ANDROID.md): a push device is either a
-- browser's Web Push subscription ('webpush', every row so far) or the app's
-- Firebase Cloud Messaging token ('fcm'). For 'fcm' the token is kept, sealed,
-- in `endpoint`, its hash in `endpoint_hash`, and p256dh and auth are empty.
ALTER TABLE push_subscriptions ADD COLUMN kind TEXT NOT NULL DEFAULT 'webpush';
