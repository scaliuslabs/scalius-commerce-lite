// Declarative dashboard UI for plugins (docs/platform/PLUGINS.md, "Admin
// surfaces"). A plugin never ships JavaScript to the dashboard: its admin
// routes answer with a small typed tree, and the dashboard draws that tree
// from its own components. Text is always plain text (never HTML), links go
// only to this app's pages, Scalius resource pages or https sites, and every
// button and form posts only to one of the app's own declared admin routes.
//
//   { version: 1, root: { type: "page", children: [ { type: "table", … } ] } }
//
// Strict, bounded and versioned: within `PLUGIN_UI_VERSION` the tree changes
// only additively; a dashboard that meets a newer version says so instead of
// guessing. Part of the versioned plugin API.

import { z } from "zod";
import { PLUGIN_URL_NAME_PATTERN, PLUGIN_URL_NAME_RULE } from "./manifest-patterns";

export const PLUGIN_UI_VERSION = 1 as const;

/** Bounds of one tree: the dashboard refuses anything larger. */
export const PLUGIN_UI_LIMITS = {
  /** Every node, inputs and table cells excluded. */
  maxNodes: 400,
  /** Nesting depth of layout nodes (the root is depth 1). */
  maxDepth: 10,
  maxChildren: 100,
  maxTableColumns: 12,
  maxTableRows: 100,
  maxOptions: 100,
  maxKeyValueItems: 50,
  /** JSON bytes of the whole document. */
  maxBytes: 256 * 1024,
  text: 2000,
  label: 120,
} as const;

/** Badge, banner and text tones (DESIGN.md status colors). */
export const PLUGIN_UI_TONES = ["neutral", "info", "success", "warning", "critical"] as const;
export type PluginUiTone = (typeof PLUGIN_UI_TONES)[number];

/** Scalius pages a link can open (each a resource's detail page). */
export const PLUGIN_UI_RESOURCES = ["product", "order", "customer", "category", "collection", "brand", "page"] as const;
export type PluginUiResource = (typeof PLUGIN_UI_RESOURCES)[number];

/** Methods a button or form may use against the app's own admin route. */
export const PLUGIN_UI_ACTION_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
export type PluginUiActionMethod = (typeof PLUGIN_UI_ACTION_METHODS)[number];

// ── Shared pieces ─────────────────────────────────────────────────────────

const text = z.string().max(PLUGIN_UI_LIMITS.text);
const label = z.string().trim().min(1).max(PLUGIN_UI_LIMITS.label);
const optionalLabel = z.string().trim().max(PLUGIN_UI_LIMITS.label);
const tone = z.enum(PLUGIN_UI_TONES);
const recordId = z.string().trim().min(1).max(128);
const routeName = z.string().regex(PLUGIN_URL_NAME_PATTERN, PLUGIN_URL_NAME_RULE);
/** Path segments after a route name: letters, digits and `-_.~`, never dot segments. */
const subpath = z.string().max(256).regex(/^(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*)(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*$/, "Use plain path segments.");
const queryValue = z.string().max(512);
const query = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/), queryValue)
  .refine((value) => Object.keys(value).length <= 20, "At most 20 query values.");
/** An https URL without credentials. */
const httpsUrl = z.string().max(2048).url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, "Use an https:// address.");

type JsonPrimitive = string | number | boolean | null;
export type PluginUiJson = JsonPrimitive | PluginUiJson[] | { [key: string]: PluginUiJson };
const json: z.ZodType<PluginUiJson> = z.lazy(() =>
  z.union([z.string().max(PLUGIN_UI_LIMITS.text), z.number().finite(), z.boolean(), z.null(), z.array(json).max(100), z.record(z.string().max(64), json)]));

/**
 * Where a link goes: one of this app's pages (by manifest page id), a
 * Scalius resource's detail page, or an https site (a new tab).
 */
export const pluginUiTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("app-page"), page: z.string().regex(PLUGIN_URL_NAME_PATTERN, PLUGIN_URL_NAME_RULE), query: query.optional() }).strict(),
  z.object({ kind: z.literal("resource"), resource: z.enum(PLUGIN_UI_RESOURCES), id: recordId }).strict(),
  z.object({ kind: z.literal("external"), href: httpsUrl }).strict(),
]);
export type PluginUiTarget = z.infer<typeof pluginUiTargetSchema>;

/**
 * A request to the app's own admin route (`/api/v1/plugins/<id>/admin/<route>[/<subpath>]`),
 * with a JSON body. Forms add their values under `values`.
 */
export const pluginUiRouteActionSchema = z.object({
  route: routeName,
  subpath: subpath.optional(),
  method: z.enum(PLUGIN_UI_ACTION_METHODS).default("POST"),
  body: z.record(z.string().max(64), json).optional(),
}).strict();
export type PluginUiRouteAction = z.input<typeof pluginUiRouteActionSchema>;

/** Asked before a button or form sends anything. */
export const pluginUiConfirmSchema = z.object({
  title: label,
  text: text.optional(),
  confirmLabel: label.optional(),
  /** Draw the confirm button as destructive. */
  destructive: z.boolean().optional(),
}).strict();

// ── Node types ────────────────────────────────────────────────────────────

export interface PluginUiButton {
  type: "button";
  label: string;
  tone?: "primary" | "secondary" | "critical";
  /** Sends a request to the app's admin route (exactly one of action and to). */
  action?: PluginUiRouteAction;
  /** Opens a page instead. */
  to?: PluginUiTarget;
  confirm?: z.infer<typeof pluginUiConfirmSchema>;
  disabled?: boolean;
}

export type PluginUiCell =
  | string
  | number
  | boolean
  | null
  | { badge: string; tone?: PluginUiTone }
  | { text: string; to: PluginUiTarget }
  /** An amount in integer minor units of the store currency (or `currency`). */
  | { money: number; currency?: string }
  /** An ISO date or date-time, shown in the dashboard's locale. */
  | { date: string };

export interface PluginUiTableColumn {
  key: string;
  label: string;
  align?: "start" | "end";
}

export interface PluginUiTableRow {
  id?: string;
  cells: Record<string, PluginUiCell>;
  /** The row opens this page. */
  to?: PluginUiTarget;
}

interface InputBase {
  /** The key the value is sent under, unique within its form. */
  name: string;
  label: string;
  help?: string;
  required?: boolean;
  /** A validation message from the app (shown under the input). */
  error?: string;
  disabled?: boolean;
}

export type PluginUiInput =
  | (InputBase & { type: "text-field"; value?: string; placeholder?: string; minLength?: number; maxLength?: number; format?: "text" | "email" | "url" | "tel" })
  | (InputBase & { type: "textarea"; value?: string; placeholder?: string; maxLength?: number; rows?: number })
  | (InputBase & { type: "number-field"; value?: number | null; min?: number; max?: number; step?: number; integer?: boolean })
  | (InputBase & { type: "select"; value?: string | null; options: Array<{ value: string; label: string }>; placeholder?: string })
  | (InputBase & { type: "checkbox"; value?: boolean })
  /** `YYYY-MM-DD`. */
  | (InputBase & { type: "date-field"; value?: string | null; min?: string; max?: string });

export type PluginUiNode =
  | { type: "page"; title?: string; description?: string; actions?: PluginUiButton[]; children: PluginUiNode[] }
  | { type: "section"; title?: string; description?: string; children: PluginUiNode[] }
  | { type: "card"; title?: string; description?: string; actions?: PluginUiButton[]; children: PluginUiNode[] }
  | { type: "stack"; direction?: "vertical" | "horizontal"; gap?: "sm" | "md" | "lg"; children: PluginUiNode[] }
  | { type: "columns"; children: PluginUiNode[] }
  | { type: "heading"; text: string; level?: 2 | 3 | 4 }
  | { type: "text"; text: string; tone?: PluginUiTone; size?: "sm" | "md"; emphasis?: "strong" | "mono" }
  | { type: "badge"; text: string; tone?: PluginUiTone }
  | { type: "banner"; tone: PluginUiTone; title?: string; text?: string; actions?: PluginUiButton[] }
  | { type: "key-value"; items: Array<{ label: string; value: string | number | boolean | null; tone?: PluginUiTone }> }
  | { type: "stat"; label: string; value: string | number; help?: string }
  | { type: "table"; caption?: string; columns: PluginUiTableColumn[]; rows: PluginUiTableRow[]; pagination?: { previous?: string | null; next?: string | null; total?: number | null }; empty?: { title: string; text?: string } }
  | { type: "empty-state"; title: string; text?: string; action?: PluginUiButton }
  | { type: "image"; src: string; alt: string; width?: number; height?: number }
  | { type: "link"; text: string; to: PluginUiTarget }
  | { type: "divider" }
  | PluginUiButton
  | { type: "form"; action: PluginUiRouteAction; submitLabel: string; confirm?: z.infer<typeof pluginUiConfirmSchema>; children: PluginUiNode[] }
  | PluginUiInput;

export type PluginUiNodeType = PluginUiNode["type"];

const buttonSchema = z.object({
  type: z.literal("button"),
  label,
  tone: z.enum(["primary", "secondary", "critical"]).optional(),
  action: pluginUiRouteActionSchema.optional(),
  to: pluginUiTargetSchema.optional(),
  confirm: pluginUiConfirmSchema.optional(),
  disabled: z.boolean().optional(),
}).strict().refine((button) => (button.action === undefined) !== (button.to === undefined), "A button has either an action or a link.");

const buttons = z.array(buttonSchema).max(5);
const cellSchema = z.union([
  z.string().max(PLUGIN_UI_LIMITS.text),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.object({ badge: optionalLabel, tone: tone.optional() }).strict(),
  z.object({ text: z.string().max(PLUGIN_UI_LIMITS.label * 2), to: pluginUiTargetSchema }).strict(),
  z.object({ money: z.number().int().safe(), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).strict(),
  z.object({ date: z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), "Use an ISO date.") }).strict(),
]);
const columnKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,47}$/);
const tableSchema = z.object({
  type: z.literal("table"),
  caption: optionalLabel.optional(),
  columns: z.array(z.object({ key: columnKey, label: optionalLabel, align: z.enum(["start", "end"]).optional() }).strict())
    .min(1).max(PLUGIN_UI_LIMITS.maxTableColumns),
  rows: z.array(z.object({
    id: recordId.optional(),
    cells: z.record(columnKey, cellSchema),
    to: pluginUiTargetSchema.optional(),
  }).strict()).max(PLUGIN_UI_LIMITS.maxTableRows),
  pagination: z.object({
    previous: z.string().max(512).nullable().optional(),
    next: z.string().max(512).nullable().optional(),
    total: z.number().int().min(0).nullable().optional(),
  }).strict().optional(),
  empty: z.object({ title: label, text: text.optional() }).strict().optional(),
}).strict().superRefine((table, context) => {
  const keys = table.columns.map((column) => column.key);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["columns"], message: "Column keys must be unique." });
  table.rows.forEach((row, index) => {
    const unknown = Object.keys(row.cells).find((key) => !keys.includes(key));
    if (unknown) context.addIssue({ code: "custom", path: ["rows", index, "cells", unknown], message: `Unknown column ${unknown}.` });
  });
});

const inputBase = {
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
  label,
  help: text.optional(),
  required: z.boolean().optional(),
  error: optionalLabel.optional(),
  disabled: z.boolean().optional(),
};
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const inputSchemas = [
  z.object({
    ...inputBase,
    type: z.literal("text-field"),
    value: z.string().max(PLUGIN_UI_LIMITS.text).optional(),
    placeholder: optionalLabel.optional(),
    minLength: z.number().int().min(0).max(PLUGIN_UI_LIMITS.text).optional(),
    maxLength: z.number().int().min(1).max(PLUGIN_UI_LIMITS.text).optional(),
    format: z.enum(["text", "email", "url", "tel"]).optional(),
  }).strict(),
  z.object({
    ...inputBase,
    type: z.literal("textarea"),
    value: z.string().max(10_000).optional(),
    placeholder: optionalLabel.optional(),
    maxLength: z.number().int().min(1).max(10_000).optional(),
    rows: z.number().int().min(2).max(20).optional(),
  }).strict(),
  z.object({
    ...inputBase,
    type: z.literal("number-field"),
    value: z.number().finite().nullable().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().finite().positive().optional(),
    integer: z.boolean().optional(),
  }).strict(),
  z.object({
    ...inputBase,
    type: z.literal("select"),
    value: z.string().max(128).nullable().optional(),
    options: z.array(z.object({ value: z.string().min(1).max(128), label }).strict()).min(1).max(PLUGIN_UI_LIMITS.maxOptions),
    placeholder: optionalLabel.optional(),
  }).strict(),
  z.object({ ...inputBase, type: z.literal("checkbox"), value: z.boolean().optional() }).strict(),
  z.object({ ...inputBase, type: z.literal("date-field"), value: isoDate.nullable().optional(), min: isoDate.optional(), max: isoDate.optional() }).strict(),
] as const;

/** Input node types: valid only inside a form. */
export const PLUGIN_UI_INPUT_TYPES = ["text-field", "textarea", "number-field", "select", "checkbox", "date-field"] as const;

const children = z.array(z.lazy(() => pluginUiNodeSchema)).max(PLUGIN_UI_LIMITS.maxChildren);

export const pluginUiNodeSchema: z.ZodType<PluginUiNode> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("page"), title: optionalLabel.optional(), description: text.optional(), actions: buttons.optional(), children }).strict(),
  z.object({ type: z.literal("section"), title: optionalLabel.optional(), description: text.optional(), children }).strict(),
  z.object({ type: z.literal("card"), title: optionalLabel.optional(), description: text.optional(), actions: buttons.optional(), children }).strict(),
  z.object({
    type: z.literal("stack"),
    direction: z.enum(["vertical", "horizontal"]).optional(),
    gap: z.enum(["sm", "md", "lg"]).optional(),
    children,
  }).strict(),
  z.object({ type: z.literal("columns"), children: z.array(z.lazy(() => pluginUiNodeSchema)).min(1).max(4) }).strict(),
  z.object({ type: z.literal("heading"), text: label, level: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional() }).strict(),
  z.object({
    type: z.literal("text"),
    text,
    tone: tone.optional(),
    size: z.enum(["sm", "md"]).optional(),
    emphasis: z.enum(["strong", "mono"]).optional(),
  }).strict(),
  z.object({ type: z.literal("badge"), text: label, tone: tone.optional() }).strict(),
  z.object({ type: z.literal("banner"), tone, title: optionalLabel.optional(), text: text.optional(), actions: buttons.optional() }).strict(),
  z.object({
    type: z.literal("key-value"),
    items: z.array(z.object({
      label,
      value: z.union([z.string().max(PLUGIN_UI_LIMITS.text), z.number().finite(), z.boolean(), z.null()]),
      tone: tone.optional(),
    }).strict()).max(PLUGIN_UI_LIMITS.maxKeyValueItems),
  }).strict(),
  z.object({ type: z.literal("stat"), label, value: z.union([z.string().max(PLUGIN_UI_LIMITS.label), z.number().finite()]), help: optionalLabel.optional() }).strict(),
  tableSchema,
  z.object({ type: z.literal("empty-state"), title: label, text: text.optional(), action: buttonSchema.optional() }).strict(),
  z.object({
    type: z.literal("image"),
    src: httpsUrl,
    alt: z.string().max(PLUGIN_UI_LIMITS.label * 2),
    width: z.number().int().min(1).max(4000).optional(),
    height: z.number().int().min(1).max(4000).optional(),
  }).strict(),
  z.object({ type: z.literal("link"), text: label, to: pluginUiTargetSchema }).strict(),
  z.object({ type: z.literal("divider") }).strict(),
  buttonSchema,
  z.object({
    type: z.literal("form"),
    action: pluginUiRouteActionSchema,
    submitLabel: label,
    confirm: pluginUiConfirmSchema.optional(),
    children,
  }).strict(),
  ...inputSchemas,
])) as z.ZodType<PluginUiNode>;

/** What an admin page, card or widget route answers: the tree and its version. */
export interface PluginUiDocument {
  version: typeof PLUGIN_UI_VERSION;
  root: PluginUiNode;
}

/** The child lists of a node (actions excluded: buttons are leaves). */
function childNodes(node: PluginUiNode): readonly PluginUiNode[] {
  switch (node.type) {
    case "page":
    case "section":
    case "card":
    case "stack":
    case "columns":
    case "form":
      return node.children;
    default:
      return [];
  }
}

function attachedButtons(node: PluginUiNode): readonly PluginUiButton[] {
  switch (node.type) {
    case "page":
    case "card":
    case "banner":
      return node.actions ?? [];
    case "empty-state":
      return node.action ? [node.action] : [];
    default:
      return [];
  }
}

/** Every route action in the tree: buttons and forms (the dashboard checks each against the app's declared routes). */
export function pluginUiRouteActions(root: PluginUiNode): PluginUiRouteAction[] {
  const actions: PluginUiRouteAction[] = [];
  const visit = (node: PluginUiNode) => {
    if (node.type === "button" && node.action) actions.push(node.action);
    if (node.type === "form") actions.push(node.action);
    for (const button of attachedButtons(node)) if (button.action) actions.push(button.action);
    childNodes(node).forEach(visit);
  };
  visit(root);
  return actions;
}

const inputTypes = new Set<string>(PLUGIN_UI_INPUT_TYPES);

/** Structural rules zod cannot say: size, depth, pages only at the root, inputs only in forms, unique input names. */
function checkTree(root: PluginUiNode, context: z.RefinementCtx): void {
  let nodes = 0;
  let reported = false;
  const report = (path: (string | number)[], message: string) => {
    if (reported) return;
    reported = true;
    context.addIssue({ code: "custom", path, message });
  };
  const visit = (node: PluginUiNode, depth: number, path: (string | number)[], inForm: Set<string> | null) => {
    nodes += 1 + attachedButtons(node).length;
    if (nodes > PLUGIN_UI_LIMITS.maxNodes) return report(path, `A tree has at most ${PLUGIN_UI_LIMITS.maxNodes} nodes.`);
    if (depth > PLUGIN_UI_LIMITS.maxDepth) return report(path, `A tree nests at most ${PLUGIN_UI_LIMITS.maxDepth} levels.`);
    if (node.type === "page" && depth !== 1) return report(path, "A page is only ever the root.");
    if (inputTypes.has(node.type)) {
      if (!inForm) return report(path, "Inputs belong inside a form.");
      const name = (node as PluginUiInput).name;
      if (inForm.has(name)) return report([...path, "name"], `Two inputs are named ${name}.`);
      inForm.add(name);
    }
    if (node.type === "form" && inForm) return report(path, "Forms do not nest.");
    if (node.type === "number-field" && node.min !== undefined && node.max !== undefined && node.min > node.max) {
      return report([...path, "min"], "min must not exceed max.");
    }
    if (node.type === "select" && node.value != null && !node.options.some((option) => option.value === node.value)) {
      return report([...path, "value"], "The value must be one of the options.");
    }
    const formNames = node.type === "form" ? new Set<string>() : inForm;
    childNodes(node).forEach((child, index) => visit(child, depth + 1, [...path, "children", index], formNames));
  };
  visit(root, 1, ["root"], null);
}

export const pluginUiDocumentSchema = z.object({
  version: z.literal(PLUGIN_UI_VERSION),
  root: pluginUiNodeSchema,
}).strict().superRefine((document, context) => checkTree(document.root, context));

export type PluginUiParseResult =
  | { ok: true; document: PluginUiDocument }
  | { ok: false; reason: "version" | "invalid" | "too_large"; issues: Array<{ path: string; message: string }> };

/**
 * Parses what an admin route answered as a UI document. A newer `version`
 * is reported as such (the dashboard asks for an update instead of drawing a
 * guess); anything else invalid lists its first issues.
 */
export function parsePluginUiDocument(value: unknown): PluginUiParseResult {
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
  } catch {
    return { ok: false, reason: "invalid", issues: [{ path: "(root)", message: "The answer is not JSON." }] };
  }
  if (bytes > PLUGIN_UI_LIMITS.maxBytes) {
    return { ok: false, reason: "too_large", issues: [{ path: "(root)", message: "The answer is larger than 256 KiB." }] };
  }
  const version = typeof value === "object" && value !== null ? (value as { version?: unknown }).version : undefined;
  if (typeof version === "number" && version > PLUGIN_UI_VERSION) {
    return { ok: false, reason: "version", issues: [{ path: "version", message: `UI version ${version} is newer than this dashboard.` }] };
  }
  const parsed = pluginUiDocumentSchema.safeParse(value);
  if (parsed.success) return { ok: true, document: parsed.data as PluginUiDocument };
  return {
    ok: false,
    reason: "invalid",
    issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join(".") || "(root)", message: issue.message })),
  };
}

// ── Action results ────────────────────────────────────────────────────────

/**
 * What a button's or form's route may answer (any other JSON is treated as
 * an empty result): a toast, validation messages by input name, a refresh
 * of the surface that sent it, a page to open, or a replacement tree.
 */
export const pluginUiActionResultSchema = z.object({
  toast: z.object({ message: label, tone: z.enum(["success", "info", "critical"]).optional() }).strict().optional(),
  errors: z.record(z.string().max(64), optionalLabel).optional(),
  refresh: z.boolean().optional(),
  navigate: pluginUiTargetSchema.optional(),
  ui: pluginUiDocumentSchema.optional(),
}).strict();
export type PluginUiActionResult = z.infer<typeof pluginUiActionResultSchema>;

/** An action's answer, or an empty result when it is not one (a plain `{ ok: true }` refreshes nothing). */
export function parsePluginUiActionResult(value: unknown): PluginUiActionResult {
  const parsed = pluginUiActionResultSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

// ── What the dashboard sends ──────────────────────────────────────────────

/**
 * The query a card, widget or page request carries, and the JSON body of a
 * resource action (`ids` for a bulk action, one id otherwise). Plugins read
 * them with the SDK's `adminContext(request)`.
 */
export const PLUGIN_ADMIN_QUERY = {
  /** The resource type a card or action is attached to (`order`). */
  resource: "resource",
  /** The resource id a card is shown for. */
  id: "id",
  /** A table's pagination cursor. */
  cursor: "cursor",
  /** The widget or card id (manifest) that asked. */
  surface: "surface",
} as const;

export interface PluginAdminActionBody {
  /** The resource type the action is attached to. */
  resource: string;
  /** The resources it runs on: one for a detail-page action, up to 250 for a bulk action. */
  ids: string[];
  /** The manifest action id. */
  action: string;
  /** A form's values, by input name. */
  values?: Record<string, PluginUiJson>;
}

/** Most resources one bulk action runs on. */
export const PLUGIN_BULK_ACTION_MAX_IDS = 250;
