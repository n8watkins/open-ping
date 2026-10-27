import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { Logo } from "../components/Logo";

/**
 * /install: the step-by-step guide to running OpenPing in your own Cloudflare
 * account. Public, and the same on every install. Each step is checked against
 * the code (package.json scripts, wrangler.jsonc, src/worker/routes/auth.ts, the
 * setup wizard) and mirrors docs/INSTALL.md, which has the full detail.
 */

const REPO = "https://github.com/n8watkins/open-ping";
const INSTALL_DOC = `${REPO}/blob/main/docs/INSTALL.md`;

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative mt-3 overflow-hidden rounded-lg border border-line bg-canvas">
      <pre className="overflow-x-auto px-4 py-3 pr-12 text-sm leading-relaxed text-ink-muted">
        <code>{children}</code>
      </pre>
      <button
        type="button"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(children).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute top-2 right-2 grid size-8 place-items-center rounded-md border border-line bg-surface text-ink-faint hover:text-ink"
      >
        {copied ? <Check className="size-4 text-up" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="relative rounded-card border border-line bg-surface p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-sm font-bold text-canvas">{n}</span>
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
      </div>
      <div className="mt-3 space-y-2 text-sm leading-relaxed text-ink-muted">{children}</div>
    </li>
  );
}

const C = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink">{children}</code>
);

export default function Install() {
  useEffect(() => {
    document.title = "Set up OpenPing in your own Cloudflare account";
  }, []);

  return (
    <div className="min-h-full bg-canvas text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/" className="inline-flex items-center gap-2 text-sm text-ink-muted hover:text-ink">
            <ArrowLeft className="size-4" />
            <Logo />
          </Link>
          <a href={INSTALL_DOC} target="_blank" rel="noreferrer" className="text-sm font-semibold text-ink-muted hover:text-ink">
            Full guide on GitHub
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <p className="text-xs font-semibold tracking-widest text-accent uppercase">Set it up</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Run OpenPing in your own Cloudflare account</h1>
        <p className="mt-4 text-base leading-relaxed text-ink-muted">
          About 20 minutes the first time. You need Node 20 or newer, git, a free Cloudflare account and a GitHub account.
          Everything runs in your account; nothing goes through mine.
        </p>

        <ol className="mt-8 space-y-4">
          <Step n={1} title="Get the code">
            <p>Fork the repository on GitHub if you want your own copy to change, or just clone it.</p>
            <Code>{`git clone ${REPO}.git\ncd open-ping\nnpm install`}</Code>
            <p>
              On npm 12, use <C>npm install --allow-git=root</C>: one development tool is installed from GitHub.
            </p>
          </Step>

          <Step n={2} title="Sign in to Cloudflare">
            <p>This opens your browser once to connect the command line to your account.</p>
            <Code>npx wrangler login</Code>
          </Step>

          <Step n={3} title="Create the database">
            <Code>npm run db:create</Code>
            <p>
              It prints a <C>database_id</C>. Paste it into <C>wrangler.jsonc</C> in place of{" "}
              <C>REPLACE_WITH_YOUR_D1_DATABASE_ID</C>.
            </p>
          </Step>

          <Step n={4} title="Set up the tables">
            <Code>npm run db:migrate</Code>
          </Step>

          <Step n={5} title="Add the two required secrets">
            <p>
              <C>MASTER_KEY</C> encrypts stored credentials; <C>SETUP_TOKEN</C> protects the first-run setup until you've
              claimed the install. Generate each with <C>openssl rand -base64 32</C> and keep a copy of the master key.
            </p>
            <Code>{"npx wrangler secret put MASTER_KEY\nnpx wrangler secret put SETUP_TOKEN"}</Code>
          </Step>

          <Step n={6} title="Deploy">
            <Code>npm run deploy</Code>
            <p>
              It prints your address, like <C>https://open-ping.your-name.workers.dev</C>. The checks start on their own
              every 12 minutes.
            </p>
          </Step>

          <Step n={7} title="Create a GitHub sign-in app">
            <p>
              On GitHub, open Settings, Developer settings, OAuth Apps, New OAuth App. Use your address from step 6 as the
              homepage, and this as the callback URL:
            </p>
            <Code>https://YOUR-ADDRESS/auth/github/callback</Code>
            <p>Then add its Client ID and a new Client Secret:</p>
            <Code>{"npx wrangler secret put GITHUB_CLIENT_ID\nnpx wrangler secret put GITHUB_CLIENT_SECRET"}</Code>
          </Step>

          <Step n={8} title="Finish setup in the browser">
            <p>
              Open your address. The setup screen asks for your <C>SETUP_TOKEN</C>, then your address, your timezone and
              your GitHub username (the only account that can sign in). When you finish, setup locks.
            </p>
          </Step>

          <Step n={9} title="Sign in and add your sites">
            <p>
              Sign in with GitHub, add monitors (HTTP, heartbeat, DNS, TCP or domain expiry), and set up alerts under
              Integrations: email, Web Push, Discord or a webhook.
            </p>
          </Step>

          <Step n={10} title="Optional extras">
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Email alerts and magic-link sign-in: add a <C>RESEND_API_KEY</C> from Resend.
              </li>
              <li>Your own domain: add it to the Worker in Cloudflare, then update the GitHub app and your address.</li>
              <li>
                On Cloudflare's paid Workers plan, set <C>WORKERS_PLAN</C> to <C>paid</C> in <C>wrangler.jsonc</C> to
                check more monitors per run.
              </li>
            </ul>
          </Step>
        </ol>

        <p className="mt-8 text-sm text-ink-muted">
          Stuck? The{" "}
          <a href={INSTALL_DOC} target="_blank" rel="noreferrer" className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-accent">
            full guide
          </a>{" "}
          covers every secret and the common problems. Would rather not run it yourself?{" "}
          <Link to="/#pricing" className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-accent">
            Join the Hosted waitlist
          </Link>
          .
        </p>
      </main>
    </div>
  );
}
