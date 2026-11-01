/**
 * Customer addresses: how `<slug>.<HOSTED_DOMAIN>` reaches a customer's
 * OpenPing (decision D2, docs/hosted/DECISIONS.md).
 *
 *   wildcard        (the default) a dedicated domain: one `*.<domain>` route
 *                   to the platform and Universal SSL's free wildcard
 *                   certificate cover every customer, so provisioning has
 *                   nothing to do per address.
 *   custom_domains  a subdomain of a zone the owner already has, such as
 *                   HOSTED_DOMAIN=openping.n8builds.dev: customers are two
 *                   levels below the zone, which Universal SSL doesn't cover,
 *                   so provisioning attaches one Workers Custom Domain per
 *                   customer (its own certificate, at no extra cost) and the
 *                   teardown detaches it. Required in starter mode, where
 *                   each customer is its own Worker.
 *
 * A zone takes at most 100 Custom Domains, the owner's own included, so this
 * module also keeps count (platform_capacity, migration 0017): sign-ups stop
 * SIGNUP_HEADROOM short of the cap with a plain message, and the health check
 * warns the owner from ALERT_HEADROOM short (src/observability/health.ts).
 *
 * A slug must never shadow a hostname the owner already uses under
 * HOSTED_DOMAIN: besides the reserved names (src/slugs.ts), a sign-up and the
 * attach itself refuse an address that already has a DNS record or another
 * Worker's Custom Domain.
 */

import type { CloudflareApi } from "./cloudflare/api";
import { PermanentError } from "./errors";
import { log } from "./log";
import type { TenantRecord } from "./tenants";

export type AddressConfig = { kind: "wildcard" } | { kind: "custom_domains"; zoneId: string; dispatchService: string };

/** Cloudflare's limit of Custom Domains on one zone (Workers limits, the same on Free and Paid). */
export const CUSTOM_DOMAINS_PER_ZONE = 100;
/** Sign-ups stop this many short of a cap, so a burst of sign-ups and the owner's own new hostnames still fit. */
export const SIGNUP_HEADROOM = 5;
/** The health check warns the owner this many short of a cap: time to plan the move before sign-ups stop. */
export const ALERT_HEADROOM = 15;
/** A count from the Cloudflare API older than this is counted again before a sign-up relies on it. */
export const CAPACITY_STALE_MS = 60 * 60_000;

export type CapacityResource = "custom_domains" | "workers";

/** The tenant's public hostname. */
export function tenantHostname(slug: string, hostedDomain: string): string {
  return `${slug}.${hostedDomain.trim().toLowerCase().replace(/\.$/, "")}`;
}

/** The Worker a tenant's Custom Domain routes to: the platform's (dispatch), or in starter mode its own (PR 4). */
export function addressService(config: Extract<AddressConfig, { kind: "custom_domains" }>, _tenant: Pick<TenantRecord, "scriptName">): string {
  return config.dispatchService;
}

export interface AddressDeps {
  db: D1Database;
  api: CloudflareApi;
  hostedDomain: string;
  addresses: AddressConfig;
  now: number;
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export interface CapacityRow {
  resource: CapacityResource;
  used: number;
  cap: number;
  checkedAt: number;
}

export async function readCapacity(db: D1Database): Promise<CapacityRow[]> {
  const rows = await db.prepare("SELECT resource, used, cap, checked_at FROM platform_capacity").all<{ resource: CapacityResource; used: number; cap: number; checked_at: number }>();
  return rows.results.map((r) => ({ resource: r.resource, used: r.used, cap: r.cap, checkedAt: r.checked_at }));
}

export function capacityStatement(db: D1Database, row: CapacityRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO platform_capacity (resource, used, cap, checked_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(resource) DO UPDATE SET used = excluded.used, cap = excluded.cap, checked_at = excluded.checked_at`,
    )
    .bind(row.resource, row.used, row.cap, row.checkedAt);
}

/** Moves a count by one after an attach or a detach, between the hourly counts. */
export async function bumpCapacity(db: D1Database, resource: CapacityResource, delta: 1 | -1): Promise<void> {
  await db.prepare("UPDATE platform_capacity SET used = MAX(0, used + ?) WHERE resource = ?").bind(delta, resource).run();
}

/** Counts the zone's Custom Domains with the Cloudflare API and records it. No-op for wildcard addresses. */
export async function refreshAddressCapacity(deps: AddressDeps): Promise<CapacityRow | null> {
  if (deps.addresses.kind !== "custom_domains") return null;
  const used = await deps.api.countCustomDomains(deps.addresses.zoneId);
  const row: CapacityRow = { resource: "custom_domains", used, cap: CUSTOM_DOMAINS_PER_ZONE, checkedAt: deps.now };
  await capacityStatement(deps.db, row).run();
  return row;
}

/** Every count this platform keeps, taken again from the Cloudflare API (the hourly cron, and a sign-up with a stale count). */
export async function refreshCapacity(deps: AddressDeps): Promise<CapacityRow[]> {
  const rows: CapacityRow[] = [];
  const domains = await refreshAddressCapacity(deps);
  if (domains) rows.push(domains);
  return rows;
}

/** What a sign-up is told while a cap is reached. */
export const CAPACITY_FULL_MESSAGE =
  "OpenPing Hosted is full for now, so new sign-ups are paused. Please try again in a few days, or self-host OpenPing for free.";

/** Tenants that will take a Custom Domain they don't have yet: being provisioned, without one. */
const PENDING_ADDRESSES_SQL = `SELECT COUNT(*) AS n FROM tenants
  WHERE provision_state NOT IN ('ready', 'deleting') AND custom_domain_id IS NULL`;

export type CapacityVerdict = { ok: true } | { ok: false; resource: CapacityResource; used: number; cap: number };

/** A cap is "full" for sign-ups at cap minus SIGNUP_HEADROOM. */
export function signUpsFull(used: number, cap: number): boolean {
  return used >= cap - SIGNUP_HEADROOM;
}

/** Near enough to a cap that the owner should hear about it. */
export function nearCap(used: number, cap: number): boolean {
  return used >= cap - ALERT_HEADROOM;
}

/**
 * May one more tenant sign up? Each cap counts what the API last said plus
 * the tenants still being provisioned that will take one more. A count older
 * than CAPACITY_STALE_MS is taken again first; when the API can't answer, the
 * last count stands (and with none, the sign-up goes ahead: the attach itself
 * then refuses past the real limit, and pauses that tenant for the owner).
 */
export async function capacityForSignUp(
  deps: AddressDeps,
  refresh: (deps: AddressDeps) => Promise<CapacityRow[]>,
): Promise<CapacityVerdict> {
  let rows = await readCapacity(deps.db);
  if (rows.length === 0 || rows.some((r) => deps.now - r.checkedAt > CAPACITY_STALE_MS)) {
    try {
      rows = await refresh(deps);
    } catch (error) {
      log.warn("capacity.refresh_failed", { error });
    }
  }
  if (!rows.length) return { ok: true };
  const pending = (await deps.db.prepare(PENDING_ADDRESSES_SQL).first<{ n: number }>())?.n ?? 0;
  for (const row of rows) {
    const used = row.used + (row.resource === "custom_domains" ? pending : 0);
    if (signUpsFull(used + 1, row.cap)) {
      log.error("capacity.signups_stopped", { resource: row.resource, used, cap: row.cap });
      return { ok: false, resource: row.resource, used, cap: row.cap };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Shadowing
// ---------------------------------------------------------------------------

export type AddressCheck = { ok: true } | { ok: false; reason: "taken" | "unavailable" };

/**
 * Is `<slug>.<domain>` free for a new customer on the zone? Taken when it has
 * a DNS record or a Custom Domain of any Worker: something the owner already
 * runs there, which a customer must never take over. "unavailable" when the
 * API didn't answer; the sign-up goes ahead and the attach checks again.
 */
export async function checkAddress(deps: AddressDeps, slug: string): Promise<AddressCheck> {
  if (deps.addresses.kind !== "custom_domains") return { ok: true };
  const hostname = tenantHostname(slug, deps.hostedDomain);
  try {
    const [domain, records] = await Promise.all([
      deps.api.findCustomDomain(deps.addresses.zoneId, hostname),
      deps.api.findDnsRecords(deps.addresses.zoneId, hostname),
    ]);
    return domain || records.length ? { ok: false, reason: "taken" } : { ok: true };
  } catch (error) {
    log.warn("address.check_failed", { hostname, error });
    return { ok: false, reason: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// Attaching and detaching
// ---------------------------------------------------------------------------

/**
 * tenants.custom_domain_id while an attach is under way: written before the
 * attach, so a retry whose answer was lost knows the domain it finds is its
 * own, and nothing else is ever taken for one.
 */
export const ATTACH_PENDING = "pending";

/**
 * Gives the tenant its Custom Domain. An existing one at its hostname is kept
 * only when it is this tenant's: its id is the one recorded, or an attach
 * was under way (ATTACH_PENDING, an answer lost), and it routes to the right
 * Worker. Anything else there (another Worker's, a mapping made by hand,
 * even to the platform, or a DNS record of its own) is the owner's and is
 * never taken: a PermanentError, which pauses the tenant for the owner.
 * `recordedId` is tenants.custom_domain_id. Resolves the domain's id, or null
 * for wildcard addresses.
 */
export async function ensureTenantAddress(
  deps: AddressDeps,
  tenant: Pick<TenantRecord, "id" | "slug" | "scriptName">,
  recordedId: string | null,
): Promise<string | null> {
  if (deps.addresses.kind !== "custom_domains") return null;
  const { zoneId } = deps.addresses;
  const hostname = tenantHostname(tenant.slug, deps.hostedDomain);
  const service = addressService(deps.addresses, tenant);
  const existing = await deps.api.findCustomDomain(zoneId, hostname);
  if (existing) {
    const ours = existing.id === recordedId || recordedId === ATTACH_PENDING;
    if (!ours) throw new PermanentError(`${hostname} already has a Custom Domain (to the Worker ${existing.service}) that this tenant didn't make; it is never taken over`);
    if (existing.service !== service) throw new PermanentError(`${hostname} is attached to the Worker ${existing.service}, not ${service}`);
    return existing.id;
  }
  const records = await deps.api.findDnsRecords(zoneId, hostname);
  if (records.length) throw new PermanentError(`${hostname} already has a DNS record (${records.map((r) => r.type).join(", ")}); it is never taken over`);
  // The intent first: if the attach's answer is lost, the retry knows the domain is ours.
  await deps.db.prepare("UPDATE tenants SET custom_domain_id = ? WHERE id = ?").bind(ATTACH_PENDING, tenant.id).run();
  const domain = await deps.api.attachCustomDomain({ hostname, service, zoneId });
  await bumpCapacity(deps.db, "custom_domains", 1);
  log.info("address.attached", { tenant: tenant.id, hostname, service });
  return domain.id;
}

/**
 * Takes the tenant's Custom Domain away: by its recorded id, or, when an
 * attach was under way (ATTACH_PENDING), the one at its hostname routed to
 * its Worker. A tenant that never recorded one detaches nothing, so a
 * mapping it didn't make is never touched.
 */
export async function removeTenantAddress(
  deps: AddressDeps,
  tenant: Pick<TenantRecord, "id" | "slug" | "scriptName">,
  recordedId: string | null,
): Promise<void> {
  if (deps.addresses.kind !== "custom_domains") return;
  const hostname = tenantHostname(tenant.slug, deps.hostedDomain);
  const service = addressService(deps.addresses, tenant);
  if (!recordedId) return;
  let id: string | null = recordedId;
  if (id === ATTACH_PENDING) {
    const found = await deps.api.findCustomDomain(deps.addresses.zoneId, hostname);
    id = found && found.service === service ? found.id : null;
  }
  if (!id) return;
  if (await deps.api.detachCustomDomain(id)) {
    await bumpCapacity(deps.db, "custom_domains", -1);
    log.info("address.detached", { tenant: tenant.id, hostname });
  }
}
