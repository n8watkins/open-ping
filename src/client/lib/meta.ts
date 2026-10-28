import { DEFAULT_DESCRIPTION } from "../../shared/landing-meta";

function metaTag(name: string): HTMLMetaElement {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.name = name;
    document.head.appendChild(tag);
  }
  return tag;
}

/**
 * Set the page's title and description, and whether search engines may index
 * it. Pages call it once they know what they are; anything left out goes back
 * to the defaults, so one page's tags never leak into the next.
 */
export function setPageMeta({
  title,
  description,
  noindex = false,
}: {
  title: string;
  description?: string | null;
  noindex?: boolean;
}): void {
  document.title = title;
  metaTag("description").content = description?.trim() || DEFAULT_DESCRIPTION;
  const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (noindex) metaTag("robots").content = "noindex";
  else robots?.remove();
}
