import { Link } from "react-router-dom";
import { ArrowRight, ExternalLink } from "lucide-react";
import { Card, CardHeader, CardTitle } from "../../components/ui/Card";
import { CodeBlock } from "../../components/ui/CodeBlock";

const DOCS = "https://github.com/n8watkins/open-ping/blob/main/docs/ALERT_CHANNELS.md#webhook";

const EVENTS = [
  "down",
  "recovered",
  "heartbeat_missed",
  "flapping",
  "degraded",
  "maintenance_start",
  "maintenance_end",
  "incident_update",
  "weekly",
  "test",
];

const PAYLOAD = `{
  "event": "down",
  "monitorId": "mon_abc123",
  "monitorName": "Checkout API",
  "state": "down",
  "title": "🔴 Checkout API is down",
  "body": "Checkout API is down (HTTP 503).",
  "url": "https://status.example.com/monitors/mon_abc123",
  "statusCode": 503,
  "error": "HTTP 503",
  "detectedAt": 1793196300000,
  "durationSeconds": null,
  "incidentId": "inc_def456"
}`;

const VERIFY = `import { createHmac, timingSafeEqual } from "node:crypto";

// req.body must be the raw request body, exactly as received.
export function verifyOpenPing(rawBody, headers, secret) {
  const timestamp = headers["x-openping-timestamp"];
  const signature = headers["x-openping-signature"] ?? "";
  // Refuse old deliveries, so a captured request can't be replayed.
  if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(\`\${timestamp}.\${rawBody}\`).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}`;

/** Developers > Webhooks: what a webhook channel sends, and how to check it came from OpenPing. */
export default function WebhooksPage() {
  return (
    <div className="stagger space-y-6 [&>*]:animate-enter">
      <Card className="p-5">
        <CardHeader>
          <CardTitle>Webhooks</CardTitle>
          <a
            href={DOCS}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
          >
            Full reference
            <ExternalLink className="size-3" aria-hidden />
          </a>
        </CardHeader>
        <p className="-mt-1 mb-4 text-sm text-ink-muted">
          A webhook channel POSTs every alert to your URL as JSON, so your own code can open a ticket, page someone or post
          anywhere OpenPing doesn&apos;t reach. Deliveries that fail are retried, so drop duplicates by{" "}
          <code className="font-mono text-ink">incidentId</code> and <code className="font-mono text-ink">event</code>.
        </p>
        <Link
          to="/alerts"
          className="group inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-muted transition-colors hover:border-accent/40 hover:text-ink"
        >
          Add a webhook channel in Alerts
          <ArrowRight aria-hidden className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
        </Link>
      </Card>

      <Card className="p-5">
        <CardHeader>
          <CardTitle>Payload</CardTitle>
        </CardHeader>
        <p className="-mt-1 mb-3 text-sm text-ink-muted">
          <code className="font-mono text-ink">Content-Type: application/json</code>. The{" "}
          <code className="font-mono text-ink">event</code> is one of:
        </p>
        <ul className="mb-4 flex flex-wrap gap-1.5">
          {EVENTS.map((e) => (
            <li key={e} className="rounded-md border border-line bg-surface-2/60 px-1.5 py-0.5 font-mono text-xs text-ink-muted">
              {e}
            </li>
          ))}
        </ul>
        <CodeBlock label="Example body" code={PAYLOAD} />
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          Times are milliseconds since 1970. An <code className="font-mono">incident_update</code> adds an{" "}
          <code className="font-mono">update</code> object with its id, status, label, message and time.
        </p>
      </Card>

      <Card className="p-5">
        <CardHeader>
          <CardTitle>Verifying the signature</CardTitle>
        </CardHeader>
        <p className="-mt-1 mb-4 text-sm text-ink-muted">
          Give the channel a signing secret and every request carries two headers:
        </p>
        <dl className="mb-4 space-y-2 text-sm">
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
            <dt className="shrink-0 font-mono text-ink sm:w-52">X-OpenPing-Timestamp</dt>
            <dd className="text-ink-muted">When it was sent, in milliseconds</dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
            <dt className="shrink-0 font-mono text-ink sm:w-52">X-OpenPing-Signature</dt>
            <dd className="text-ink-muted">
              <code className="font-mono">sha256=</code> and the hex HMAC-SHA256 of{" "}
              <code className="font-mono">&lt;timestamp&gt;.&lt;body&gt;</code>, keyed with your secret
            </dd>
          </div>
        </dl>
        <CodeBlock label="verify.mjs (Node.js)" code={VERIFY} />
      </Card>
    </div>
  );
}
