# OpenPing on phones: the mobile plan

Status: M1 built 2026-10-28; M2 built 2026-10-29 (the store listing waits on the owner); M3 planned.
The owner wants people to use OpenPing from their phones: as a web app they install from the browser, and as an Android app.
This plan covers both, for every install (self-hosted, the owner's, and Hosted), and makes "works well on a phone" a rule for all future UI work.

## Where we are

- OpenPing already ships a web app manifest (`public/manifest.webmanifest`), a service worker (`public/sw.js`), an offline page and Web Push notifications, so Android Chrome can already "Add to Home screen" and receive alerts.
- The admin app has a bottom navigation bar on phones, and the 2026-10-28 UX work (#41 to #43) checked every page at 390x844.
- Gaps:
  - Only SVG icons are listed; Android's install prompt, splash screen and the Play Store want PNG icons (192 and 512 px, plus maskable).
  - The app never offers to install itself; people have to find "Add to Home screen" in the browser menu.
  - The manifest has no `id`, `shortcuts` or `screenshots`, so the install sheet is plain.
  - No written mobile standard, so phone quality depends on each PR's author.

## Stage M1: a first-class installable web app (all installs, no store)

Effort: about 2 days of agent work, after the UX PRs merge.
Owner actions: none.

1. **Icons and manifest.**
   PNG icons at 192 and 512 px in normal and maskable versions, an Apple touch icon, `id`, `shortcuts` (Overview, Incidents, Add monitor), `screenshots` for phone and desktop so Android shows the rich install sheet, and the right `theme_color` for light and dark.
2. **Install button.**
   Catch `beforeinstallprompt` on Android and desktop Chrome and show an "Install OpenPing" button in the sidebar and in Settings; on iPhone, where there is no prompt, show short "Share, then Add to Home Screen" steps; hide it once installed (`display-mode: standalone`).
3. **Feels like an app when installed.**
   Safe-area insets for notches and gesture bars, no rubber-band scrolling of the shell, the status bar colour following the page, pull to refresh on Overview, Monitors and Incidents, and haptic-free but instant tap feedback.
4. **Offline and flaky networks.**
   The service worker caches the app shell and the last Overview response, so opening the app on a train shows the last known status with an "Offline, showing data from 10:42" banner instead of an error page.
5. **Notifications that lead somewhere.**
   Tapping an alert opens the incident in the installed app (not a new browser tab); the Alerts page explains, per platform, how to turn notifications on, including iPhone, which only allows Web Push for installed web apps.
6. **Tests.**
   Lighthouse PWA and mobile checks in CI on the built app, and a browser check of install, offline and notification-tap flows.

Works the same for self-hosted installs, the owner's install and Hosted customers, because each serves the same files from its own address.

### M1 as built (2026-10-28)

- Icons: `node scripts/build-icons.mjs` renders the PNGs in `public/` from `icon.svg` and `maskable-icon.svg` (plus the white notification badge); commit them after changing an SVG.
- Manifest screenshots (`public/screenshots/`) are the Overview at 390x844 (2x) and 1440x900, taken on throwaway demo data in a local D1 (Website, API degraded, Payments, Docs), never an owner's real monitors; retake them the same way when the Overview changes a lot.
- Install: `src/client/lib/install.ts` keeps the `beforeinstallprompt` event; `components/InstallApp.tsx` has the sidebar and More-menu entry, the iPhone steps sheet and the Settings > General card.
- Offline: `public/sw.js` keeps the last `/api/overview` and `/api/overview/history` answers (network first) and no other API answer.
  A signed-out answer (401 or 403) or signing out clears them.
  The signed-in app asks the worker to save every admin bundle listed in `/sw-precache.json` (written by `vite.config.ts`), so pages not opened yet still load offline.
  With the server unreachable and a saved Overview on the device, the app opens on it with "Offline, showing data from HH:MM".
- Change `VERSION` in `public/sw.js` whenever its caching changes.
- Pull to refresh: `components/PullToRefresh.tsx` on Overview, Monitors and Incidents; touch only, only from the very top of the page, never inside a scrolled panel, a fixed sheet or a field.
- Notification taps: `notificationclick` moves an open OpenPing window to the incident, or opens one inside the app's scope, so the installed app opens it.
- Tests: `src/pwa-files.test.ts` (manifest, icons on disk at their sizes, `index.html`, the worker's shell list), `src/sw.test.ts` (notification taps and the Overview cache, run against the real `sw.js`), and unit tests for the install, offline-banner and pull logic.

**Checking it by hand.**
Lighthouse no longer has a PWA category (removed in Lighthouse 12), and adding it to CI would mean a headless Chrome and Lighthouse as new dependencies, so it isn't in CI.
To check a build: `npm run build`, `npx vite preview --port 5212`, sign in, then in Chrome DevTools run Lighthouse for Mobile, and look at Application > Manifest (no installability errors) and Application > Service workers.
The 2026-10-28 run scored Accessibility 100, Best Practices 100 and SEO 100 on the Overview, and Accessibility 100 on a monitor page (whose SEO score is low on purpose: admin pages aren't indexed).
For offline, stop the server (DevTools' offline switch doesn't reach the worker's own requests) and reload.

## Stage M2: OpenPing for Android in Google Play

Effort: about 4 to 5 days of agent work, after Hosted wave 3 (so the app can sign in to Hosted too).
Owner actions: a Google Play developer account (one-time $25 fee), a Firebase project for push notifications, and the store listing (name, screenshots, privacy policy link).

**Approach: a small native shell (Capacitor) that opens your OpenPing.**

- On first launch the app asks "Where is your OpenPing?" with two choices: "OpenPing Hosted" (sign in at the Hosted address) or "My own install" (type its address, for example `openping.n8builds.dev`).
- It can remember several installs and switch between them, which suits people who run more than one.
- Inside, it shows the same OpenPing web app, so every feature and every future UI improvement reaches the app without a new store release.
- Push notifications use Firebase Cloud Messaging, because Android's in-app web view does not support Web Push: OpenPing gets a new "Android app" alert channel that sends through FCM, alongside the existing Web Push for browsers.
- Native touches where they matter: a home-screen widget with the overall status, the notification channel settings Android expects, and biometric unlock (the app's passkey support already works through the system).

**Why not a Trusted Web Activity (the usual "PWA in the Play Store" route):** a TWA is tied to one web address and proves it owns that address with a file on the site.
That fits a single site, but OpenPing is many sites: every self-hosted install and every Hosted customer has its own address, so one TWA can't open them all.
A TWA for Hosted alone remains an option later if the Hosted platform moves customers under one shared address.

**Why not a full native app:** two codebases (web and native) for one product would double every UI change; the shell keeps one.

### M2 as built (2026-10-29)

The full description is [ANDROID.md](./ANDROID.md); in short:

- `apps/android`: a Capacitor 8 shell with its own `package.json`. Its bundled screens are only "Where is your OpenPing?", the list of installs and the offline screen; each install's own web app loads from its address, so web changes reach the app without a release.
- Loading rules (`NavigationPolicy.java`): https only, only the open install inside the app, other links in the browser, no bad certificates; install pages get only a message bridge limited to their origin, never Capacitor's.
- Sign-in through the phone's browser for every install and every method (`/auth/app/start`, `/finish`, `/exchange`, PKCE). Passkeys inside the web view work where an install serves `assetlinks.json` (`ANDROID_APP_LINKS`).
- Push through FCM HTTP v1 from the Worker (`FCM_SERVICE_ACCOUNT`), as an "Android app" push device; taps open the page in the right install.
  A store build can only receive from installs holding the owner's Firebase key (the owner's and Hosted); a push relay for other self-hosted installs is a follow-up.
- CI (`.github/workflows/android.yml`) builds a debug APK and an unsigned release bundle on every change to the app.
- The web app hides its Install button in the app and shows Switch OpenPing instead.
- Not built yet: the home-screen status widget and biometric unlock from the plan above; the push relay; the Hosted choice waits on Hosted's domain (`VITE_HOSTED_DOMAIN`).
- Found and fixed on the way: push devices got no alert unless some other channel existed (#82, v0.17.1).
- After an independent review (2026-10-29): app sign-ins only start from the app and always need a fresh sign-in, the admin gets an email for each, Settings lists every session to sign out, exchanges refuse other sites' forms, removed or turned-off phones stay that way, notification taps can't be forged by other apps, old web views can't open installs, and removing an install signs out on the server. What remains is in ANDROID.md, "Security".

## Stage M3: iPhone (later, if asked)

The installable web app (M1) already works on iPhone, including notifications for installed web apps on recent iOS versions.
A store app for iPhone uses the same Capacitor shell but needs an Apple developer account ($99 a year) and APNs; do it only if Hosted customers ask.

## The mobile standard (applies to every UI change from now on)

Every PR that changes the UI meets these, and its description says so:

- Checked at 390x844 and 360x800 (small Android) as well as 1440x900, with no horizontal scroll and nothing cut off.
- Touch targets at least 44 by 44 px, with at least 8 px between them.
- Nothing works only on hover: every tooltip, menu and chart readout also works by tap and by keyboard.
- Side panels become full-screen sheets on phones, with a clear close button and Escape or back to close.
- Tables become cards or keep a horizontal scroll inside their own container, never the page.
- Forms use the right keyboard (`inputmode`, `type="email"`, `type="url"`) and don't zoom the page on focus (16 px inputs).
- Content respects safe areas and the bottom navigation bar; nothing important hides behind it.
- Charts stay readable on a phone: fewer axis labels, larger hit areas, the same data.
- Reduced motion is honoured (the global rule in `src/client/index.css` does this for CSS animations).

`docs/HANDOFF.md` links this list, and reviews check it.

## Order with the rest of the roadmap

1. Finish the UX work (#42, #43), then M1, which touches the same files.
2. Hosted waves 1 to 3 continue in parallel where files don't overlap (the platform lives in `platform/`).
3. M2 after Hosted wave 3, so the Android app can offer Hosted sign-in from day one.
