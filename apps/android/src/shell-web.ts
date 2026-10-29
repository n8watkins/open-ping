import { WebPlugin } from "@capacitor/core";
import type { Install, OpenPingShellPlugin, ProbeResult, ShellState } from "./shell";

/**
 * A stand-in for the native plugin in a desktop browser (`npx vite`), so the
 * screens can be built and checked without a phone. The app itself always
 * uses OpenPingShellPlugin.java. `?demo=1` starts with two installs.
 */
const KEY = "openping-shell-preview";

export class OpenPingShellWeb extends WebPlugin implements OpenPingShellPlugin {
  private read(): ShellState {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) return JSON.parse(saved) as ShellState;
    } catch {
      // Storage off: start empty.
    }
    const now = Date.now();
    const demo: Install[] = new URLSearchParams(location.search).has("demo")
      ? [
          { origin: "https://openping.n8builds.dev", hosted: false, addedAt: now, lastOpenedAt: now },
          { origin: "https://acme.openping.example", hosted: true, addedAt: now, lastOpenedAt: now - 1 },
        ]
      : [];
    return { installs: demo, active: null, version: "preview" };
  }

  private write(state: ShellState): ShellState {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // As above.
    }
    return state;
  }

  async getState(): Promise<ShellState> {
    return this.read();
  }

  async probe({ origin }: { origin: string }): Promise<ProbeResult> {
    await new Promise((r) => setTimeout(r, 400));
    if (origin.includes("old")) return { ok: false, reason: "too_old" };
    if (origin.includes("nope")) return { ok: false, reason: "not_openping" };
    if (origin.includes("www.")) return { ok: false, reason: "moved", location: origin.replace("www.", "") };
    return { ok: true, origin, hosted: false };
  }

  async add({ origin, hosted }: { origin: string; hosted: boolean }): Promise<ShellState> {
    const state = this.read();
    const now = Date.now();
    if (!state.installs.some((i) => i.origin === origin)) state.installs.push({ origin, hosted, addedAt: now, lastOpenedAt: now });
    return this.write(state);
  }

  async remove({ origin }: { origin: string }): Promise<ShellState> {
    const state = this.read();
    state.installs = state.installs.filter((i) => i.origin !== origin);
    if (state.active === origin) state.active = null;
    return this.write(state);
  }

  async open({ origin }: { origin: string; path?: string }): Promise<void> {
    const state = this.read();
    state.active = origin;
    this.write(state);
    console.info(`[preview] the app would open ${origin} here`);
  }

  async openExternal({ url }: { url: string }): Promise<void> {
    window.open(url, "_blank", "noopener");
  }
}
