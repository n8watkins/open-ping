# OpenPing for Android

The OpenPing Android app opens your OpenPing, wherever it runs: OpenPing Hosted or your own install on any domain.
It remembers several installs and switches between them, signs in through the phone's browser, and shows alerts as Android notifications.
It is stage M2 of [the mobile plan](./MOBILE_PLAN.md).

The code is in [`apps/android`](../apps/android), with its own `package.json`; the Worker's build doesn't use it.

## How it works

```
  Android app (apps/android)                          your OpenPing (any domain)
 +---------------------------------------+          +----------------------------+
 | one web view                          |  https   | the normal web app         |
 |  - the app's own screens              |--------->| /api/... as in a browser   |
 |    (picker, offline) at               |          | /auth/app/* (sign-in)      |
 |    https://localhost, bundled         |          | /api/push/fcm (the app's   |
 |  - or the open install, loaded        |          |   notifications)           |
 |    from its own address               |          +-------------+--------------+
 | window.OpenPingApp: a message bridge  |                        |
 |   for that install's pages only       |                        | FCM HTTP v1
 | Custom Tab: sign-in in the browser    |                        v
 | FCM: alerts as notifications          |<------------ Firebase Cloud Messaging
 +---------------------------------------+
```

### Installs

- The first launch asks "Where is your OpenPing?": **OpenPing Hosted** (type your OpenPing's name) or **My own install** (type its address).
- Before adding an address, the app asks its public `/api/auth/status` and explains what is wrong when it isn't an OpenPing, has no valid certificate, forwards somewhere else, or is too old for the app (it doesn't report `appSignIn`).
- The app opens the install used last on launch.
  Switch OpenPing is in the web app's menu (sidebar, More menu and Settings > General), on the app icon's long-press menu, and on the back button at an install's first page when there are several.
- Removing an install signs the phone out of it: the app first removes this phone's notifications there and posts `/api/auth/logout` with its session, then deletes the session cookie and the site data.
  When the install can't be reached, its session just expires there (or the owner signs it out in Settings).
  The install itself is not touched.

### What loads inside the app

- Only https.
- Only the open install's origin, plus the app's own screens (only from those screens).
- Every other web link opens in the phone's browser; `mailto:`, `tel:` and `sms:` open their apps; `intent:`, `file:`, `javascript:`, `data:` and the app's own scheme go nowhere.
- A certificate error is never accepted: the install's own shows the offline screen, another site's resource just doesn't load.
- Capacitor's plugin bridge exists only on the app's screens.
  An install's pages get only `window.OpenPingApp`, an Android WebMessageListener limited to that install's origin and its top-level frame, which understands `hello`, `signin`, `switch`, `push.register` and `push.refresh` ([`src/shared/native-app.ts`](../src/shared/native-app.ts)).
- File access, content access, extra windows and third-party cookies are off, and the app's data is excluded from backups and device transfers.
- When the phone's Android System WebView is too old for `WebMessageListener`, no install opens: Capacitor would fall back to a JavaScript interface on every page and frame, so the app shows "Update Android System WebView" with a link to Google Play instead.
- The web app knows it runs in the app from the user agent, which ends in `OpenPingApp/<version> (Android)`; it then hides its Install button and shows Switch OpenPing.

Pull to refresh is the web app's own (Overview, Monitors and Incidents), so there is one gesture, not two.
When a page can't load, the app shows its offline screen with Try again and Switch OpenPing; the web app's own offline cache still shows the last Overview when it has one ([MOBILE_PLAN.md](./MOBILE_PLAN.md), M1).

### Signing in

An app's web view can't do every sign-in itself: an email link opens in the phone's browser, GitHub wants a real browser, and passkeys in a web view need a Digital Asset Links file on every install.
So the app signs in the way [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252) asks native apps to, in the browser, and brings the session back with a one-time code only the app can redeem (PKCE):

1. The app makes a random verifier and opens `https://<install>/auth/app/start?challenge=<S256 of the verifier>&state=<random>` in a Custom Tab.
   Only a request the browser started itself is taken (`Sec-Fetch-Site: none`, as from an app); a link or form on any web page gets "Start signing in from the app".
   The pending sign-in is a `__Host-` cookie, so no sibling subdomain (another Hosted customer) can plant one.
2. The person signs in there with whatever the install offers: a passkey (always with user verification), GitHub (asked to pick the account, `prompt=select_account`), an email link, or the OpenPing Hosted platform (asked to sign in again, `reauth=1`).
   This is always a fresh sign-in, even when the browser is signed in already: `/finish` takes only a session made after step 1.
3. `/auth/app/finish` shows "Open the OpenPing app".
   Its button opens `dev.n8builds.openping:/signed-in?code=...&state=...&origin=...`; the code works once, for 2 minutes.
   A tap is needed, so a page someone else opened can't sign a phone in unseen.
4. The app checks the state and the origin against what it saved, and posts the code and the verifier to `/auth/app/exchange` from its web view, which then has its own session.
   `/exchange` refuses another site's form (an `Origin` other than the install's, or `Sec-Fetch-Site` cross-site or same-site), so no page can sign a browser in to someone else's session.
   A callback that doesn't match the app's pending sign-in is ignored and leaves it in place.
5. The admin gets an email ("The OpenPing app signed in", with the phone), and the session shows as the OpenPing app under Settings > Sign-in & security > Signed in now, where any session can be signed out on its own.

A code caught by another app is useless without the verifier, which never leaves the OpenPing app.
If the browser was signed in only for the app, that browser session ends at step 3.
A Hosted support session can't be moved to the app.
The server side is [`src/worker/routes/app-signin.ts`](../src/worker/routes/app-signin.ts); the app side is `AppSignIn.java`.

This needs nothing on the install, so it works for every self-hosted install on any domain.

**Passkeys inside the app (optional).**
Android's WebView supports WebAuthn through Credential Manager (`WebSettingsCompat.setWebAuthenticationSupport(..., WEB_AUTHENTICATION_SUPPORT_FOR_APP)`, androidx.webkit 1.12 and later), and the app turns it on.
It works only for sites that link the app with [Digital Asset Links](https://developer.android.com/identity/sign-in/credential-manager-webview).
An install can serve that file by setting the `ANDROID_APP_LINKS` var to the app's signing-certificate SHA-256 fingerprints, comma separated; `/.well-known/assetlinks.json` then lists them for `dev.n8builds.openping` with `get_login_creds` and `handle_all_urls`.
A build of your own under another package can be named as `com.example.app=<fingerprint>`.
Without the var the path is a 404 and nothing else changes.

### Push notifications

Android's web view has no Web Push, so the app uses Firebase Cloud Messaging:

1. In the app, Alerts > Push devices > **Turn on for this phone** asks Android for notification permission (Android 13 and later), and the app hands the page an FCM token over the bridge.
2. The page registers it with `POST /api/push/fcm` (signed in, with the CSRF token like any change).
   It is a push device like a browser's: listed, testable, and turned off or removed under Push devices.
3. Alerts go to it through the [FCM HTTP v1 API](https://firebase.google.com/docs/cloud-messaging/send/v1-api) ([`src/worker/notifications/push/fcm.ts`](../src/worker/notifications/push/fcm.ts)): a data message, so the app builds the notification itself, on an "Alerts" channel, one per incident.
   The Worker signs a service account JWT (RS256, Web Crypto), trades it at `https://oauth2.googleapis.com/token` for an hour-long access token, and keeps that in memory.
4. A tap opens the alert's page in the right install.
   The notification carries a one-time nonce for the page the app itself stored, never a page in the intent, which any app could send to the app's (exported) activity; and only a page on an install the phone has added.
   A phone that uninstalled the app answers `UNREGISTERED` and is removed; a token from another Firebase project (`SENDER_ID_MISMATCH`) is removed too; quota and outages are retried by the outbox.
5. The web app sends the token again on each app start (`refresh`, with the previous token when Firebase changed it), which only keeps an existing device up to date: a phone turned off under Push devices stays off, and a removed one is told so (`fcm_device_removed`) and stops asking.
   An install takes at most 20 phones.

It is off unless the install has the `FCM_SERVICE_ACCOUNT` secret (a Firebase service account's JSON key).
An install without it is unchanged; the app says "This OpenPing can't send notifications to the Android app yet".

**Which installs can send to the store app, and what the shared key means.**
An FCM token belongs to the Firebase project the app was built with, and only that project's service account can send to it.
So a store build reaches installs that hold the owner's Firebase key: the owner's own install, and OpenPing Hosted.
Another self-hosted install can't send to the store app without that key, and the owner shouldn't hand it out: it can send a notification to every phone with the app, for any install, so it lives only as a secret on the owner's install and the Hosted platform.
The app shows a notification only for an install the phone has added and only with a link on that install, which limits what a leaked key could do to misleading notification text.
Two ways forward, both later:

- **A push relay** run by the owner: installs send the alert to it, it sends through FCM.
  This is how ntfy and Nextcloud do it; it needs per-install registration and abuse limits, and the relay sees alert titles.
- **Build your own app** with your own Firebase project and package name (see Building), then set your own `FCM_SERVICE_ACCOUNT`.

Email, chat and webhook alerts work in every case.

### Security

What the design protects against is above; this is what remains, and why it is accepted:

- **A malicious app on the phone** that claims the same `dev.n8builds.openping:` scheme could start the sign-in itself, with its own verifier, and be handed the code if the person signs in and taps "Open the OpenPing app" for it.
  Android lets any app claim a custom scheme, and RFC 8252 accepts this risk for native apps.
  What stands in its way: the fresh sign-in the person has to do, the tap, the "The OpenPing app signed in" email, and the session list in Settings.
  A verified App Link (an https callback the system gives only to the signed app) would close it, but an app can only verify the domains in its own manifest, fixed at build time, so it can't cover every self-hosted install.
  It is the better callback for installs on the owner's domains (openping.n8builds.dev and Hosted) once `ANDROID_APP_LINKS` is set there; that is a follow-up.
- **Debug builds** (the CI artifact) allow `chrome://inspect` of the app's web view over USB, which shows the open install's pages and cookies to whoever has the unlocked phone and a cable; release builds don't.
- **CI artifacts from pull requests**, including ones from forks, can be downloaded by anyone with read access to the repository; install only builds from this repository's own branches.
- **The shared Firebase key**: see Push notifications above.

### What reaches the app without a store release

Everything in the web app reaches the app the moment the install updates: pages, features, fixes, the sign-in page, the push devices card.
A new app version is needed only for the shell itself: the picker and offline screens, the navigation rules, the sign-in hand-off, the push plumbing, icons and Android settings.

## Building

The app's screens need Node 22 or later; the native build also needs JDK 21 and the Android SDK (compile SDK 36).
CI does the Gradle build (below), so a machine without the Android SDK can still work on the app.

```sh
cd apps/android
npm ci
npm test              # unit tests of the app's screens
npm run sync          # build the screens and copy them into android/
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug bundleRelease
```

- `npx vite` in `apps/android` previews the app's screens in a desktop browser, with a stand-in for the native side (`src/shell-web.ts`); `?demo=1` starts with two installs.
- `VITE_HOSTED_DOMAIN=<domain>` at build time turns on the OpenPing Hosted choice for `<name>.<domain>` addresses.
  Empty (today), it says "Opening soon".
- `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_API_KEY` and `FIREBASE_SENDER_ID` (environment or `-P` gradle properties) turn on push.
  They are the values of the Firebase console's Android app (in `google-services.json`, which is never committed); without them the app builds with notifications off.
- The version is `apps/android/package.json`'s; the Play version code comes from it (1.2.3 is 10203).
  Bump it for every store upload.
- Versions: Capacitor 8.5.3, androidx.browser 1.10.0, androidx.webkit 1.14.0, Firebase BoM 35.1.0, min SDK 26 (Android 8), target and compile SDK 36, Java 21, Android Gradle Plugin 8.13, Gradle 8.14.6.

## CI and installing a build on your phone

[`.github/workflows/android.yml`](../.github/workflows/android.yml) runs on every pull request and push to main that touches the app (and on demand from the Actions tab).
It typechecks and tests the screens, then runs the Gradle unit tests, lint, a debug APK and a release bundle, with Gradle caching, and keeps three artifacts for 30 days: `openping-debug-apk`, `openping-release-aab` (unsigned) and `android-reports`.
The Firebase values come from repository variables of the same names, when set.

To install the debug APK on an Android phone:

1. On GitHub, open the repository's **Actions** tab, the **Android app** workflow, and the newest green run (or the run on a pull request's Checks tab).
2. Under **Artifacts**, download `openping-debug-apk` and unzip it: it holds `app-debug.apk`.
3. Put the APK on the phone (email it to yourself, Google Drive, or a USB cable), open it, and allow your browser or file manager to install unknown apps when Android asks.
   With a USB cable and developer options on, `adb install app-debug.apk` works too.
4. Open OpenPing, choose **My own install** and type your install's address.

A debug build replaces a store build with the same package name and is signed with a throwaway debug key, so you uninstall it before installing the store version.
It also lets a computer inspect the app's web view (see Security), so use it only on your own phone, and only from this repository's runs, not a fork's pull request.

## Signing

Nothing that signs the app is ever committed: `*.jks`, `*.keystore` and `google-services.json` are ignored.
A release build is signed only when these environment variables are set (for example as repository secrets in a release workflow, or in a local shell):

| Variable | What |
| --- | --- |
| `OPENPING_UPLOAD_KEYSTORE` | Path to the upload keystore file |
| `OPENPING_UPLOAD_KEYSTORE_PASSWORD` | Its password |
| `OPENPING_UPLOAD_KEY_ALIAS` | The key's alias |
| `OPENPING_UPLOAD_KEY_PASSWORD` | The key's password |

Make the upload key once, on your own machine, and keep the file and both passwords in your password manager:

```sh
keytool -genkeypair -v -keystore openping-upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
```

With Play App Signing (the default for new apps), Google holds the app signing key and this is only the upload key, which Google can reset if it is lost.
For `ANDROID_APP_LINKS`, use the **app signing key** certificate's SHA-256 from Play Console > Test and release > App integrity, not the upload key's.

## The owner's steps before the store

None of these is needed for the debug APK.
They are also in [DEFERRED_INPUTS.md](./DEFERRED_INPUTS.md).

1. **Google Play developer account**: sign up at [play.google.com/console](https://play.google.com/console) (a one-time $25 fee) and verify your identity.
   A new personal account must run a closed test with at least 12 testers, opted in for 14 days in a row, before it can publish to everyone ([Google's rules](https://support.google.com/googleplay/android-developer/answer/14151465)).
2. **Firebase project** for notifications: create one in the [Firebase console](https://console.firebase.google.com), add an Android app with the package `dev.n8builds.openping`, and copy its four values into the repository's Actions variables `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_API_KEY` and `FIREBASE_SENDER_ID`.
   Then in Project settings > Service accounts, generate a private key, and set its JSON as the `FCM_SERVICE_ACCOUNT` secret on your install (`npx wrangler secret put FCM_SERVICE_ACCOUNT`, pasting the file's contents; never commit it).
   FCM itself is free.
3. **Upload key**: make it as in Signing, and give a release build its four variables.
4. **Store listing**: name ("OpenPing"), short and full description, the icon (512 px, `public/icon-512.png`), a feature graphic (1024x500), at least two phone screenshots, the category (Tools) and a contact email.
5. **Privacy policy link**: the store requires a public one.
   The app itself collects nothing: what you see is each install's own data, and the only thing it sends anywhere is the FCM token, to the install you turn notifications on for.
   The draft [Privacy Policy](./legal/PRIVACY.md) (served at `/privacy`, review pending in [DEFERRED_INPUTS.md](./DEFERRED_INPUTS.md)) can gain a short section on the app; fill in Play's Data safety form to match.
6. **After the first upload**: put the app signing certificate's SHA-256 in `ANDROID_APP_LINKS` on your install if you want passkeys inside the app.
7. **When Hosted's domain is bought**: build with `VITE_HOSTED_DOMAIN`, and give the Hosted platform the Firebase key so customers' installs can send to the app.

## Server settings

| Setting | Kind | Default | What it does |
| --- | --- | --- | --- |
| `FCM_SERVICE_ACCOUNT` | Secret | unset | Firebase service account JSON key: the Android app's notifications |
| `ANDROID_APP_LINKS` | Var | unset | App signing SHA-256 fingerprints: serves `/.well-known/assetlinks.json` for passkeys inside the app |

Migration `0025_session_via.sql` adds `sessions.via` (`app` for the app's sessions) and `0026_push_subscription_kind.sql` adds `push_subscriptions.kind` (`webpush` or `fcm`).

## Tests

- Worker: `test/integration/app-signin.test.ts` (the browser sign-in end to end, with a Custom Tab and a web view as two cookie jars: a start from a web page refused, a fresh sign-in required even when signed in, a planted cookie ignored, a cross-site exchange refused, the notice email, the session listed and signed out), the Hosted variant in `test/integration/hosted-mode.test.ts` (`reauth=1`, a stale hand-off refused), `test/integration/android-push.test.ts` (registering, an incident reaching the phone, a test send, an uninstalled app, refreshes that keep a phone off or removed, a rotated token, the cap of 20, removal by the app) and `src/worker/notifications/push/fcm.test.ts`, all against a fake FCM and token endpoint (`test/support/fake-fcm.ts`) that checks the JWT's signature and claims.
  No test calls Google.
- App: Vitest for the screens' address and route logic, JUnit for `Origins`, `NavigationPolicy` and `Pkce` (in CI).

## Troubleshooting

- **"That OpenPing needs an update"**: the install is older than the app's sign-in; update it ([UPGRADE.md](./UPGRADE.md)).
- **Sign-in comes back with "didn't start in this app"**: the sign-in took longer than 20 minutes, or another app's link was opened; tap Sign in again.
- **"Start signing in from the app"**: the sign-in page was opened from a link, not by the app; open the app and tap Sign in there.
- **"Update Android System WebView"**: update it in Google Play (it updates on its own on most phones), then open OpenPing again.
- **"Turn on for this phone" is greyed out**: the install has no `FCM_SERVICE_ACCOUNT`.
- **"A different Firebase project"**: the install's key and the app's build come from different Firebase projects.
- **No notifications although the device is listed**: check Android's settings for OpenPing (notifications and the Alerts channel), and send a test from Push devices.
- **Inspecting a page**: a debug build allows `chrome://inspect` from a computer over USB; a release build doesn't.
