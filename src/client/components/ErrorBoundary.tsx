import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../lib/error-reporting";
import { EdgePage, primaryAction, secondaryAction } from "./EdgePage";

/**
 * The app's last line of defence: a render error anywhere shows this page
 * (with Try again) instead of a blank screen, and is reported to Sentry when
 * the install has a DSN (lib/error-reporting.ts).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
    reportError(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <EdgePage
        label="Something went wrong"
        title="This page didn't load."
        actions={
          <>
            <button type="button" className={primaryAction} onClick={() => window.location.reload()}>
              Try again
            </button>
            <a href="/" className={secondaryAction}>
              Go to the home page
            </a>
          </>
        }
      >
        Monitoring keeps running on Cloudflare either way; this was a problem in the page.
      </EdgePage>
    );
  }
}
