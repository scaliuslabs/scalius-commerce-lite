/**
 * Breaking-change check between two versions of a sealed schema: the stable
 * app API's operations (`apps/api/src/openapi/stable-operations.test.ts`),
 * the webhook representations, and the plugin ABI (`plugins/abi-compat.ts`,
 * through `openApiDialect`, which reads zod's JSON Schema 2020-12).
 *
 * A request schema may only accept more: a new required field or parameter,
 * a removed field, a narrower type, enum, bound or pattern, or a lost
 * `nullable` breaks. A response schema may only promise more: a removed or
 * no-longer-required field, a changed type or a new `nullable` breaks.
 * New optional request fields, new response fields, new response enum
 * values and new union variants in a response are additive (clients must
 * tolerate unknown values, as with Shopify's Admin API).
 *
 * The check covers the keywords Scalius routes emit (type, nullable, enum,
 * properties, required, additionalProperties, propertyNames, items,
 * oneOf/anyOf/allOf, string/number/array bounds, pattern, format). Anything
 * else that changes is still caught by the exact snapshot, which an additive
 * change updates.
 */

import { resolveComponentSchemaRef, type ComponentSchemas } from "./openapi-schema-refs";

export type SchemaDirection = "request" | "response";

type Schema = Record<string, unknown>;

function isRecord(value: unknown): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface Side {
  schema: unknown;
  components: ComponentSchemas;
}

/** A schema with its component reference resolved and a lone `allOf` (OpenAPI 3.0's nullable reference) merged. */
function normalize(side: Side, depth = 0): Schema {
  const resolved = resolveComponentSchemaRef(side.schema, side.components);
  if (!isRecord(resolved)) return {};
  const allOf = resolved.allOf;
  if (!Array.isArray(allOf) || depth > 8) return resolved;
  const { allOf: _allOf, ...rest } = resolved;
  const merged: Schema = {};
  const properties: Schema = {};
  const required = new Set<string>();
  for (const member of allOf) {
    const part = normalize({ schema: member, components: side.components }, depth + 1);
    Object.assign(merged, part);
    if (isRecord(part.properties)) Object.assign(properties, part.properties);
    if (Array.isArray(part.required)) part.required.forEach((name) => required.add(String(name)));
  }
  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.size > 0) merged.required = [...required];
  return { ...merged, ...rest };
}

const BOUND_KEYS = {
  upper: ["maxLength", "maxItems", "maximum", "maxProperties"],
  lower: ["minLength", "minItems", "minimum", "minProperties"],
} as const;

function enumValues(schema: Schema): string[] | null {
  return Array.isArray(schema.enum) ? schema.enum.map((value) => JSON.stringify(value)) : null;
}

function variants(schema: Schema): unknown[] | null {
  if (Array.isArray(schema.oneOf)) return schema.oneOf;
  if (Array.isArray(schema.anyOf)) return schema.anyOf;
  return null;
}

/** A union variant's discriminator: its single-value enum properties (`section: "base"`). */
function signature(side: Side): string {
  const schema = normalize(side);
  if (!isRecord(schema.properties)) return "";
  return Object.entries(schema.properties)
    .map(([name, property]) => {
      const resolved = normalize({ schema: property, components: side.components });
      return Array.isArray(resolved.enum) && resolved.enum.length === 1 ? `${name}=${JSON.stringify(resolved.enum[0])}` : null;
    })
    .filter((entry): entry is string => entry !== null)
    .sort()
    .join("&");
}

function matchVariants(before: Side[], after: Side[]): Array<[number, number | null]> {
  const beforeKeys = before.map(signature);
  const afterKeys = after.map(signature);
  const keyed = beforeKeys.every((key) => key !== "") && new Set(beforeKeys).size === beforeKeys.length;
  return before.map((_, index) => {
    if (!keyed) return [index, index < after.length ? index : null];
    const match = afterKeys.indexOf(beforeKeys[index]!);
    return [index, match >= 0 ? match : null];
  });
}

function typeCompatible(before: unknown, after: unknown, direction: SchemaDirection): boolean {
  if (before === after || before === undefined) return true;
  if (after === undefined) return direction === "request";
  // An integer is a number: a request may widen to number, a response narrow to integer.
  if (direction === "request") return before === "integer" && after === "number";
  return before === "number" && after === "integer";
}

function compare(before: Side, after: Side, direction: SchemaDirection, path: string, out: string[], seen: Set<string>): void {
  // A recursive component (a tree) would nest forever: compare the first 24 levels.
  if (path.split(/[.[{]/).length > 24) return;
  if (seen.has(path)) return;
  seen.add(path);
  const b = normalize(before);
  const a = normalize(after);
  const at = path || "(root)";

  if (direction === "request" && b.nullable === true && a.nullable !== true) out.push(`${at}: null is no longer accepted.`);
  if (direction === "response" && b.nullable !== true && a.nullable === true) out.push(`${at}: the response may now be null.`);

  const bVariants = variants(b);
  const aVariants = variants(a);
  if (bVariants || aVariants) {
    const bSides = (bVariants ?? [b]).map((schema) => ({ schema, components: before.components }));
    const aSides = (aVariants ?? [a]).map((schema) => ({ schema, components: after.components }));
    for (const [bIndex, aIndex] of matchVariants(bSides, aSides)) {
      if (aIndex === null) {
        if (direction === "request") out.push(`${at}: a request variant is no longer accepted.`);
        else continue; // a response that stops producing a variant breaks no client
      } else {
        compare(bSides[bIndex]!, aSides[aIndex]!, direction, `${path}[variant ${bIndex}]`, out, seen);
      }
    }
    return;
  }

  if (!typeCompatible(b.type, a.type, direction)) out.push(`${at}: type changed from ${String(b.type)} to ${String(a.type)}.`);

  const bEnum = enumValues(b);
  const aEnum = enumValues(a);
  if (direction === "request" && aEnum) {
    const removed = bEnum ? bEnum.filter((value) => !aEnum.includes(value)) : ["(any value)"];
    if (removed.length > 0) out.push(`${at}: no longer accepts ${removed.join(", ")}.`);
  }

  if (direction === "request") {
    for (const bound of BOUND_KEYS.upper) {
      const was = b[bound];
      const now = a[bound];
      if (typeof now === "number" && (typeof was !== "number" || now < was)) out.push(`${at}: ${bound} tightened to ${now}.`);
    }
    for (const bound of BOUND_KEYS.lower) {
      const was = b[bound];
      const now = a[bound];
      if (typeof now === "number" && (typeof was !== "number" || now > was)) out.push(`${at}: ${bound} tightened to ${now}.`);
    }
    for (const exclusive of ["exclusiveMinimum", "exclusiveMaximum"] as const) {
      if (a[exclusive] === true && b[exclusive] !== true) out.push(`${at}: ${exclusive} added.`);
    }
    if (a.pattern !== undefined && a.pattern !== b.pattern) out.push(`${at}: pattern changed.`);
    if (a.format !== undefined && a.format !== b.format) out.push(`${at}: format changed to ${String(a.format)}.`);
    if (a.additionalProperties === false && b.additionalProperties !== false && b.type === "object") {
      out.push(`${at}: additional properties are no longer accepted.`);
    }
  }

  const bProps = isRecord(b.properties) ? b.properties : {};
  const aProps = isRecord(a.properties) ? a.properties : {};
  const bRequired = new Set(Array.isArray(b.required) ? b.required.map(String) : []);
  const aRequired = new Set(Array.isArray(a.required) ? a.required.map(String) : []);
  for (const name of Object.keys(bProps)) {
    const child = path ? `${path}.${name}` : name;
    if (!(name in aProps)) {
      out.push(direction === "request" ? `${child}: the field is no longer accepted.` : `${child}: the field was removed.`);
      continue;
    }
    if (direction === "response" && bRequired.has(name) && !aRequired.has(name)) out.push(`${child}: the field is no longer always present.`);
    compare({ schema: bProps[name], components: before.components }, { schema: aProps[name], components: after.components }, direction, child, out, seen);
  }
  if (direction === "request") {
    for (const name of aRequired) {
      if (!bRequired.has(name)) out.push(`${path ? `${path}.${name}` : name}: a new required field.`);
    }
  }
  if (isRecord(b.additionalProperties) && isRecord(a.additionalProperties)) {
    compare({ schema: b.additionalProperties, components: before.components }, { schema: a.additionalProperties, components: after.components }, direction, `${path}{*}`, out, seen);
  }
  if (isRecord(b.propertyNames) || isRecord(a.propertyNames)) {
    compare({ schema: b.propertyNames ?? {}, components: before.components }, { schema: a.propertyNames ?? {}, components: after.components }, direction, `${path}{key}`, out, seen);
  }
  if (b.items !== undefined && a.items !== undefined) {
    compare({ schema: b.items, components: before.components }, { schema: a.items, components: after.components }, direction, `${path}[]`, out, seen);
  }
}

/** The breaking differences between two schemas, as readable lines (empty when compatible). */
export function schemaBreakingChanges(
  before: unknown,
  after: unknown,
  direction: SchemaDirection,
  components: { before: ComponentSchemas; after: ComponentSchemas },
  path = "",
): string[] {
  const out: string[] = [];
  compare({ schema: before, components: components.before }, { schema: after, components: components.after }, direction, path, out, new Set());
  return out;
}

type Parameter = { name: string; in: string; required?: boolean; schema?: unknown };

function parameters(input: unknown): Map<string, Parameter> {
  const list = isRecord(input) && Array.isArray(input.parameters) ? input.parameters : [];
  return new Map(list.filter(isRecord).map((parameter) => [`${String(parameter.in)}:${String(parameter.name)}`, parameter as Parameter]));
}

function jsonBody(input: unknown): { required: boolean; schema: unknown } | null {
  if (!isRecord(input) || !isRecord(input.requestBody)) return null;
  const content = isRecord(input.requestBody.content) ? input.requestBody.content : {};
  const json = isRecord(content["application/json"]) ? content["application/json"] : null;
  return { required: input.requestBody.required === true, schema: json?.schema ?? null };
}

/** Breaking differences of an operation's input (`{ parameters, requestBody }`). */
export function inputBreakingChanges(
  before: unknown,
  after: unknown,
  components: { before: ComponentSchemas; after: ComponentSchemas },
): string[] {
  const out: string[] = [];
  const beforeParameters = parameters(before);
  const afterParameters = parameters(after);
  for (const [key, parameter] of beforeParameters) {
    const next = afterParameters.get(key);
    if (!next) {
      out.push(`parameter ${key}: no longer accepted.`);
      continue;
    }
    out.push(...schemaBreakingChanges(parameter.schema, next.schema, "request", components, `parameter ${key}`));
  }
  for (const [key, parameter] of afterParameters) {
    if (parameter.required === true && beforeParameters.get(key)?.required !== true) out.push(`parameter ${key}: newly required.`);
  }
  const beforeBody = jsonBody(before);
  const afterBody = jsonBody(after);
  if (beforeBody && !afterBody) out.push("body: no longer accepted.");
  if (afterBody?.required && !beforeBody?.required) out.push("body: newly required.");
  if (beforeBody && afterBody) out.push(...schemaBreakingChanges(beforeBody.schema, afterBody.schema, "request", components, "body"));
  return out;
}

const JSON_SCHEMA_DEFS_PREFIX = "#/$defs/";

/**
 * A JSON Schema 2020-12 document (`z.toJSONSchema`) in the OpenAPI 3.0
 * dialect the checker reads: `$defs` become components, `const` a one-value
 * `enum`, a `null` type or union member `nullable`, and a numeric exclusive
 * bound a bound with the boolean flag. Nested `$schema` keys are dropped.
 */
export function openApiDialect(document: unknown): { schema: unknown; components: ComponentSchemas } {
  const components: Record<string, unknown> = {};
  const convert = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(convert);
    if (!isRecord(node)) return node;
    const { $schema: _schema, $defs, const: constant, type, anyOf, oneOf, exclusiveMinimum, exclusiveMaximum, $ref, ...rest } = node;
    if (isRecord($defs)) for (const [name, value] of Object.entries($defs)) components[name] = convert(value);
    const out: Schema = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, convert(value)]));
    if (typeof $ref === "string") out.$ref = $ref.startsWith(JSON_SCHEMA_DEFS_PREFIX) ? `#/components/schemas/${$ref.slice(JSON_SCHEMA_DEFS_PREFIX.length)}` : $ref;
    if (constant !== undefined) out.enum = [constant];
    if (Array.isArray(type)) {
      const types = type.filter((entry) => entry !== "null");
      if (types.length < type.length) out.nullable = true;
      if (types.length === 1) out.type = types[0];
      else if (types.length > 1) out.type = types;
    } else if (type !== undefined) {
      out.type = type;
    }
    for (const [keyword, bound, value] of [["exclusiveMinimum", "minimum", exclusiveMinimum], ["exclusiveMaximum", "maximum", exclusiveMaximum]] as const) {
      if (typeof value === "number") {
        out[bound] = value;
        out[keyword] = true;
      } else if (value !== undefined) {
        out[keyword] = value;
      }
    }
    for (const [keyword, members] of [["anyOf", anyOf], ["oneOf", oneOf]] as const) {
      if (!Array.isArray(members)) continue;
      const converted = members.map(convert);
      const present = converted.filter((member) => !(isRecord(member) && member.type === "null" && Object.keys(member).length === 1));
      if (present.length < converted.length) out.nullable = true;
      if (present.length === 1 && isRecord(present[0])) Object.assign(out, present[0], out.nullable ? { nullable: true } : {});
      else out[keyword] = present;
    }
    return out;
  };
  const schema = convert(document);
  return { schema, components };
}

/** The breaking differences between two zod JSON Schema documents (see `openApiDialect`). */
export function jsonSchemaBreakingChanges(before: unknown, after: unknown, direction: SchemaDirection, path = ""): string[] {
  const was = openApiDialect(before);
  const now = openApiDialect(after);
  return schemaBreakingChanges(was.schema, now.schema, direction, { before: was.components, after: now.components }, path);
}
