import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { Check, Loader2, ArrowRight, ArrowLeft, Fingerprint, Plus } from "lucide-react";
import { api } from "../lib/api";
import { hostMatchesRpId, passkeyErrorMessage, passkeysSupported, registerPasskey } from "../lib/webauthn";
import { defaultPasskeyName } from "../components/PasskeysCard";
import { useBootstrap } from "../lib/bootstrap";
import { Logo } from "../components/Logo";
import { AddSecretHelp } from "../components/AddSecretHelp";
import { cn } from "../lib/cn";

interface SetupStatus {
  setupComplete: boolean;
  encryptionConfigured: boolean;
  githubEnabled: boolean;
  githubAdminConfigured: boolean;
  emailAdminConfigured: boolean;
  resendConfigured: boolean;
  appUrl: string | null;
  timezone: string | null;
  /** Passkeys created so far (optional for an older Worker). */
  passkeyCount?: number;
  /** The hostname passkeys are bound to, once an address is configured. */
  passkeyRpId?: string | null;
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
  const {
    loading: bootstrapLoading,
    me,
    csrf,
    refresh,
  } = useBootstrap();
  const tzList = useMemo(timezones, []);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [setupToken, setSetupToken] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [tokenMissing, setTokenMissing] = useState(false);

  // Form fields
  const [appUrl, setAppUrl] = useState("");
  const [timezone, setTimezone] = useState(guessTimezone());
  const [adminGithubLogin, setAdminGithubLogin] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [creatingPasskey, setCreatingPasskey] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  const loadState = useCallback(
    async (token?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api<StateResponse>("/api/setup/state", {
          headers: token ? { "x-setup-token": token } : undefined,
        });
        if (res.status.setupComplete) {
          navigate("/", { replace: true });
          return;
        }
        setStatus(res.status);
        setDone(res.state.completedSteps);
        setStep(Math.min(res.state.currentStep, STEPS.length - 1));
        const d = res.state.data;
        setAppUrl((d.appUrl as string) ?? res.status.appUrl ?? window.location.origin);
        setTimezone((d.timezone as string) ?? res.status.timezone ?? guessTimezone());
        setAdminGithubLogin((d.adminGithubLogin as string) ?? "");
        setAdminEmail((d.adminEmail as string) ?? "");
        setUnlocked(true);
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : "error";
        setTokenMissing(code === "setup_token_not_configured");
        setError(
          code === "setup_token_invalid"
            ? "That setup token is not valid."
            : code === "setup_token_not_configured"
              ? "SETUP_TOKEN is not configured on this deployment."
              : "Could not load setup state.",
        );
      } finally {
        setLoading(false);
      }
    },
    [navigate],
  );

  useEffect(() => {
    if (bootstrapLoading) return;
    if (me?.authenticated) void loadState();
    else setLoading(false);
  }, [bootstrapLoading, loadState, me?.authenticated]);

  function setupRequestOptions() {
    return me?.authenticated
      ? { csrf: csrf ?? undefined }
      : { headers: { "x-setup-token": setupToken } };
  }

  async function createPasskey() {
    setCreatingPasskey(true);
    setPasskeyError(null);
    try {
      const res = await registerPasskey<{ status: SetupStatus }>(
        "/api/setup/passkeys",
        defaultPasskeyName(),
        setupRequestOptions(),
      );
      setStatus(res.status);
    } catch (err) {
      setPasskeyError(passkeyErrorMessage(err));
    } finally {
      setCreatingPasskey(false);
    }
  }

  function unlock(event: FormEvent) {
    event.preventDefault();
    if (!setupToken) {
      setError("Enter the setup token configured for this deployment.");
      return;
    }
    void loadState(setupToken);
  }

  function dataForStep(id: string): Record<string, unknown> {
    switch (id) {
      case "url":
        return { appUrl };
      case "timezone":
        return { timezone };
      case "admin":
        return { adminGithubLogin, adminEmail };
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
        ...setupRequestOptions(),
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
      await api("/api/setup/complete", {
        method: "POST",
        json: {},
        ...setupRequestOptions(),
      });
      await refresh();
      navigate("/login", { replace: true });
    } catch (e) {
      const code = e instanceof Error ? e.message : "error";
      setError(
        code === "no_admin_configured"
          ? "Create a passkey, or add a GitHub username or email address, before finishing."
          : code === "timezone_required"
            ? "Select a timezone before finishing."
            : code === "master_key_required"
              ? "Configure a valid 32-byte MASTER_KEY before finishing setup."
              : "Could not complete setup.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (bootstrapLoading || loading) {
    return (
      <div className="grid min-h-full place-items-center">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
      </div>
    );
  }

  if (!me?.authenticated && !unlocked) {
    return (
      <div className="grid min-h-full place-items-center px-4">
        <main className="w-full max-w-sm">
          <div className="mb-8 flex justify-center">
            <Logo />
          </div>
          <form
            onSubmit={unlock}
            className="rounded-card border border-line bg-surface p-6"
          >
            <h1 className="text-center text-lg font-semibold tracking-tight">
              Unlock setup
            </h1>
            <p className="mt-2 text-center text-sm text-ink-muted">
              Enter the one-time setup token configured as a Worker secret.
            </p>
            <label className="mt-6 block">
              <span className="mb-1.5 block text-xs font-medium text-ink-muted">
                Setup token
              </span>
              <input
                type="password"
                value={setupToken}
                onChange={(event) => setSetupToken(event.target.value)}
                autoComplete="off"
                required
                className="input"
              />
            </label>
            {error && (
              <p
                role="alert"
                className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down"
              >
                {error}
              </p>
            )}
            {tokenMissing && <AddSecretHelp name="SETUP_TOKEN" />}
            <button
              type="submit"
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover"
            >
              Continue securely
              <ArrowRight className="size-4" />
            </button>
          </form>
        </main>
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
        <main className="rounded-card border border-line bg-surface p-6">
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
            adminEmail={adminEmail}
            setAdminEmail={setAdminEmail}
            onCreatePasskey={() => void createPasskey()}
            creatingPasskey={creatingPasskey}
            passkeyError={passkeyError}
          />

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down"
            >
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
        </main>
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
  adminEmail: string;
  setAdminEmail: (v: string) => void;
  onCreatePasskey: () => void;
  creatingPasskey: boolean;
  passkeyError: string | null;
}

function StepBody(p: BodyProps) {
  switch (p.id) {
    case "welcome":
      return (
        <Section title="Welcome to OpenPing" desc="Let's get your installation configured. You can leave and resume this wizard at any time.">
          <ul className="space-y-2 text-sm text-ink-muted">
            <Ready ok label="Worker is running" />
            <Ready ok label="Database is reachable" />
            <Ready ok={p.status?.encryptionConfigured} label="Encryption at rest configured" />
            <Ready ok={p.status?.githubEnabled} label="GitHub sign-in app configured" optional />
            <Ready ok={p.status?.resendConfigured} label="Resend email configured" optional />
          </ul>
          {p.status && !p.status.encryptionConfigured && <AddSecretHelp name="MASTER_KEY" />}
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
        <Section
          title="Administrator"
          desc="OpenPing has one administrator: you. A passkey is enough to sign in; add GitHub or an email address if you want another way in."
        >
          <PasskeyStep {...p} />
          <div className="my-5 flex items-center gap-3 text-xs text-ink-faint">
            <span className="h-px flex-1 bg-line" />
            optional
            <span className="h-px flex-1 bg-line" />
          </div>
          <Field label="Administrator GitHub username">
            <input
              value={p.adminGithubLogin}
              onChange={(e) => p.setAdminGithubLogin(e.target.value)}
              placeholder="octocat"
              className="input"
            />
          </Field>
          {!p.status?.githubEnabled && (
            <p className="mt-1.5 text-xs text-ink-faint">
              GitHub sign-in also needs a GitHub OAuth app: the GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET secrets.
            </p>
          )}
          <div className="mt-4">
            <Field label="Administrator email address">
              <input
                type="email"
                value={p.adminEmail}
                onChange={(e) => p.setAdminEmail(e.target.value)}
                placeholder="admin@example.com"
                autoComplete="email"
                className="input"
              />
            </Field>
          </div>
          <p className="mt-1.5 text-xs text-ink-faint">Email sign-in also needs RESEND_API_KEY.</p>
        </Section>
      );
    case "finish":
      return (
        <Section title="You're all set" desc="Finish setup to start using OpenPing.">
          <ul className="space-y-2 text-sm text-ink-muted">
            <Ready ok={!!p.status?.timezone || !!p.timezone} label={`Timezone: ${p.timezone}`} />
            <Ready
              ok={
                (p.status?.passkeyCount ?? 0) > 0 ||
                p.status?.githubAdminConfigured ||
                p.status?.emailAdminConfigured ||
                !!p.adminGithubLogin ||
                !!p.adminEmail
              }
              label={
                (p.status?.passkeyCount ?? 0) > 0 ? "Passkey created for sign-in" : "Administrator identity recorded"
              }
            />
          </ul>
          <p className="mt-5 rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm text-ink-muted">
            After signing in, create your first monitor from Monitoring and add
            email, push, Slack, Teams, Discord, Telegram or webhook delivery under Integrations &amp;
            API.
          </p>
        </Section>
      );
    default:
      return null;
  }
}

/** The Administrator step's passkey box: create one (or more) for the admin. */
function PasskeyStep(p: BodyProps) {
  const count = p.status?.passkeyCount ?? 0;
  const rpId = p.status?.passkeyRpId ?? window.location.hostname;
  const supported = passkeysSupported();
  const here = hostMatchesRpId(rpId);
  return (
    <div className="rounded-lg border border-line bg-surface-2/40 p-4">
      <div className="flex items-start gap-3">
        <Fingerprint className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">Sign in with a passkey (recommended)</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Uses your fingerprint, face, screen lock or a security key. No GitHub app or email service needed. It works
            only at <span className="font-mono text-ink">{rpId}</span>.
          </p>
          {count > 0 && (
            <p role="status" className="mt-3 flex items-center gap-1.5 text-sm font-medium text-up">
              <Check className="size-4" aria-hidden />
              {count === 1 ? "Passkey created." : `${count} passkeys created.`} You'll sign in with it after setup.
            </p>
          )}
          {!supported ? (
            <p className="mt-3 text-sm text-degraded">This browser can't create passkeys.</p>
          ) : !here ? (
            <p className="mt-3 text-sm text-degraded">
              Passkeys are bound to the installation URL. Open this wizard at{" "}
              <span className="font-mono">{rpId}</span> to create one, or change the URL in step 2.
            </p>
          ) : (
            <button
              type="button"
              onClick={p.onCreatePasskey}
              disabled={p.creatingPasskey}
              className={cn(
                "mt-3 inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-60",
                count > 0
                  ? "border border-line bg-surface text-ink hover:bg-surface-2"
                  : "bg-accent text-canvas hover:bg-accent-hover",
              )}
            >
              {p.creatingPasskey ? (
                <Loader2 className="size-4 animate-spin" />
              ) : count > 0 ? (
                <Plus className="size-4" />
              ) : (
                <Fingerprint className="size-4" />
              )}
              {count > 0 ? "Add another passkey" : "Create a passkey"}
            </button>
          )}
          {p.passkeyError && (
            <p role="alert" className="mt-2 text-sm text-down">
              {p.passkeyError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
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
