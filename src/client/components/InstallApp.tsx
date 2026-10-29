import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, CheckCircle2, Download, Share, Smartphone, SquarePlus, X } from "lucide-react";
import { cn } from "../lib/cn";
import { promptInstall, useInstallState, type InstallState } from "../lib/install";
import { hasAppBridge, tellApp } from "../lib/native-app";
import { Card, CardHeader, CardTitle } from "./ui/Card";

/**
 * "Install OpenPing": the sidebar and More-menu entry, the iPhone steps sheet,
 * and the Settings card. The state itself lives in lib/install.ts.
 */

/** Whether there is something to offer: a prompt, or the iPhone steps. */
export function canOfferInstall(state: InstallState): boolean {
  return state === "prompt" || state === "ios";
}

/**
 * Whether the sidebar and More menu have an entry: the install, or, inside the
 * OpenPing Android app, "Switch OpenPing" to its list of installs.
 */
export function hasNavEntry(state: InstallState): boolean {
  return canOfferInstall(state) || (state === "app" && hasAppBridge());
}

/** The iPhone and iPad steps: Safari has no install prompt. */
export function IosInstallSteps({ className }: { className?: string }) {
  return (
    <ol className={cn("space-y-3 text-sm text-ink-muted", className)}>
      <li className="flex items-start gap-3">
        <StepNumber n={1} />
        <span className="pt-0.5">
          Tap <Share aria-hidden className="inline size-4 -translate-y-px text-accent" />{" "}
          <span className="font-medium text-ink">Share</span> in Safari's toolbar.
        </span>
      </li>
      <li className="flex items-start gap-3">
        <StepNumber n={2} />
        <span className="pt-0.5">
          Choose <SquarePlus aria-hidden className="inline size-4 -translate-y-px text-accent" />{" "}
          <span className="font-medium text-ink">Add to Home Screen</span>, then{" "}
          <span className="font-medium text-ink">Add</span>.
        </span>
      </li>
      <li className="flex items-start gap-3">
        <StepNumber n={3} />
        <span className="pt-0.5">Open OpenPing from your home screen. Alerts can reach this iPhone from there.</span>
      </li>
    </ol>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent"
    >
      {n}
    </span>
  );
}

/**
 * The iPhone steps as a sheet: from the bottom on a phone, centred on a larger
 * screen. Escape, the close button or a tap outside closes it.
 */
export function IosInstallSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      // The close button is the only control, so Tab stays on it.
      if (e.key === "Tab") {
        e.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 animate-fade bg-canvas/80 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-sheet-title"
        className="relative z-10 w-full animate-enter rounded-t-card border border-line bg-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl shadow-black/50 sm:max-w-sm sm:rounded-card sm:pb-5"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="install-sheet-title" className="text-base font-semibold tracking-tight">
            Install OpenPing
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 grid size-11 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <X className="size-5" />
          </button>
        </div>
        <IosInstallSteps />
      </div>
    </div>,
    document.body,
  );
}

/**
 * Run the install: the browser's prompt where there is one, else the iPhone
 * steps (through `onShowSteps`).
 */
async function startInstall(state: InstallState, onShowSteps: () => void) {
  if (state === "ios") onShowSteps();
  else if (state === "prompt") await promptInstall();
}

/**
 * The "Install OpenPing" entry in the sidebar (desktop) and the More menu
 * (phone). Renders nothing when installed or not installable here.
 */
export function InstallNavButton({
  variant,
  onShowSteps,
}: {
  variant: "sidebar" | "menu";
  onShowSteps: () => void;
}) {
  const state = useInstallState();
  if (!hasNavEntry(state)) return null;
  const className = cn(
    "flex w-full items-center gap-3 font-medium transition-colors",
    variant === "sidebar"
      ? "rounded-lg px-3 py-2 text-sm text-ink-muted hover:bg-surface-2/70 hover:text-ink"
      : "min-h-11 rounded-lg px-3 py-2.5 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink",
  );
  if (state === "app") {
    return (
      <button type="button" onClick={() => tellApp({ type: "switch" })} className={className}>
        <ArrowLeftRight className="size-[18px] shrink-0 text-accent" />
        Switch OpenPing
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void startInstall(state, onShowSteps)}
      className={className}
    >
      <Download className="size-[18px] shrink-0 text-accent" />
      Install OpenPing
    </button>
  );
}

/** Settings > General: install this device, or how. */
export function InstallCard() {
  const state = useInstallState();
  const [busy, setBusy] = useState(false);

  async function install() {
    setBusy(true);
    try {
      await promptInstall();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <CardHeader>
        <CardTitle>{state === "app" ? "The OpenPing app" : "Install the app"}</CardTitle>
      </CardHeader>
      <p className="-mt-1 mb-4 text-sm text-ink-muted">
        {state === "app"
          ? "The app opens this OpenPing and any other you add, and switches between them."
          : "OpenPing works as an app on your phone or computer: its own icon and window, alerts as notifications, and the last known status even without a connection."}
      </p>
      {state === "app" ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-sm text-up">
            <Smartphone className="size-4 shrink-0" />
            You're using the OpenPing app on this phone.
          </p>
          {hasAppBridge() && (
            <button
              type="button"
              onClick={() => tellApp({ type: "switch" })}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-line"
            >
              <ArrowLeftRight className="size-4" />
              Switch OpenPing
            </button>
          )}
        </div>
      ) : state === "installed" ? (
        <p className="flex items-center gap-2 text-sm text-up">
          <CheckCircle2 className="size-4 shrink-0" />
          OpenPing is installed on this device.
        </p>
      ) : state === "prompt" ? (
        <button
          type="button"
          onClick={() => void install()}
          disabled={busy}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          <Download className="size-4" />
          Install OpenPing
        </button>
      ) : state === "ios" ? (
        <IosInstallSteps />
      ) : (
        <p className="text-sm text-ink-muted">
          Open your browser's menu and choose <span className="font-medium text-ink">Install OpenPing</span> or{" "}
          <span className="font-medium text-ink">Add to Home screen</span>. In Chrome and Edge it is also the install
          icon at the end of the address bar. Firefox on a computer can't install web apps.
        </p>
      )}
    </Card>
  );
}
