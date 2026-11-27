/**
 * A cart line's reading order: the product's title comes first in the markup (so Tab, a screen reader and a copy of
 * the page read the title, then its details, price, quantity and actions), whatever order a theme's arrangement draws
 * the line in. Where the arrangement draws something before the title in the title's box (the options over the title),
 * the title moves to the front of that box and every child keeps its place on screen through CSS `order`. The image
 * (decorative: `alt=""`) may stay before it. Used by the cart page's line (`renderLineTemplate`) and the drawer's.
 */

/** A node of a line's arrangement (private-anatomy.ts), as the cart page and the drawer read it. */
export interface LineNode {
  type: string;
  part?: string;
  variant?: string;
  target?: string;
  layout?: string;
  hook?: string;
  children?: readonly LineNode[];
}

/** A node with the place it keeps on screen (`order`) where its box's markup was reordered. */
export type OrderedLineNode = LineNode & { order?: number; children?: readonly OrderedLineNode[] };

/** Tailwind's order steps, written out so the stylesheet carries them. */
export const LINE_ORDER_CLASSES = ["order-0", "order-1", "order-2", "order-3", "order-4", "order-5", "order-6", "order-7", "order-8", "order-9", "order-10", "order-11", "order-12"] as const;

const holdsTitle = (node: LineNode): boolean => (node.type === "part" && node.part === "title") || (node.type === "layout" && (node.children ?? []).some(holdsTitle));
const decorative = (node: LineNode) => node.type === "part" && node.part === "image";

/** The line's nodes with the title first in the markup of every box that holds it, each child's place kept by `order`. */
export function titleFirst(nodes: readonly LineNode[]): OrderedLineNode[] {
  const at = nodes.findIndex(holdsTitle);
  const children: OrderedLineNode[] = nodes.map((node) => node.type === "layout" && holdsTitle(node) ? { ...node, children: titleFirst(node.children ?? []) } : node);
  // Already first, or only the image before it: the markup reads the title first.
  if (at <= 0 || nodes.slice(0, at).every(decorative) || nodes.length > LINE_ORDER_CLASSES.length) return children;
  const ordered = children.map((node, index) => ({ ...node, order: index }));
  return [ordered[at]!, ...ordered.filter((_, index) => index !== at)];
}

/** Whether a box's children carry places of their own (its box then lays them out by `order`). */
export const reordered = (children: readonly OrderedLineNode[]) => children.some((child) => child.order !== undefined);

/** The class that keeps a node's place on screen, or "". */
export const orderClass = (node: OrderedLineNode) => node.order === undefined ? "" : LINE_ORDER_CLASSES[node.order]!;

/** A part's or a box's markup with its place on screen: the class on its first element. */
export function withOrder(html: string, order: number | undefined): string {
  if (order === undefined || !html) return html;
  const at = html.indexOf('class="');
  return at < 0 || at > html.indexOf(">") ? html.replace(/^<([a-z0-9]+)/i, `<$1 class="${LINE_ORDER_CLASSES[order]}"`) : `${html.slice(0, at + 7)}${LINE_ORDER_CLASSES[order]} ${html.slice(at + 7)}`;
}
