// Which money fields an agent's write really changes, for a write that also
// edits other things (a product's price beside its description: registry
// `moneyFields`, manifest impact `money_fields`). A field the request leaves
// out, or sets to the value already stored, changes nothing; any other is a
// money change and asks for the owner's approval (mcp/confirm.ts). The
// stored values come from the operation's reviewed read, dispatched as the
// same agent; a read that fails, or a field no read holds, counts as changed.
import type { AgentOperationPolicy } from "../openapi/agent-operation-manifest";
import type { AgentOperationInput } from "./dispatch-error";
import type { AgentPrincipal } from "./types";
import { containsStepReference } from "./mcp/references";
import { unlabelUntrusted } from "./mcp/untrusted";

type MoneyFieldsOperation = Pick<AgentOperationPolicy, "operationId" | "impact"> & { moneyFields?: AgentOperationPolicy["moneyFields"] };

const SELECTOR = /^\[([A-Za-z0-9_]+)=\{([A-Za-z0-9_]+)\}\]$/;
/** `[id=@id]`: the list item whose `id` is the `id` of the input row a `*` stands for (the first `@` the outermost row). */
const ROW_SELECTOR = /^\[([A-Za-z0-9_]+)=@([A-Za-z0-9_]+)\]$/;

/** One value at an input pointer, with the rows its `*` segments passed through (outermost first). */
interface InputMatch {
  value: unknown;
  rows: Array<Record<string, unknown>>;
}

/** Every value at an input pointer, `*` matching each item of a list. */
function inputMatches(input: AgentOperationInput, pointer: string): InputMatch[] {
  let matches: InputMatch[] = [{ value: input, rows: [] }];
  for (const segment of segmentsOf(pointer)) {
    matches = matches.flatMap(({ value, rows }) => {
      if (segment === "*") {
        return Array.isArray(value)
          ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)).map((item) => ({ value: item, rows: [...rows, item as Record<string, unknown>] }))
          : [];
      }
      return value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, segment)
        ? [{ value: (value as Record<string, unknown>)[segment], rows }]
        : [];
    });
  }
  return matches.filter((match) => match.value !== undefined);
}

function segmentsOf(pointer: string): string[] {
  return pointer.split("/").slice(1).map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** The value at a JSON pointer of the input (`/body/price`), or undefined. */
export function inputValueAt(input: AgentOperationInput, pointer: string): unknown {
  let node: unknown = input;
  for (const segment of segmentsOf(pointer)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** The value at a read pointer, where `[id={variantId}]` picks the list item whose `id` is the path parameter. */
function readValueAt(data: unknown, pointer: string, path: Record<string, unknown>, rows: ReadonlyArray<Record<string, unknown>> = []): { found: boolean; value: unknown } {
  let node: unknown = data;
  let row = 0;
  for (const segment of segmentsOf(pointer)) {
    const rowSelector = ROW_SELECTOR.exec(segment);
    if (rowSelector) {
      const wanted = rows[row]?.[rowSelector[2]!];
      row += 1;
      if (!Array.isArray(node) || wanted === undefined) return { found: false, value: undefined };
      node = node.find((item) => item && typeof item === "object" && String((item as Record<string, unknown>)[rowSelector[1]!]) === String(wanted));
      if (node === undefined) return { found: false, value: undefined };
      continue;
    }
    const selector = SELECTOR.exec(segment);
    if (selector) {
      if (!Array.isArray(node)) return { found: false, value: undefined };
      node = node.find((item) => item && typeof item === "object" && String((item as Record<string, unknown>)[selector[1]!]) === String(path[selector[2]!]));
      if (node === undefined) return { found: false, value: undefined };
      continue;
    }
    if (!node || typeof node !== "object" || Array.isArray(node) || !Object.hasOwn(node, segment)) return { found: false, value: undefined };
    node = (node as Record<string, unknown>)[segment];
  }
  return { found: true, value: node };
}

/** Values compared as stored: numbers by value (a numeric string too), text trimmed, absent as null, objects by content. */
function normal(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" && /^-?\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed;
  }
  if (Array.isArray(value)) return value.map(normal);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, normal((value as Record<string, unknown>)[key])] as const)
      .filter(([, item]) => item !== null));
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(normal(left)) === JSON.stringify(normal(right));
}

/** Every value at an input pointer whose `*` segments match any item. */
function inputValuesAt(input: AgentOperationInput, pointer: string): unknown[] {
  let nodes: unknown[] = [input];
  for (const segment of segmentsOf(pointer)) {
    nodes = nodes.flatMap((node) => {
      if (segment === "*") return Array.isArray(node) ? node : [];
      return node && typeof node === "object" && !Array.isArray(node) && Object.hasOwn(node, segment) ? [(node as Record<string, unknown>)[segment]] : [];
    });
  }
  return nodes;
}

/** The input conditions under which a create is buyable at once (`/body/isActive` true). */
function buyableInputs(operation: MoneyFieldsOperation, input: AgentOperationInput): string[] {
  return (operation.moneyFields?.buyable ?? [])
    .filter((condition) => condition.input !== undefined && inputValuesAt(input, condition.input).some((value) =>
      condition.any ? value !== null && value !== undefined : (condition.equals ?? []).some((wanted) => same(value, wanted))))
    .map((condition) => condition.input!);
}

/**
 * The inputs of a tag or segment write that touch what net terms, a price
 * list or a discount selects by; empty for ordinary marketing. A references
 * read that fails counts every tag input as touching.
 */
async function referencedChanges(
  references: NonNullable<NonNullable<MoneyFieldsOperation["moneyFields"]>["references"]>,
  input: AgentOperationInput,
  env: Env,
): Promise<string[]> {
  const tagInputs = (references.tags ?? []).filter((pointer) => inputValueAt(input, pointer) !== undefined);
  const segmentId = references.segment ? input.path?.[references.segment] : undefined;
  const collectionId = references.collection &&
    ((references.collectionWhen ?? []).length === 0 || references.collectionWhen!.some((pointer) => inputValueAt(input, pointer) !== undefined))
    ? input.path?.[references.collection]
    : undefined;
  const attributes = references.customerAttributes;
  const attributeInputs = attributes
    ? (attributes.when ?? []).length === 0 ? ["/body"] : attributes.when!.filter((pointer) => inputValueAt(input, pointer) !== undefined)
    : [];
  if (tagInputs.length === 0 && segmentId === undefined && collectionId === undefined && attributeInputs.length === 0) return [];
  const everything = [
    ...tagInputs,
    ...(segmentId !== undefined ? [`/path/${references.segment}`] : []),
    ...(collectionId !== undefined ? [`/path/${references.collection}`] : []),
    ...attributeInputs,
  ];
  if (containsStepReference(input)) return everything;
  try {
    const { readCustomerTags, readMoneyReferences } = await import("./money-references");
    const referenced = await readMoneyReferences(env);
    const touched: string[] = [];
    // A collection a discount targets: what it holds is what the discount prices.
    if (collectionId !== undefined && referenced.collectionIds.has(String(collectionId))) touched.push(`/path/${references.collection}`);
    // A customer attribute a money-relevant segment reads decides who that segment holds.
    if (attributes && attributes.fields.some((field) => referenced.customerAttributes.has(field))) touched.push(...attributeInputs);
    if (segmentId !== undefined && referenced.segmentIds.has(String(segmentId)) && inputValueAt(input, "/body/definition") !== undefined) {
      touched.push(`/path/${references.segment}`);
    }
    const customerId = references.storedTagsOf ? input.path?.[references.storedTagsOf] : undefined;
    const stored = customerId !== undefined ? new Set((await readCustomerTags(env, String(customerId))).map((tag) => tag.toLowerCase())) : null;
    for (const pointer of tagInputs) {
      const sent = (inputValuesAt(input, pointer).flat() as unknown[]).filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim().toLowerCase());
      // A set replaces the customer's tags: what it adds and what it drops both count.
      const changed = stored ? [...sent.filter((tag) => !stored.has(tag)), ...[...stored].filter((tag) => !sent.includes(tag))] : sent;
      if (changed.some((tag) => referenced.tags.has(tag))) touched.push(pointer);
    }
    return touched;
  } catch {
    return everything;
  }
}

/** The money fields this request names (input pointers), whatever their values, and a create's buyable inputs. */
export function presentMoneyFields(operation: MoneyFieldsOperation, input: AgentOperationInput): string[] {
  if (operation.impact !== "money_fields" || !operation.moneyFields) return [];
  return [
    ...Object.keys(operation.moneyFields.fields).filter((pointer) => inputMatches(input, pointer).length > 0),
    ...buyableInputs(operation, input),
  ];
}

/**
 * The money fields this request changes, as input pointers (`/body/price`):
 * empty for a write that is money by nature or by none of its fields, or
 * that leaves every money field as stored.
 */
export async function changedMoneyFields(
  operation: MoneyFieldsOperation,
  input: AgentOperationInput,
  principal: AgentPrincipal,
  env: Env,
  ctx: ExecutionContext,
): Promise<string[]> {
  const declared = operation.moneyFields;
  if (operation.impact !== "money_fields" || !declared) return [];
  const referenced = declared.references ? await referencedChanges(declared.references, input, env) : [];
  const fields = await fieldChanges(operation, declared, input, principal, env, ctx);
  return [...new Set([...referenced, ...fields])];
}

async function fieldChanges(
  operation: MoneyFieldsOperation,
  declared: NonNullable<MoneyFieldsOperation["moneyFields"]>,
  input: AgentOperationInput,
  principal: AgentPrincipal,
  env: Env,
  ctx: ExecutionContext,
): Promise<string[]> {
  // A create that is buyable once it exists charges at the price it sets.
  const buyableNow = buyableInputs(operation, input);
  if (buyableNow.length > 0) return buyableNow;
  const readsBuyable = (declared.buyable ?? []).filter((condition) => condition.read !== undefined);
  const present = presentMoneyFields(operation, input);
  if (present.length === 0 && readsBuyable.length === 0) return [];
  // Unknown stored values count as changed: the fields sent, or the read a create's sale depends on.
  const conservative = present.length > 0 ? present : readsBuyable.map((condition) => condition.read!);
  // A value another step supplies is not known until it runs: count it as changed.
  if (containsStepReference(input)) return conservative;
  const compared = present.filter((pointer) => declared.fields[pointer] !== null && declared.fields[pointer] !== undefined);
  if ((compared.length === 0 && readsBuyable.length === 0) || !declared.read) return present;
  let data: unknown;
  try {
    const [{ AGENT_OPERATIONS_BY_ID }, { dispatchAgentOperation }] = await Promise.all([
      import("../generated/agent-operations.gen"),
      import("./dispatch"),
    ]);
    const read = AGENT_OPERATIONS_BY_ID[declared.read];
    if (!read) return conservative;
    const params: Record<string, string | number | boolean> = {};
    for (const name of read.pathTemplate.match(/\{([^}]+)\}/g)?.map((part) => part.slice(1, -1)) ?? []) {
      const source = declared.readPath?.[name] ?? name;
      // `=base` is a literal: the read's section, not one of this request's parameters.
      const value = source.startsWith("=") ? source.slice(1) : input.path?.[source];
      if (value === undefined) return conservative;
      params[name] = value as string | number | boolean;
    }
    const query: Record<string, string> = {};
    for (const [name, source] of Object.entries(declared.readQuery ?? {})) {
      // `=x` is a literal, `@/body/products/*/id` the input's values joined by commas, else a path parameter.
      const value = source.startsWith("=")
        ? source.slice(1)
        : source.startsWith("@")
          ? inputMatches(input, source.slice(1)).map((match) => String(match.value)).join(",") || undefined
          : input.path?.[source];
      if (value === undefined) return conservative;
      query[name] = String(value);
    }
    const result = await dispatchAgentOperation({ operation: read, input: { path: params, ...(Object.keys(query).length > 0 ? { query } : {}) }, principal, env, ctx });
    if (!result.ok) return conservative;
    data = unlabelUntrusted(result.data);
  } catch {
    return conservative;
  }
  // A new SKU of a product already on sale is buyable at once.
  const buyableRead = readsBuyable.filter((condition) => {
    const stored = readValueAt(data, condition.read!, input.path ?? {});
    return stored.found && (condition.any ? stored.value !== null : (condition.equals ?? []).some((wanted) => same(stored.value, wanted)));
  });
  if (buyableRead.length > 0) return buyableRead.map((condition) => condition.read!);
  // The write lands only on the revision the comparison read (the route checks
  // it in the write itself); any other revision, or none, may have moved them.
  for (const precondition of declared.preconditions ?? []) {
    const sent = inputMatches(input, precondition.input);
    if (sent.length === 0) return present;
    for (const match of sent) {
      const stored = readValueAt(data, precondition.read, input.path ?? {}, match.rows);
      if (!stored.found || !same(match.value, stored.value)) return present;
    }
  }
  return present.filter((pointer) => {
    const readPointer = declared.fields[pointer];
    if (readPointer === null || readPointer === undefined) return true;
    // Each row its own comparison: one changed row makes the field changed.
    return inputMatches(input, pointer).some((match) => {
      const stored = readValueAt(data, readPointer, input.path ?? {}, match.rows);
      return !stored.found || !same(match.value, stored.value);
    });
  });
}
