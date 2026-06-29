import { Github, Mail } from "lucide-react";
import { Logo } from "../components/Logo";

export default function Login() {
  return (
    <div className="grid min-h-full place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>

        <div className="rounded-card border border-line bg-surface p-6">
          <h1 className="text-center text-lg font-semibold tracking-tight">
            Sign in
          </h1>
          <p className="mt-1 text-center text-sm text-ink-muted">
            OpenPing is single-administrator. Only the configured identity can
            sign in.
          </p>

          <div className="mt-6 space-y-3">
            <a
              href="/auth/github/start"
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-canvas transition-opacity hover:opacity-90"
            >
              <Github className="size-4" />
              Continue with GitHub
            </a>
            <button
              type="button"
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-line"
            >
              <Mail className="size-4" />
              Email magic link
            </button>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-ink-faint">
          Self-hosted on your own Cloudflare account.
        </p>
      </div>
    </div>
  );
}
