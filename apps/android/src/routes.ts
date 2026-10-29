/**
 * The shell's screens, as URL hashes. The native side opens some of them
 * directly: `#/picker` (Switch OpenPing) and `#/offline?url=...&reason=...`
 * (MainActivity.showOffline).
 */
export type Route =
  | { name: "boot" }
  | { name: "picker" }
  | { name: "add" }
  | { name: "add-own" }
  | { name: "add-hosted" }
  | { name: "webview" }
  | { name: "offline"; origin: string | null; path: string; reason: "network" | "certificate" };

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?", 2);
  switch (path) {
    case "/picker":
      return { name: "picker" };
    case "/add":
      return { name: "add" };
    case "/add/own":
      return { name: "add-own" };
    case "/add/hosted":
      return { name: "add-hosted" };
    case "/webview":
      return { name: "webview" };
    case "/offline": {
      const params = new URLSearchParams(query);
      let origin: string | null = null;
      let rest = "/";
      try {
        const url = new URL(params.get("url") ?? "");
        if (url.protocol === "https:") {
          origin = url.origin;
          rest = `${url.pathname}${url.search}${url.hash}`;
        }
      } catch {
        // No usable address: the screen still offers the list.
      }
      return { name: "offline", origin, path: rest, reason: params.get("reason") === "certificate" ? "certificate" : "network" };
    }
    default:
      return { name: "boot" };
  }
}
