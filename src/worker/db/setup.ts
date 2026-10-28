import type { Env } from "../types";
import { getJSON, setJSON, getSetting, setSetting } from "./settings";
import { sha256hex } from "../lib/ids";
import { timingSafeEqual } from "../lib/timing";

/**
 * First-run setup state (PRD §22). The wizard must be resumable, so progress
 * (current step, completed steps, collected data) is persisted in D1 under a
 * single settings key. Known fields are also mirrored into their canonical
 * settings keys so the rest of the app reads them normally.
 */

export interface SetupState {
  currentStep: number;
  completedSteps: string[];
  data: Record<string, unknown>;
  updatedAt: number;
}

const STATE_KEY = "setup_state";
const COMPLETE_KEY = "setup_complete";

/** Wizard fields that mirror into canonical settings keys. */
const MIRRORED: Record<string, string> = {
  appUrl: "app_url",
  timezone: "timezone",
  adminGithubLogin: "admin_github_login",
  adminEmail: "admin_email",
};

export async function getSetupState(env: Env): Promise<SetupState> {
  return (
    (await getJSON<SetupState>(env, STATE_KEY)) ?? {
      currentStep: 0,
      completedSteps: [],
      data: {},
      updatedAt: 0,
    }
  );
}

export async function saveSetupStep(
  env: Env,
  input: { step?: number; stepId?: string; data?: Record<string, unknown> },
): Promise<SetupState> {
  const state = await getSetupState(env);
  const completed =
    input.stepId && !state.completedSteps.includes(input.stepId)
      ? [...state.completedSteps, input.stepId]
      : state.completedSteps;

  const next: SetupState = {
    currentStep: input.step ?? state.currentStep,
    completedSteps: completed,
    data: { ...state.data, ...(input.data ?? {}) },
    updatedAt: Date.now(),
  };
  await setJSON(env, STATE_KEY, next);

  // Mirror recognized fields to canonical settings keys.
  for (const [field, key] of Object.entries(MIRRORED)) {
    const value = input.data?.[field];
    if (value != null && value !== "") await setSetting(env, key, String(value));
  }
  return next;
}

export async function isSetupComplete(env: Env): Promise<boolean> {
  return (await getSetting(env, COMPLETE_KEY)) === "true";
}

export async function markSetupComplete(env: Env): Promise<void> {
  await setSetting(env, COMPLETE_KEY, "true");
}

export async function resetSetup(env: Env): Promise<void> {
  await setSetting(env, COMPLETE_KEY, "false");
}

/**
 * SETUP_TOKEN spending, for passkey recovery (docs/SECURITY.md, "Passkeys").
 * A finished install keeps the SHA-256 of the SETUP_TOKEN that was in place
 * when setup finished, or when it was last used to recover. Recovery accepts
 * only a SETUP_TOKEN with a different hash, so the token that set the install
 * up never works again and each new token works once.
 *
 * Installs finished before passkeys existed have no record ("unknown"): the
 * first passkey registration records whatever token is set then, and recovery
 * refuses until a new token is set after that.
 */
const SPENT_KEY = "setup_token_spent_hash";
const NO_TOKEN = "none";

/** Record the current SETUP_TOKEN (or its absence) as spent. */
export async function spendSetupToken(env: Env): Promise<void> {
  await setSetting(env, SPENT_KEY, env.SETUP_TOKEN ? await sha256hex(env.SETUP_TOKEN) : NO_TOKEN);
}

/** Record the current token as spent only when nothing has been recorded yet. */
export async function ensureSetupTokenSpendRecorded(env: Env): Promise<void> {
  if ((await getSetting(env, SPENT_KEY)) == null) await spendSetupToken(env);
}

/**
 * Whether the configured SETUP_TOKEN can still be used for recovery: set, and
 * different from the spent one. An install with no record yet records the
 * current token and answers false.
 */
export async function isSetupTokenUnspent(env: Env): Promise<boolean> {
  if (!env.SETUP_TOKEN) return false;
  const spent = await getSetting(env, SPENT_KEY);
  if (spent == null) {
    await spendSetupToken(env);
    return false;
  }
  return !(await timingSafeEqual(spent, await sha256hex(env.SETUP_TOKEN)));
}
