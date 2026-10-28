/**
 * Sign-in with GitHub (OAuth app, web flow):
 * https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 *
 * The state is random, kept in a ceremony bound to this browser, and checked
 * before the code is exchanged. The account is matched by GitHub user id,
 * and a new GitHub sign-in is joined to an existing account only by an email
 * GitHub says is the user's verified primary address.
 */

import { randomToken } from "../../../src/worker/lib/ids";
import { normalizeEmail } from "../accounts";

const AUTHORIZE = "https://github.com/login/oauth/authorize";
const TOKEN = "https://github.com/login/oauth/access_token";
const USER = "https://api.github.com/user";
const EMAILS = "https://api.github.com/user/emails";
const UA = "openping-platform";

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
}

export function githubConfig(env: { GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string }): GithubConfig | null {
  return env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } : null;
}

export const newOAuthState = () => randomToken(24);

export function authorizeUrl(config: GithubConfig, input: { redirectUri: string; state: string }): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", input.state);
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

export interface GithubUser {
  /** GitHub's numeric user id, as text: stable across renames. */
  id: string;
  login: string;
  /** The verified primary address, lowercased; null when GitHub has none. */
  email: string | null;
}

export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubError";
  }
}

async function getJson<T>(fetcher: typeof fetch, url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new GithubError(`no answer from ${new URL(url).host}`);
  }
  if (!res.ok) throw new GithubError(`${new URL(url).pathname} answered ${res.status}`);
  return (await res.json()) as T;
}

/** Exchanges the callback's code and reads who signed in. */
export async function fetchGithubUser(
  config: GithubConfig,
  input: { code: string; redirectUri: string },
  fetcher: typeof fetch = (i, init) => fetch(i, init),
): Promise<GithubUser> {
  const token = await getJson<{ access_token?: string; error?: string }>(fetcher, TOKEN, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code: input.code, redirect_uri: input.redirectUri }),
  });
  if (!token.access_token) throw new GithubError(`token exchange refused: ${token.error ?? "no token"}`);
  const headers = { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": UA };
  const [user, emails] = await Promise.all([
    getJson<{ id?: number; login?: string }>(fetcher, USER, { headers }),
    getJson<{ email?: string; primary?: boolean; verified?: boolean }[]>(fetcher, EMAILS, { headers }),
  ]);
  if (!Number.isSafeInteger(user.id) || typeof user.login !== "string") throw new GithubError("unexpected user answer");
  const primary = Array.isArray(emails) ? emails.find((e) => e.primary === true && e.verified === true) : undefined;
  return { id: String(user.id), login: user.login, email: normalizeEmail(primary?.email) };
}
