import { useMemo, useState } from "react";
import { Percent } from "lucide-react";
import {
  ToolLayout,
  Panel,
  Notice,
} from "./ToolLayout";
import {
  allowedDowntime,
  uptimeFromDowntime,
  formatDowntimeDuration,
  UPTIME_PERIODS,
} from "./lib";

const SLA_PRESETS = [
  { label: "99%", value: 99 },
  { label: "99.9%", value: 99.9 },
  { label: "99.99%", value: 99.99 },
  { label: "99.999%", value: 99.999 },
];

const DOWNTIME_UNITS = [
  { label: "seconds", seconds: 1 },
  { label: "minutes", seconds: 60 },
  { label: "hours", seconds: 3600 },
  { label: "days", seconds: 86400 },
];

type Mode = "forward" | "reverse";

export default function UptimeCalculator() {
  const [mode, setMode] = useState<Mode>("forward");

  return (
    <ToolLayout
      icon={Percent}
      title="Uptime calculator"
      intro="Translate an uptime SLA into the downtime it actually permits — or work backwards from a downtime budget to the percentage it represents."
    >
      <div
        className="mb-6 inline-flex rounded-lg border border-line bg-surface p-1"
        role="tablist"
        aria-label="Calculation mode"
      >
        <ModeTab current={mode} value="forward" onSelect={setMode}>
          Uptime % → downtime
        </ModeTab>
        <ModeTab current={mode} value="reverse" onSelect={setMode}>
          Downtime → uptime %
        </ModeTab>
      </div>

      {mode === "forward" ? <ForwardMode /> : <ReverseMode />}

      <Explainer />
    </ToolLayout>
  );
}

function ModeTab({
  current,
  value,
  onSelect,
  children,
}: {
  current: Mode;
  value: Mode;
  onSelect: (m: Mode) => void;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(value)}
      className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
        active ? "bg-accent text-canvas" : "text-ink-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Forward: uptime % -> allowed downtime per period
 * ------------------------------------------------------------------ */
function ForwardMode() {
  const [raw, setRaw] = useState("99.9");

  const pct = Number(raw);
  const valid = raw.trim() !== "" && Number.isFinite(pct) && pct >= 0 && pct <= 100;
  const rows = useMemo(() => (valid ? allowedDowntime(pct) : []), [valid, pct]);

  return (
    <Panel>
      <label htmlFor="uptime-pct" className="block text-sm font-medium text-ink">
        Uptime percentage
      </label>
      <div className="mt-2 flex items-center gap-2">
        <input
          id="uptime-pct"
          type="number"
          inputMode="decimal"
          min={0}
          max={100}
          step="any"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          aria-describedby="uptime-pct-help"
          className="input max-w-[10rem]"
        />
        <span className="text-lg font-semibold text-ink-muted">%</span>
      </div>
      <p id="uptime-pct-help" className="mt-2 text-xs text-ink-faint">
        Enter a value between 0 and 100, or pick a common SLA below.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {SLA_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => setRaw(String(p.value))}
            aria-pressed={raw === String(p.value)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              raw === String(p.value)
                ? "border-accent bg-accent-soft text-accent"
                : "border-line bg-surface-2 text-ink-muted hover:text-ink"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="mt-6" aria-live="polite">
        {!valid ? (
          <Notice>Enter an uptime percentage between 0 and 100.</Notice>
        ) : (
          <>
            <p className="mb-3 text-sm text-ink-muted">
              At <span className="font-semibold text-ink">{pct}%</span> uptime you
              can be down for at most:
            </p>
            <div className="overflow-hidden rounded-lg border border-line">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Allowed downtime by period at {pct}% uptime
                </caption>
                <thead>
                  <tr className="border-b border-line bg-surface-2/60 text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th scope="col" className="px-4 py-2 font-medium">
                      Period
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Allowed downtime
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="border-b border-line/60 last:border-0">
                      <th scope="row" className="px-4 py-2.5 text-left font-medium text-ink">
                        {r.label}
                      </th>
                      <td className="px-4 py-2.5 font-mono text-ink">
                        {formatDowntimeDuration(r.downtimeSeconds)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Reverse: downtime -> uptime %
 * ------------------------------------------------------------------ */
function ReverseMode() {
  const [amount, setAmount] = useState("60");
  const [unitIdx, setUnitIdx] = useState(1); // minutes
  const [periodKey, setPeriodKey] = useState<string>("month");

  const unit = DOWNTIME_UNITS[unitIdx]!;
  const period = UPTIME_PERIODS.find((p) => p.key === periodKey)!;
  const amt = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(amt) && amt >= 0;

  const downtimeSeconds = amt * unit.seconds;
  const exceeds = downtimeSeconds > period.seconds;
  const uptimePct = valid ? uptimeFromDowntime(downtimeSeconds, period.seconds) : 0;

  return (
    <Panel>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="dt-amount" className="block text-sm font-medium text-ink">
            Downtime
          </label>
          <input
            id="dt-amount"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="input mt-2"
          />
        </div>
        <div>
          <label htmlFor="dt-unit" className="block text-sm font-medium text-ink">
            Unit
          </label>
          <select
            id="dt-unit"
            value={unitIdx}
            onChange={(e) => setUnitIdx(Number(e.target.value))}
            className="input mt-2"
          >
            {DOWNTIME_UNITS.map((u, i) => (
              <option key={u.label} value={i}>
                {u.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="dt-period" className="block text-sm font-medium text-ink">
            Over
          </label>
          <select
            id="dt-period"
            value={periodKey}
            onChange={(e) => setPeriodKey(e.target.value)}
            className="input mt-2"
          >
            {UPTIME_PERIODS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-6" aria-live="polite">
        {!valid ? (
          <Notice>Enter a downtime amount of zero or more.</Notice>
        ) : (
          <div className="rounded-lg border border-line bg-surface-2/50 p-5 text-center">
            <div className="text-xs uppercase tracking-wide text-ink-faint">
              Resulting uptime
            </div>
            <div className="mt-1 font-mono text-4xl font-semibold text-accent">
              {uptimePct.toFixed(uptimePct >= 99.99 ? 5 : 3)}%
            </div>
            <p className="mt-2 text-sm text-ink-muted">
              {formatDowntimeDuration(downtimeSeconds)} of downtime {period.label.toLowerCase()}.
            </p>
            {exceeds && (
              <p className="mt-3">
                <Notice>
                  That downtime is longer than the period itself, so uptime is 0%.
                </Notice>
              </p>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Explainer() {
  return (
    <div className="mt-6 rounded-card border border-line bg-surface/50 p-5 text-sm leading-relaxed text-ink-muted">
      <h2 className="mb-1.5 text-sm font-semibold text-ink">How this is calculated</h2>
      <p>
        Allowed downtime is simply{" "}
        <span className="font-mono text-ink">(100 − uptime%) × period</span>. Following
        the common SLA convention, a month is treated as 30 days and a year as 365
        days. So 99.9% — "three nines" — works out to about 43 minutes per month,
        while 99.999% — "five nines" — is just over 5 minutes per year.
      </p>
    </div>
  );
}
