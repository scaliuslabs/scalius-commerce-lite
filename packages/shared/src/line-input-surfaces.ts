// Where the host draws an app line input's control: a leaf, so the cart's
// controls and the buy form check it without the line-property module.

/**
 * Where the host draws its own control for an app's line input: `product`,
 * the product page's buy form (and quick add's form); `cart`, the line's
 * control on the cart page and in the drawer (with the input's bulk
 * actions). Absent: both. An input drawn on neither (`[]`) is set by its
 * app's own buyer UI (`cart.line.after`, a `set_line_input` button) or
 * island; checkout, its decision and the no-script checkout treat it like
 * any other input.
 */
export const LINE_INPUT_SURFACES = ["product", "cart"] as const;
export type LineInputSurface = (typeof LINE_INPUT_SURFACES)[number];

/** Whether the host draws its own control for the input on `surface` (`surfaces` absent: everywhere). */
export function lineInputDrawnOn(input: { surfaces?: readonly LineInputSurface[] }, surface: LineInputSurface): boolean {
  return input.surfaces === undefined || input.surfaces.includes(surface);
}

/**
 * A choice its own app draws: an input on no surface of the store (`[]`) that
 * is a select or a checkbox. Its answer carries `appDrawnChoice` from where the
 * declaration is known (the cart's answer, checkout's frozen entry), so every
 * surface decides from the answer alone (`printedLineAnswers`).
 */
export function isAppDrawnChoice(input: { type: string; surfaces?: readonly LineInputSurface[] }): boolean {
  return input.surfaces?.length === 0 && (input.type === "select" || input.type === "checkbox");
}

/** The app of an app-scoped key (`<app id>.<key>`): everything before its last dot; null for the product's own keys. */
function keyAppId(key: string): string | null {
  const dot = key.lastIndexOf(".");
  return dot > 0 ? key.slice(0, dot) : null;
}

/**
 * The answers the store prints under a line. An app-drawn choice is the app's
 * to state: on a line where the same app also charged an add-on (`addOnApps`,
 * the apps of the line's add-on rows), that row says it and the store prints
 * no answer beside it, never "Protection: Added" next to "Add-on: Account
 * protection (+৳350)". With no add-on of that app on the line (declined, or not
 * priced yet) the answer shows; a buyer's own words (text, a file) and an input
 * the store draws always show.
 */
export function printedLineAnswers<T extends { key: string; appId?: string; appDrawnChoice?: true }>(
  answers: readonly T[],
  addOnApps: Iterable<string | null | undefined>,
): T[] {
  const charged = new Set([...addOnApps].filter((appId): appId is string => typeof appId === "string" && appId.length > 0));
  if (charged.size === 0) return [...answers];
  return answers.filter((answer) => {
    if (answer.appDrawnChoice !== true) return true;
    const appId = answer.appId ?? keyAppId(answer.key);
    return appId === null || !charged.has(appId);
  });
}
