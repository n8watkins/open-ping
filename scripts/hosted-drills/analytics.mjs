// Cloudflare's GraphQL Analytics API, for the load test's D1 rows and CPU
// (https://developers.cloudflare.com/d1/observability/metrics-analytics/,
// https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/).
//
// Needs an API token with Account Analytics Read (CLOUDFLARE_ANALYTICS_TOKEN)
// and the account id (CLOUDFLARE_ACCOUNT_ID). The query is printed, the token
// never is. Without them, the report says the cost wasn't measured; the same
// numbers are in the dashboard (D1 > each database > Metrics, and Workers for
// Platforms > the namespace > Analytics).

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

/**
 * The query. D1's adaptive groups are filtered by minute; should the API not
 * take that, `granularity: "hour"` filters by whole hours (wrangler's own `d1
 * info` does), covering the window, and the rows are scaled to the window.
 */
export function analyticsQuery(granularity = "minute") {
  const field = granularity === "hour" ? "datetimeHour" : "datetimeMinute";
  return `query LoadTest($accountTag: string!, $start: Time!, $end: Time!, $d1Start: Time!, $d1End: Time!, $databases: [string!], $scripts: [string!]) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { ${field}_geq: $d1Start, ${field}_leq: $d1End, databaseId_in: $databases }) {
        sum { rowsRead rowsWritten readQueries writeQueries }
        dimensions { databaseId }
      }
      workers: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end, scriptName_in: $scripts }) {
        sum { requests errors }
        quantiles { cpuTimeP50 cpuTimeP99 }
        dimensions { scriptName }
      }
    }
  }
}`;
}

const HOUR_MS = 3_600_000;

export function analyticsRequest({ accountId, start, end, databaseIds, scriptNames, granularity = "minute" }) {
  const d1Start = granularity === "hour" ? Math.floor(start / HOUR_MS) * HOUR_MS : start;
  // datetimeHour_leq takes the last hour's start.
  const d1End = granularity === "hour" ? Math.floor((end - 1) / HOUR_MS) * HOUR_MS : end;
  const covered = granularity === "hour" ? d1End + HOUR_MS - d1Start : end - start;
  return {
    body: {
      query: analyticsQuery(granularity),
      variables: {
        accountTag: accountId,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        d1Start: new Date(d1Start).toISOString(),
        d1End: new Date(d1End).toISOString(),
        databases: databaseIds,
        scripts: scriptNames,
      },
    },
    /** What the D1 numbers are multiplied by to stand for the window alone. */
    d1Scale: (end - start) / covered,
  };
}

/** Whether an error answer means the minute filter isn't known (so try by hour). */
export function isUnknownFieldError(message) {
  return /datetimeMinute/.test(message ?? "");
}

/** The answer as flat rows for report.mjs, or an error message. */
export function parseAnalytics(json, { d1Scale = 1 } = {}) {
  if (!json || typeof json !== "object") return { error: "no answer" };
  if (Array.isArray(json.errors) && json.errors.length) return { error: json.errors.map((e) => e.message).join("; ").slice(0, 500) };
  const account = json.data?.viewer?.accounts?.[0];
  if (!account) return { error: "no account in the answer (check CLOUDFLARE_ACCOUNT_ID and the token's access)" };
  return {
    d1Scale,
    d1: (account.d1 ?? []).map((g) => ({
      databaseId: g.dimensions?.databaseId,
      rowsRead: (g.sum?.rowsRead ?? 0) * d1Scale,
      rowsWritten: (g.sum?.rowsWritten ?? 0) * d1Scale,
      readQueries: (g.sum?.readQueries ?? 0) * d1Scale,
      writeQueries: (g.sum?.writeQueries ?? 0) * d1Scale,
    })),
    workers: (account.workers ?? []).map((g) => ({ scriptName: g.dimensions?.scriptName, requests: g.sum?.requests ?? 0, errors: g.sum?.errors ?? 0, cpuTimeP50: g.quantiles?.cpuTimeP50 ?? null, cpuTimeP99: g.quantiles?.cpuTimeP99 ?? null })),
  };
}
