// The SDK's generated references (packages/plugin-sdk/docs/operations.md and
// events.md): every stable app API operation with its request, response and
// scopes, and every event topic with its facts, rendered from the one source
// each has (the sealed stable-operations snapshot; EVENT_FACT_SCHEMAS). No
// list is kept by hand. `node scripts/plugin-contract.mjs` writes them with
// the SDK's contract copy; scripts/plugin-contract.test.mjs fails when stale.

const APP_OWNED = {
  keys: "its keys are `<app id>.<key>`; an app reads and writes only its own",
  entries: "an app sees only its own entries",
};
const PROTECTED = {
  name: "read_customer_names",
  email: "read_customer_emails",
  phone: "read_customer_phones",
  address: "read_customer_addresses",
};

const anchor = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const code = (text) => `\`${text}\``;
const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

/** A schema's type as a short, readable expression: `string`, `OrderResource[]`, `"a" | "b"`, `{ id, name? }`. */
export function schemaType(schema, depth = 0) {
  if (!schema || typeof schema !== "object") return "unknown";
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop();
    return `[${name}](#${anchor(name)})`;
  }
  const nullable = schema.nullable ? " | null" : "";
  const union = schema.anyOf ?? schema.oneOf;
  if (union) return union.map((each) => schemaType(each, depth)).join(" | ") + nullable;
  if (schema.allOf) return schema.allOf.map((each) => schemaType(each, depth)).join(" & ") + nullable;
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ") + nullable;
  if (schema.type === "array") return `${wrap(schemaType(schema.items, depth))}[]${nullable}`;
  if (schema.type === "object" || schema.properties) {
    const properties = Object.entries(schema.properties ?? {});
    if (properties.length === 0) {
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") return `Record<string, ${schemaType(schema.additionalProperties, depth + 1)}>${nullable}`;
      return `object${nullable}`;
    }
    const required = new Set(schema.required ?? []);
    // Nested shapes list their fields' names only, so a table row stays readable.
    if (depth >= 1) return `{ ${properties.map(([key]) => `${key}${required.has(key) ? "" : "?"}`).join(", ")} }${nullable}`;
    return `{ ${properties.map(([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${schemaType(value, depth + 1)}`).join(", ")} }${nullable}`;
  }
  const type = schema.type === "integer" ? "integer" : schema.type ?? "unknown";
  return `${type}${nullable}`;
}

const wrap = (type) => (/[ |&]/.test(type) && !type.startsWith("{") && !type.startsWith("[") ? `(${type})` : type);

/** The constraints and notes of one schema, in words: lengths, bounds, formats, defaults, protection and app ownership. */
export function schemaNotes(schema) {
  if (!schema || typeof schema !== "object" || schema.$ref) return "";
  const notes = [];
  const description = schema.description?.trim().replace(/\.$/u, "") ?? "";
  if (description) notes.push(description);
  // A description that already states the limit is not repeated.
  const says = (value) => value !== undefined && description.replace(/,/g, "").includes(String(value));
  const length = [schema.minLength, says(schema.maxLength) ? undefined : schema.maxLength];
  if (length[0] !== undefined && length[1] !== undefined) notes.push(`${length[0]} to ${length[1]} characters`);
  else if (length[1] !== undefined) notes.push(`at most ${length[1]} characters`);
  else if (length[0] !== undefined) notes.push(`at least ${length[0]} characters`);
  const low = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? `more than ${schema.exclusiveMinimum}` : undefined);
  if (low !== undefined && schema.maximum !== undefined) notes.push(`${low} to ${schema.maximum}`);
  else if (low !== undefined) notes.push(typeof low === "string" ? low : `at least ${low}`);
  else if (schema.maximum !== undefined) notes.push(`at most ${schema.maximum}`);
  if (schema.minItems !== undefined || schema.maxItems !== undefined) {
    notes.push(schema.minItems !== undefined && schema.maxItems !== undefined ? `${schema.minItems} to ${schema.maxItems} items` : schema.maxItems !== undefined ? `at most ${schema.maxItems} items` : `at least ${schema.minItems} items`);
  }
  if (schema.format) notes.push(schema.format === "date-time" ? "ISO 8601 date-time" : schema.format);
  if (schema.pattern) notes.push(`pattern ${code(schema.pattern)}`);
  if (schema.default !== undefined) notes.push(`default ${code(JSON.stringify(schema.default))}`);
  const protectedData = schema["x-scalius-protected"];
  if (protectedData) notes.push(`protected: null unless the app holds ${code(PROTECTED[protectedData] ?? `read_customer_${protectedData}`)}`);
  const owned = schema["x-scalius-app-owned"];
  if (owned) notes.push(APP_OWNED[owned] ?? `app-owned (${owned})`);
  return notes.join("; ");
}

/** A field table of an object schema (one row per property). */
function fieldTable(schema) {
  const properties = Object.entries(schema?.properties ?? {});
  if (properties.length === 0) return [`Type: ${schemaType(schema)}${schemaNotes(schema) ? `. ${cell(schemaNotes(schema))}` : ""}`];
  const required = new Set(schema.required ?? []);
  return [
    "| Field | Type | Required | Notes |",
    "| --- | --- | --- | --- |",
    ...properties.map(([key, value]) => `| ${code(key)} | ${cell(schemaType(value))} | ${required.has(key) ? "yes" : ""} | ${cell(schemaNotes(value))} |`),
  ];
}

function parameterRows(parameters) {
  return parameters.map((parameter) => `| ${code(parameter.name)} | ${parameter.in} | ${cell(schemaType(parameter.schema))} | ${parameter.required ? "yes" : ""} | ${cell(schemaNotes({ ...parameter.schema, description: parameter.description ?? parameter.schema?.description }))} |`);
}

const AREA = (name) => name.split(".")[0];
const IDEMPOTENCY = {
  required: "required: pass `idempotencyKey` (8 to 200 printable characters); a repeat within 24 hours answers the first result",
  supported: "supported: pass `idempotencyKey` to make a retry safe",
  none: "none (a read)",
};
const REVISION = {
  required: "required: pass the `revision` you read as `expectedRevision`; a changed resource answers 409",
  optional: "optional: pass `expectedRevision` to refuse a change made since you read",
  none: "",
};

/**
 * `docs/operations.md`: every stable operation by area, then every component
 * schema, from the sealed stable-operations snapshot.
 */
export function renderOperationsReference(snapshotText) {
  const { operations, components } = JSON.parse(snapshotText);
  const names = Object.keys(operations).sort();
  const areas = [...new Set(names.map(AREA))];
  const lines = [
    "<!-- Generated by `node scripts/plugin-contract.mjs` from apps/api/src/openapi/stable-operations.snapshot.json. Do not edit by hand. -->",
    "",
    "# Stable app API reference",
    "",
    `Every operation an app may call with \`ctx.api.call(name, { path, query, body, idempotencyKey })\`: ${names.length} operations in ${areas.length} areas, generated from the contract this SDK release is sealed with (\`stableContract\` in \`@scalius/plugin-sdk/testing\`, which \`createContractApi\` checks calls against). Each answers \`{ ok, status, data, error }\`; \`data\` is the response below. A scope listed is enough on its own: a \`write_*\` scope includes its \`read_*\`. Money is integer minor units beside a \`currency\`; every list takes \`cursor\` and \`limit\` and answers \`nextCursor\`.`,
    "",
    "## Operations",
    "",
    "| Area | Operations |",
    "| --- | --- |",
    ...areas.map((area) => `| ${area} | ${names.filter((name) => AREA(name) === area).map((name) => `[${code(name.slice(area.length + 1))}](#${anchor(name)})`).join(", ")} |`),
    "",
  ];
  for (const area of areas) {
    lines.push(`## ${area}`, "");
    for (const name of names.filter((each) => AREA(each) === area)) {
      const operation = operations[name];
      lines.push(`### ${name}`, "");
      lines.push(`${code(`${operation.method} ${operation.path}`)}. Scopes: ${operation.scopes.length > 0 ? `any one of ${operation.scopes.map(code).join(", ")}` : "none"}. Risk: ${operation.risk}.`, "");
      lines.push(`- Idempotency: ${IDEMPOTENCY[operation.idempotency] ?? operation.idempotency}.`);
      if (REVISION[operation.revision]) lines.push(`- Revision: ${REVISION[operation.revision]}.`);
      lines.push("");
      const parameters = (operation.input?.parameters ?? []).filter((parameter) => parameter.in !== "header");
      if (parameters.length > 0) {
        lines.push("Parameters:", "", "| Name | In | Type | Required | Notes |", "| --- | --- | --- | --- | --- |", ...parameterRows(parameters), "");
      }
      const body = operation.input?.requestBody?.content?.["application/json"]?.schema;
      if (body) lines.push(`Body${operation.input.requestBody.required ? "" : " (optional)"}:`, "", ...fieldTable(body), "");
      const data = operation.output?.properties?.data;
      if (data) lines.push("Response `data`:", "", ...fieldTable(data), "");
    }
  }
  lines.push("## Schemas", "", "The resources and shapes the operations name.", "");
  for (const name of Object.keys(components).sort()) {
    lines.push(`### ${name}`, "", ...fieldTable(components[name]), "");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

const READ_OPERATION = {
  order: "orders.get",
  product: "products.get",
  variant: "variants.get",
  customer: "customers.get",
  refund: "refunds.list",
  review: "reviews.get",
  gift_card: "gift_cards.get",
  checkout: "abandoned_checkouts.get",
  fulfillment: "fulfillments.list",
  shipment: "shipments.get",
  payment: "payments.list",
  return: "returns.get",
  discount: "discounts.get",
  purchase_order: "purchase_orders.get",
  inventory_transfer: "inventory_transfers.get",
  conversation: "conversations.get",
  payout: "payouts.get",
  object: "objects.get",
};

/**
 * `docs/events.md`: every topic, the resource it is about and its facts, from
 * `EVENT_TOPICS`, `EVENT_TOPIC_RESOURCE` and `EVENT_FACT_SCHEMAS` (as JSON
 * Schema), plus the stable read for the resource when there is one.
 */
export function renderEventsReference({ topics, resources, facts, stableOperations }) {
  const lines = [
    "<!-- Generated by `node scripts/plugin-contract.mjs` from packages/shared/src/events.ts. Do not edit by hand. -->",
    "",
    "# Event reference",
    "",
    `Every topic an app may subscribe to (\`events\` in the manifest), ${topics.length} in all. A handler gets \`{ id, topic, apiVersion, occurredAt, resource: { type, id }, facts }\`. Facts are ids, states and quantities, never contact data or money: read the resource with \`ctx.api\` for the rest. Delivery is at least once, so key your work by \`event.id\`. A fact a later release adds is additive: never refuse an event for a key you do not know.`,
    "",
    "| Topic | Resource | Read it with |",
    "| --- | --- | --- |",
    ...topics.map((topic) => {
      const read = READ_OPERATION[resources[topic]];
      return `| [${code(topic)}](#${anchor(topic)}) | ${code(resources[topic])} | ${read && stableOperations.includes(read) ? code(read) : ""} |`;
    }),
    "",
  ];
  for (const topic of topics) {
    lines.push(`## ${topic}`, "", `Resource: ${code(resources[topic])}.`, "", ...fieldTable(facts[topic]), "");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
