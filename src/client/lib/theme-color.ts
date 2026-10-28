/**
 * The phone's status bar (and the installed app's title bar) takes the page's
 * colour: the dark shell everywhere, except a status page set to the light
 * theme, which marks its wrapper `data-theme="light"`.
 */
export const DARK_THEME_COLOR = "#0b1220";

/** The status bar colour for a page whose wrapper has this data-theme (or none). */
export function themeColorFor(dataTheme: string | null, lightCanvas: string | null): string {
  return dataTheme === "light" && lightCanvas ? lightCanvas : DARK_THEME_COLOR;
}

/** Keep `<meta name="theme-color">` in step with the page. Call once at start. */
export function followPageThemeColor(): void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const root = document.getElementById("root");
  if (!meta || !root) return;

  let last = meta.content;
  const update = () => {
    const wrapper = root.querySelector<HTMLElement>("[data-theme]");
    const theme = wrapper?.getAttribute("data-theme") ?? null;
    const canvas = wrapper ? getComputedStyle(wrapper).getPropertyValue("--color-canvas").trim() || null : null;
    const next = themeColorFor(theme, canvas);
    if (next !== last) {
      meta.content = next;
      last = next;
    }
  };
  new MutationObserver(update).observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  update();
}
