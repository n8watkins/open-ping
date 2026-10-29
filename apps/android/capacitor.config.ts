import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The OpenPing Android app (docs/ANDROID.md). The bundled web app in `dist/`
 * is only the install picker and the offline screen; each install's own web
 * app is loaded from its address by the native shell (MainActivity), which
 * also decides what may load inside the web view.
 */
const config: CapacitorConfig = {
  appId: "dev.n8builds.openping",
  appName: "OpenPing",
  webDir: "dist",
  backgroundColor: "#0b1220",
  android: {
    // Only https, everywhere: no cleartext and no mixed content.
    allowMixedContent: false,
    // webContentsDebuggingEnabled is left to Capacitor: on in a debug build
    // (chrome://inspect), off in a release build.
  },
  server: {
    androidScheme: "https",
    // The picker never navigates anywhere; installs are loaded natively.
    allowNavigation: [],
  },
  plugins: {
    SystemBars: {
      // The web view sits between the status bar and the gesture bar, so an
      // install's pages never draw under them, whatever their CSS does.
      insetsHandling: "native",
      style: "DARK",
    },
  },
};

export default config;
