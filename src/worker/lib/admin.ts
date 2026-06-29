import type { Env } from "../types";
import { getSetting } from "../db/settings";

/**
 * The single administrator allowlist (PRD §13). Identity may be provided as a
 * Worker secret/var (bootstrap) or written into settings by the setup wizard.
 * Env takes precedence so a deployment can always recover access.
 */

export async function getAdminGithubLogin(env: Env): Promise<string | null> {
  return env.ADMIN_GITHUB_LOGIN ?? (await getSetting(env, "admin_github_login"));
}

export async function getAdminEmail(env: Env): Promise<string | null> {
  return env.ADMIN_EMAIL ?? (await getSetting(env, "admin_email"));
}

/** Case-insensitive match of a GitHub login against the allowlist. */
export async function isAllowedGithubLogin(
  env: Env,
  login: string,
): Promise<boolean> {
  const allowed = await getAdminGithubLogin(env);
  return !!allowed && allowed.toLowerCase() === login.toLowerCase();
}

/** Case-insensitive match of an email against the allowlist. */
export async function isAllowedEmail(env: Env, email: string): Promise<boolean> {
  const allowed = await getAdminEmail(env);
  return !!allowed && allowed.toLowerCase() === email.toLowerCase();
}

/** Whether any administrator identity is configured at all. */
export async function hasAdminConfigured(env: Env): Promise<boolean> {
  return !!(await getAdminGithubLogin(env)) || !!(await getAdminEmail(env));
}
