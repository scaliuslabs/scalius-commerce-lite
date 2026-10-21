// One builder for an app's `ui` trees (`@scalius/shared/plugins/ui`): the
// dashboard's pages, cards and widgets (admin surface) and the UI slots of
// the buyer's own pages (buyer surface, a storefront extension's answer).
// Plain functions that build the documented shapes (types only from
// `@scalius/shared`, so a packed plugin carries no schema code); the host
// validates what arrives against its surface.
//
//   routes: {
//     admin: {
//       overview: (request, ctx) => ({ body: ui.page([ui.stat("Wishes", 12)]) }),
//       "mark-done": (request) => ({ body: ui.result({ toast: "Done", refresh: true }) }),
//     },
//   },
//   functions: {
//     "checkout.actions.before": () => ({ ui: ui.view([ui.text("120 points"), ui.button("Redeem", ui.cart.applyCode("POINTS"))]) }),
//   }

import type {
  PluginAdminActionBody,
  PluginUiAction,
  PluginUiActionResult,
  PluginUiButton,
  PluginUiDocument,
  PluginUiImageSource,
  PluginUiNode,
  PluginUiRouteAction,
  PluginUiTarget,
  PluginUiTone,
} from "@scalius/shared/plugins";
import type { PluginRouteRequest } from "./context";

type NodeOf<T extends PluginUiNode["type"]> = Extract<PluginUiNode, { type: T }>;
type Options<T extends PluginUiNode["type"], Omitted extends string = never> = Omit<NodeOf<T>, "type" | Omitted>;

/** A UI document: what admin routes and storefront extensions answer. */
function document(root: PluginUiNode): PluginUiDocument {
  return { version: 1, root };
}

export const ui = {
  /** A full app page (admin); `children` are its sections, cards and tables. */
  page: (children: PluginUiNode[], options: Options<"page", "children"> = {}) => document({ type: "page", ...options, children }),
  /** A resource card or home widget body (admin), or a UI slot's content (buyer). */
  view: (children: PluginUiNode[]) => document({ type: "stack", children }),
  section: (title: string, children: PluginUiNode[], options: Options<"section", "children" | "title"> = {}): PluginUiNode => ({ type: "section", title, ...options, children }),
  card: (title: string, children: PluginUiNode[], options: Options<"card", "children" | "title"> = {}): PluginUiNode => ({ type: "card", title, ...options, children }),
  stack: (children: PluginUiNode[], options: Options<"stack", "children"> = {}): PluginUiNode => ({ type: "stack", ...options, children }),
  columns: (children: PluginUiNode[]): PluginUiNode => ({ type: "columns", children }),
  heading: (text: string, level: 2 | 3 | 4 = 2): PluginUiNode => ({ type: "heading", text, level }),
  text: (text: string, options: Options<"text", "text"> = {}): PluginUiNode => ({ type: "text", text, ...options }),
  badge: (text: string, tone: PluginUiTone = "neutral"): PluginUiNode => ({ type: "badge", text, tone }),
  banner: (tone: PluginUiTone, text: string, options: Options<"banner", "tone" | "text"> = {}): PluginUiNode => ({ type: "banner", tone, text, ...options }),
  keyValue: (items: NodeOf<"key-value">["items"]): PluginUiNode => ({ type: "key-value", items }),
  stat: (label: string, value: string | number, help?: string): PluginUiNode => ({ type: "stat", label, value, ...(help ? { help } : {}) }),
  /**
   * A progress bar at `value` of `max` with its percentage (admin), e.g. a
   * background job's `progress.done` of `progress.total`. `live: true`
   * makes the dashboard read the surface again every few seconds while it is
   * shown, so the bar moves on its own; leave it off once the job is done.
   */
  progress: (label: string, value: number, max: number, options: Options<"progress", "label" | "value" | "max"> = {}): PluginUiNode =>
    ({ type: "progress", label, value, max, ...options }),
  table: (options: Options<"table">): PluginUiNode => ({ type: "table", ...options }),
  empty: (title: string, options: Options<"empty-state", "title"> = {}): PluginUiNode => ({ type: "empty-state", title, ...options }),
  /** An https URL (admin), or `{ media }` / `{ app: "public/…" }` (buyer). */
  image: (src: PluginUiImageSource, alt: string, options: Options<"image", "src" | "alt"> = {}): PluginUiNode => ({ type: "image", src, alt, ...options }),
  link: (text: string, to: PluginUiTarget): PluginUiNode => ({ type: "link", text, to }),
  divider: (): PluginUiNode => ({ type: "divider" }),
  /** A button: `ui.route(…)`, `ui.navigate(…)` or a `ui.cart.*` operation. */
  button: (label: string, action: PluginUiAction, options: Omit<PluginUiButton, "type" | "label" | "action"> = {}): PluginUiButton =>
    ({ type: "button", label, action, ...options }),
  /** A form (admin) that sends its values to one of this app's routes. */
  form: (action: PluginUiRouteAction, submitLabel: string, children: PluginUiNode[], options: Options<"form", "action" | "submitLabel" | "children"> = {}): PluginUiNode =>
    ({ type: "form", action, submitLabel, ...options, children }),
  textField: (name: string, label: string, options: Options<"text-field", "name" | "label"> = {}): PluginUiNode => ({ type: "text-field", name, label, ...options }),
  textarea: (name: string, label: string, options: Options<"textarea", "name" | "label"> = {}): PluginUiNode => ({ type: "textarea", name, label, ...options }),
  numberField: (name: string, label: string, options: Options<"number-field", "name" | "label"> = {}): PluginUiNode => ({ type: "number-field", name, label, ...options }),
  select: (name: string, label: string, options: NodeOf<"select">["options"], rest: Options<"select", "name" | "label" | "options"> = {}): PluginUiNode =>
    ({ type: "select", name, label, options, ...rest }),
  checkbox: (name: string, label: string, options: Options<"checkbox", "name" | "label"> = {}): PluginUiNode => ({ type: "checkbox", name, label, ...options }),
  dateField: (name: string, label: string, options: Options<"date-field", "name" | "label"> = {}): PluginUiNode => ({ type: "date-field", name, label, ...options }),
  /** One of the app's `checkout.attributes`, drawn as the store's own input (buyer). */
  field: (attribute: string): PluginUiNode => ({ type: "field", attribute }),
  /** A request to one of this app's routes: an admin route (admin), a public route through the store's proxy (buyer). */
  route: (route: string, options: Omit<PluginUiRouteAction, "kind" | "route"> = {}): PluginUiRouteAction => ({ kind: "route", route, ...options }),
  /** Opens a page (`ui.to.*`). */
  navigate: (to: PluginUiTarget): PluginUiAction => ({ kind: "navigate", to }),
  /** Cart operations (buyer, on the cart and checkout pages). */
  cart: {
    addLine: (variantId: string, quantity = 1): PluginUiAction => ({ kind: "cart", op: "add_line", variantId, quantity }),
    applyCode: (code: string): PluginUiAction => ({ kind: "cart", op: "apply_code", code }),
    /** Sets one of the app's checkout attributes. */
    setAttribute: (key: string, value: string): PluginUiAction => ({ kind: "cart", op: "set_attribute", key, value }),
  },
  /** Where links go: a Scalius resource page, one of this app's pages or an https site (admin); a path on the store (buyer). */
  to: {
    resource: (resource: Extract<PluginUiTarget, { kind: "resource" }>["resource"], id: string): PluginUiTarget => ({ kind: "resource", resource, id }),
    page: (page: string, query?: Record<string, string>): PluginUiTarget => ({ kind: "app-page", page, ...(query ? { query } : {}) }),
    external: (href: string): PluginUiTarget => ({ kind: "external", href }),
    store: (path: string): PluginUiTarget => ({ kind: "store", path }),
  },
  /** What a button's or form's admin route answers. */
  result: (result: Omit<PluginUiActionResult, "toast"> & { toast?: string | PluginUiActionResult["toast"] }): PluginUiActionResult => {
    const { toast, ...rest } = result;
    return { ...rest, ...(toast === undefined ? {} : { toast: typeof toast === "string" ? { message: toast, tone: "success" } : toast }) };
  },
};

/** What a dashboard request is about: the card's or action's resource, the selected ids, a table cursor, form values. */
export interface PluginAdminContext {
  /** `order`, `product`, … for a card or an action; null for pages and widgets. */
  resource: string | null;
  /** The resource a card is shown for, or the one resource of a detail-page action. */
  id: string | null;
  /** Every resource an action runs on (one for a detail page, many for a bulk action). */
  ids: string[];
  /** The manifest action id of an action request. */
  action: string | null;
  /** A table's pagination cursor. */
  cursor: string | null;
  /** A form's values by input name. */
  values: Record<string, unknown>;
  /**
   * The staff member's dashboard language (the dashboard sends it as
   * `Accept-Language`): write the screen's headings, labels and messages in
   * it. The manifest's own titles take `translations`.
   */
  locale: PluginAdminLocale;
}

/** Dashboard languages. */
export type PluginAdminLocale = "en" | "bn";

/** The dashboard's language from a request's `Accept-Language` (English unless Bangla leads). */
export function adminLocale(request: Pick<PluginRouteRequest, "headers">): PluginAdminLocale {
  return /^\s*bn\b/i.test(request.headers["accept-language"] ?? "") ? "bn" : "en";
}

/** Reads the dashboard's request: GET carries `resource`, `id` and `cursor` in the query; actions send `{ resource, ids, action, values }`. */
export function adminContext(request: PluginRouteRequest): PluginAdminContext {
  const body = (typeof request.body === "object" && request.body !== null ? request.body : {}) as Partial<PluginAdminActionBody> & Record<string, unknown>;
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string").slice(0, 250) : [];
  const resource = typeof body.resource === "string" ? body.resource : request.query.resource ?? null;
  const id = request.query.id ?? (ids.length === 1 ? ids[0]! : null);
  return {
    resource,
    id,
    ids: ids.length > 0 ? ids : id ? [id] : [],
    action: typeof body.action === "string" ? body.action : null,
    cursor: request.query.cursor ?? null,
    values: typeof body.values === "object" && body.values !== null && !Array.isArray(body.values) ? body.values as Record<string, unknown> : {},
    locale: adminLocale(request),
  };
}

/** Whether a proxied request is a browser navigation that wants a page (answer `{ page }` or `{ redirect }`). */
export function wantsPage(request: PluginRouteRequest): boolean {
  return (request.headers.accept ?? "").includes("text/html");
}
