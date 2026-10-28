import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../../lib/cn";

/** Copy text to the clipboard, falling back to a hidden textarea where the API is missing. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path (an insecure origin, a denied permission).
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * A copy button that confirms with a brief "Copied" (announced to screen
 * readers), then returns to its resting state.
 */
export function CopyButton({
  text,
  label = "Copy",
  ariaLabel,
  className,
  compact = false,
  variant = "outline",
}: {
  text: string;
  /** The visible text at rest. */
  label?: string;
  /** A fuller accessible name when several copy buttons share a page: "Copy the MCP command". */
  ariaLabel?: string;
  className?: string;
  /** Icon only (the accessible name is ariaLabel, else label). */
  compact?: boolean;
  /** "ghost" drops the border and fill, for use inside a bordered header. */
  variant?: "outline" | "ghost";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  }

  const copied = state === "copied";
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={ariaLabel ?? (compact ? label : undefined)}
      title={compact ? (ariaLabel ?? label) : undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors duration-150",
        variant === "ghost"
          ? cn(
              "border-transparent",
              copied ? "text-up" : state === "failed" ? "text-down" : "text-ink-muted hover:bg-surface-2 hover:text-ink",
            )
          : copied
            ? "border-up/40 bg-up/10 text-up"
            : state === "failed"
              ? "border-down/40 bg-down/10 text-down"
              : "border-line bg-surface-2 text-ink-muted hover:border-ink-faint/40 hover:text-ink",
        className,
      )}
    >
      <span className="relative grid size-3.5 place-items-center" aria-hidden>
        <Copy className={cn("absolute size-3.5 transition-all duration-150", copied ? "scale-50 opacity-0" : "scale-100 opacity-100")} />
        <Check className={cn("absolute size-3.5 transition-all duration-150", copied ? "scale-100 opacity-100" : "scale-50 opacity-0")} />
      </span>
      {!compact && <span>{copied ? "Copied" : state === "failed" ? "Copy failed" : label}</span>}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Copied to the clipboard" : state === "failed" ? "Could not copy" : ""}
      </span>
    </button>
  );
}
