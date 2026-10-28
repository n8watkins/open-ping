import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { api } from "./api";

export interface AuthStatus {
  setupComplete: boolean;
  encryptionConfigured: boolean;
  githubEnabled: boolean;
  githubAdminConfigured: boolean;
  emailAdminConfigured: boolean;
  /** Whether at least one passkey exists (optional for an older Worker). */
  passkeyConfigured?: boolean;
  /** The hostname passkeys are bound to (the install's configured address). */
  passkeyRpId?: string;
  /** The install's address, where passkeys work. */
  passkeyOrigin?: string;
  /**
   * What `/` shows a signed-out visitor (the HOME_PAGE var): "landing" only on
   * the canonical install. Optional so an older Worker without it still works.
   */
  homePage?: "status" | "landing";
  /** Whether this install collects the Hosted waitlist (WAITLIST_ENABLED). */
  waitlistEnabled?: boolean;
  /**
   * Present only when this OpenPing runs on OpenPing Hosted, which sets it up
   * and signs its customer in (docs/hosted/CONTRACT.md).
   */
  hosted?: { signInUrl: string };
}

/** The OpenPing Hosted account a signed-in customer sees in Settings (hosted mode only). */
export interface HostedAccount {
  slug: string;
  plan: "trial" | "hosted" | "hosted_fast";
  status: "trial" | "active" | "past_due" | "suspended";
  /** End of the trial (epoch ms) while the status is "trial". */
  trialEndsAt: number | null;
  accountUrl: string;
  billingUrl: string;
  upgradeUrl: string;
  signOutUrl: string;
}

export interface Me {
  authenticated: boolean;
  identity?: string;
  identityKind?: "github" | "email" | "passkey" | "hosted" | "hosted_support";
  csrf?: string;
  expiresAt?: number;
  /** Hosted mode only. */
  hosted?: HostedAccount;
}

interface BootstrapValue {
  loading: boolean;
  status: AuthStatus | null;
  me: Me | null;
  /** CSRF token for mutations, when authenticated. */
  csrf: string | null;
  /** Non-null when the bootstrap fetch failed (vs. a genuine unauthenticated state). */
  error: string | null;
  refresh: () => Promise<void>;
}

const BootstrapContext = createContext<BootstrapValue | null>(null);

export function BootstrapProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([
        api<AuthStatus>("/api/auth/status"),
        api<Me>("/api/auth/me"),
      ]);
      setStatus(s);
      setMe(m);
      setError(null);
    } catch (e) {
      // Capture the failure instead of swallowing it: a transient status fetch
      // error must be distinguishable from a genuinely provider-less install,
      // otherwise Login renders every sign-in option as disabled. Left
      // un-cleared at the start of refresh so a retry keeps the error visible
      // until it actually succeeds.
      setError(e instanceof Error ? e.message : "Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <BootstrapContext.Provider
      value={{ loading, status, me, csrf: me?.csrf ?? null, error, refresh }}
    >
      {children}
    </BootstrapContext.Provider>
  );
}

export function useBootstrap(): BootstrapValue {
  const ctx = useContext(BootstrapContext);
  if (!ctx) throw new Error("useBootstrap must be used within BootstrapProvider");
  return ctx;
}
