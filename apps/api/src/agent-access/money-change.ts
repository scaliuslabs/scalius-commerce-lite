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
function readValueAt(data: unknown, pointer: string, path: Record<string, unknown>): { found: boolean; value: unknown } {
  let node: unknown = data;
  for (const segment of segmentsOf(pointer)) {
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

/** The money fields this request names (input pointers), whatever their values. */
export function presentMoneyFields(operation: MoneyFieldsOperation, input: AgentOperationInput): string[] {
  if (operation.impact !== "money_fields" || !operation.moneyFields) return [];
  return Object.keys(operation.moneyFields.fields).filter((pointer) => inputValueAt(input, pointer) !== undefined);
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
  const present = presentMoneyFields(operation, input);
  const declared = operation.moneyFields;
  if (present.length === 0 || !declared) return [];
  // A value another step supplies is not known until it runs: count it as changed.
  if (containsStepReference(input)) return present;
  const compared = present.filter((pointer) => declared.fields[pointer] !== null);
  if (compared.length === 0 || !declared.read) return present;
  let data: unknown;
  try {
    const [{ AGENT_OPERATIONS_BY_ID }, { dispatchAgentOperation }] = await Promise.all([
      import("../generated/agent-operations.gen"),
      import("./dispatch"),
    ]);
    const read = AGENT_OPERATIONS_BY_ID[declared.read];
    if (!read) return present;
    const params: Record<string, string | number | boolean> = {};
    for (const name of read.pathTemplate.match(/\{([^}]+)\}/g)?.map((part) => part.slice(1, -1)) ?? []) {
      const source = declared.readPath?.[name] ?? name;
      // `=base` is a literal: the read's section, not one of this request's parameters.
      const value = source.startsWith("=") ? source.slice(1) : input.path?.[source];
      if (value === undefined) return present;
      params[name] = value as string | number | boolean;
    }
    const result = await dispatchAgentOperation({ operation: read, input: { path: params }, principal, env, ctx });
    if (!result.ok) return present;
    data = unlabelUntrusted(result.data);
  } catch {
    return present;
  }
  return present.filter((pointer) => {
    const readPointer = declared.fields[pointer];
    if (readPointer === null || readPointer === undefined) return true;
    const stored = readValueAt(data, readPointer, input.path ?? {});
    return !stored.found || !same(inputValueAt(input, pointer), stored.value);
  });
}
