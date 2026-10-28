import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useFetch } from "../../lib/useFetch";
import { installationUrlImpact, installationUrlWarning, type PasskeySignIn } from "../../lib/webauthn";
import { api } from "../../lib/api";
import { useBootstrap } from "../../lib/bootstrap";
import { Card, CardHeader, CardTitle } from "../../components/ui/Card";
import { HostedManagedCard } from "../../components/HostedManaged";
import {
  ErrorBanner,
  Field,
  PrimaryButton,
  SavedNote,
  SectionSkeleton,
  errMessage,
  type SettingsResponse,
} from "./shared";

function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timezones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (fn) return fn("timeZone");
  } catch {
    /* ignore */
  }
  return ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London"];
}

/** Settings > General: timezone, the install's address, and the email sender. */
export default function GeneralSettings() {
  const { me } = useBootstrap();
  // On OpenPing Hosted the platform runs the install and gives it its address.
  if (me?.hosted) {
    return (
      <div className="stagger space-y-6 [&>*]:animate-enter">
        <HostedManagedCard account={me.hosted} />
        <GeneralCard hosted />
      </div>
    );
  }
  return <GeneralCard hosted={false} />;
}

function GeneralCard({ hosted }: { hosted: boolean }) {
  const { csrf } = useBootstrap();
  const { data, loading, error, reload } = useFetch<SettingsResponse>("/api/settings");
  const settings = data?.settings ?? null;
  // Passkeys are bound to the installation's hostname, so a new hostname
  // strands them (docs/SECURITY.md); ask before saving one.
  const { data: passkeyData } = useFetch<PasskeySignIn>("/api/passkeys");

  const tzList = useMemo(timezones, []);
  const [timezone, setTimezone] = useState(guessTimezone);
  const [appUrl, setAppUrl] = useState("");
  const [emailFrom, setEmailFrom] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      setTimezone(settings.timezone ?? guessTimezone());
      setAppUrl(settings.app_url ?? "");
      setEmailFrom(settings.email_from ?? "");
    }
  }, [settings]);

  const dirty =
    !!settings &&
    // An unset timezone shows this browser's guess, which is worth saving.
    (timezone !== (settings.timezone ?? "") ||
      (!hosted && appUrl !== (settings.app_url ?? "")) ||
      (!hosted && emailFrom !== (settings.email_from ?? "")));

  async function save(e: FormEvent) {
    e.preventDefault();
    const impact = hosted ? null : installationUrlImpact(appUrl, settings?.app_url, passkeyData);
    if (impact && !window.confirm(installationUrlWarning(impact))) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await api("/api/settings", {
        method: "PUT",
        csrf: csrf ?? undefined,
        // Hosted mode: the address isn't the customer's to change (the API refuses it).
        json: { settings: hosted ? { timezone } : { timezone, app_url: appUrl, email_from: emailFrom } },
      });
      setSaved(true);
      void reload();
    } catch (err) {
      setSaveError(errMessage(err, "Could not save settings."));
    } finally {
      setSaving(false);
    }
  }

  function edited<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setSaved(false);
    };
  }

  return (
    <Card className="p-5">
      <CardHeader>
        <CardTitle>General</CardTitle>
      </CardHeader>
      <p className="-mt-1 mb-5 text-sm text-ink-muted">
        {hosted
          ? "How this OpenPing tells time, and where it lives."
          : "How this install tells time, where it lives, and who its email comes from."}
      </p>

      {loading && !data ? (
        <SectionSkeleton rows={3} />
      ) : error && !data ? (
        <ErrorBanner>Could not load settings: {error}</ErrorBanner>
      ) : (
        <form onSubmit={(e) => void save(e)} className="space-y-5">
          <Field label="Timezone" hint="Used for schedules, maintenance windows and reports.">
            <select
              name="timezone"
              value={timezone}
              onChange={(e) => edited(setTimezone)(e.target.value)}
              className="input sm:max-w-sm"
            >
              {!tzList.includes(timezone) && timezone && <option value={timezone}>{timezone}</option>}
              {tzList.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </Field>

          {hosted ? (
            <div>
              <span className="mb-1.5 block text-xs font-medium text-ink-muted">Address</span>
              <p className="truncate rounded-lg border border-line bg-surface-2/40 px-3 py-2 font-mono text-sm text-ink">
                {window.location.host}
              </p>
              <span className="mt-1 block text-xs leading-relaxed text-ink-faint">
                OpenPing Hosted gives this OpenPing its address. Passkeys work only here.
              </span>
            </div>
          ) : (
            <Field
              label="Installation URL"
              hint={
                passkeyData?.appUrlFromEnv
                  ? `The APP_URL Worker variable sets this address (${passkeyData.origin}) and takes precedence, so this setting has no effect while it is set.`
                  : "The public address, used for links in alerts, OAuth redirects and passkeys. Passkeys work only at this address, so changing it means adding new ones."
              }
            >
              <input
                name="app_url"
                value={appUrl}
                onChange={(e) => edited(setAppUrl)(e.target.value)}
                placeholder="https://status.example.com"
                type="url"
                className="input"
              />
            </Field>
          )}

          {/* Hosted mode: the platform sends every email from its own address. */}
          {!hosted && (
            <Field label="Email from address" hint="The sender of email alerts and reports.">
              <input
                name="email_from"
                value={emailFrom}
                onChange={(e) => edited(setEmailFrom)(e.target.value)}
                placeholder="openping@example.com"
                type="email"
                className="input sm:max-w-sm"
              />
            </Field>
          )}

          {saveError && <ErrorBanner>{saveError}</ErrorBanner>}

          <div className="flex items-center gap-3 border-t border-line pt-4">
            <PrimaryButton type="submit" busy={saving} disabled={!dirty}>
              Save changes
            </PrimaryButton>
            <SavedNote show={saved && !saving && !dirty} />
          </div>
        </form>
      )}
    </Card>
  );
}
