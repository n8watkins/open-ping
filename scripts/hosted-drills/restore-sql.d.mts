// Types for restore-sql.mjs, which the platform's workerd tests run against
// the real schema and provisioning (platform/test/drills.test.ts).

export declare function tenantLookupSql(slug: string): string;
export declare function quiesceSql(tenantId: string, options: { at: number; note: string }): string;
export declare function unquiesceSql(tenantId: string, options: { quiescedAt: number; now: number }): string;
export declare function exportRequestSql(input: { exportId: string; tenantId: string; accountId: string; slug: string; at: number }): string;
export declare function exportStatusSql(exportId: string): string;
export declare function rebindSql(tenantId: string, options: { d1Id: string; quiescedAt: number; now: number }): string;
