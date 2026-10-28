import { CopyButton } from "./CopyButton";
import { cn } from "../../lib/cn";

/**
 * A copyable snippet: monospace, scrolls sideways inside itself (never the
 * page), with a copy button in its header. `code` is shown as is; pass
 * `copy` when what is copied differs (for example a masked token).
 */
export function CodeBlock({
  code,
  copy,
  label,
  language,
  className,
  wrap = false,
}: {
  code: string;
  copy?: string;
  /** Header text, like "Terminal" or "claude_desktop_config.json". */
  label?: string;
  language?: string;
  className?: string;
  /** Wrap long lines (one-line snippets like a URL) instead of scrolling them. */
  wrap?: boolean;
}) {
  return (
    <div className={cn("min-w-0 overflow-hidden rounded-lg border border-line bg-canvas/60", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-line-soft px-3 py-1.5">
        <span className="truncate font-mono text-[11px] text-ink-faint">{label ?? language ?? ""}</span>
        <CopyButton text={copy ?? code} ariaLabel={label ? `Copy ${label}` : "Copy snippet"} variant="ghost" className="-mr-1.5" />
      </div>
      <pre
        className={cn(
          "px-3 py-2.5 text-[12.5px] leading-relaxed text-ink",
          wrap ? "break-all whitespace-pre-wrap" : "overflow-x-auto",
        )}
      >
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
