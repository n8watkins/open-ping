import type { Env } from "../types";
import { getJSON, setJSON, getSetting, setSetting } from "./settings";

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
