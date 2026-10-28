import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, Copy, KeyRound } from "lucide-react";
import { Logo } from "../components/Logo";
import { useBootstrap } from "../lib/bootstrap";
import { isLandingInstall } from "../lib/home";
import { hostedOffer } from "../lib/hosted-offer";
import { setPageMeta } from "../lib/meta";
import { DEPLOY_BUTTON_URL, randomSecret } from "../lib/secrets";
import { track } from "../lib/track";

/**
 * /install: the guide to running OpenPing in your own Cloudflare account, the
 * Deploy to Cloudflare button first and the manual steps below it. Public, and
 * the same on every install. Each step is checked against the code
 * (package.json scripts, scripts/deploy.mjs, wrangler.jsonc,
 * src/worker/routes/auth.ts, the setup wizard) and mirrors docs/INSTALL.md,
 * which has the full detail.
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

/**
 * Makes MASTER_KEY and SETUP_TOKEN in the page, for the deploy form. Nothing is
 * stored or sent: the values live in this component until the page closes.
 */
function SecretGenerator() {
  const [secrets, setSecrets] = useState<{ masterKey: string; setupToken: string } | null>(null);
  return (
    <div id="generate" className="scroll-mt-6 rounded-lg border border-line bg-canvas p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-semibold text-ink">Make your two secrets</p>
        <button
          type="button"
          onClick={() => setSecrets({ masterKey: randomSecret(), setupToken: randomSecret() })}
          className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-semibold text-ink hover:border-accent"
        >
          <KeyRound className="size-4" />
          {secrets ? "Make new ones" : "Generate"}
        </button>
      </div>
      {secrets ? (
        <>
          <p className="mt-3 text-xs font-medium text-ink-faint">MASTER_KEY</p>
          <Code>{secrets.masterKey}</Code>
          <p className="mt-3 text-xs font-medium text-ink-faint">SETUP_TOKEN</p>
          <Code>{secrets.setupToken}</Code>
        </>
      ) : null}
      <p className="mt-3">
        Made in your browser and sent nowhere; <C>openssl rand -base64 32</C> makes the same kind of value.{" "}
        <strong className="font-semibold text-ink">Save both in your password manager before you deploy:</strong>{" "}
        Cloudflare never shows a secret again, and the master key is the only key to your encrypted data.
      </p>
    </div>
  );
}

const C = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink">{children}</code>
);

export default function Install() {
  const { status } = useBootstrap();
  const landing = isLandingInstall(status);
  const offer = hostedOffer(status);
  useEffect(() => {
    setPageMeta({
      title: "Set up OpenPing in your own Cloudflare account",
      description: "One button, or about 15 minutes by hand: run OpenPing free in your own Cloudflare account.",
    });
  }, []);
  useEffect(() => {
    if (landing) track("install_view");
  }, [landing]);

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
          You need a free Cloudflare account and a GitHub account. Everything runs in your account; nothing goes through
          mine.
        </p>

        <section className="mt-8 rounded-card border border-accent/40 bg-surface p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-ink">The quick way: Deploy to Cloudflare</h2>
          <div className="mt-3 space-y-4 text-sm leading-relaxed text-ink-muted">
            <p>
              One button copies OpenPing into a new repository in your GitHub account, creates the database and deploys
              it, in about 5 minutes and without a terminal. Its form asks for <C>MASTER_KEY</C> and <C>SETUP_TOKEN</C>,
              so make them first.
            </p>
            <SecretGenerator />
            <a
              href={DEPLOY_BUTTON_URL}
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                if (landing) track("install_deploy");
              }}
              className="inline-block"
            >
              <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" width={184} height={39} />
            </a>
            <div>
              <p className="font-semibold text-ink">When the build finishes</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>
                  Open your new address. The setup page asks for your <C>SETUP_TOKEN</C> and your timezone, and has you
                  create a passkey, the way you&apos;ll sign in.
                </li>
                <li>Sign in with your passkey and add your sites.</li>
                <li>
                  Optional: to also sign in with GitHub, create a GitHub sign-in app (step 5 below) and add its Client ID
                  and Client Secret in the Cloudflare dashboard (your Worker, Settings, Variables and Secrets) as{" "}
                  <C>GITHUB_CLIENT_ID</C> and <C>GITHUB_CLIENT_SECRET</C>.
                </li>
              </ol>
            </div>
            <p>
              Your copy deploys again whenever you push to it. To upgrade, pull this repository's changes into it and
              push; the{" "}
              <a href={`${REPO}/blob/main/docs/UPGRADE.md`} target="_blank" rel="noreferrer" className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-accent">
                upgrade guide
              </a>{" "}
              has the commands.
            </p>
          </div>
        </section>

        <h2 className="mt-12 text-2xl font-semibold tracking-tight">Or set it up by hand</h2>
        <p className="mt-2 text-base leading-relaxed text-ink-muted">
          About 15 minutes the first time, with Node 20 or newer and git.
        </p>

        <ol className="mt-6 space-y-4">
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

          <Step n={3} title="Add the two required secrets">
            <p>
              <C>MASTER_KEY</C> encrypts stored credentials; <C>SETUP_TOKEN</C> protects the first-run setup until you've
              claimed the install. Generate each with <C>openssl rand -base64 32</C> (or the generator above) and keep a
              copy of both. The first command offers to create the Worker; say yes.
            </p>
            <Code>{"npx wrangler secret put MASTER_KEY\nnpx wrangler secret put SETUP_TOKEN"}</Code>
          </Step>

          <Step n={4} title="Deploy">
            <Code>npm run deploy</Code>
            <p>
              It builds, creates the database the first time, sets up its tables and deploys, then prints your address,
              like <C>https://open-ping.your-name.workers.dev</C>. The checks start on their own every 12 minutes.
            </p>
          </Step>

          <Step n={5} title="Optional: add GitHub sign-in">
            <p>
              A passkey is enough to sign in, so you can skip this. To also sign in with GitHub, open GitHub Settings,
              Developer settings, OAuth Apps, New OAuth App. Use your address from step 4 as the homepage, and this as the
              callback URL:
            </p>
            <Code>https://YOUR-ADDRESS/auth/github/callback</Code>
            <p>Then add its Client ID and a new Client Secret:</p>
            <Code>{"npx wrangler secret put GITHUB_CLIENT_ID\nnpx wrangler secret put GITHUB_CLIENT_SECRET"}</Code>
          </Step>

          <Step n={6} title="Finish setup in the browser">
            <p>
              Open your address. The setup screen asks for your <C>SETUP_TOKEN</C>, then your address and your timezone,
              and has you create a passkey, the way you&apos;ll sign in. You can add a GitHub username or an email address
              too. When you finish, setup locks.
            </p>
          </Step>

          <Step n={7} title="Sign in and add your sites">
            <p>
              Sign in with your passkey, add monitors (HTTP, heartbeat, DNS, TCP or domain expiry), and set up alerts under
              Integrations: email, Web Push, Slack, Microsoft Teams, Discord, Telegram or a webhook.
            </p>
          </Step>

          <Step n={8} title="Optional extras">
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Email alerts and magic-link sign-in: add a <C>RESEND_API_KEY</C> from Resend.
              </li>
              <li>
                Your own domain: add it to the Worker in Cloudflare and update your address (and the GitHub app, if you
                use one). Passkeys belong to one address, so add new ones there.
              </li>
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
          {offer.open ? (
            <a href={offer.signupUrl} className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-accent">
              Start a free trial of OpenPing Hosted
            </a>
          ) : (
            <Link to="/#pricing" className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-accent">
              Join the Hosted waitlist
            </Link>
          )}
          .
        </p>
      </main>
    </div>
  );
}
