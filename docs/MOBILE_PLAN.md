# OpenPing on phones: the mobile plan

Status: planned, 2026-10-28.
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
