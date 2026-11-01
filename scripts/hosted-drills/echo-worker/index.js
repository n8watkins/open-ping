// The load test's target (docs/hosted/LAUNCH_DRILLS.md): a tiny Worker the
// load-test tenants' monitors check, deployed to the staging account by
// `npm run hosted-load -- seed` and deleted by `cleanup`. It answers at once,
// with nothing stored, and fails on purpose on a few paths, the same way for
// everyone, so a run's failed checks are predictable:
//
//   /ok                 200
//   /flaky?rate=10&m=3  500 for about rate% of minutes (a fixed set per m)
//   /slow?ms=1500       200 after ms milliseconds (at most 10 s)
//   /window?down=20-29  503 during those minutes of every hour (UTC), else 200
//   anything else       404

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}

export function answer(url, now) {
  const minute = Math.floor(now / 60_000);
  switch (url.pathname) {
    case "/ok":
      return { status: 200 };
    case "/flaky": {
      const rate = Math.min(100, Math.max(0, Number(url.searchParams.get("rate") ?? 10)));
      const down = hash(`${url.searchParams.get("m") ?? ""}:${minute}`) % 100 < rate;
      return { status: down ? 500 : 200 };
    }
    case "/slow":
      return { status: 200, delayMs: Math.min(10_000, Math.max(0, Number(url.searchParams.get("ms") ?? 1500) || 0)) };
    case "/window": {
      const [from, to] = (url.searchParams.get("down") ?? "20-29").split("-").map(Number);
      const m = new Date(now).getUTCMinutes();
      return { status: m >= from && m <= to ? 503 : 200 };
    }
    default:
      return { status: 404 };
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const { status, delayMs = 0 } = answer(url, Date.now());
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response(status < 400 ? "ok\n" : "failing on purpose\n", {
      status,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
