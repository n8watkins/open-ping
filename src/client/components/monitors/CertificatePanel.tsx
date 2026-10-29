import { useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, ShieldOff } from "lucide-react";
import { Card, CardHeader, CardTitle } from "../ui/Card";
import { cn } from "../../lib/cn";
import { formatDateTime, formatRelativeTime } from "../../lib/format";
import { certLookupFailure, daysLeftLabel, type CertificateDetail } from "./certificate";

/** How many names show before "Show all". */
const NAMES_SHOWN = 8;

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs text-ink-muted sm:text-sm">{label}</dt>
      <dd className={cn("min-w-0 break-words text-sm text-ink", mono && "font-mono text-[13px]")}>{children}</dd>
    </div>
  );
}

const longDate = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/**
 * The SSL certificate monitor's last read (GET /api/monitors/:id/detail
 * `certificate`): issuer, validity, days left and the names it covers, or why
 * it can't be read from a Worker.
 */
export function CertificatePanel({
  detail,
  warnDays,
}: {
  detail: CertificateDetail | null | undefined;
  warnDays: number[];
}) {
  const [allNames, setAllNames] = useState(false);
  const thresholds = warnDays.length ? `Warns at ${warnDays.join(", ")} days` : null;

  if (!detail) {
    return (
      <Card className="mt-4">
        <CardHeader className="mb-1">
          <CardTitle as="h2">Certificate</CardTitle>
          {thresholds && <span className="text-xs text-ink-faint">{thresholds}</span>}
        </CardHeader>
        <p className="text-sm text-ink-muted">Not read yet. The first read shows up here.</p>
      </Card>
    );
  }

  const read = (
    <span className="text-xs text-ink-faint" title={formatDateTime(detail.checkedAt)}>
      Read {formatRelativeTime(detail.checkedAt)}
    </span>
  );
  const failure = detail.lookupError && (
    <p className="mt-3 flex items-start gap-2 rounded-lg border border-degraded/40 bg-degraded/10 px-3 py-2 text-xs text-degraded">
      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        The last read failed ({certLookupFailure(detail.lookupError.code)}), so this is the one from{" "}
        {formatRelativeTime(detail.checkedAt)}.
      </span>
    </p>
  );

  if (detail.cantCheck) {
    return (
      <Card className="mt-4">
        <CardHeader className="mb-2">
          <CardTitle as="h2">Certificate</CardTitle>
          {read}
        </CardHeader>
        <div className="flex items-start gap-3 rounded-lg border border-line bg-surface-2/50 p-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-surface text-paused">
            <ShieldOff className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Can't check this certificate from here</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-muted">{detail.cantCheck.message}</p>
            <p className="mt-2 text-xs text-ink-faint">
              This isn't an outage: the monitor stays neutral, opens no incident and sends no alert.
            </p>
          </div>
        </div>
        {failure}
      </Card>
    );
  }

  const cert = detail.certificate;
  if (!cert) return null;
  const expired = cert.validTo <= Date.now();
  const soon = !expired && warnDays.length > 0 && cert.daysUntil <= Math.max(...warnDays);
  const names = allNames ? cert.sans : cert.sans.slice(0, NAMES_SHOWN);
  const notStored = cert.sanCount - cert.sans.length;

  return (
    <Card className="mt-4">
      <CardHeader className="mb-1">
        <CardTitle as="h2">Certificate</CardTitle>
        {read}
      </CardHeader>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={cn(
            "text-2xl font-semibold tabular-nums tracking-tight",
            expired ? "text-down" : soon ? "text-degraded" : "text-ink",
          )}
        >
          {daysLeftLabel(cert.daysUntil, expired)}
        </span>
        <span className="text-sm text-ink-muted">
          {expired ? "on" : "Expires"} {longDate(cert.validTo)}
        </span>
      </div>
      {thresholds && <p className="mt-1 text-xs text-ink-faint">{thresholds}</p>}
      {!cert.coversHost && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            This certificate doesn't list {detail.host}, so browsers will refuse it for that name.
          </span>
        </p>
      )}
      {failure}
      <dl className="mt-3 divide-y divide-line border-t border-line">
        <Row label="Issuer">{cert.issuer ?? "-"}</Row>
        <Row label="Issued to">{cert.subject ?? "-"}</Row>
        <Row label="Valid from">{formatDateTime(cert.validFrom)}</Row>
        <Row label="Valid to">{formatDateTime(cert.validTo)}</Row>
        <Row label={cert.sanCount === 1 ? "Name" : `Names (${cert.sanCount})`}>
          {cert.sans.length === 0 ? (
            "-"
          ) : (
            <>
              <ul className="flex flex-wrap gap-1.5">
                {names.map((n) => (
                  <li
                    key={n}
                    className="max-w-full truncate rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-xs text-ink"
                    title={n}
                  >
                    {n}
                  </li>
                ))}
              </ul>
              {cert.sans.length > NAMES_SHOWN && (
                <button
                  type="button"
                  onClick={() => setAllNames((v) => !v)}
                  aria-expanded={allNames}
                  className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-accent hover:underline"
                >
                  <ChevronDown className={cn("size-3.5 transition-transform", allNames && "rotate-180")} aria-hidden />
                  {allNames ? "Show fewer" : `Show all ${cert.sans.length}`}
                </button>
              )}
              {allNames && notStored > 0 && (
                <p className="text-xs text-ink-faint">and {notStored} more</p>
              )}
            </>
          )}
        </Row>
        <Row label="Serial number" mono>
          {cert.serial}
        </Row>
      </dl>
    </Card>
  );
}
