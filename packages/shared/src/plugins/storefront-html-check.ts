// Author diagnostics, used only by SDK tests and the packer. These check
// declared host contracts; layout, CSS and optional capabilities stay the app's.
import { Parser } from "htmlparser2";
import { sanitizePluginUrl } from "./html";
import { STOREFRONT_DEFERRED_TAG, STOREFRONT_ISLAND_HYDRATION } from "./storefront-protocol";

export interface StorefrontHeaderCheckOptions {
  /** Manifest island names. Omit when testing markup without its manifest. */
  islands?: readonly string[];
}

/** Static errors in one rendered header, with no browser or style assumptions. */
export function checkStorefrontHeaderHtml(html: string, options: StorefrontHeaderCheckOptions = {}): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  const islands = options.islands ? new Set(options.islands) : undefined;
  let templateDepth = 0;
  // Open elements, to know a template's parent: deferred markup's template
  // (`<scalius-deferred><template>`) becomes page content, so it is checked.
  const open: string[] = [];
  const parser = new Parser({
    onopentag(tag, attributes) {
      const parent = open.at(-1);
      open.push(tag);
      // Template children are inert and have a separate ID scope until an
      // island clones them. The template element itself is still in the page.
      if (templateDepth > 0) {
        if (tag === "template") templateDepth += 1;
        return;
      }
      if (tag === "template" && parent !== STOREFRONT_DEFERRED_TAG) templateDepth = 1;
      const id = attributes.id;
      if (id) {
        if (ids.has(id)) issues.push(`Duplicate id ${JSON.stringify(id)}: give each header element a unique id.`);
        ids.add(id);
      }
      for (const marker of ["data-search-open", "data-account-link", "data-cart-open"]) {
        if (marker in attributes && tag === "a" && attributes.href !== undefined && sanitizePluginUrl(attributes.href, "link") === null) {
          issues.push(`${marker} has an unsafe href; use a safe fallback URL such as the supplied data.routes path.`);
        }
      }
      if ("data-header-search" in attributes && tag !== "form") {
        issues.push(`data-header-search belongs on <form>, not <${tag}>; the host listens for that form's submit event.`);
      }
      if ("data-sticky-header" in attributes && ["template", "style", "script", "head", "meta", "link", "title", "base"].includes(tag)) {
        issues.push(`data-sticky-header on <${tag}> cannot mark a rendered box; move it to the element that sticks.`);
      }
      if (tag === "scalius-island") {
        const name = attributes["data-island"] ?? "";
        if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name)) {
          issues.push(`scalius-island needs a valid data-island name (lowercase letters, digits and hyphens, starting with a letter).`);
        } else if (islands && !islands.has(name)) {
          issues.push(`Island ${JSON.stringify(name)} is not declared in storefront.islands; declare it and provide src/islands/${name}.ts.`);
        }
        const hydrate = attributes["data-hydrate"];
        if (hydrate !== undefined && !STOREFRONT_ISLAND_HYDRATION.some((value) => value === hydrate)) {
          issues.push(`Island ${JSON.stringify(name)} has invalid data-hydrate ${JSON.stringify(hydrate)}; use ${STOREFRONT_ISLAND_HYDRATION.join(", ")}.`);
        }
      }
    },
    onclosetag(tag) {
      open.pop();
      if (tag === "template" && templateDepth > 0) templateDepth -= 1;
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.end(html);
  return issues;
}
