import { useState } from "react";
import { ChevronDown, KeyRound, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useFetch } from "../../lib/useFetch";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Card, CardHeader, CardTitle } from "../../components/ui/Card";
import { keysHealthy, type KeyClassStatus, type RekeyStatusResponse, type UnreadableValue } from "../../lib/encryption";
import { Chip, ErrorBanner, KeyVal, PrimaryButton, SectionSkeleton, errMessage, fmt, plural } from "./shared";

interface RekeyBatchResponse {
  done: boolean;
  cursor: string | null;
  stats: { scanned: number; rewritten: number; reencrypted: number; sealed: number; unchanged: number; conflicts: number };
  unreadable: UnreadableValue[];
}
interface PassProgress {
  scanned: number;
  total: number;
  reencrypted: number;
  sealed: number;
  unreadable: number;
}

const UNREADABLE_REASONS: Record<string, string> = {
  unknown_key: "sealed with a key that is not configured",
  decrypt_failed: "opens with neither key",
  invalid_format: "not a recognised ciphertext",
  invalid_json: "stored JSON cannot be read",
  no_key: "no key configured",
};

const RUNBOOK_URL = "https://github.com/n8watkins/open-ping/blob/main/docs/SECURITY.md#rotating-master_key";

/** "Done: 8 values re-encrypted, 1 unreadable value left unchanged." (zero parts omitted). */
function passSummary(p: PassProgress): string {
  const parts = [
    p.reencrypted ? `${plural(p.reencrypted, "value")} re-encrypted` : null,
    p.sealed ? `${plural(p.sealed, "plaintext value")} encrypted for the first time` : null,
    p.unreadable ? `${plural(p.unreadable, "unreadable value")} left unchanged` : null,
  ].filter(Boolean);
  return parts.length ? `Done: ${parts.join(", ")}.` : "Done: every value was already on the current key.";
}

function KeyStateChip({ status }: { status: RekeyStatusResponse }) {
  const [tone, label] = !status.encryptionConfigured
    ? (["down", "Encryption off"] as const)
    : status.unreadableCount > 0
      ? (["down", `${fmt(status.unreadableCount)} unreadable`] as const)
      : status.previousKey.configured && !status.previousKey.valid
        ? (["down", "Previous key invalid"] as const)
        : status.previousKey.configured
          ? status.safeToRemovePreviousKey
            ? (["up", "Previous key no longer needed"] as const)
            : (["degraded", "Rotation in progress"] as const)
          : status.needsReencryption > 0
            ? (["degraded", "Needs re-encryption"] as const)
            : (["up", "Healthy"] as const);
  return (
    <Chip tone={tone}>
      <KeyRound className="size-3.5" />
      {label}
    </Chip>
  );
}

function ClassCounts({ c }: { c: KeyClassStatus }) {
  const parts: { text: string; className: string }[] = [];
  if (c.current) parts.push({ text: `${fmt(c.current)} current`, className: "text-ink-muted" });
  if (c.previous) parts.push({ text: `${fmt(c.previous)} previous key`, className: "text-degraded" });
  if (c.legacy) parts.push({ text: `${fmt(c.legacy)} legacy format`, className: "text-degraded" });
  if (c.unsealed) parts.push({ text: `${fmt(c.unsealed)} not encrypted`, className: "text-degraded" });
  if (c.unreadable) parts.push({ text: `${fmt(c.unreadable)} unreadable`, className: "text-down" });
  if (parts.length === 0) return <span className="text-xs text-ink-faint">Nothing stored</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums">
      {parts.map((p) => (
        <span key={p.text} className={p.className}>
          {p.text}
        </span>
      ))}
    </span>
  );
}

/**
 * MASTER_KEY: which key protects what, and the batched re-encryption pass
 * (POST /api/admin/rekey) run until it reports done. One line when healthy.
 */
export function EncryptionCard({ csrf }: { csrf: string | undefined }) {
  const { data, loading, error, reload } = useFetch<RekeyStatusResponse>("/api/admin/rekey/status");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<PassProgress | null>(null);
  const [passError, setPassError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [expanded, setExpanded] = useState<boolean | null>(null);

  async function reencrypt() {
    if (!data) return;
    const total = data.classes.reduce((n, c) => n + c.rows, 0);
    const p: PassProgress = { scanned: 0, total, reencrypted: 0, sealed: 0, unreadable: 0 };
    setRunning(true);
    setFinished(false);
    setPassError(null);
    setProgress({ ...p });
    try {
      let cursor: string | null = null;
      do {
        const batch: RekeyBatchResponse = await api<RekeyBatchResponse>("/api/admin/rekey", {
          method: "POST",
          csrf,
          json: { cursor },
        });
        p.scanned += batch.stats.scanned;
        p.reencrypted += batch.stats.reencrypted;
        p.sealed += batch.stats.sealed;
        p.unreadable += batch.unreadable.length;
        // Rows created mid-pass can push the count past the starting total.
        p.total = Math.max(p.total, p.scanned);
        setProgress({ ...p });
        cursor = batch.cursor;
      } while (cursor);
      setFinished(true);
    } catch (e) {
      setPassError(errMessage(e, "The re-encryption pass stopped."));
    } finally {
      setRunning(false);
      void reload();
    }
  }

  const healthy = data ? keysHealthy(data) : false;
  // Healthy: collapsed until asked. Needs attention: open until closed.
  const open = expanded ?? !healthy;
  const blocked = !data || !data.encryptionConfigured || (data.previousKey.configured && !data.previousKey.valid);
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.scanned / progress.total) * 100))
      : running
        ? 0
        : 100;
  const protectedCount = data ? data.classes.reduce((n, c) => n + c.current, 0) : 0;

  return (
    <Card className="p-5">
      <CardHeader>
        <CardTitle>Encryption keys</CardTitle>
        {data && <KeyStateChip status={data} />}
      </CardHeader>

      {loading && !data ? (
        <SectionSkeleton rows={1} />
      ) : error && !data ? (
        <ErrorBanner>Could not load key status: {error}</ErrorBanner>
      ) : data ? (
        <div className="space-y-4">
          <div
            className={cn(
              "flex flex-col gap-2 rounded-lg border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between",
              healthy ? "border-line bg-surface-2/40" : "border-down/40 bg-down/10",
            )}
          >
            <p role="status" className="flex min-w-0 items-start gap-2.5 text-sm">
              {healthy ? (
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-up" aria-hidden />
              ) : (
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-down" aria-hidden />
              )}
              <span className={healthy ? "text-ink-muted" : "text-ink"}>
                {healthy ? (
                  <>
                    {protectedCount > 0 ? `All ${plural(protectedCount, "value")} encrypted` : "Encryption is on"} with key{" "}
                    <span className="font-mono text-ink">{data.currentKeyId}</span>
                    {data.previousKey.configured && data.safeToRemovePreviousKey
                      ? ". MASTER_KEY_PREVIOUS is no longer needed and can be removed."
                      : "."}
                  </>
                ) : (
                  data.summary
                )}
              </span>
            </p>
            <button
              type="button"
              onClick={() => setExpanded(!open)}
              aria-expanded={open}
              aria-controls="encryption-details"
              className="inline-flex shrink-0 items-center gap-1 self-start rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink sm:self-auto"
            >
              {open ? "Hide details" : "Details"}
              <ChevronDown className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} />
            </button>
          </div>

          {open && (
            <div id="encryption-details" className="animate-enter space-y-5">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KeyVal
                  label="Current key id"
                  value={<span className="font-mono">{data.currentKeyId ?? "Not configured"}</span>}
                  valueClass={data.currentKeyId ? undefined : "text-down"}
                />
                <KeyVal
                  label="Previous key id"
                  value={
                    !data.previousKey.configured ? (
                      <span className="text-ink-muted">Not set</span>
                    ) : !data.previousKey.valid ? (
                      "Invalid"
                    ) : (
                      <span className="font-mono">{data.previousKey.keyId}</span>
                    )
                  }
                  valueClass={data.previousKey.configured && !data.previousKey.valid ? "text-down" : undefined}
                />
                <KeyVal
                  label="On previous key"
                  value={fmt(data.dependsOnPreviousKey)}
                  valueClass={data.dependsOnPreviousKey ? "text-degraded" : undefined}
                />
                <KeyVal
                  label="Unreadable"
                  value={fmt(data.unreadableCount)}
                  valueClass={data.unreadableCount ? "text-down" : undefined}
                />
              </div>

              <div>
                <h4 className="mb-2 text-xs font-medium text-ink-muted">Protected values</h4>
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {data.classes.map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                    >
                      <span className="text-sm text-ink">{c.label}</span>
                      <ClassCounts c={c} />
                    </li>
                  ))}
                </ul>
              </div>

              {data.unreadable.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-medium text-ink-muted">
                    Unreadable values (left unchanged; re-create or delete them)
                  </h4>
                  <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-down/40 text-sm">
                    {data.unreadable.map((u) => (
                      <li key={`${u.class}/${u.id}/${u.field}`} className="px-3 py-2">
                        <div className="text-ink">
                          {data.classes.find((c) => c.id === u.class)?.label ?? u.class}
                          <span className="text-ink-faint"> · {u.field}</span>
                        </div>
                        <div className="mt-0.5 font-mono text-xs break-all text-ink-faint">{u.id}</div>
                        <div className="mt-0.5 text-xs text-down">{UNREADABLE_REASONS[u.reason] ?? u.reason}</div>
                      </li>
                    ))}
                  </ul>
                  {data.unreadableCount > data.unreadable.length && (
                    <p className="mt-2 text-xs text-ink-faint">
                      Showing {data.unreadable.length} of {fmt(data.unreadableCount)}.
                    </p>
                  )}
                </div>
              )}

              {progress && (running || finished || passError) && (
                <div className="space-y-2">
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-surface-2"
                    role="progressbar"
                    aria-label="Re-encryption progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                  >
                    <div
                      className={cn("h-full rounded-full transition-[width] duration-300", passError ? "bg-down" : "bg-accent")}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="text-xs text-ink-muted">
                    {running
                      ? `Re-encrypting… ${progress.scanned.toLocaleString()} of ${progress.total.toLocaleString()} rows checked`
                      : finished
                        ? passSummary(progress)
                        : `Stopped after ${progress.scanned.toLocaleString()} rows. Running it again resumes safely.`}
                  </p>
                </div>
              )}
              {passError && <ErrorBanner>Re-encryption failed: {passError}</ErrorBanner>}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <PrimaryButton onClick={() => void reencrypt()} busy={running} disabled={blocked}>
                  {!running && <RefreshCw className="size-4" />}
                  Re-encrypt now
                </PrimaryButton>
                <a
                  href={RUNBOOK_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                >
                  How to rotate MASTER_KEY
                </a>
              </div>
              <p className="text-xs text-ink-faint">
                Re-encrypting is safe to repeat: it rewrites only values that are not yet on the current key, in small
                batches, and never changes a value it cannot read.
              </p>
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
}
