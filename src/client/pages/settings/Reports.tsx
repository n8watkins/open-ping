import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../../lib/api";
import { useBootstrap } from "../../lib/bootstrap";
import { useFetch } from "../../lib/useFetch";
import { formatRelativeTime } from "../../lib/format";
import { Card, CardHeader, CardTitle } from "../../components/ui/Card";
import { Stat } from "../../components/ui/Stat";
import { ReportsCard } from "../../components/ReportsCard";
import { LandingEventsCard } from "../../components/LandingEventsCard";
import { weeklyLocalTime } from "../../lib/weekly";
import { ErrorBanner, SavedNote, errMessage, type AppSettings, type SettingsResponse } from "./shared";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

interface WaitlistResponse {
  count: number;
  entries: { email: string; created_at: number }[];
}

/** Settings > Reports: the monthly report, the weekly summary email, and the Hosted waitlist where it runs. */
export default function ReportsSettings() {
  const { csrf, status, me } = useBootstrap();
  // OpenPing Hosted sends the email itself, to the account's address; no key to set.
  const hosted = !!me?.hosted;
  const { data, error, reload } = useFetch<SettingsResponse>("/api/settings");
  // Only the canonical install collects the Hosted waitlist; elsewhere the
  // endpoint doesn't exist, so don't ask (a 404 would log a console error).
  const { data: waitlist } = useFetch<WaitlistResponse>(status?.waitlistEnabled ? "/api/waitlist" : null);

  return (
    <div className="stagger space-y-6 [&>*]:animate-enter">
      <ReportsCard
        emailEnabled={data?.settings.monthly_report_enabled === "true"}
        csrf={csrf ?? undefined}
        hosted={hosted}
        onSaved={() => void reload()}
      />
      <WeeklySummaryCard
        settings={data?.settings ?? null}
        loadError={error}
        csrf={csrf ?? undefined}
        hosted={hosted}
        onSaved={() => void reload()}
      />
      {waitlist && <WaitlistCard waitlist={waitlist} />}
      <LandingEventsCard />
    </div>
  );
}

function WeeklySummaryCard({
  settings,
  loadError,
  csrf,
  hosted,
  onSaved,
}: {
  settings: AppSettings | null;
  loadError: string | null;
  csrf: string | undefined;
  hosted: boolean;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Optimistic copy so the controls answer at once; the reload confirms it.
  const [local, setLocal] = useState<Record<string, string>>({});

  const read = (key: string, fallback: string) => local[key] ?? (typeof settings?.[key] === "string" ? (settings[key] as string) : fallback);
  const enabled = read("weekly_summary_enabled", "false") === "true";
  const day = Number(read("weekly_summary_day", "1"));
  const hour = Number(read("weekly_summary_hour", "9"));
  const timezone = typeof settings?.timezone === "string" && settings.timezone ? settings.timezone : "UTC";

  async function save(key: string, value: string) {
    setLocal((m) => ({ ...m, [key]: value }));
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api("/api/settings", { method: "PUT", csrf, json: { settings: { [key]: value } } });
      setSaved(true);
      onSaved();
    } catch (e) {
      setLocal((m) => {
        const next = { ...m };
        delete next[key];
        return next;
      });
      setError(errMessage(e, "Could not save."));
    } finally {
      setSaving(false);
    }
  }

  const localTime = timezone !== "UTC" ? weeklyLocalTime(day, hour, timezone) : "";

  return (
    <section id="weekly-summary" className="scroll-mt-6">
      <Card className="p-5">
        <CardHeader>
          <CardTitle>Weekly summary</CardTitle>
          <span className="flex items-center gap-2">
            {saving && <Loader2 className="size-4 animate-spin text-ink-faint" />}
            <SavedNote show={saved && !saving} />
          </span>
        </CardHeader>
        <p className="-mt-1 mb-4 text-sm text-ink-muted">
          A short email each week: overall uptime, incidents, downtime, response time and the slowest monitor.
        </p>
        {loadError && !settings ? (
          <ErrorBanner>Could not load settings: {loadError}</ErrorBanner>
        ) : (
          <div className="space-y-4">
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                name="weekly-summary-email"
                checked={enabled}
                disabled={!settings || saving}
                onChange={(e) => void save("weekly_summary_enabled", e.target.checked ? "true" : "false")}
                className="mt-0.5 size-4 rounded border-line bg-surface-2 accent-accent"
              />
              <span>
                <span className="text-ink">Email me a weekly summary</span>
                <span className="block text-xs text-ink-faint">
                  {hosted
                    ? "Sent to your account email. A send that fails is retried hourly."
                    : "Sent to the admin email. Needs RESEND_API_KEY; a send that fails is retried hourly."}
                </span>
              </span>
            </label>
            <div className="grid gap-3 sm:grid-cols-2 sm:max-w-md">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-ink-muted">Day</span>
                <select
                  className="input"
                  name="weekly-summary-day"
                  value={day}
                  disabled={!settings || !enabled}
                  onChange={(e) => void save("weekly_summary_day", e.target.value)}
                >
                  {DAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-ink-muted">Hour (UTC)</span>
                <select
                  className="input"
                  name="weekly-summary-hour"
                  value={hour}
                  disabled={!settings || !enabled}
                  onChange={(e) => void save("weekly_summary_hour", e.target.value)}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, "0")}:00 UTC
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {enabled && (
              <p className="text-xs text-ink-faint">
                Goes out on the first scheduler run after {DAYS[day]} {String(hour).padStart(2, "0")}:00 UTC
                {localTime ? ` (${localTime} in ${timezone})` : ""}.
              </p>
            )}
            {error && <ErrorBanner>{error}</ErrorBanner>}
          </div>
        )}
      </Card>
    </section>
  );
}

/** The OpenPing Hosted waitlist (canonical install only): the count, the latest sign-ups and a CSV. */
function WaitlistCard({ waitlist }: { waitlist: WaitlistResponse }) {
  return (
    <section id="waitlist" className="scroll-mt-6">
      <Card className="p-5">
        <CardHeader>
          <CardTitle>Hosted waitlist</CardTitle>
          <a
            href="/api/waitlist/export.csv"
            className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface"
          >
            Download CSV
          </a>
        </CardHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card className="bg-surface-2/40 p-4">
            <Stat label="People waiting" value={waitlist.count.toLocaleString()} />
          </Card>
          <Card className="bg-surface-2/40 p-4">
            <Stat label="Goal before building Hosted" value="20 in 8 weeks" />
          </Card>
        </div>
        {waitlist.entries.length > 0 ? (
          <ul className="mt-4 divide-y divide-line text-sm">
            {waitlist.entries.slice(0, 10).map((e) => (
              <li key={e.email} className="flex items-center justify-between gap-3 py-2">
                <span className="truncate text-ink">{e.email}</span>
                <span className="shrink-0 text-xs text-ink-faint">{formatRelativeTime(e.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-ink-muted">No one yet. The landing page&apos;s pricing section collects sign-ups.</p>
        )}
      </Card>
    </section>
  );
}
