import "./styles.css";
import { HOSTED_DOMAIN } from "./config";
import { hostOf, hostedOrigin, normalizeAddress, type AddressResult } from "./addresses";
import { parseRoute, type Route } from "./routes";
import { Shell, type Install, type ProbeResult, type ShellState } from "./shell";

/**
 * The app's own screens: "Where is your OpenPing?", the list of installs, and
 * the offline screen. Everything else is the install's own web app, which the
 * native side loads in place of this page.
 *
 * Routes are hashes (routes.ts) so the Android back button walks them.
 */

const root = document.getElementById("app")!;

// --- Icons (Lucide, ISC licence), constant markup only ----------------------

const ICONS = {
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  server:
    '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  remove:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  offline:
    '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
} as const;

function icon(name: keyof typeof ICONS, className = ""): SVGSVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${className}">${ICONS[name]}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

const BRAND = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#111b2e"/><circle cx="16" cy="16" r="4" fill="#6d8bff"/><circle cx="16" cy="16" r="9" fill="none" stroke="#6d8bff" stroke-width="1.5" opacity="0.5"/><circle cx="16" cy="16" r="13" fill="none" stroke="#6d8bff" stroke-width="1.5" opacity="0.2"/></svg><span>Open<span class="ping">Ping</span></span>`;

// --- Tiny DOM helpers ---------------------------------------------------------

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) if (value !== undefined) node.setAttribute(key, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

function brand(): HTMLElement {
  const p = el("p", { class: "brand", "aria-label": "OpenPing" });
  p.innerHTML = BRAND;
  return p;
}

function backLink(to: string, label: string): HTMLElement {
  const a = el("a", { class: "link back", href: to }, icon("back"), label);
  return a;
}

function footer(state: ShellState): HTMLElement {
  return el("p", { class: "footer" }, `OpenPing for Android ${state.version}`);
}

function show(...nodes: Child[]) {
  root.replaceChildren(...nodes.filter((n): n is Node | string => !!n));
  window.scrollTo(0, 0);
}

// --- Screens --------------------------------------------------------------------

function bootScreen() {
  show(el("div", { class: "boot" }, brand()));
}

/** "Where is your OpenPing?": the two ways in. */
function welcomeScreen(state: ShellState) {
  const hostedOpen = HOSTED_DOMAIN !== "";
  const hosted = el(
    "a",
    hostedOpen
      ? { class: "choice", href: "#/add/hosted" }
      : { class: "choice", role: "link", "aria-disabled": "true" },
    el("span", { class: "choice-icon" }, icon("cloud")),
    el(
      "span",
      { class: "choice-text" },
      el("span", { class: "choice-title" }, "OpenPing Hosted", hostedOpen ? null : el("span", { class: "badge" }, "Opening soon")),
      el("span", { class: "choice-sub" }, "Sign in with your OpenPing Hosted account."),
    ),
    hostedOpen ? icon("chevron", "chevron") : null,
  );
  const own = el(
    "a",
    { class: "choice", href: "#/add/own" },
    el("span", { class: "choice-icon" }, icon("server")),
    el(
      "span",
      { class: "choice-text" },
      el("span", { class: "choice-title" }, "My own install"),
      el("span", { class: "choice-sub" }, "One you or your team runs on Cloudflare: type its address."),
    ),
    icon("chevron", "chevron"),
  );
  show(
    state.installs.length > 0 ? backLink("#/picker", "Your OpenPings") : null,
    brand(),
    el("h1", {}, "Where is your OpenPing?"),
    el("p", { class: "lead" }, "The app opens your OpenPing and keeps it a tap away. You can add more than one."),
    el("div", { class: "choices" }, hosted, own),
    footer(state),
  );
}

/** The installs this app knows, the last used first. */
function listScreen(state: ShellState) {
  const installs = [...state.installs].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  const list = el("ul", { class: "installs" }, ...installs.map((install) => installRow(install, state)));
  show(
    brand(),
    el("h1", {}, "Your OpenPings"),
    el("p", { class: "lead" }, "Tap one to open it."),
    list,
    el(
      "div",
      { class: "stack" },
      el("a", { class: "button secondary", href: "#/add" }, icon("plus"), "Add another OpenPing"),
    ),
    footer(state),
  );
}

function installRow(install: Install, state: ShellState): HTMLElement {
  const host = hostOf(install.origin);
  const open = el(
    "button",
    { type: "button", class: "install-open" },
    el("span", { class: "choice-icon" }, icon(install.hosted ? "cloud" : "server")),
    el(
      "span",
      { class: "choice-text" },
      el("span", { class: "install-host" }, host),
      el("span", { class: "choice-sub" }, install.hosted ? "OpenPing Hosted" : "Own install"),
    ),
  );
  open.addEventListener("click", () => void openInstall(install.origin));
  const remove = el("button", { type: "button", class: "icon-button", "aria-label": `Remove ${host}` }, icon("remove"));
  remove.addEventListener("click", () => confirmRemove(install.origin));
  return el("li", { class: install.origin === state.active ? "install active" : "install" }, open, remove);
}

function confirmRemove(origin: string) {
  const host = hostOf(origin);
  const cancel = el("button", { type: "button", class: "button secondary" }, "Cancel");
  const confirm = el("button", { type: "button", class: "button danger" }, "Remove");
  const dialog = el(
    "dialog",
    { "aria-labelledby": "remove-title" },
    el("h2", { id: "remove-title" }, `Remove ${host}?`),
    el(
      "p",
      {},
      "The app forgets this address and signs out of it on this phone. The OpenPing itself and its monitors aren't touched.",
    ),
    el("div", { class: "dialog-actions" }, cancel, confirm),
  );
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  confirm.addEventListener("click", async () => {
    dialog.close();
    const state = await Shell.remove({ origin });
    render(parseRoute(location.hash), state);
  });
  document.body.append(dialog);
  dialog.showModal();
}

function errorText(result: Exclude<AddressResult, { ok: true }> | Exclude<ProbeResult, { ok: true }>, hosted: boolean): string {
  switch (result.reason) {
    case "empty":
      return hosted ? "Type your OpenPing's name." : "Type your OpenPing's address.";
    case "not_https":
      return "The app opens only https addresses. Use the address that starts with https://.";
    case "invalid":
      return hosted
        ? "That isn't an OpenPing Hosted name: letters, numbers and hyphens, starting with a letter."
        : "That doesn't look like a web address.";
    case "not_found":
      return hosted ? "There's no OpenPing Hosted with that name. Check the spelling." : "No site answers at that address. Check the spelling.";
    case "unreachable":
      return "Couldn't reach that address. Check your connection and try again.";
    case "tls":
      return "That address's security certificate isn't valid, so the app won't open it.";
    case "not_openping":
      return "That address answers, but it isn't an OpenPing.";
    case "too_old":
      return "That OpenPing needs an update before the app can sign in to it. Its owner can update it (docs/UPGRADE.md).";
    case "moved":
      return `That address forwards to ${hostOf(result.location ?? "")}.`;
  }
}

/** The address form, for an own install (`hosted` false) or a Hosted name. */
function addScreen(state: ShellState, hosted: boolean) {
  const inputId = "address";
  const input = el("input", {
    id: inputId,
    name: "address",
    type: hosted ? "text" : "url",
    inputmode: hosted ? "text" : "url",
    autocomplete: "off",
    autocapitalize: "none",
    autocorrect: "off",
    spellcheck: "false",
    enterkeyhint: "go",
    placeholder: hosted ? "your-name" : "openping.example.com",
    "aria-describedby": "address-hint",
  });
  const field = el("div", { class: "field" }, input, hosted ? el("span", { class: "suffix" }, `.${HOSTED_DOMAIN}`) : null);
  const errorBox = el("div", {});
  const submit = el("button", { type: "submit", class: "button" }, "Continue");
  const hint = hosted
    ? el("p", { class: "hint", id: "address-hint" }, "The name in your OpenPing's address, shown on your account page.")
    : el("p", { class: "hint", id: "address-hint" }, "The address you open it at in a browser, for example status.example.com.");
  const form = el(
    "form",
    { novalidate: "" },
    el("label", { for: inputId }, hosted ? "Your OpenPing Hosted name" : "Your OpenPing's address"),
    field,
    hint,
    errorBox,
    submit,
  );

  const setBusy = (busy: boolean) => {
    submit.disabled = busy;
    submit.replaceChildren(...(busy ? [el("span", { class: "spinner", "aria-hidden": "true" }), "Checking"] : ["Continue"]));
  };
  const showError = (text: string, retry?: { label: string; value: string }) => {
    const box = el("p", { class: "error", role: "alert" }, text);
    if (retry) {
      const use = el("button", { type: "button", class: "link" }, retry.label);
      use.addEventListener("click", () => {
        input.value = retry.value;
        form.requestSubmit();
      });
      box.append(" ", use);
    }
    errorBox.replaceChildren(box);
    input.setAttribute("aria-invalid", "true");
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.replaceChildren();
    input.removeAttribute("aria-invalid");
    const address = hosted ? hostedOrigin(input.value, HOSTED_DOMAIN) : normalizeAddress(input.value);
    if (!address.ok) return showError(errorText(address, hosted));
    if (state.installs.some((i) => i.origin === address.origin)) return void openInstall(address.origin);
    setBusy(true);
    try {
      const probe = await Shell.probe({ origin: address.origin });
      if (!probe.ok) {
        const moved = probe.reason === "moved" && probe.location ? normalizeAddress(probe.location) : null;
        return showError(
          errorText(probe, hosted),
          moved?.ok && !hosted ? { label: `Use ${hostOf(moved.origin)}`, value: hostOf(moved.origin) } : undefined,
        );
      }
      await Shell.add({ origin: probe.origin, hosted: hosted || probe.hosted });
      await openInstall(probe.origin);
    } catch {
      showError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  });

  const extra = hosted
    ? (() => {
        const find = el("button", { type: "button", class: "link" }, "Don't know it? Open your account", icon("external"));
        find.addEventListener("click", () => void Shell.openExternal({ url: `https://app.${HOSTED_DOMAIN}/account` }));
        return el("div", { class: "stack" }, find);
      })()
    : null;

  show(
    backLink("#/add", "Back"),
    brand(),
    el("h1", {}, hosted ? "OpenPing Hosted" : "Your own install"),
    el(
      "p",
      { class: "lead" },
      hosted
        ? "Type your OpenPing's name. You sign in with your Hosted account next."
        : "Type the address of your OpenPing. You sign in to it next, in your browser.",
    ),
    form,
    extra,
    footer(state),
  );
  input.focus();
}

/** The install didn't load: why, and the ways on. */
function offlineScreen(state: ShellState, route: Extract<Route, { name: "offline" }>) {
  const host = route.origin ? hostOf(route.origin) : "your OpenPing";
  const certificate = route.reason === "certificate";
  const retry = el("button", { type: "button", class: "button" }, "Try again");
  retry.addEventListener("click", () => {
    if (route.origin) void Shell.open({ origin: route.origin, path: route.path });
  });
  const others = el("a", { class: "button secondary", href: "#/picker" }, "Switch OpenPing");
  show(
    brand(),
    el("div", { class: "status-icon" }, icon(certificate ? "lock" : "offline")),
    el("h1", {}, `Can't open ${host}`),
    el(
      "p",
      { class: "lead" },
      certificate
        ? `${host}'s security certificate isn't valid right now, so the app won't open it. Try again later.`
        : "Check your phone's connection. If it's fine, the OpenPing may be down for a moment.",
    ),
    el("div", { class: "stack" }, retry, state.installs.length > 0 ? others : null),
    footer(state),
  );
}

// --- Flow -------------------------------------------------------------------------

async function openInstall(origin: string) {
  bootScreen();
  await Shell.open({ origin });
}

function render(route: Route, state: ShellState) {
  switch (route.name) {
    case "offline":
      return offlineScreen(state, route);
    case "add":
      return welcomeScreen(state);
    case "add-own":
      return addScreen(state, false);
    case "add-hosted":
      return HOSTED_DOMAIN ? addScreen(state, true) : welcomeScreen(state);
    case "picker":
    case "boot":
      return state.installs.length > 0 ? listScreen(state) : welcomeScreen(state);
  }
}

async function start() {
  bootScreen();
  const state = await Shell.getState();
  const route = parseRoute(location.hash);
  // A plain launch goes straight to the install used last.
  if (route.name === "boot" && state.active) return void (await Shell.open({ origin: state.active }));
  render(route, state);
}

window.addEventListener("hashchange", () => {
  void Shell.getState().then((state) => render(parseRoute(location.hash), state));
});

void start();
