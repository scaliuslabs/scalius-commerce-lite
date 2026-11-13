// What a person approves when an agent asks: which operations need their
// approval, and the fields of an operation's input the approval page shows.
// The API writes an approval's rows from these (apps/api/src/agent-access/
// mcp/confirm-summary.ts), and the dashboard's census holds its approval
// copy (en and bn) to every field and value they can carry, so a change the
// page cannot put in words cannot be approved there.
import { resolveComponentSchemaRef, type ComponentSchemas } from "./openapi-schema-refs";

/**
 * Why a write needs a person's approval, strictest first:
 * - `financial`: it moves or forgoes money, or changes who is paid or what is charged;
 * - `destructive`: it deletes, trashes or archives;
 * - `security`: it changes access keys, roles, webhooks or platform origins;
 * - `reviewed`: an ordinary write the registry marks `confirmation: "required"`
 *   (closing or cancelling a document).
 */
export type ApprovalClass = "financial" | "destructive" | "security" | "reviewed";
export const APPROVAL_CLASSES: readonly ApprovalClass[] = ["financial", "destructive", "security", "reviewed"];

export interface ApprovalGatedOperation {
  risk: string;
  method: string;
  confirmation?: string;
  impact?: string;
}

/**
 * The approval class of an operation, or null when it runs without one. A
 * write whose impact is `money_fields` is financial only when this request
 * changes one of them (`changedMoneyFields`). A security read (a GET such as
 * the masked email or SMS setup) keeps its tag but changes nothing, so it
 * needs no approval. A registry entry can add the gate, never remove one.
 * `changedMoneyFields` undefined asks whether the operation can ever need one.
 */
export function approvalClassOf(operation: ApprovalGatedOperation, changedMoneyFields?: readonly string[]): ApprovalClass | null {
  const write = operation.risk !== "read";
  const moneyFieldsChange = changedMoneyFields === undefined || changedMoneyFields.length > 0;
  if (
    operation.risk === "financial" ||
    (write && operation.impact === "money") ||
    (write && operation.impact === "money_fields" && moneyFieldsChange)
  ) return "financial";
  if (operation.risk === "destructive") return "destructive";
  if ((operation.risk === "security" && operation.method !== "GET") || (write && operation.impact === "security")) return "security";
  return operation.confirmation === "required" ? "reviewed" : null;
}

/**
 * Inputs that bind an approval but change nothing a person decides (reviewed,
 * one name at a time): retry keys, the revisions and stored values a write
 * checks before it runs (it runs only when they still hold), paging, dry
 * runs, and a selection by filter (refused for a change that needs approval).
 * A field is "no effect" when any part of its path is one of these. A new
 * field is shown until it is reviewed here, and the census then asks for its
 * label.
 */
export const NO_EFFECT_FIELDS: ReadonlySet<string> = new Set([
  "requestKey", "idempotencyKey", "commandKey", "operationKey", "cursor", "offset", "dryRun",
  "revision", "aggregateRevision", "basePublishedRevision", "quoteFingerprint",
  "expected", "expectedRevision", "expectedVersion", "expectedAggregateRevision", "expectedStockVersion",
  "expectedDraftRevision", "expectedPublishedRevision", "expectedTotalMinor", "expectedPriceMinor", "expectedCost",
  "expectedTaxExempt", "expectedTaxExemptionId", "expectedQuoteFingerprint",
]);

/**
 * Secrets (reviewed): bound, and shown only as the last characters so a
 * person can tell which key or account it is. Anything else, keys that only
 * name something (a publishable key, a field's key) included, is shown.
 */
export const SECRET_FIELDS: ReadonlySet<string> = new Set([
  "password", "currentPassword", "newPassword", "secretKey", "apiSecret", "apiKey", "accessToken",
  "whatsappAccessToken", "webhookSecret", "serviceAccount", "privateKey", "clientSecret", "shippingRateToken",
]);

/** How the page treats a field: shown in words, shown as a secret's last characters, or not listed. */
export type ApprovalFieldDisposition = "shown" | "masked" | "no_effect";

/** A field path's disposition (`body.items.*.unitPriceMinor`, `query.view`, `path.id`). */
export function approvalFieldDisposition(path: string): ApprovalFieldDisposition {
  if (/^body\.(?:matching|filter)(?:\.|$)/.test(path)) return "no_effect";
  const segments = path.split(".").filter((segment) => segment !== "*");
  if (segments.some((segment) => NO_EFFECT_FIELDS.has(segment))) return "no_effect";
  return SECRET_FIELDS.has(segments.at(-1) ?? "") ? "masked" : "shown";
}

/** The last characters of a secret, as the page shows it: never more than four, never more than a third. */
export function secretTail(value: string): string {
  const shown = Math.min(4, Math.floor(value.length / 3));
  return shown > 0 ? value.slice(-shown) : "";
}

/** The key a field is labelled by: its last named segment (`body.effects.*.config.basisPoints` → `basisPoints`). */
export function approvalFieldKey(path: string): string {
  return path.split(".").filter((segment) => segment !== "*").at(-1) ?? path;
}

/** The key with its parent (`combinesWith.product`), for a label the key alone would leave unclear. */
export function approvalFieldParentKey(path: string): string | null {
  const segments = path.split(".").filter((segment) => segment !== "*");
  return segments.length >= 2 ? `${segments.at(-2)}.${segments.at(-1)}` : null;
}

/** One input field: its path, how the page treats it, and what its schema says about its values. */
export interface ApprovalInputField {
  /** `body.effects.*.config.basisPoints`, `query.view`, `path.id`. */
  path: string;
  disposition: ApprovalFieldDisposition;
  /** The values it may take, when the schema lists them. */
  enumValues: readonly unknown[] | null;
  type: string | null;
  /** It holds money (`x-scalius-money`). */
  money: boolean;
}

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every field of an operation's input (parameters and JSON body), resolving
 * component references and every union branch, each with its disposition.
 */
export function approvalInputFields(inputSchema: unknown, components: ComponentSchemas): ApprovalInputField[] {
  const fields = new Map<string, ApprovalInputField>();
  const visit = (raw: unknown, path: string, depth: number, refs: ReadonlySet<unknown>) => {
    const node = resolveComponentSchemaRef(raw, components);
    if (!isNode(node) || depth > 16 || refs.has(node)) return;
    const seen = new Set(refs).add(node);
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const variants = node[key];
      if (Array.isArray(variants)) for (const variant of variants) visit(variant, path, depth + 1, seen);
    }
    const properties = isNode(node.properties) ? node.properties : null;
    if (properties) for (const [key, child] of Object.entries(properties)) visit(child, `${path}.${key}`, depth + 1, seen);
    if (node.items !== undefined) visit(node.items, `${path}.*`, depth + 1, seen);
    if (isNode(node.additionalProperties)) visit(node.additionalProperties, `${path}.*`, depth + 1, seen);
    const composite = properties || node.items !== undefined || node.anyOf || node.oneOf || node.allOf;
    if (composite) return;
    const existing = fields.get(path);
    const enumValues = Array.isArray(node.enum) ? node.enum.filter((value) => value !== null) : null;
    const type = typeof node.type === "string" ? node.type : Array.isArray(node.type) ? String(node.type.find((each) => each !== "null") ?? "") : null;
    fields.set(path, {
      path,
      disposition: approvalFieldDisposition(path),
      enumValues: existing?.enumValues || enumValues ? [...new Set([...(existing?.enumValues ?? []), ...(enumValues ?? [])])] : null,
      type: existing?.type ?? type,
      money: (existing?.money ?? false) || isNode(node["x-scalius-money"]),
    });
  };
  const input = isNode(inputSchema) ? inputSchema : {};
  for (const parameter of Array.isArray(input.parameters) ? input.parameters : []) {
    if (!isNode(parameter) || (parameter.in !== "path" && parameter.in !== "query")) continue;
    visit(parameter.schema, `${parameter.in}.${String(parameter.name)}`, 0, new Set());
  }
  const body = isNode(input.requestBody) && isNode(input.requestBody.content)
    ? Object.values(input.requestBody.content)[0]
    : undefined;
  if (isNode(body)) visit(body.schema, "body", 0, new Set());
  return [...fields.values()];
}
