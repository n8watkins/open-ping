import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

/*
 * public/sw.js is plain JS served as is, so it is tested the same way: run in
 * a sandbox with a fake `self`, then fire its events. Covers where a tapped
 * alert goes and what the Overview cache keeps.
 */
const SOURCE = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const SCOPE = "https://status.example.com/";

type Listener = (event: unknown) => void;

interface FakeClient {
  url: string;
  focused: boolean;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

function fakeClient(url: string, { focused = false, navigable = true } = {}): FakeClient {
  const client: FakeClient = {
    url,
    focused,
    focus: vi.fn(async () => client),
    navigate: vi.fn(async (to: string) => {
      if (!navigable) throw new TypeError("not controlled");
      client.url = to;
      return client;
    }),
    postMessage: vi.fn(),
  };
  return client;
}

/** A tiny Cache Storage: one Map per cache name, keyed by URL. */
function fakeCaches() {
  const store = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const entries = store.get(name)!;
    const key = (r: Request | string) => new URL(typeof r === "string" ? r : r.url, SCOPE).href;
    return {
      match: async (r: Request | string) => entries.get(key(r))?.clone(),
      put: async (r: Request | string, res: Response) => void entries.set(key(r), res),
      add: async () => undefined,
      addAll: async () => undefined,
      delete: async (r: Request | string) => entries.delete(key(r)),
      keys: async () => [...entries.keys()].map((u) => new Request(u)),
    };
  };
  return {
    store,
    api: {
      open,
      keys: async () => [...store.keys()],
      delete: async (name: string) => store.delete(name),
      match: async (r: Request | string) => {
        for (const name of store.keys()) {
          const hit = await (await open(name)).match(r);
          if (hit) return hit;
        }
        return undefined;
      },
    },
  };
}

function loadWorker({ windows = [] as FakeClient[], fetchImpl = vi.fn() } = {}) {
  const listeners = new Map<string, Listener>();
  const caches = fakeCaches();
  const clients = {
    matchAll: vi.fn(async () => windows),
    openWindow: vi.fn(async (url: string) => fakeClient(url)),
    get: vi.fn(async (id: string) => windows.find((_, i) => `client-${i}` === id)),
    claim: vi.fn(async () => undefined),
  };
  const self = {
    location: new URL(SCOPE),
    registration: { scope: SCOPE, showNotification: vi.fn() },
    clients,
    skipWaiting: vi.fn(),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
  };
  runInNewContext(SOURCE, {
    self,
    caches: caches.api,
    fetch: fetchImpl,
    URL,
    Request,
    Response,
    Headers,
    Promise,
    Set,
    Date,
    Number,
    Array,
    String,
    JSON,
  });
  return { listeners, clients, caches, self };
}

/** Fire an extendable event and wait for everything it waits on. */
async function fire(listeners: Map<string, Listener>, type: string, extra: Record<string, unknown>) {
  const pending: Promise<unknown>[] = [];
  let responded: Promise<Response> | undefined;
  listeners.get(type)!({
    ...extra,
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    respondWith: (p: Promise<Response>) => {
      responded = p;
    },
  });
  const response = responded ? await responded : undefined;
  // waitUntil promises can add more of their own.
  for (let i = 0; i < pending.length; i++) await pending[i];
  return { response, results: await Promise.all(pending) };
}

function tap(url: string | undefined) {
  return { notification: { close: vi.fn(), data: { url } } };
}

describe("tapping an alert", () => {
  it("moves an open OpenPing window to the incident and brings it forward", async () => {
    const app = fakeClient(`${SCOPE}monitors`);
    const { listeners, clients } = loadWorker({ windows: [app] });
    await fire(listeners, "notificationclick", tap(`${SCOPE}incidents?incident=inc_1`));
    expect(app.focus).toHaveBeenCalled();
    expect(app.navigate).toHaveBeenCalledWith(`${SCOPE}incidents?incident=inc_1`);
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it("only focuses a window already showing the incident", async () => {
    const app = fakeClient(`${SCOPE}incidents?incident=inc_1`);
    const { listeners } = loadWorker({ windows: [app] });
    await fire(listeners, "notificationclick", tap(`${SCOPE}incidents?incident=inc_1`));
    expect(app.focus).toHaveBeenCalled();
    expect(app.navigate).not.toHaveBeenCalled();
  });

  it("prefers the focused window when several are open", async () => {
    const a = fakeClient(`${SCOPE}`);
    const b = fakeClient(`${SCOPE}alerts`, { focused: true });
    const { listeners } = loadWorker({ windows: [a, b] });
    await fire(listeners, "notificationclick", tap(`${SCOPE}incidents?incident=inc_2`));
    expect(b.navigate).toHaveBeenCalledWith(`${SCOPE}incidents?incident=inc_2`);
    expect(a.navigate).not.toHaveBeenCalled();
  });

  it("opens the app's own window when none is open", async () => {
    const { listeners, clients } = loadWorker();
    await fire(listeners, "notificationclick", tap(`${SCOPE}incidents?incident=inc_1`));
    expect(clients.openWindow).toHaveBeenCalledWith(`${SCOPE}incidents?incident=inc_1`);
  });

  it("opens a new window when the open one can't be moved", async () => {
    const tab = fakeClient(`${SCOPE}`, { navigable: false });
    const { listeners, clients } = loadWorker({ windows: [tab] });
    await fire(listeners, "notificationclick", tap(`${SCOPE}incidents?incident=inc_1`));
    expect(clients.openWindow).toHaveBeenCalledWith(`${SCOPE}incidents?incident=inc_1`);
  });

  it("keeps the tap inside the app when the alert names another address", async () => {
    const { listeners, clients } = loadWorker();
    await fire(listeners, "notificationclick", tap("https://open-ping.example.workers.dev/incidents?incident=inc_3#updates"));
    expect(clients.openWindow).toHaveBeenCalledWith(`${SCOPE}incidents?incident=inc_3#updates`);
  });

  it("opens the Overview for an alert without a link", async () => {
    const { listeners, clients } = loadWorker();
    await fire(listeners, "notificationclick", tap(undefined));
    expect(clients.openWindow).toHaveBeenCalledWith(SCOPE);
  });

  it("ignores windows of other sites", async () => {
    const other = fakeClient("https://elsewhere.example/");
    const { listeners, clients } = loadWorker({ windows: [other] });
    await fire(listeners, "notificationclick", tap(`${SCOPE}incidents`));
    expect(other.navigate).not.toHaveBeenCalled();
    expect(clients.openWindow).toHaveBeenCalledWith(`${SCOPE}incidents`);
  });
});

function get(path: string) {
  return { request: new Request(new URL(path, SCOPE)), clientId: "client-0" };
}

describe("the saved Overview", () => {
  it("saves a good answer, then serves it with its time when the network fails", async () => {
    const page = fakeClient(SCOPE);
    const fetchImpl = vi.fn(async () => new Response('{"counts":{}}', { status: 200 }));
    const { listeners, caches } = loadWorker({ windows: [page], fetchImpl });
    // Responses built in Node are type "default"; the worker keeps "basic" ones.
    fetchImpl.mockImplementationOnce(async () => {
      const res = new Response('{"counts":{}}', { status: 200 });
      Object.defineProperty(res, "type", { value: "basic" });
      return res;
    });
    const first = await fire(listeners, "fetch", get("/api/overview"));
    expect(first.response!.status).toBe(200);
    expect(page.postMessage).toHaveBeenLastCalledWith({ type: "openping:api-cache", source: "fresh" });
    expect([...caches.store.get("openping-api-v1")!.keys()]).toEqual([`${SCOPE}api/overview`]);

    fetchImpl.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    const offline = await fire(listeners, "fetch", get("/api/overview"));
    expect(await offline.response!.text()).toBe('{"counts":{}}');
    const message = page.postMessage.mock.calls.at(-1)![0];
    expect(message).toMatchObject({ type: "openping:api-cache", source: "cached" });
    expect(typeof message.savedAt).toBe("number");
  });

  it("forgets everything saved on a signed-out answer", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    const { listeners, caches } = loadWorker({ fetchImpl });
    caches.store.set("openping-api-v1", new Map([[`${SCOPE}api/overview`, new Response("{}")]]));
    const { response } = await fire(listeners, "fetch", get("/api/overview"));
    expect(response!.status).toBe(401);
    expect(caches.store.has("openping-api-v1")).toBe(false);
  });

  it("never touches other API answers", async () => {
    const { listeners } = loadWorker();
    for (const path of ["/api/monitors", "/api/overviewx", "/api/auth/me", "/api/incidents?limit=1"]) {
      const { response } = await fire(listeners, "fetch", get(path));
      expect(response, path).toBeUndefined();
    }
  });

  it("leaves requests that change things to the network", async () => {
    const { listeners } = loadWorker();
    const { response } = await fire(listeners, "fetch", {
      request: new Request(new URL("/api/overview", SCOPE), { method: "POST" }),
      clientId: "client-0",
    });
    expect(response).toBeUndefined();
  });
});
