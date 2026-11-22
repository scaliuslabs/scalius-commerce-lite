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
