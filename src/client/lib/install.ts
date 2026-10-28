/**
 * "Install OpenPing": whether this browser can install the app, and how.
 *
 * - Android and desktop Chrome/Edge fire `beforeinstallprompt`; we keep the
 *   event and replay it from our own "Install OpenPing" button.
 * - iPhone and iPad have no prompt: the steps are Share, then Add to Home
 *   Screen.
 * - Once installed (running standalone, or `appinstalled` fired) the button
 *   hides.
 *
 * The event can fire before React renders anything, so the listeners attach
 * when this module first loads (AppLayout imports it eagerly).
 */
import { useSyncExternalStore } from "react";

export type InstallState =
  /** Running as the installed app, or this browser installed it. */
  | "installed"
  /** The browser handed us its install prompt: show the button. */
  | "prompt"
  /** iPhone or iPad: show the Share, Add to Home Screen steps. */
  | "ios"
  /** No prompt (yet), or not installable here: nothing to offer. */
  | "unsupported";

export interface InstallSignals {
  /** `display-mode: standalone` (or iOS `navigator.standalone`). */
  standalone: boolean;
  /** A deferred `beforeinstallprompt` event is waiting. */
  hasPrompt: boolean;
  /** This browser reported `appinstalled` before. */
  installedBefore: boolean;
  /** An iPhone, iPad or iPod (including iPadOS posing as a Mac). */
  ios: boolean;
}

/**
 * The one decision. A waiting prompt beats an old "installed" note: Chrome only
 * offers the prompt again when the app was uninstalled.
 */
export function installState(s: InstallSignals): InstallState {
  if (s.standalone) return "installed";
  if (s.hasPrompt) return "prompt";
  if (s.installedBefore) return "installed";
  if (s.ios) return "ios";
  return "unsupported";
}

/** iOS and iPadOS, whose browsers install only through the Share sheet. */
export function isIosDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  // iPadOS 13+ reports a desktop Mac user agent; a Mac has no touch screen.
  return platform === "MacIntel" && maxTouchPoints > 1;
}

export type DevicePlatform = "android" | "ios" | "desktop";

/** The kind of device, for platform-specific steps (notifications, install). */
export function devicePlatform(userAgent: string, platform: string, maxTouchPoints: number): DevicePlatform {
  if (isIosDevice(userAgent, platform, maxTouchPoints)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "desktop";
}

/** Chrome's install prompt event (not in the DOM typings). */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
}

const INSTALLED_KEY = "openping:installed";

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let snapshot: InstallState = "unsupported";
const listeners = new Set<() => void>();

function readInstalledBefore(): boolean {
  try {
    return window.localStorage.getItem(INSTALLED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeInstalledBefore(value: boolean) {
  try {
    if (value) window.localStorage.setItem(INSTALLED_KEY, "1");
    else window.localStorage.removeItem(INSTALLED_KEY);
  } catch {
    // Private mode or storage disabled: the note is only a nicety.
  }
}

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches
  );
}

function recompute() {
  const next = installState({
    standalone: isStandalone(),
    hasPrompt: deferredPrompt !== null,
    installedBefore: readInstalledBefore(),
    ios: isIosDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints ?? 0),
  });
  if (next === snapshot) return;
  snapshot = next;
  for (const fn of listeners) fn();
}

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Keep the browser's own mini-infobar away; our button offers it instead.
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    writeInstalledBefore(false);
    recompute();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    writeInstalledBefore(true);
    recompute();
  });
  window.matchMedia("(display-mode: standalone)").addEventListener?.("change", recompute);
  recompute();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The current install state, kept up to date. */
export function useInstallState(): InstallState {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => "unsupported" as const,
  );
}

/**
 * Show the browser's install prompt. Resolves to the person's choice, or
 * "unavailable" when there is no prompt to show. A prompt can be used once.
 */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferredPrompt;
  if (!event) return "unavailable";
  deferredPrompt = null;
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === "accepted") writeInstalledBefore(true);
  recompute();
  return outcome;
}
