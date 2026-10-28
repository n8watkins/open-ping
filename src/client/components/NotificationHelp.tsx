import type { ReactNode } from "react";
import { ChevronDown, Laptop, Smartphone, Tablet } from "lucide-react";
import { devicePlatform, useInstallState, type DevicePlatform } from "../lib/install";
import { cn } from "../lib/cn";

function currentPlatform(): DevicePlatform {
  if (typeof navigator === "undefined") return "desktop";
  return devicePlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints ?? 0);
}

const STEPS: Record<DevicePlatform, { title: string; icon: ReactNode; steps: ReactNode[] }> = {
  android: {
    title: "Android",
    icon: <Smartphone className="size-4" />,
    steps: [
      <>
        In Chrome, install OpenPing: <B>Install OpenPing</B> under <B>More</B>, or Chrome's menu, then{" "}
        <B>Add to Home screen</B>.
      </>,
      <>
        Open the installed app, come back to <B>Alerts</B>, tap <B>Enable on this device</B> and choose <B>Allow</B>.
      </>,
      <>
        Blocked it earlier? Android <B>Settings</B>, <B>Apps</B>, <B>OpenPing</B>, <B>Notifications</B>.
      </>,
    ],
  },
  desktop: {
    title: "Computer",
    icon: <Laptop className="size-4" />,
    steps: [
      <>
        In Chrome, Edge, Firefox or Safari, click <B>Enable on this device</B> and choose <B>Allow</B>.
      </>,
      <>
        Alerts arrive while the browser is running, even with OpenPing closed. Installing it (Chrome or Edge) shows them
        under OpenPing's own name and icon.
      </>,
      <>
        Blocked it earlier? Click the icon to the left of the address, turn <B>Notifications</B> on, and check your
        system's notification settings allow the browser.
      </>,
    ],
  },
  ios: {
    title: "iPhone and iPad",
    icon: <Tablet className="size-4" />,
    steps: [
      <>
        iPhone only sends notifications to web apps on the home screen (iOS 16.4 or later). In Safari tap <B>Share</B>,
        then <B>Add to Home Screen</B>.
      </>,
      <>
        Open OpenPing from its home screen icon, go to <B>Alerts</B>, tap <B>Enable on this device</B> and choose{" "}
        <B>Allow</B>.
      </>,
      <>
        To change it later: <B>Settings</B>, <B>Notifications</B>, <B>OpenPing</B>.
      </>,
    ],
  },
};

const ORDER: DevicePlatform[] = ["android", "desktop", "ios"];

function B({ children }: { children: ReactNode }) {
  return <span className="font-medium text-ink">{children}</span>;
}

/**
 * How to turn on push notifications, per platform. This device's platform is
 * open; the others are one tap away. On an iPhone that hasn't installed
 * OpenPing yet, a note says that comes first.
 */
export function NotificationHelp() {
  const here = currentPlatform();
  const install = useInstallState();
  const iosNeedsInstall = here === "ios" && install !== "installed";

  return (
    <div className="mb-4 space-y-3">
      {iosNeedsInstall && (
        <p className="rounded-lg border border-degraded/40 bg-degraded/10 px-3 py-2 text-sm text-degraded">
          To get alerts on this iPhone, add OpenPing to your home screen first, then enable them from the app.
        </p>
      )}
      <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
        {ORDER.map((p) => {
          const { title, icon, steps } = STEPS[p];
          return (
            <details key={p} open={p === here} className="group">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-2/60 hover:text-ink [&::-webkit-details-marker]:hidden">
                <span className="text-accent">{icon}</span>
                <span className="flex-1">
                  {title}
                  {p === here && <span className="ml-2 text-xs font-normal text-ink-faint">this device</span>}
                </span>
                <ChevronDown
                  aria-hidden
                  className={cn("size-4 text-ink-faint transition-transform duration-200 group-open:rotate-180")}
                />
              </summary>
              <ol className="space-y-2 px-3 pt-0.5 pb-3 text-sm leading-relaxed text-ink-muted">
                {steps.map((step, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span aria-hidden className="w-4 shrink-0 text-right text-xs leading-6 font-semibold text-ink-faint">
                      {i + 1}.
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </details>
          );
        })}
      </div>
    </div>
  );
}
