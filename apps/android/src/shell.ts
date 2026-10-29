import { registerPlugin } from "@capacitor/core";

/**
 * The native side of the shell (OpenPingShellPlugin.java). It keeps the list
 * of installs, checks an address really is an OpenPing, and loads installs
 * into the web view; this page is only the picker and the offline screen.
 */

export interface Install {
  origin: string;
  /** Added through the "OpenPing Hosted" choice. */
  hosted: boolean;
  addedAt: number;
  lastOpenedAt: number;
}

export interface ShellState {
  installs: Install[];
  /** The install the app opens on launch. */
  active: string | null;
  /** The app's version name. */
  version: string;
  /**
   * False when the phone's Android System WebView is too old to keep an
   * install's pages away from the app's own bridge: no install opens then.
   */
  webviewSupported: boolean;
}

export type ProbeResult =
  | { ok: true; origin: string; hosted: boolean }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "unreachable" | "tls" | "not_openping" | "too_old" | "moved";
      /** For "moved": where the address forwards to. */
      location?: string;
    };

export interface OpenPingShellPlugin {
  getState(): Promise<ShellState>;
  /** Check that `origin` answers like an OpenPing new enough for the app. */
  probe(options: { origin: string }): Promise<ProbeResult>;
  add(options: { origin: string; hosted: boolean }): Promise<ShellState>;
  /** Sign this phone out on the install (best effort), then forget it. */
  remove(options: { origin: string }): Promise<ShellState>;
  /** Load the install (its `path`, default "/") into the web view, replacing this page. */
  open(options: { origin: string; path?: string }): Promise<void>;
  /** Open a link in the phone's browser. */
  openExternal(options: { url: string }): Promise<void>;
}

export const Shell = registerPlugin<OpenPingShellPlugin>("OpenPingShell", {
  // Only for previewing the screens in a desktop browser (shell-web.ts).
  web: () => import("./shell-web").then((m) => new m.OpenPingShellWeb()),
});
