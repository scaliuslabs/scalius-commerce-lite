// `createContractApi`: a `ctx.api` for tests that refuses what the platform
// refuses. Every call is checked against the sealed stable app API
// (apps/api/src/openapi/stable-operations.snapshot.json, carried as
// ./testing-contract.gen.ts) in the order the host checks it
// (apps/api/src/plugins/api-call.ts, agent-access/dispatch.ts, the
// Idempotency-Key middleware and the route's own validation), and a refusal
// comes back as the result the app would get, never a throw:
//
//   404 api.unknown_operation      not a stable operation id
//   400 api.invalid_input          input is not { path, query, body, idempotencyKey }
//   403 api.operation_forbidden    no granted scope covers the operation
//   400 idempotency_key_required   a stock move without idempotencyKey
//   400 idempotency_not_supported  idempotencyKey on an operation that takes none
//   400 body_not_allowed           a body on a GET
//   400 unknown_body_property      a top-level body field the operation does not declare
//   413 body_too_large             a body over 1 MiB
//   400 missing_path_parameter / unknown_path_parameter
//   422 idempotency_key_reused     the same key for a different request
//   400 validation_error           path, query or body against the schema
//                                  (enums, required fields, revision preconditions)
//
// A valid call reaches your handler. Its answer is checked against the
// operation's response schema, so a test cannot rely on a shape the platform
// never returns. A repeat with the same Idempotency-Key replays the first
// answer without calling the handler again, as the platform does.

import type { PluginApiCallInput, PluginApiResult } from "./context";
import { NON_STABLE_OPERATION_IDS, STABLE_CONTRACT } from "./testing-contract.gen";

const NON_STABLE_OPERATIONS = new Set(NON_STABLE_OPERATION_IDS);

/** JSON Schema (the OpenAPI 3.0 subset the contract uses). */
export type ContractSchema = Record<string, unknown>;

export interface StableContractParameter {
  name: string;
  in: "path" | "query" | "header" | string;
  required?: boolean;
  schema?: ContractSchema;
  description?: string;
}

export interface StableContractOperation {
  method: string;
  path: string;
  risk: string;
  idempotency: "none" | "supported" | "required" | string;
  revision: "none" | "optional" | "required" | string;
  /** Every scope that alone lets a third-party app call it. */
  scopes: string[];
  input: { parameters?: StableContractParameter[]; requestBody?: { required?: boolean; content?: Record<string, { schema?: ContractSchema }> } } | null;
  output: ContractSchema | null;
}

export interface StableContract {
  operations: Record<string, StableContractOperation>;
  components: Record<string, ContractSchema>;
}

/** The stable app API this SDK release was sealed against. */
export const stableContract: StableContract = STABLE_CONTRACT;

/** One call as a handler sees it: the app's input after the platform's checks. */
export interface ContractCall {
  operationId: string;
  operation: StableContractOperation;
  path: Record<string, string | number>;
  query: Record<string, string | number | boolean | null>;
  body: unknown;
  idempotencyKey: string | undefined;
}

/**
 * Answers one operation: return the response's `data` (checked against the
 * operation's response schema), or a whole `PluginApiResult` (`{ ok: false,
 * status, data: null, error }` for a refusal such as a 409 revision conflict).
 */
export type ContractHandler = (call: ContractCall) => unknown | Promise<unknown>;

export interface ContractApiOptions {
  /** Answers by stable operation id. A call to an operation without a handler fails the test (it throws). */
  handlers?: Record<string, ContractHandler>;
  /**
   * The app's granted scopes. The harness passes the manifest's (with the
   * features that are on); set this to call the API outside a harness.
   */
  scopes?: readonly string[];
  /** Check each handler's answer against the response schema (default true). */
  checkOutput?: boolean;
  /** Another contract snapshot (default: the one this SDK release carries). */
  contract?: StableContract;
}

/** What `createContractApi` returns: the `api` option of `createPluginTestHarness`, plus the calls it answered. */
export interface ContractApi {
  (operationId: string, input: PluginApiCallInput | undefined, call?: { scopes?: readonly string[] }): Promise<PluginApiResult>;
  /** Every call, in order, with the result the app got. */
  readonly calls: Array<{ operationId: string; input: PluginApiCallInput | undefined; result: PluginApiResult }>;
}

const OPERATION_ID = /^(?:dashboard(\.[a-z][a-z0-9_]*){2,}|objects\.(?:types\.(?:list|get|create|update|delete)|list|get|upsert|delete))$/;
const IDEMPOTENCY_KEY = /^[\x20-\x7E]{8,200}$/u;
const MAX_BODY_BYTES = 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const refusal = (status: number, code: string, message: string): PluginApiResult => ({ ok: false, status, data: null, error: { code, message } });

/** The input as the host normalizes it (api-call.ts `normalizePluginApiInput`), or what is wrong with it. */
function normalize(input: unknown): Required<Pick<ContractCall, "path" | "query">> & { body: unknown; idempotencyKey: string | undefined } | string {
  const normalized = { path: {} as Record<string, string | number>, query: {} as Record<string, string | number | boolean | null>, body: undefined as unknown, idempotencyKey: undefined as string | undefined };
  if (input === undefined || input === null) return normalized;
  if (!isRecord(input)) return "The input is an object with path, query, body and idempotencyKey.";
  const extra = Object.keys(input).find((key) => !["path", "query", "body", "idempotencyKey"].includes(key));
  if (extra) return `Unknown input property "${extra}".`;
  if (input.path !== undefined) {
    if (!isRecord(input.path)) return "path is an object of strings and numbers.";
    for (const [key, value] of Object.entries(input.path)) {
      if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) return `path.${key} must be a string or number.`;
      normalized.path[key] = value;
    }
  }
  if (input.query !== undefined) {
    if (!isRecord(input.query)) return "query is an object of strings, numbers and booleans.";
    for (const [key, value] of Object.entries(input.query)) {
      if (value === undefined) continue;
      if (value !== null && typeof value !== "string" && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) {
        return `query.${key} must be a string, number, boolean or null.`;
      }
      normalized.query[key] = value;
    }
  }
  if (input.body !== undefined) normalized.body = input.body;
  if (input.idempotencyKey !== undefined) {
    if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) return "idempotencyKey is 8 to 200 printable characters.";
    normalized.idempotencyKey = input.idempotencyKey;
  }
  return normalized;
}

// ── Schema checks ────────────────────────────────────────────────────────

interface SchemaIssue {
  path: string;
  message: string;
  missing?: string;
}

function resolveRef(schema: unknown, contract: StableContract): ContractSchema | null {
  let current = schema;
  for (let depth = 0; isRecord(current) && typeof current.$ref === "string" && depth < 16; depth += 1) {
    const name = current.$ref.replace(/^#\/components\/schemas\//, "");
    current = contract.components[name];
  }
  return isRecord(current) ? current : null;
}

const describe = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : `${typeof value} ${JSON.stringify(value)}`);
const join = (path: string, key: string | number) => (typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key);

/** The first way `value` breaks `schema`, or null. Unknown keywords (format, examples) are not checked. */
export function contractSchemaIssue(schemaInput: unknown, value: unknown, contract: StableContract = stableContract, path = ""): SchemaIssue | null {
  const schema = resolveRef(schemaInput, contract);
  if (!schema) return null;
  if (value === null) return schema.nullable === true || (Array.isArray(schema.enum) && schema.enum.includes(null)) ? null : { path, message: "must not be null" };
  for (const key of ["allOf"] as const) {
    if (Array.isArray(schema[key])) {
      for (const part of schema[key] as unknown[]) {
        const issue = contractSchemaIssue(part, value, contract, path);
        if (issue) return issue;
      }
    }
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[key])) {
      const issues = (schema[key] as unknown[]).map((part) => contractSchemaIssue(part, value, contract, path));
      if (!issues.some((issue) => issue === null)) {
        // The alternative that got furthest explains the failure best.
        return issues.reduce((best, issue) => ((issue?.path.length ?? 0) > (best?.path.length ?? 0) ? issue : best), issues[0] ?? null)
          ?? { path, message: "matches none of the allowed shapes" };
      }
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    return { path, message: `must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")} (got ${describe(value)})` };
  }
  const type = schema.type;
  switch (type) {
    case "string":
      if (typeof value !== "string") return { path, message: `must be a string (got ${describe(value)})` };
      if (typeof schema.minLength === "number" && [...value].length < schema.minLength) return { path, message: `must be at least ${schema.minLength} characters` };
      if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) return { path, message: `must be at most ${schema.maxLength} characters` };
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return { path, message: `must match ${schema.pattern}` };
      return null;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return { path, message: `must be a ${type} (got ${describe(value)})` };
      if (type === "integer" && !Number.isInteger(value)) return { path, message: `must be a whole number (got ${value})` };
      if (typeof schema.minimum === "number" && (value < schema.minimum || (schema.exclusiveMinimum === true && value === schema.minimum))) {
        return { path, message: `must be ${schema.exclusiveMinimum === true ? "greater than" : "at least"} ${schema.minimum}` };
      }
      if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return { path, message: `must be greater than ${schema.exclusiveMinimum}` };
      if (typeof schema.maximum === "number" && (value > schema.maximum || (schema.exclusiveMaximum === true && value === schema.maximum))) {
        return { path, message: `must be ${schema.exclusiveMaximum === true ? "less than" : "at most"} ${schema.maximum}` };
      }
      if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return { path, message: `must be less than ${schema.exclusiveMaximum}` };
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : { path, message: `must be a boolean (got ${describe(value)})` };
    case "array": {
      if (!Array.isArray(value)) return { path, message: `must be an array (got ${describe(value)})` };
      if (typeof schema.minItems === "number" && value.length < schema.minItems) return { path, message: `must have at least ${schema.minItems} items` };
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return { path, message: `must have at most ${schema.maxItems} items` };
      for (const [index, item] of value.entries()) {
        const issue = contractSchemaIssue(schema.items, item, contract, join(path, index));
        if (issue) return issue;
      }
      return null;
    }
    default: {
      const objectLike = type === "object" || isRecord(schema.properties) || Array.isArray(schema.required);
      if (!objectLike) return null;
      if (!isRecord(value)) return { path, message: `must be an object (got ${describe(value)})` };
      const properties = isRecord(schema.properties) ? schema.properties : {};
      for (const key of Array.isArray(schema.required) ? schema.required as string[] : []) {
        if (value[key] === undefined) return { path: join(path, key), message: "is required", missing: key };
      }
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        if (key in properties) {
          const issue = contractSchemaIssue(properties[key], item, contract, join(path, key));
          if (issue) return issue;
        } else if (schema.additionalProperties === false) {
          return { path: join(path, key), message: "is not a field of this operation" };
        } else if (isRecord(schema.additionalProperties)) {
          const issue = contractSchemaIssue(schema.additionalProperties, item, contract, join(path, key));
          if (issue) return issue;
        }
      }
      return null;
    }
  }
}

/** A path or query value as the route reads it from the URL: text, coerced to the parameter's type. */
function urlValue(schemaInput: unknown, value: string | number | boolean, contract: StableContract): unknown {
  const schema = resolveRef(schemaInput, contract);
  const text = String(value);
  switch (schema?.type) {
    case "integer":
    case "number":
      return text.trim() === "" ? text : Number.isFinite(Number(text)) ? Number(text) : text;
    case "boolean":
      return text === "true" ? true : text === "false" ? false : text;
    default:
      return text;
  }
}

function bodySchema(operation: StableContractOperation): ContractSchema | null {
  const schema = operation.input?.requestBody?.content?.["application/json"]?.schema;
  return isRecord(schema) ? schema : null;
}

/** The top-level body fields the dispatcher accepts, or null when it accepts any (dispatch.ts `declaredJsonBodyProperties`). */
function declaredBodyProperties(operation: StableContractOperation, contract: StableContract): Set<string> | null {
  const root = resolveRef(bodySchema(operation), contract);
  if (!root || (root.additionalProperties !== undefined && root.additionalProperties !== false)) return null;
  const declared = new Set<string>();
  for (const candidate of [root, ...(["oneOf", "anyOf", "allOf"] as const).flatMap((key) => (Array.isArray(root[key]) ? root[key] as unknown[] : []))]) {
    const resolved = resolveRef(candidate, contract);
    if (resolved && isRecord(resolved.properties)) Object.keys(resolved.properties).forEach((key) => declared.add(key));
  }
  return declared.size > 0 ? declared : null;
}

function validation(where: string, issue: SchemaIssue, operation: StableContractOperation): PluginApiResult {
  const precondition = issue.missing && /^expected/i.test(issue.missing) && operation.revision !== "none"
    ? " This operation is revision-checked: pass the revision you read (a change since is refused with 409)."
    : "";
  return refusal(400, "validation_error", `${where}${issue.path ? `.${issue.path}` : ""} ${issue.message}.${precondition}`);
}

function isApiResult(value: unknown): value is PluginApiResult {
  return isRecord(value) && typeof value.ok === "boolean" && typeof value.status === "number" && "data" in value && "error" in value;
}

const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

/**
 * A contract-checked `ctx.api` for `createPluginTestHarness(plugin, { api })`.
 *
 *   const api = createContractApi({
 *     handlers: { "dashboard.resources.orders.get": ({ path }) => ({ id: path.id, … }) },
 *   });
 *   const harness = createPluginTestHarness(plugin, { api });
 *   // api.calls lists every call and the result the app got.
 */
export function createContractApi(options: ContractApiOptions = {}): ContractApi {
  const contract = options.contract ?? stableContract;
  const handlers = options.handlers ?? {};
  for (const operationId of Object.keys(handlers)) {
    if (!contract.operations[operationId]) {
      throw new Error(`createContractApi: ${operationId} is not a stable app API operation, so no app can call it. Stable operations: ${Object.keys(contract.operations).length} (see stableContract.operations).`);
    }
  }
  const replays = new Map<string, { request: string; result: PluginApiResult }>();
  const calls: ContractApi["calls"] = [];

  const answer = async (operationId: string, rawInput: unknown, granted: readonly string[] | undefined): Promise<PluginApiResult> => {
    if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) {
      return refusal(404, "api_unknown_operation", "Plugins call dashboard or objects operations by their reviewed id.");
    }
    const operation = contract.operations[operationId];
    const exists = Boolean(operation) || NON_STABLE_OPERATIONS.has(operationId);
    if (!exists) return refusal(404, "api_unknown_operation", `Unknown operation ${operationId}: it is not part of the stable app API.`);
    const input = normalize(rawInput);
    if (typeof input === "string") return refusal(400, "api_invalid_input", input);
    // As the host: an operation that exists but is beta or internal is refused, not unknown.
    if (!operation) return refusal(403, "api_operation_not_stable", `${operationId} is not part of the stable app API.`);
    if (granted && !operation.scopes.some((scope) => granted.includes(scope))) {
      return refusal(403, "api_operation_forbidden", `Operation is not authorized: ${operationId} needs one of ${operation.scopes.join(", ") || "(no app scope)"}.`);
    }

    // The dispatcher's checks, in its order.
    if (operation.idempotency === "required" && !input.idempotencyKey) return refusal(400, "idempotency_key_required", "This operation requires an idempotency key");
    if (input.idempotencyKey && operation.idempotency === "none") return refusal(400, "idempotency_not_supported", "This operation does not support an idempotency key");
    const method = operation.method.toUpperCase();
    if ((method === "GET" || method === "HEAD") && input.body !== undefined) return refusal(400, "body_not_allowed", `${method} operations do not accept a body`);
    let bodyText: string | undefined;
    if (input.body !== undefined) {
      const declared = isRecord(input.body) ? declaredBodyProperties(operation, contract) : null;
      const unknown = declared ? Object.keys(input.body as Record<string, unknown>).filter((key) => !declared.has(key)).sort() : [];
      if (unknown.length > 0) return refusal(400, "unknown_body_property", `Unknown body property '${unknown[0]}'. Allowed properties: ${[...declared!].sort().join(", ")}.`);
      try {
        bodyText = JSON.stringify(input.body);
      } catch {
        return refusal(400, "invalid_json_body", "Operation body must be JSON serializable");
      }
      if (bodyText === undefined) return refusal(400, "invalid_json_body", "Operation body must be JSON serializable");
      if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) return refusal(413, "body_too_large", "Operation body exceeds the 1 MiB limit");
    }
    const expected = new Set<string>();
    for (const [, key] of operation.path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
      expected.add(key!);
      if (input.path[key!] === undefined || input.path[key!] === "") return refusal(400, "missing_path_parameter", `Missing path parameter: ${key}`);
    }
    const extraPath = Object.keys(input.path).filter((key) => !expected.has(key)).sort();
    if (extraPath.length > 0) return refusal(400, "unknown_path_parameter", `Unknown path parameter: ${extraPath[0]}`);

    // The Idempotency-Key middleware runs before the route validates.
    const request = JSON.stringify([method, input.path, Object.entries(input.query).filter(([, value]) => value !== null).sort(([a], [b]) => a.localeCompare(b)), bodyText ?? ""]);
    const replayKey = input.idempotencyKey && method !== "GET" && method !== "HEAD" ? `${operationId}\n${input.idempotencyKey}` : null;
    const earlier = replayKey ? replays.get(replayKey) : undefined;
    if (earlier) {
      if (earlier.request !== request) {
        return refusal(422, "idempotency_key_reused", "This Idempotency-Key was used for a different request. Use a new key for a new request.");
      }
      return copy(earlier.result);
    }

    // The route's validation: path and query read as URL text, then the body.
    const parameters = operation.input?.parameters ?? [];
    for (const parameter of parameters) {
      if (parameter.in !== "path" && parameter.in !== "query") continue;
      const source = parameter.in === "path" ? input.path : input.query;
      const raw = source[parameter.name];
      if (raw === undefined || raw === null) {
        if (parameter.required) return validation(parameter.in, { path: parameter.name, message: "is required", missing: parameter.name }, operation);
        continue;
      }
      const issue = contractSchemaIssue(parameter.schema, urlValue(parameter.schema, raw, contract), contract, parameter.name);
      if (issue) return validation(parameter.in, issue, operation);
    }
    const schema = bodySchema(operation);
    if (input.body === undefined) {
      if (schema && operation.input?.requestBody?.required) return validation("body", { path: "", message: "is required" }, operation);
    } else if (schema) {
      const issue = contractSchemaIssue(schema, input.body, contract);
      if (issue) return validation("body", issue, operation);
    }

    const handler = handlers[operationId];
    if (!handler) {
      throw new Error(`createContractApi: the app called ${operationId} (a valid call), but no handler answers it. Add handlers["${operationId}"].`);
    }
    const answered = await handler(copy({ operationId, operation, path: input.path, query: input.query, body: input.body, idempotencyKey: input.idempotencyKey }));
    const result: PluginApiResult = isApiResult(answered) ? answered : { ok: true, status: 200, data: answered ?? null, error: null };
    if (result.ok && options.checkOutput !== false && operation.output) {
      const issue = contractSchemaIssue(operation.output, { success: true, data: result.data }, contract);
      if (issue) {
        throw new Error(`createContractApi: the handler for ${operationId} answered a shape the platform never returns: ${issue.path.replace(/^data\.?/, "data.")} ${issue.message}.`);
      }
    }
    if (replayKey && result.status < 500) replays.set(replayKey, { request, result: copy(result) });
    return copy(result);
  };

  const api = (async (operationId: string, input: PluginApiCallInput | undefined, call?: { scopes?: readonly string[] }) => {
    const result = await answer(operationId, input, options.scopes ?? call?.scopes);
    calls.push({ operationId, input: copy(input), result: copy(result) });
    return result;
  }) as ContractApi;
  Object.defineProperty(api, "calls", { value: calls, enumerable: true });
  return api;
}
