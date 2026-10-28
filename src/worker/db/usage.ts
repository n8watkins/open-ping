import type { PlatformCapability, UsageCounts } from "../../shared/hosted-contract";

/**
 * What a tenant has, for the platform's admin console and abuse signals
 * (docs/hosted/CONTRACT.md, section 4, `reportUsage`). Hosted mode only.
 */
export async function usageCounts(db: D1Database, at: number = Date.now()): Promise<UsageCounts> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM monitors) AS monitors,
              (SELECT COUNT(*) FROM status_pages) AS statusPages,
              (SELECT COUNT(*) FROM notification_channels) AS channels`,
    )
    .first<{ monitors: number; statusPages: number; channels: number }>();
  return { monitors: row?.monitors ?? 0, statusPages: row?.statusPages ?? 0, channels: row?.channels ?? 0, at };
}

/**
 * Counts and reports them through the platform capability. The report is for
 * metrics only, so a failure is logged and never fails the caller.
 */
export async function reportUsage(db: D1Database, platform: PlatformCapability): Promise<void> {
  try {
    await platform.reportUsage(await usageCounts(db));
  } catch (error) {
    console.error("[hosted] could not report usage", error);
  }
}
