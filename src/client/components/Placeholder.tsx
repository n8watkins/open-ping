import { Construction } from "lucide-react";

/** Temporary section scaffold used until a page is built out in later phases. */
export function Placeholder({ title }: { title: string }) {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-6 flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-line bg-surface/40 px-6 py-16 text-center">
        <Construction className="size-7 text-ink-faint" />
        <p className="text-sm text-ink-muted">
          {title} arrives in a later build phase.
        </p>
      </div>
    </div>
  );
}
