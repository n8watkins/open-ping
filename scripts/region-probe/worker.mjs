import { DurableObject } from "cloudflare:workers";

/**
 * Throwaway measurement Worker for second-region confirmation
 * (docs/SECOND_REGION.md, "What to measure"). Not part of OpenPing: deploy it
 * on its own (wrangler.jsonc next to this file), read the numbers, delete it.
 *
 *   GET /hints            where each location hint's Durable Object lands, and
 *                         the round trip to it, cold (first call) and warm
 *   GET /do-calls?n=60    n Durable Object calls in one invocation: do they
 *                         count against the 50 external subrequests on Free?
 *   GET /do-fetches?n=60  one call whose Durable Object makes n fetches: do they
 *                         count against the caller's 50?
 *   GET /all              all three; the cron run does the same and logs it
 */

const HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"];
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

async function traceColo() {
  const res = await fetch(TRACE_URL);
  const m = /^colo=([A-Z]{3})\s*$/m.exec(await res.text());
  return m ? m[1] : null;
}

export class Probe extends DurableObject {
  /** This object's data center: looked up once, then from storage. */
  async where() {
    let colo = await this.ctx.storage.get("colo");
    if (!colo) {
      colo = await traceColo();
      await this.ctx.storage.put("colo", colo);
    }
    return { colo };
  }

  async ping() {
    return Date.now();
  }

  /** Makes n trace fetches from here; reports how many worked and where they left from. */
  async fetchMany(n) {
    let ok = 0;
    let colo = null;
    let error = null;
    for (let i = 0; i < n; i++) {
      try {
        colo = await traceColo();
        ok++;
      } catch (e) {
        error = String(e);
        break;
      }
    }
    return { ok, colo, error };
  }
}

function stub(env, name, hint) {
  return env.PROBE.get(env.PROBE.idFromName(name), hint ? { locationHint: hint } : undefined);
}

async function hints(env) {
  const here = await traceColo();
  // A new generation per deploy would re-create the objects; the names are
  // fixed so a second call measures the warm path to the same objects.
  const results = await Promise.all(
    HINTS.map(async (hint) => {
      const s = stub(env, `hint:${hint}`, hint);
      try {
        const t0 = Date.now();
        const { colo } = await s.where();
        const first = Date.now() - t0;
        const t1 = Date.now();
        await s.ping();
        const warm = Date.now() - t1;
        return { hint, colo, firstMs: first, warmMs: warm };
      } catch (e) {
        return { hint, error: String(e) };
      }
    }),
  );
  return { workerColo: here, results };
}

async function doCalls(env, n) {
  const s = stub(env, "limits", "enam");
  let ok = 0;
  let error = null;
  for (let i = 0; i < n; i++) {
    try {
      await s.ping();
      ok++;
    } catch (e) {
      error = String(e);
      break;
    }
  }
  return { asked: n, ok, error };
}

async function doFetches(env, n) {
  try {
    return { asked: n, ...(await stub(env, "limits", "enam").fetchMany(n)) };
  } catch (e) {
    return { asked: n, ok: 0, error: String(e) };
  }
}

async function all(env, cfColo) {
  return {
    at: new Date().toISOString(),
    requestCfColo: cfColo ?? null,
    hints: await hints(env),
    doCalls: await doCalls(env, 60),
    doFetches: await doFetches(env, 60),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const n = Math.min(Number(url.searchParams.get("n") ?? 60) || 60, 200);
    const json = (body) => Response.json(body, { headers: { "cache-control": "no-store" } });
    switch (url.pathname) {
      case "/hints":
        return json({ requestCfColo: request.cf?.colo ?? null, ...(await hints(env)) });
      case "/do-calls":
        return json(await doCalls(env, n));
      case "/do-fetches":
        return json(await doFetches(env, n));
      case "/all":
        return json(await all(env, request.cf?.colo));
      default:
        return new Response("GET /hints, /do-calls?n=60, /do-fetches?n=60 or /all\n", { status: 404 });
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(all(env).then((r) => console.log(`[region-probe] ${JSON.stringify(r)}`)));
  },
};
