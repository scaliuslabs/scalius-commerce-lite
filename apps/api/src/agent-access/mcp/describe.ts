// scalius_describe: the compact contract an agent needs to call one
// operation correctly (purpose, when, inputs with required first, the rules
// that make a write safe, one example input, the response fields), or the
// full schema once with shared components. Compact is never larger than full.

import { AGENT_COMPONENT_SCHEMAS, AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { resolveComponentSchemaRef } from "../../openapi/component-schema-refs";
import { utf8ByteLength } from "../limits";
import { isConfirmGated } from "./confirm";
import { describeOperation } from "./operations";

export type AgentDryRunSupport = "native" | `preview:${string}` | "none";
export type AgentDescribeDetail = "compact" | "full" | "examples";

/** Full descriptions over this many bytes are served as the `scalius://ops/{id}` resource instead. */
export const FULL_DESCRIBE_MAX_BYTES = 32 * 1024;

const MAX_FIELDS = 40;
const MAX_ENUM_INLINE = 6;
const EXAMPLE_MAX_BYTES = 1024;
const FULL_EXAMPLE_MAX_BYTES = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const node = (value: unknown) => resolveComponentSchemaRef(value, AGENT_COMPONENT_SCHEMAS);
const bytes = (value: unknown) => utf8ByteLength(JSON.stringify(value));

/**
 * How a dry run works for an operation. The registry's `dryRun` field
 * decides; until an operation declares one, a dry run validates the input
 * and returns the confirmation without calling the route ("none").
 */
export function dryRunSupportOf(operation: AgentOperationManifestEntry): AgentDryRunSupport {
  const declared = (operation as { dryRun?: unknown }).dryRun;
  if (declared === "native") return "native";
  if (typeof declared === "string" && declared.startsWith("preview:")) {
    const preview = AGENT_OPERATIONS_BY_ID[declared.slice("preview:".length)];
    if (preview && preview.risk === "read" && preview.surface === operation.surface) return declared as `preview:${string}`;
  }
  return "none";
}

function schemaType(schema: Record<string, unknown>): string {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) return schema.type.filter((value) => typeof value === "string").join("|") || "any";
  if (isRecord(schema.properties)) return "object";
  return "any";
}

function alternativesOf(schema: Record<string, unknown>): unknown[] | null {
  return Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
}

function fieldType(value: unknown, depth: number): string {
  const schema = node(value);
  if (!isRecord(schema)) return "any";
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.slice(0, MAX_ENUM_INLINE).map(String).join("|");
    return `enum(${values}${schema.enum.length > MAX_ENUM_INLINE ? "|..." : ""})`;
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const alternatives = alternativesOf(schema);
  if (alternatives) return alternatives.slice(0, 3).map((candidate) => fieldType(candidate, depth + 1)).join("|");
  const type = schemaType(schema);
  if (type === "array") return `${fieldType(schema.items, depth + 1)}[]`;
  if (type === "object" && isRecord(schema.properties) && depth < 2) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const names = Object.keys(schema.properties);
    return `{${names.slice(0, 12).map((name) => `${name}${required.has(name) ? "!" : ""}`).join(",")}${names.length > 12 ? ",..." : ""}}`;
  }
  const notes: string[] = [];
  if (typeof schema.format === "string") notes.push(schema.format);
  if (typeof schema.maximum === "number") notes.push(`<=${schema.maximum}`);
  if (typeof schema.maxLength === "number" && schema.maxLength <= 500) notes.push(`<=${schema.maxLength}ch`);
  if (schema.nullable === true) notes.push("nullable");
  return notes.length > 0 ? `${type}(${notes.join(",")})` : type;
}

/** `name!:type` (`!` marks required), required fields first. */
function fieldList(value: unknown): string[] {
  const schema = node(value);
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties)
    .sort(([left], [right]) => Number(required.has(right)) - Number(required.has(left)))
    .slice(0, MAX_FIELDS)
    .map(([name, field]) => `${name}${required.has(name) ? "!" : ""}:${fieldType(field, 0)}`);
}

function inputParts(operation: AgentOperationManifestEntry) {
  const input = isRecord(operation.inputSchema) ? operation.inputSchema : {};
  const parameters = Array.isArray(input.parameters) ? input.parameters.filter(isRecord) : [];
  const requestBody = isRecord(input.requestBody) ? input.requestBody : null;
  const content = requestBody && isRecord(requestBody.content) ? requestBody.content : null;
  const json = content && isRecord(content["application/json"]) ? content["application/json"] : null;
  return { parameters, bodySchema: json?.schema };
}

function parameterList(operation: AgentOperationManifestEntry, location: "path" | "query"): string[] {
  return inputParts(operation).parameters
    .filter((parameter) => parameter.in === location && typeof parameter.name === "string")
    .sort((left, right) => Number(right.required === true) - Number(left.required === true))
    .slice(0, MAX_FIELDS)
    .map((parameter) => `${parameter.name as string}${parameter.required === true ? "!" : ""}:${fieldType(parameter.schema, 0)}`);
}

function placeholder(name: string, schema: Record<string, unknown>): string {
  switch (schema.format) {
    case "date-time": return "2026-10-19T00:00:00.000Z";
    case "date": return "2026-10-19";
    case "email": return "buyer@example.com";
    case "uri":
    case "url": return "https://example.com";
    case "uuid": return "00000000-0000-4000-8000-000000000000";
    default: return `<${name}>`;
  }
}

function exampleValue(name: string, value: unknown, depth: number, optional: boolean): unknown {
  const schema = node(value);
  if (!isRecord(schema) || depth > 5) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const alternatives = alternativesOf(schema);
  if (alternatives && alternatives.length > 0) return exampleValue(name, alternatives[0], depth + 1, optional);
  switch (schemaType(schema)) {
    case "object": {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      return Object.fromEntries(Object.entries(properties)
        .filter(([key]) => required.has(key) || (optional && depth < 2))
        .map(([key, field]) => [key, exampleValue(key, field, depth + 1, optional)]));
    }
    case "array": return [exampleValue(name.replace(/s$/, ""), schema.items, depth + 1, optional)];
    case "integer":
    case "number": {
      const minimum = typeof schema.minimum === "number" ? schema.minimum : null;
      if (minimum === null) return 1;
      return schema.exclusiveMinimum === true ? minimum + 1 : Math.max(minimum, 1);
    }
    case "boolean": return false;
    case "string": return placeholder(name, schema);
    default: return null;
  }
}

/** One input in the operation's shape: required fields (with `optional`, optional ones too), bounded. */
export function exampleInput(operation: AgentOperationManifestEntry, optional = false): Record<string, unknown> {
  const { parameters, bodySchema } = inputParts(operation);
  const example: Record<string, unknown> = {};
  for (const location of ["path", "query"] as const) {
    const values = Object.fromEntries(parameters
      .filter((parameter) => parameter.in === location && typeof parameter.name === "string" &&
        (location === "path" || parameter.required === true || optional))
      .map((parameter) => [parameter.name as string, exampleValue(parameter.name as string, parameter.schema, 1, optional)]));
    if (Object.keys(values).length > 0) example[location] = values;
  }
  if (bodySchema !== undefined) example.body = exampleValue("body", bodySchema, 0, optional);
  if (bytes(example) <= (optional ? FULL_EXAMPLE_MAX_BYTES : EXAMPLE_MAX_BYTES)) return example;
  return optional ? exampleInput(operation, false) : { ...example, body: "<too large: see detail full>" };
}

/** The route's `data` fields; a row array lists its row fields. */
function responseFields(operation: AgentOperationManifestEntry): string[] {
  const output = node(operation.outputSchema);
  if (!isRecord(output) || !isRecord(output.properties)) return [];
  const data = node(output.properties.data);
  if (!isRecord(data)) return [];
  const names = (value: unknown) => fieldList(value).map((field) => field.split(":")[0]!.replace(/!$/, "")).slice(0, 12);
  if (schemaType(data) === "array") return [`[]{${names(node(data.items)).join(",")}}`];
  if (!isRecord(data.properties)) return [schemaType(data)];
  return Object.entries(data.properties).slice(0, 24).map(([name, value]) => {
    const field = node(value);
    if (isRecord(field) && schemaType(field) === "array") {
      const items = names(node(field.items));
      return items.length > 0 ? `${name}[]{${items.join(",")}}` : `${name}[]`;
    }
    return name;
  });
}

function writeRules(operation: AgentOperationManifestEntry): string[] {
  const rules: string[] = [];
  if (operation.revision === "required") rules.push("Send the revision from a fresh read; a stale one is a 409 carrying current.");
  if (operation.idempotency !== "none") rules.push("scalius_write adds an idempotency key; retry with meta.idempotencyKey.");
  if (isConfirmGated(operation)) rules.push("Needs confirmation: dryRun:true, show confirmation.summary to the merchant, then send confirmToken.");
  if (operation.batch === "forbidden") rules.push("Not allowed in steps[].");
  if (operation.artifactOutput) rules.push("Returns a one-use artifact resource link.");
  return rules;
}

export function describeOperationBrief(operation: AgentOperationManifestEntry, detail: "compact" | "examples" = "compact") {
  const path = parameterList(operation, "path");
  const query = parameterList(operation, "query");
  const body = fieldList(inputParts(operation).bodySchema);
  const rules = writeRules(operation);
  return {
    operationId: operation.operationId,
    purpose: operation.summary,
    ...(operation.when ?? operation.description ? { when: (operation.when ?? operation.description)!.slice(0, 240) } : {}),
    risk: operation.risk,
    stability: operation.stability,
    inputs: {
      ...(path.length > 0 ? { path } : {}),
      ...(query.length > 0 ? { query } : {}),
      ...(body.length > 0 ? { body } : {}),
    },
    revision: operation.revision,
    idempotency: operation.idempotency,
    dryRun: dryRunSupportOf(operation),
    ...(rules.length > 0 ? { rules } : {}),
    example: exampleInput(operation, detail === "examples"),
    returns: responseFields(operation),
  };
}

export type AgentOperationDescription =
  | { kind: "described"; value: Record<string, unknown> }
  | { kind: "resource"; value: Record<string, unknown>; uri: string };

/** One operation at the requested detail. A full schema over 32 KiB becomes a resource reference. */
export function describeForAgent(operation: AgentOperationManifestEntry, detail: AgentDescribeDetail): AgentOperationDescription {
  const full = {
    ...describeOperation(operation, true),
    dryRun: dryRunSupportOf(operation),
    example: exampleInput(operation, false),
  };
  const fullBytes = bytes(full);
  if (detail === "full") {
    if (fullBytes <= FULL_DESCRIBE_MAX_BYTES) return { kind: "described", value: full };
    const uri = `scalius://ops/${operation.operationId}`;
    return {
      kind: "resource",
      uri,
      value: {
        ...describeOperationBrief(operation, "compact"),
        bytes: fullBytes,
        resource: uri,
        note: "The full schema is larger than one result; read the resource, or use detail compact.",
      },
    };
  }
  const brief = describeOperationBrief(operation, detail);
  return { kind: "described", value: bytes(brief) <= fullBytes ? brief : full };
}
