import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Accessible, animated FAQ accordion. Each item is an independent disclosure:
 * a <button aria-expanded aria-controls> toggles a region whose open/close is
 * animated with the grid-template-rows 0fr→1fr technique (no JS height
 * measurement, no layout thrash). Native button keyboard handling is preserved
 * (Enter/Space), and the height/opacity transition is dropped under
 * prefers-reduced-motion via Tailwind's motion-reduce variant.
 */

export interface FaqItem {
  q: string;
  a: ReactNode;
}

function AccordionItem({ item }: { item: FaqItem }) {
  const [open, setOpen] = useState(false);
  const baseId = useId();
  const buttonId = `${baseId}-button`;
  const panelId = `${baseId}-panel`;

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface transition-colors hover:border-ink-faint/30">
      <h3>
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-sm font-semibold text-ink"
        >
          <span>{item.q}</span>
          <ChevronDown
            className={`size-4 shrink-0 text-ink-faint transition-transform duration-300 motion-reduce:transition-none ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>
      </h3>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        inert={!open}
        className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div
            className={`px-5 pb-5 text-sm leading-relaxed text-ink-muted transition-opacity duration-300 motion-reduce:transition-none ${
              open ? "opacity-100" : "opacity-0"
            }`}
          >
            {item.a}
          </div>
        </div>
      </div>
    </div>
  );
}

export function FaqAccordion({ items }: { items: FaqItem[] }) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <AccordionItem key={item.q} item={item} />
      ))}
    </div>
  );
}
