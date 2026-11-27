// The store's mark that a release's buyer-page sheet (`buyer-chrome.css`,
// the store's own reading of the app's `styles.css`, buyer-chrome-css.ts) is
// this checker's reading: which checker version wrote or checked it again,
// and the file's SHA-256, or why that checker would not draw it. The API
// writes it when it installs a release (whose upload ran the checker) and
// again in its maintenance run after a deploy whose checker is newer; it
// serves the file to the storefront only under a current mark, with the
// mark's checker version beside it, and the storefront draws only a file of
// its own checker version. A buyer's request never parses a sheet: it reads
// the file the mark allows, or draws the store's own chrome.

import { BUYER_CHROME_CSS_VERSION } from "./buyer-chrome-css";

/** The response header the API serves a release's `buyer-chrome.css` with: the checker version of its mark. */
export const BUYER_CHROME_CHECKER_HEADER = "X-Scalius-Buyer-Chrome-Checker";

/** The marks' prefix in `system_kv`. */
export const BUYER_CHROME_MARK_PREFIX = "buyer-chrome:";

/**
 * Allowed (`sha256`), refused (`problem`), or a check begun that has not ended
 * (`tries`: a run that started it and was stopped, a CPU limit, before it wrote either).
 */
export type BuyerChromeMark = { checker: number; sha256: string } | { checker: number; problem: string } | { checker: number; tries: number };

/** The `system_kv` key of one release's mark. */
export function buyerChromeMarkKey(pluginId: string, release: string): string {
  return `${BUYER_CHROME_MARK_PREFIX}${pluginId}:${release}`;
}

/** A stored mark, or null when there is none or it does not read. */
export function readBuyerChromeMark(value: string | null | undefined): BuyerChromeMark | null {
  if (!value) return null;
  try {
    const mark = JSON.parse(value) as Record<string, unknown>;
    if (typeof mark.checker !== "number" || !Number.isInteger(mark.checker)) return null;
    if (typeof mark.sha256 === "string" && /^[0-9a-f]{64}$/.test(mark.sha256)) return { checker: mark.checker, sha256: mark.sha256 };
    if (typeof mark.problem === "string") return { checker: mark.checker, problem: mark.problem.slice(0, 300) };
    if (typeof mark.tries === "number" && Number.isInteger(mark.tries) && mark.tries > 0) return { checker: mark.checker, tries: mark.tries };
    return null;
  } catch {
    return null;
  }
}

/** Whether the mark lets this checker's store draw the file with this hash. */
export function buyerChromeMarkAllows(mark: BuyerChromeMark | null, sha256: string): boolean {
  return mark !== null && mark.checker === BUYER_CHROME_CSS_VERSION && "sha256" in mark && mark.sha256 === sha256;
}

/** Whether this checker has judged the release (drawn or refused): nothing to check again. */
export function buyerChromeMarkCurrent(mark: BuyerChromeMark | null): boolean {
  return mark !== null && mark.checker === BUYER_CHROME_CSS_VERSION && !("tries" in mark);
}

/** The checks this checker began on the release without ending them. */
export function buyerChromeMarkTries(mark: BuyerChromeMark | null): number {
  return mark !== null && mark.checker === BUYER_CHROME_CSS_VERSION && "tries" in mark ? mark.tries : 0;
}
