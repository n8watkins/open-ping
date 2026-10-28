import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "../../lib/cn";

export interface MonitorOption {
  id: string;
  name: string;
}

/** "all", or the chosen monitor ids. */
export type MonitorChoice = "all" | string[];

const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-[background-color,border-color,color] duration-(--duration-fast) ease-out-quart";

function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        CHIP,
        pressed
          ? "border-accent/60 bg-accent-soft text-ink"
          : "border-line bg-surface text-ink-muted hover:border-ink-faint/50 hover:text-ink",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-3.5 place-items-center rounded-full transition-colors duration-(--duration-fast)",
          pressed ? "bg-accent text-canvas" : "border border-line",
        )}
      >
        {pressed && <Check className="size-2.5" strokeWidth={3} />}
      </span>
      {children}
    </button>
  );
}

/** Toggle chips: "All monitors", or any set of monitors. */
export function MonitorPicker({
  monitors,
  value,
  onChange,
  label,
}: {
  monitors: MonitorOption[];
  value: MonitorChoice;
  onChange: (next: MonitorChoice) => void;
  label: string;
}) {
  const chosen = value === "all" ? [] : value;
  function toggle(id: string) {
    const next = chosen.includes(id) ? chosen.filter((m) => m !== id) : [...chosen, id];
    onChange(next.length === 0 || next.length === monitors.length ? "all" : next);
  }
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      <Chip pressed={value === "all"} onClick={() => onChange("all")}>
        All monitors
      </Chip>
      {monitors.map((m) => (
        <Chip key={m.id} pressed={value !== "all" && chosen.includes(m.id)} onClick={() => toggle(m.id)}>
          <span className="max-w-40 truncate">{m.name}</span>
        </Chip>
      ))}
    </div>
  );
}

/** "All monitors", "Echo", "Echo and Scout", "Echo, Scout +1 more". */
export function choiceSummary(choice: MonitorChoice, byId: Map<string, string>): string {
  if (choice === "all") return "All monitors";
  const names = choice.map((id) => byId.get(id) ?? "Unknown monitor");
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
}
