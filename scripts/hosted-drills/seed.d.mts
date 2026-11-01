// Types for seed.mjs, which the platform's and OpenPing's workerd tests run
// against the real schemas (platform/test/drills.test.ts, test/integration/hosted-drills.test.ts).

export interface LoadTenant {
  tenantId: string;
  accountId: string;
  slug: string;
  email: string;
}

export interface MonitorTarget {
  name: string;
  url: string;
}

export declare const LOAD_EMAIL_DOMAIN: string;
export declare const LOAD_SLUG_PREFIX: string;
export declare const LOAD_PLAN: "hosted";
export declare const LOAD_INTERVAL_SECONDS: number;
export declare const MONITOR_DEFAULTS: {
  schedule: { mode: "always" };
  assertions: unknown[];
  notify: { channels: string[] };
  public: Record<string, unknown>;
  confirmFailures: "retry";
};
export declare function isRunId(value: unknown): value is string;
export declare function loadTenants(input: { runId: string; count: number; newTenantId: () => string }): LoadTenant[];
export declare function platformSeedSql(tenants: LoadTenant[], options: { now: number }): string;
export declare function loadTenantFilter(runId?: string | null, alias?: string): string;
export declare function provisionStatusSql(runId: string): string;
export declare function seedKeysSql(runId: string): string;
export declare function monitorTargets(echoUrl: string, count: number): MonitorTarget[];
export declare function httpConfig(url: string): Record<string, unknown>;
export declare function monitorSeedSql(input: {
  targets: MonitorTarget[];
  seal: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  now: number;
  newMonitorId: () => string;
}): Promise<string>;
export declare function markForRemovalSql(runId: string, options: { now: number }): string;
export declare function remainingTenantsSql(runId: string): string;
export declare function leftoversSql(runId: string, tenantIds: string[]): string;
