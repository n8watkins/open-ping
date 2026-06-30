import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Loader2, ArrowRight, ArrowLeft } from "lucide-react";
import { api } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { Logo } from "../components/Logo";
import { cn } from "../lib/cn";

interface SetupStatus {
  setupComplete: boolean;
  githubEnabled: boolean;
  githubAdminConfigured: boolean;
  emailAdminConfigured: boolean;
  resendConfigured: boolean;
  appUrl: string | null;
  timezone: string | null;
}
interface SetupState {
  currentStep: number;
  completedSteps: string[];
  data: Record<string, unknown>;
  updatedAt: number;
}
interface StateResponse {
  state: SetupState;
  status: SetupStatus;
}

const STEPS = [
  { id: "welcome", title: "Welcome" },
  { id: "url", title: "Installation URL" },
  { id: "timezone", title: "Timezone" },
  { id: "admin", title: "Administrator" },
  { id: "notifications", title: "Notifications" },
  { id: "monitor", title: "First monitor" },
  { id: "finish", title: "Finish" },
] as const;

function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timezones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    if (fn) return fn("timeZone");
  } catch {
    /* ignore */
  }
  return ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London"];
}

export default function Setup() {
  const navigate = useNavigate();
  const { refresh } = useBootstrap();
  const tzList = useMemo(timezones, []);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [done, setDone] = useState<string[]>([]);

  // Form fields
  const [appUrl, setAppUrl] = useState("");
  const [timezone, setTimezone] = useState(guessTimezone());
  const [adminGithubLogin, setAdminGithubLogin] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const res = await api<StateResponse>("/api/setup/state");
        if (res.status.setupComplete) {
          navigate("/", { replace: true });
          return;
        }
        // An admin is already configured (e.g. via the ADMIN_GITHUB_LOGIN env
        // secret). The anonymous wizard can't reconfigure the admin and is locked
        // server-side, so send the operator to sign in instead of a dead-end form.
        if (res.status.githubAdminConfigured || res.status.emailAdminConfigured) {
          navigate("/login", { replace: true });
          return;
        }
        setStatus(res.status);
        setDone(res.state.completedSteps);
        setStep(Math.min(res.state.currentStep, STEPS.length - 1));
        const d = res.state.data;
        setAppUrl((d.appUrl as string) ?? res.status.appUrl ?? window.location.origin);
        setTimezone((d.timezone as string) ?? res.status.timezone ?? guessTimezone());
        setAdminGithubLogin((d.adminGithubLogin as string) ?? "");
      } catch {
        setError("Could not load setup state.");
      } finally {
        setLoading(false);
      }
    })();
  }, [navigate]);

  function dataForStep(id: string): Record<string, unknown> {
    switch (id) {
      case "url":
        return { appUrl };
      case "timezone":
        return { timezone };
      case "admin":
        return { adminGithubLogin };
      default:
        return {};
    }
  }

  async function persist(nextStep: number, stepId: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await api<StateResponse>("/api/setup/save", {
        method: "POST",
        json: { step: nextStep, stepId, data: dataForStep(stepId) },
      });
      setStatus(res.status);
      setDone(res.state.completedSteps);
      setStep(nextStep);
    } catch {
      setError("Could not save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function finish() {
    setSaving(true);
    setError(null);
    try {
      await api("/api/setup/complete", { method: "POST", json: {} });
      await refresh();
      navigate("/login", { replace: true });
    } catch (e) {
      const code = e instanceof Error ? e.message : "error";
      setError(
        code === "no_admin_configured"
          ? "Configure an administrator GitHub login (or email) before finishing."
          : code === "timezone_required"
            ? "Select a timezone before finishing."
            : "Could not complete setup.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-full place-items-center">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
      </div>
    );
  }

  const current = STEPS[step];
  if (!current) return null; // step is always a valid index; guard for the type

  return (
    <div className="mx-auto flex min-h-full max-w-4xl flex-col px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <Logo />
        <span className="text-xs text-ink-faint">First-run setup</span>
      </div>

      <div className="grid flex-1 gap-6 md:grid-cols-[200px_1fr]">
        {/* Step rail */}
        <ol className="hidden flex-col gap-1 md:flex">
          {STEPS.map((s, i) => {
            const isDone = done.includes(s.id) || i < step;
            const isActive = i === step;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => i <= step && setStep(i)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                    isActive
                      ? "bg-accent-soft text-ink"
                      : "text-ink-muted hover:bg-surface-2",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-full border text-[10px]",
                      isDone
                        ? "border-up bg-up/15 text-up"
                        : isActive
                          ? "border-accent text-accent"
                          : "border-line text-ink-faint",
                    )}
                  >
                    {isDone ? <Check className="size-3" /> : i + 1}
                  </span>
                  {s.title}
                </button>
              </li>
            );
          })}
        </ol>

        {/* Panel */}
        <div className="rounded-card border border-line bg-surface p-6">
          <StepBody
            id={current.id}
            status={status}
            appUrl={appUrl}
            setAppUrl={setAppUrl}
            timezone={timezone}
            setTimezone={setTimezone}
            tzList={tzList}
            adminGithubLogin={adminGithubLogin}
            setAdminGithubLogin={setAdminGithubLogin}
          />

          {error && (
            <p className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
              {error}
            </p>
          )}

          <div className="mt-8 flex items-center justify-between">
            <button
              type="button"
              disabled={step === 0 || saving}
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-ink-muted transition-colors hover:text-ink disabled:opacity-40"
            >
              <ArrowLeft className="size-4" /> Back
            </button>

            {current.id === "finish" ? (
              <button
                type="button"
                disabled={saving}
                onClick={finish}
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
              >
                {saving && <Loader2 className="size-4 animate-spin" />}
                Finish setup
              </button>
            ) : (
              <button
                type="button"
                disabled={saving}
                onClick={() => persist(step + 1, current.id)}
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <>
                    Continue <ArrowRight className="size-4" />
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface BodyProps {
  id: string;
  status: SetupStatus | null;
  appUrl: string;
  setAppUrl: (v: string) => void;
  timezone: string;
  setTimezone: (v: string) => void;
  tzList: string[];
  adminGithubLogin: string;
  setAdminGithubLogin: (v: string) => void;
}

function StepBody(p: BodyProps) {
  switch (p.id) {
    case "welcome":
      return (
        <Section title="Welcome to OpenPing" desc="Let's get your installation configured. You can leave and resume this wizard at any time.">
          <ul className="space-y-2 text-sm text-ink-muted">
            <Ready ok label="Worker is running" />
            <Ready ok label="Database is reachable" />
            <Ready ok={p.status?.githubEnabled} label="GitHub OAuth credentials present" optional />
            <Ready ok={p.status?.resendConfigured} label="Resend email configured" optional />
          </ul>
        </Section>
      );
    case "url":
      return (
        <Section title="Installation URL" desc="The public base URL of this installation. Used for links in notifications and OAuth redirects.">
          <Field label="Installation URL">
            <input
              value={p.appUrl}
              onChange={(e) => p.setAppUrl(e.target.value)}
              placeholder="https://status.example.com"
              className="input"
            />
          </Field>
        </Section>
      );
    case "timezone":
      return (
        <Section title="Timezone" desc="Used for schedules, maintenance windows, and reporting.">
          <Field label="Installation timezone">
            <select
              value={p.timezone}
              onChange={(e) => p.setTimezone(e.target.value)}
              className="input"
            >
              {p.tzList.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </Field>
        </Section>
      );
    case "admin":
      return (
        <Section title="Administrator" desc="OpenPing is single-administrator. Only this identity can sign in.">
          {!p.status?.githubEnabled && (
            <p className="mb-4 rounded-lg border border-degraded/40 bg-degraded/10 px-3 py-2 text-sm text-degraded">
              GitHub OAuth isn't configured yet. Set the GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET Worker secrets to enable GitHub sign-in. You can still record your login below.
            </p>
          )}
          <Field label="Administrator GitHub username">
            <input
              value={p.adminGithubLogin}
              onChange={(e) => p.setAdminGithubLogin(e.target.value)}
              placeholder="octocat"
              className="input"
            />
          </Field>
        </Section>
      );
    case "notifications":
      return (
        <Section title="Notifications" desc="Email (Resend), mobile push, Discord, and webhooks can be configured here or later in Integrations.">
          <p className="text-sm text-ink-muted">
            You can skip this for now and set up notification channels after the first monitor is running.
          </p>
        </Section>
      );
    case "monitor":
      return (
        <Section title="First monitor" desc="Add your first HTTP or heartbeat monitor.">
          <p className="text-sm text-ink-muted">
            Monitor creation becomes available on the dashboard once setup is complete.
          </p>
        </Section>
      );
    case "finish":
      return (
        <Section title="You're all set" desc="Finish setup to start using OpenPing.">
          <ul className="space-y-2 text-sm text-ink-muted">
            <Ready ok={!!p.status?.timezone || !!p.timezone} label={`Timezone: ${p.timezone}`} />
            <Ready
              ok={p.status?.githubAdminConfigured || p.status?.emailAdminConfigured || !!p.adminGithubLogin}
              label="Administrator identity recorded"
            />
          </ul>
        </Section>
      );
    default:
      return null;
  }
}

function Section({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-ink-muted">{desc}</p>
      <div className="mt-6">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

function Ready({ ok, label, optional }: { ok?: boolean; label: string; optional?: boolean }) {
  return (
    <li className="flex items-center gap-2">
      <span
        className={cn(
          "size-2 rounded-full",
          ok ? "bg-up" : optional ? "bg-scheduled" : "bg-degraded",
        )}
      />
      <span className={ok ? "text-ink" : undefined}>{label}</span>
      {optional && !ok && <span className="text-xs text-ink-faint">(optional)</span>}
    </li>
  );
}
