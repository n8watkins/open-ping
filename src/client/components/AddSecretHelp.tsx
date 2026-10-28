/**
 * How to add a missing required Worker secret, shown by the setup wizard. An
 * install from the Deploy to Cloudflare button may have skipped one in the
 * deploy form, and its owner may have no terminal, so the dashboard path
 * comes first (docs/INSTALL.md, "The quick way").
 */
export function AddSecretHelp({ name }: { name: "MASTER_KEY" | "SETUP_TOKEN" }) {
  const code = "rounded bg-surface-2 px-1 py-0.5 text-xs text-ink";
  return (
    <div className="mt-4 rounded-lg border border-line bg-surface-2/50 px-3 py-3 text-sm text-ink-muted">
      <p className="font-medium text-ink">
        Add <code className={code}>{name}</code> to this Worker
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        <li>
          Make a value with <code className={code}>openssl rand -base64 32</code>, or the generator at{" "}
          <a
            href="https://openping.n8builds.dev/install#generate"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-ink underline decoration-line underline-offset-4 hover:decoration-accent"
          >
            openping.n8builds.dev/install
          </a>
          , and save it in your password manager.
        </li>
        <li>
          In the Cloudflare dashboard, open Workers &amp; Pages, this Worker, Settings, Variables and Secrets. Choose
          Add, type Secret, name it <code className={code}>{name}</code>, paste the value and deploy.
        </li>
        <li>Reload this page.</li>
      </ol>
      <p className="mt-2 text-xs text-ink-faint">
        From a terminal instead: <code className={code}>npx wrangler secret put {name}</code>
      </p>
    </div>
  );
}
