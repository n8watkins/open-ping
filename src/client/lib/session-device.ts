import { androidPhone } from "../../shared/native-app";

/**
 * A session's device, in words, from the user agent it signed in with
 * (Settings > Sign-in & security). Rough on purpose: enough to tell your
 * laptop from your phone, and the OpenPing app from a browser.
 */
export function sessionDevice(userAgent: string | null, via: string | null): string {
  const ua = userAgent ?? "";
  const phone = androidPhone(ua);
  if (via === "app" || /\bOpenPingApp\//.test(ua)) return phone ? `OpenPing app on ${phone}` : "OpenPing app";
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "A browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iPhone or iPad"
    : phone
      ? phone
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  return os ? `${browser} on ${os}` : browser;
}
