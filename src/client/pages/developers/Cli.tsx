import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { opEnvFile } from "../../lib/dev-snippets";
import { Card, CardHeader, CardTitle } from "../../components/ui/Card";
import { CodeBlock } from "../../components/ui/CodeBlock";
import { CopyButton } from "../../components/ui/CopyButton";
import { useDevelopers } from "../Developers";

const DOCS = "https://github.com/n8watkins/open-ping/blob/main/docs/CLI.md";

/** The commands most worth knowing (docs/CLI.md has every one). */
const COMMANDS: { cmd: string; what: string }[] = [
  { cmd: "op status", what: "Every monitor's state, latency and 24h uptime, open incidents and the last run" },
  { cmd: "op monitors list", what: "Monitors with id, type, schedule and target" },
  { cmd: 'op monitors create --name "My App" --url https://my-app.example.com/health', what: "An HTTP monitor, checked around the clock" },
  { cmd: "op monitors pause <id>", what: "Pause checks and alerts (resume brings them back)" },
  { cmd: "op incidents list --status open", what: "Open incidents, newest first" },
  {
    cmd: 'op incidents update <id> --status identified --message "Rolling back"',
    what: "Post a status update to the public timeline and alert channels",
  },
  { cmd: "op maintenance create --title Deploy --duration 30", what: "Thirty minutes of maintenance, starting now" },
  { cmd: "op report --month 2026-09 --csv", what: "A month's uptime report as CSV" },
  { cmd: "op diagnostics --runs 5", what: "The last scheduler runs and table counts" },
];

/** Developers > CLI: scripts/op.mjs, configured with this install's address. */
export default function CliPage() {
  const { fresh, origin } = useDevelopers();
  return (
    <div className="stagger space-y-6 [&>*]:animate-enter">
      <Card className="p-5">
        <CardHeader>
          <CardTitle>CLI</CardTitle>
          <a
            href={DOCS}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
          >
            Full command list
            <ExternalLink className="size-3" aria-hidden />
          </a>
        </CardHeader>
        <p className="-mt-1 mb-5 text-sm text-ink-muted">
          <code className="font-mono text-ink">scripts/op.mjs</code> in the OpenPing repository runs this install from a
          terminal or a script. It needs only Node 20 or later, and prints tables, or JSON with{" "}
          <code className="font-mono text-ink">--json</code>.
        </p>
        <ol className="space-y-5">
          <Step n={1} title="Get the CLI">
            <CodeBlock label="Terminal" code={"git clone https://github.com/n8watkins/open-ping.git\ncd open-ping"} />
          </Step>
          <Step n={2} title="Point it at this install">
            <p className="mb-2 text-sm text-ink-muted">
              Save this as <code className="font-mono text-ink">.op.env</code> in the checkout (it&apos;s gitignored), then
              run <code className="font-mono text-ink">chmod 600 .op.env</code>.
            </p>
            <CodeBlock label=".op.env" code={opEnvFile(origin, fresh?.token ?? null)} />
          </Step>
          <Step n={3} title="Run a command">
            <CodeBlock label="Terminal" code="node scripts/op.mjs status" />
          </Step>
        </ol>
      </Card>

      <Card className="p-5">
        <CardHeader>
          <CardTitle>Common commands</CardTitle>
        </CardHeader>
        <p className="-mt-1 mb-4 text-sm text-ink-muted">
          <code className="font-mono text-ink">op</code> is short for <code className="font-mono text-ink">node scripts/op.mjs</code>{" "}
          (or <code className="font-mono text-ink">npm run op --</code>). Add <code className="font-mono text-ink">--help</code>{" "}
          to any command for its flags.
        </p>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {COMMANDS.map((c) => {
            const full = c.cmd.replace(/^op /, "node scripts/op.mjs ");
            return (
              <li key={c.cmd} className="flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-surface-2/30">
                <div className="min-w-0 flex-1">
                  <code className="block overflow-x-auto font-mono text-[12.5px] whitespace-nowrap text-ink">{c.cmd}</code>
                  <span className="mt-0.5 block text-xs text-ink-faint">{c.what}</span>
                </div>
                <CopyButton text={full} compact ariaLabel={`Copy ${c.cmd}`} />
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3">
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-full border border-line bg-surface-2 text-xs font-semibold text-ink-muted"
      >
        {n}
      </span>
      <div className="min-w-0">
        <h4 className="mb-2 pt-1 text-sm font-medium text-ink">{title}</h4>
        {children}
      </div>
    </li>
  );
}
