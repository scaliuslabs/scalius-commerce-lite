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
 * Inputs that bind an approval but change nothing a person decides: retry
 * keys, the revisions and stored values a write checks (`expected*`), paging
 * and dry runs. The page does not list them.
 */
const PLUMBING_SEGMENT = /^(?:requestKey|idempotencyKey|commandKey|operationKey|commandId|cursor|offset|dryRun|revision|aggregateRevision|basePublishedRevision|quoteFingerprint|expected[A-Z]\w*)$/;
/** Secrets are bound, never shown. */
export const SECRET_FIELD = /key$|token|secret|password/i;

/** A field path (`body.items.*.unitPriceMinor`, `query.view`) the page does not list. */
export function isUnshownApprovalField(path: string): boolean {
  const segments = path.split(".").filter((segment) => segment !== "*");
  const key = segments.at(-1) ?? "";
  return SECRET_FIELD.test(key) || segments.some((segment) => PLUMBING_SEGMENT.test(segment));
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

/** One input field an approval can show: its path, and what its schema says about its values. */
export interface ApprovalInputField {
  /** `body.effects.*.config.basisPoints`, `query.view`, `path.id`. */
  path: string;
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
 * Every field of an operation's input (parameters and JSON body) a person may
 * be shown, resolving component references and every union branch. Fields the
 * page does not list (`isUnshownApprovalField`) and selections by filter
 * (`body.matching`, `body.filter`: refused for gated changes) are left out.
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
    if (isUnshownApprovalField(path) || /^body\.(?:matching|filter)(?:\.|$)/.test(path)) return;
    const existing = fields.get(path);
    const enumValues = Array.isArray(node.enum) ? node.enum.filter((value) => value !== null) : null;
    const type = typeof node.type === "string" ? node.type : Array.isArray(node.type) ? String(node.type.find((each) => each !== "null") ?? "") : null;
    fields.set(path, {
      path,
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
