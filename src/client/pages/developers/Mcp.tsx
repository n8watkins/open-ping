import { useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Info } from "lucide-react";
import { cn } from "../../lib/cn";
import { useFetch } from "../../lib/useFetch";
import { claudeCodeCommand, claudeDesktopConfig, exportTokenLine, type McpScope } from "../../lib/dev-snippets";
import { Card, CardHeader, CardTitle } from "../../components/ui/Card";
import { CodeBlock } from "../../components/ui/CodeBlock";
import { CopyButton } from "../../components/ui/CopyButton";
import { Chip } from "../settings/shared";
import { useDevelopers } from "../Developers";

const DOCS = "https://github.com/n8watkins/open-ping/blob/main/docs/MCP.md";

const SCOPES: { id: McpScope; label: string; hint: string }[] = [
  { id: "local", label: "This project", hint: "Only in the folder you run it from, kept private to you." },
  { id: "user", label: "Every project", hint: "Available in every folder on this computer." },
];

/** Developers > MCP server: connect Claude Code, Claude Desktop or another client to /mcp. */
export default function McpPage() {
  const { fresh, origin } = useDevelopers();
  const token = fresh?.token ?? null;
  const [scope, setScope] = useState<McpScope>("local");
  const { data } = useFetch<{ tokens: unknown[]; secretConfigured: boolean }>("/api/api-tokens");
  const on = !!data && (data.tokens.length > 0 || data.secretConfigured);
  const endpoint = `${origin}/mcp`;

  return (
    <div className="stagger space-y-6 [&>*]:animate-enter">
      <Card className="p-5">
        <CardHeader>
          <CardTitle>MCP server</CardTitle>
          {data && <Chip tone={on ? "up" : "neutral"}>{on ? "On" : "Off until you create a token"}</Chip>}
        </CardHeader>
        <p className="-mt-1 mb-4 text-sm text-ink-muted">
          Let Claude, or any other Model Context Protocol client, read your monitors and incidents and manage them for you.
          It runs in this Worker, at no extra cost, and signs in with an{" "}
          <Link to="/developers/tokens" className="font-medium text-accent hover:underline">
            API token
          </Link>
          .
        </p>
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-xs text-ink-faint">Endpoint (Streamable HTTP)</div>
            <div className="truncate font-mono text-sm text-ink">{endpoint}</div>
          </div>
          <CopyButton text={endpoint} label="Copy URL" className="self-start sm:self-auto" />
        </div>
        {!token && (
          <p className="mt-3 flex items-start gap-2 text-xs text-ink-faint">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              The snippets below show <code className="font-mono">&lt;your API token&gt;</code>.{" "}
              <Link to="/developers/tokens" className="text-ink-muted underline underline-offset-2 hover:text-ink">
                Create a token
              </Link>{" "}
              and they fill it in.
            </span>
          </p>
        )}
      </Card>

      <Card className="p-5">
        <CardHeader>
          <CardTitle>Claude Code</CardTitle>
        </CardHeader>
        <fieldset className="mb-4">
          <legend className="mb-2 text-xs font-medium text-ink-muted">Where to add it</legend>
          <div className="inline-flex rounded-lg border border-line bg-surface-2/50 p-0.5">
            {SCOPES.map((s) => (
              <label
                key={s.id}
                className={cn(
                  "cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                  scope === s.id ? "bg-accent-soft text-ink shadow-sm" : "text-ink-muted hover:text-ink",
                )}
              >
                <input
                  type="radio"
                  name="mcp-scope"
                  value={s.id}
                  checked={scope === s.id}
                  onChange={() => setScope(s.id)}
                  className="sr-only"
                />
                {s.label}
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-ink-faint">{SCOPES.find((s) => s.id === scope)?.hint}</p>
        </fieldset>
        <CodeBlock label="Terminal" code={`${exportTokenLine(token)}\n${claudeCodeCommand(origin, scope)}`} />
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          Then run <code className="font-mono text-ink-muted">/mcp</code> in Claude Code to check that{" "}
          <code className="font-mono text-ink-muted">openping</code> is connected, and ask &ldquo;what&apos;s the status of
          my OpenPing?&rdquo;
        </p>
      </Card>

      <Card className="p-5">
        <CardHeader>
          <CardTitle>Claude Desktop</CardTitle>
        </CardHeader>
        <p className="-mt-1 mb-4 text-sm text-ink-muted">
          Add this to <code className="font-mono text-ink">claude_desktop_config.json</code> (Settings, Developer, Edit
          Config), then restart Claude Desktop. It reaches the server through the{" "}
          <code className="font-mono text-ink">mcp-remote</code> bridge, which needs Node.js.
        </p>
        <CodeBlock label="claude_desktop_config.json" code={claudeDesktopConfig(origin, token)} />
      </Card>

      <Card className="p-5">
        <CardHeader>
          <CardTitle>Other clients</CardTitle>
          <a
            href={DOCS}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
          >
            MCP guide
            <ExternalLink className="size-3" aria-hidden />
          </a>
        </CardHeader>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-ink-faint">URL</dt>
          <dd className="min-w-0 font-mono break-all text-ink">{endpoint}</dd>
          <dt className="text-ink-faint">Transport</dt>
          <dd className="text-ink">Streamable HTTP (sometimes called &ldquo;HTTP&rdquo;)</dd>
          <dt className="text-ink-faint">Header</dt>
          <dd className="min-w-0 font-mono break-all text-ink">Authorization: Bearer {token ?? "<your API token>"}</dd>
        </dl>
        <p className="mt-4 text-xs leading-relaxed text-ink-faint">
          OpenPing has no OAuth sign-in, so a client that can&apos;t send a custom header (such as a custom connector on the
          claude.ai website) can&apos;t connect.
        </p>
      </Card>
    </div>
  );
}
