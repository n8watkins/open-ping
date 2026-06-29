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
  githubEnabled: boolean;
  githubAdminConfigured: boolean;
  emailAdminConfigured: boolean;
}

export interface Me {
  authenticated: boolean;
  identity?: string;
  identityKind?: "github" | "email";
  csrf?: string;
  expiresAt?: number;
}

interface BootstrapValue {
  loading: boolean;
  status: AuthStatus | null;
  me: Me | null;
  /** CSRF token for mutations, when authenticated. */
  csrf: string | null;
  refresh: () => Promise<void>;
}

const BootstrapContext = createContext<BootstrapValue | null>(null);

export function BootstrapProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([
        api<AuthStatus>("/api/auth/status"),
        api<Me>("/api/auth/me"),
      ]);
      setStatus(s);
      setMe(m);
    } catch {
      // Leave nulls; gate will treat as unauthenticated.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <BootstrapContext.Provider
      value={{ loading, status, me, csrf: me?.csrf ?? null, refresh }}
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
