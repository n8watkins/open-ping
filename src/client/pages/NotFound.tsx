import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="grid min-h-full place-items-center px-4 text-center">
      <div>
        <div className="text-5xl font-semibold tracking-tight text-ink-faint">404</div>
        <p className="mt-3 text-sm text-ink-muted">This page doesn't exist.</p>
        <Link
          to="/"
          className="mt-6 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover"
        >
          Back to overview
        </Link>
      </div>
    </div>
  );
}
