#!/usr/bin/env node
// Generates each skill's references/recipes.md and references/workflows.md
// from scripts/recipes.source.json, the operation manifest and its workflow
// catalog (apps/api/src/generated/agent-operations.gen.txt). Facts an agent
// acts on (risk, approval, revision, required inputs, route steps) come from
// the manifest, so the skills cannot drift from the contract: a referenced
// operation or route that disappears fails the generation.
//
//   node scripts/generate-recipes.mjs          write the files
//   node scripts/generate-recipes.mjs --check  exit 1 when a file is stale

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export const MANIFEST_PATH = join(packageRoot, "../../apps/api/src/generated/agent-operations.gen.txt");
export const SOURCE_PATH = join(packageRoot, "scripts/recipes.source.json");
export const REFERENCE_MAX_BYTES = 6 * 1024;

const GATED_RISKS = new Set(["destructive", "financial"]);
const REVISION_FIELD = /^expected(?:[A-Z]\w*)?(?:Revision|Version)$/;
const VERB_WIDTH = 6;

export function loadManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadSource(path = SOURCE_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveSchema(manifest, schema) {
  let current = schema;
  for (let depth = 0; depth < 6 && isRecord(current) && typeof current.$ref === "string"; depth += 1) {
    current = manifest.componentSchemas?.[current.$ref.split("/").pop()];
  }
  return current;
}

/** Required inputs, as path.x / query.x / body.x, without the revision fields `rev` already names. */
export function requiredInputs(manifest, operation) {
  const input = isRecord(operation.inputSchema) ? operation.inputSchema : {};
  const names = [];
  for (const parameter of Array.isArray(input.parameters) ? input.parameters : []) {
    if (parameter?.required === true && (parameter.in === "path" || parameter.in === "query")) names.push(`${parameter.in}.${parameter.name}`);
  }
  const body = resolveSchema(manifest, input.requestBody?.content?.["application/json"]?.schema);
  if (isRecord(body) && Array.isArray(body.required)) {
    for (const field of body.required) if (!REVISION_FIELD.test(field)) names.push(`body.${field}`);
  }
  return names;
}

/** Every field name a schema holds at any depth (objects, items, alternatives), and each enum field's values. */
function schemaFields(manifest, schema, names = new Set(), enums = new Map()) {
  const seen = new Set();
  const walk = (value, depth) => {
    const resolved = resolveSchema(manifest, value);
    if (!isRecord(resolved) || depth > 24 || seen.has(resolved)) return;
    seen.add(resolved);
    for (const [name, property] of Object.entries(isRecord(resolved.properties) ? resolved.properties : {})) {
      names.add(name);
      const field = resolveSchema(manifest, property);
      if (isRecord(field) && Array.isArray(field.enum)) {
        const values = enums.get(name) ?? new Set();
        for (const entry of field.enum) values.add(String(entry));
        enums.set(name, values);
      }
      walk(property, depth + 1);
    }
    walk(resolved.items, depth + 1);
    if (isRecord(resolved.additionalProperties)) walk(resolved.additionalProperties, depth + 1);
    for (const key of ["allOf", "oneOf", "anyOf"]) for (const part of Array.isArray(resolved[key]) ? resolved[key] : []) walk(part, depth + 1);
  };
  walk(schema, 0);
  return { names, enums };
}

/** Every name a request of `operation` takes: path and query parameters, and body properties at any depth. */
export function requestFieldNames(manifest, operation) {
  return requestFields(manifest, operation).names;
}

/** The request's field names and, for each enum field, the values it accepts. */
function requestFields(manifest, operation) {
  const input = isRecord(operation.inputSchema) ? operation.inputSchema : {};
  const names = new Set();
  const enums = new Map();
  for (const parameter of Array.isArray(input.parameters) ? input.parameters : []) {
    if (typeof parameter?.name !== "string") continue;
    names.add(parameter.name);
    const schema = resolveSchema(manifest, parameter.schema);
    if (isRecord(schema) && Array.isArray(schema.enum)) enums.set(parameter.name, new Set(schema.enum.map(String)));
  }
  return schemaFields(manifest, input.requestBody?.content?.["application/json"]?.schema, names, enums);
}

/** Every field name a response of `operation` carries, at any depth. */
export function responseFieldNames(manifest, operation) {
  return schemaFields(manifest, operation.outputSchema).names;
}

/** A field name in prose: a camelCase word (`expectedRevision`) or a name in backticks (`version`), never plain words. */
const FIELD_NAME = /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g;
const TICKED_NAME = /`([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)`/g;
/** Words of the camelCase shape that are names, not fields. */
const PROPER_NOUNS = new Set(["bKash"]);

function namedFields(text) {
  return [...new Set([...(text.match(FIELD_NAME) ?? []), ...[...text.matchAll(TICKED_NAME)].map((match) => match[1])])]
    // An operation id in backticks names an operation, not a field.
    .filter((name) => !PROPER_NOUNS.has(name) && !/^(?:dashboard|storefront|system|objects)\./.test(name));
}

/** The values each field name takes anywhere in the manifest: what makes `status returned` a claim about a value. */
function knownValues(manifest) {
  if (knownValues.cache?.manifest === manifest) return knownValues.cache.values;
  const values = new Map();
  for (const operation of manifest.operations) {
    for (const fields of [requestFields(manifest, operation).enums, schemaFields(manifest, operation.outputSchema).enums]) {
      for (const [name, entries] of fields) {
        const all = values.get(name) ?? new Set();
        for (const entry of entries) all.add(entry);
        values.set(name, all);
      }
    }
  }
  knownValues.cache = { manifest, values };
  return values;
}

/**
 * The values prose claims an operation takes (`status returned`, `action
 * collected`) that its request refuses: a value the same field takes
 * somewhere, named after one of this request's enum fields, but not in it.
 */
function refusedValueClaims(manifest, operation, text) {
  const known = knownValues(manifest);
  const claims = [];
  for (const [field, accepted] of requestFields(manifest, operation).enums) {
    for (const match of text.matchAll(new RegExp(`\\b${field}\`?\\s+\`?([a-z][a-z0-9_]*)\\b`, "g"))) {
      if (known.get(field)?.has(match[1]) && !accepted.has(match[1])) claims.push(`${field} ${match[1]}`);
    }
  }
  return claims;
}

/** Fields of the agent tools' own envelope (scalius_write, confirmation) that guidance names beside an operation. */
const ENVELOPE_FIELDS = new Set(["approvalUrl", "approvalId", "idempotencyKey", "dryRun", "requestId"]);
const ENVELOPE_ROOTS = new Set(["confirmation", "meta"]);

/** Whether `segments` name a field at that path below `schema` (through arrays and alternatives). */
function pathResolves(manifest, schema, segments, depth = 0) {
  const resolved = resolveSchema(manifest, schema);
  if (segments.length === 0) return true;
  if (!isRecord(resolved) || depth > 24) return false;
  const [head, ...rest] = segments;
  if (isRecord(resolved.properties) && head in resolved.properties && pathResolves(manifest, resolved.properties[head], rest, depth + 1)) return true;
  const parts = [resolved.items, ...["allOf", "oneOf", "anyOf"].flatMap((key) => (Array.isArray(resolved[key]) ? resolved[key] : []))];
  return parts.some((part) => part !== undefined && pathResolves(manifest, part, segments, depth + 1));
}

/**
 * The names `text` gives that none of `targets` has. A plain name (`id`,
 * `expectedRevision`) is checked at any depth of a request (and, with
 * `answers`, of an answer), and a value an enum field takes counts as named;
 * a dotted name (`run.id`) is checked at that path from the request body or
 * the answer's `data`.
 */
function unresolvedNames(manifest, text, targets, { answers = true } = {}) {
  const plain = new Set(ENVELOPE_FIELDS);
  const roots = [];
  for (const operation of targets) {
    const request = requestFields(manifest, operation);
    for (const name of request.names) plain.add(name);
    for (const values of request.enums.values()) for (const value of values) plain.add(value);
    roots.push(operation.inputSchema?.requestBody?.content?.["application/json"]?.schema);
    if (!answers) continue;
    for (const name of responseFieldNames(manifest, operation)) plain.add(name);
    const output = resolveSchema(manifest, operation.outputSchema);
    roots.push(isRecord(output) && isRecord(output.properties) ? output.properties.data : undefined);
  }
  return namedFields(text).filter((name) => {
    if (!name.includes(".")) return !plain.has(name);
    const segments = name.split(".");
    return !ENVELOPE_ROOTS.has(segments[0]) && !roots.some((root) => root !== undefined && pathResolves(manifest, root, segments));
  });
}

/**
 * What a step's note names that its operation does not have: a write names
 * only fields its request takes and values it accepts; a read names fields
 * of its request or its answer.
 */
function stepFaults(manifest, operation, verb, note) {
  if (!note) return [];
  const unknown = unresolvedNames(manifest, note, [operation], { answers: verb !== "write" });
  const faults = unknown.length > 0
    ? [`names ${unknown.join(", ")} for ${operation.operationId}, which its ${verb === "write" ? "request does not take" : "request and answer do not have"}`]
    : [];
  const claims = verb === "write" ? refusedValueClaims(manifest, operation, note) : [];
  if (claims.length > 0) faults.push(`claims ${claims.join(", ")} for ${operation.operationId}, which its request refuses`);
  return faults;
}

function assertNamedFields(manifest, operation, verb, note, where) {
  const [fault] = stepFaults(manifest, operation, verb, note);
  if (fault) throw new Error(`${where} ${fault}.`);
}

function markers(operation) {
  const marks = [];
  if (GATED_RISKS.has(operation.risk) || operation.confirmation === "required") marks.push("[approval]");
  else if (operation.risk === "security") marks.push("[ask first]");
  return marks;
}

function available(operations, id) {
  const operation = operations.get(id);
  return operation !== undefined && operation.exposure !== "excluded";
}

function requireOperation(operations, id, where) {
  const operation = operations.get(id);
  if (!operation) throw new Error(`${where} references operation ${id}, which is not in the manifest.`);
  if (operation.exposure === "excluded") throw new Error(`${where} references operation ${id}, which agents cannot run.`);
  return operation;
}

function renderStep(manifest, operations, step, index, where, planned) {
  const [verb, target, note] = step;
  const prefix = `${index}. ${verb.padEnd(VERB_WIDTH)}`;
  const tail = note ? `: ${note}` : "";
  if (verb === "answer" || verb === "search") return `${prefix} "${target}"${tail}`;
  if (verb === "cli" || verb === "resource") return `${prefix} ${target}${tail}`;
  if (!["read", "write", "verify"].includes(verb)) throw new Error(`${where} has an unknown step verb '${verb}'.`);
  const operation = planned.has(target) && !operations.has(target)
    ? { operationId: target, risk: verb === "write" ? "write" : "read", inputSchema: {}, revision: "none" }
    : requireOperation(operations, target, where);
  if (verb === "write" && operation.risk === "read") throw new Error(`${where} writes with read operation ${target}.`);
  if (verb !== "write" && operation.risk !== "read") throw new Error(`${where} reads with ${operation.risk} operation ${target}.`);
  const facts = [...markers(operation)];
  if (operation.revision === "required") facts.push("rev");
  if (operation.idempotency === "required") facts.push("key");
  if (!planned.has(target)) assertNamedFields(manifest, operation, verb, note, where);
  const needs = verb === "write" ? requiredInputs(manifest, operation) : [];
  if (needs.length > 0) facts.push(`needs ${needs.slice(0, 6).join(", ")}${needs.length > 6 ? ", ..." : ""}`);
  return `${prefix} ${target}${facts.length > 0 ? ` ${facts.join("; ")}` : ""}${tail}`;
}

function renderRecipe(manifest, operations, recipe, skill) {
  const where = `Recipe "${recipe.title}" (${skill})`;
  const variants = recipe.variants ?? [{ steps: recipe.steps, note: recipe.note }];
  for (const variant of variants) {
    for (const step of variant.steps ?? []) {
      if (["read", "write", "verify"].includes(step[0]) && !(variant.requires ?? []).includes(step[1])) {
        requireOperation(operations, step[1], where);
      }
    }
  }
  const chosen = variants.find((variant) => (variant.requires ?? []).every((id) => available(operations, id)));
  if (!chosen) throw new Error(`${where} has no variant this API can run.`);
  const planned = new Set(chosen.requires ?? []);
  const lines = [`## ${recipe.title}`];
  (chosen.steps ?? []).forEach((step, index) => lines.push(renderStep(manifest, operations, step, index + 1, where, planned)));
  const note = chosen.note ?? recipe.note;
  if (note) lines.push(`Note: ${note}`);
  return lines.join("\n");
}

const LEGEND = [
  "Each step is one call. answer = scalius_answer, search = scalius_search, read/verify = scalius_read, write = scalius_write, resource = an MCP resource, cli = the scalius CLI (ask, search, read, write, bulk, export).",
  "Every write: dryRun first. [approval] = destructive or financial: the write answers with confirmation.approvalUrl: the merchant approves it there in the dashboard, then repeat the write with approvalId (CLI: --approval <id>). [ask first] = a security change: confirm with the merchant before it. rev = send the revision your read returned. key = the write needs a retry key (scalius_write and the CLI add one): retry with the same key, never a new one, or it acts twice. needs = required inputs; scalius_describe gives the exact shape and an example.",
].join("\n");

function catalogVersion(manifest) {
  return manifest.workflowCatalog?.version ?? "unknown";
}

function routeSkill(route, skills) {
  if (route.surface === "storefront") return "scalius-storefront";
  const tags = new Set(route.tags ?? []);
  const has = (...names) => names.some((name) => tags.has(name));
  if (has("meta", "pixel", "tracking", "consent", "capi", "feed") || (has("analytics") && has("provider"))) return "scalius-marketing";
  if (has("orders", "refund", "returns", "discounts", "customers", "gift-cards", "reviews", "conversations")) return "scalius-sales";
  if (has("catalog", "products", "inventory", "media", "variants", "categories", "collections")) return "scalius-catalog";
  if (has("theme", "content", "pages", "navigation", "campaign", "storefront")) return "scalius-content";
  if (has("analytics", "reports", "sales", "briefing", "operations")) return "scalius-insights";
  return skills.includes("scalius-settings") ? "scalius-settings" : skills[0];
}

function renderRoute(operations, route) {
  const steps = route.operationIds.map((id) => {
    const operation = operations.get(id);
    return operation && (GATED_RISKS.has(operation.risk) || operation.confirmation === "required") ? `${id}[approval]` : id;
  });
  const rule = route.rules?.[0];
  const clipped = rule && rule.length > 150 ? `${rule.slice(0, 147)}...` : rule;
  return [`### ${route.title} (\`${route.id}\`)`, `ops: ${steps.join(" -> ")}`, ...(clipped ? [`- ${clipped}`] : [])].join("\n");
}

function assertSize(path, content) {
  const bytes = Buffer.byteLength(content);
  if (bytes > REFERENCE_MAX_BYTES) throw new Error(`${path} is ${bytes} bytes; references must stay within ${REFERENCE_MAX_BYTES}.`);
}

/** The generated reference files, as [{path (relative to the package), content}]. */
export function generateRecipeFiles(manifest, source) {
  const operations = new Map(manifest.operations.map((operation) => [operation.operationId, operation]));
  const catalog = manifest.workflowCatalog ?? { routes: [] };
  const routesById = new Map(catalog.routes.map((route) => [route.id, route]));
  const skills = Object.keys(source.skills);
  const assigned = new Map(skills.map((skill) => [skill, []]));
  const placed = new Set();
  for (const [skill, spec] of Object.entries(source.skills)) {
    for (const id of spec.routes ?? []) {
      const route = routesById.get(id);
      if (!route) throw new Error(`Skill ${skill} lists workflow route ${id}, which is not in the workflow catalog.`);
      assigned.get(skill).push(route);
      placed.add(id);
    }
  }
  for (const route of catalog.routes) {
    if (!placed.has(route.id)) assigned.get(routeSkill(route, skills)).push(route);
  }
  const header = `Generated by scripts/generate-recipes.mjs from the operation manifest and workflow catalog ${catalogVersion(manifest)}; do not edit.`;
  const files = [];
  for (const [skill, spec] of Object.entries(source.skills)) {
    const recipes = (spec.recipes ?? []).map((recipe) => renderRecipe(manifest, operations, recipe, skill));
    const recipesPath = `skills/${skill}/references/recipes.md`;
    const recipesContent = `# ${spec.title}\n\n${header}\n\n${LEGEND}\n\n${recipes.join("\n\n")}\n`;
    assertSize(recipesPath, recipesContent);
    files.push({ path: recipesPath, content: recipesContent });
    files.push(...workflowFiles(operations, skill, spec, header, assigned.get(skill)));
  }
  return files;
}

/** The skill's reviewed routes, split into `workflows.md`, `workflows-2.md`, ... so each stays within the reference budget. */
function workflowFiles(operations, skill, spec, header, routes) {
  if (routes.length === 0) return [];
  const title = spec.title.replace(/recipes$/, "workflows");
  const intro = "scalius_search ranks these; a confident hit inlines its plan and all its rules. [approval] marks a step that needs the merchant's approval.";
  const blocks = routes.map((route) => renderRoute(operations, route));
  const parts = [[]];
  const room = REFERENCE_MAX_BYTES - Buffer.byteLength(`# ${title} (part 10)\n\n${header}\n${intro}\n\nMore: workflows-10.md\n`) - 64;
  let used = 0;
  for (const block of blocks) {
    const size = Buffer.byteLength(block) + 2;
    if (used + size > room && parts[parts.length - 1].length > 0) {
      parts.push([]);
      used = 0;
    }
    parts[parts.length - 1].push(block);
    used += size;
  }
  const name = (index) => (index === 0 ? "workflows.md" : `workflows-${index + 1}.md`);
  return parts.map((part, index) => {
    const path = `skills/${skill}/references/${name(index)}`;
    const heading = parts.length > 1 ? `# ${title} (part ${index + 1})` : `# ${title}`;
    const more = index + 1 < parts.length ? `\n\nMore: [${name(index + 1)}](${name(index + 1)})` : "";
    const content = `${heading}\n\n${header}\n${intro}\n\n${part.join("\n\n")}${more}\n`;
    assertSize(path, content);
    return { path, content };
  });
}

const OPERATION_ID = /\b(?:dashboard|storefront|system|objects)\.[a-z0-9_.]*[a-z0-9_]/g;
const READ_SIBLINGS = ["get", "get_section", "get_status", "list"];
const REVISION_WORDS = new Set(["revision", "version"]);

/** The record's own revision field as its read names it (`version`, `revision`), top level or one object down. */
function readRevisionFields(manifest, read) {
  const output = resolveSchema(manifest, read.outputSchema);
  const data = isRecord(output) && isRecord(output.properties) ? resolveSchema(manifest, output.properties.data) : null;
  const found = new Set();
  for (const [name, value] of Object.entries(isRecord(data) && isRecord(data.properties) ? data.properties : {})) {
    if (REVISION_WORDS.has(name)) found.add(name);
    const inner = resolveSchema(manifest, value);
    for (const nested of Object.keys(isRecord(inner) && isRecord(inner.properties) ? inner.properties : {})) {
      if (REVISION_WORDS.has(nested)) found.add(nested);
    }
  }
  return found;
}

/**
 * The reads a caller of a write uses to get the record's revision: the
 * write's own surface's read (`dashboard.orders.get` beside
 * `dashboard.orders.update_status`) and the app API's resource read
 * (`dashboard.resources.orders.get`, an app's `orders.get`).
 */
function recordReads(operations, operationId) {
  const prefix = operationId.slice(0, operationId.lastIndexOf("."));
  const own = READ_SIBLINGS.map((name) => operations.get(`${prefix}.${name}`)).find((candidate) => candidate?.risk === "read");
  const resource = operations.get(`dashboard.resources.${prefix.slice(prefix.lastIndexOf(".") + 1)}.get`);
  return [own, resource?.risk === "read" ? resource : null].filter((read) => read && read.operationId !== operationId);
}

const NAMED_IN_READ = /`(revision|version)`\s+in\s+((?:dashboard|storefront|system)\.[a-z0-9_.]*[a-z0-9_])/g;

/**
 * A revision field's description names the field each read of the record
 * carries (the order page reads `version`, the order resource `revision`),
 * and a field it says a read carries is one that read carries.
 */
function revisionDescriptionFaults(manifest, operations, operation) {
  if (operation.risk === "read") return [];
  const reads = recordReads(operations, operation.operationId)
    .map((read) => ({ read, carried: readRevisionFields(manifest, read) }))
    .filter((entry) => entry.carried.size > 0);
  const input = isRecord(operation.inputSchema) ? operation.inputSchema : {};
  const body = resolveSchema(manifest, input.requestBody?.content?.["application/json"]?.schema);
  const fields = [
    ...Object.entries(isRecord(body) && isRecord(body.properties) ? body.properties : {}),
    ...(Array.isArray(input.parameters) ? input.parameters : []).map((parameter) => [parameter?.name, parameter?.schema ?? {}, parameter?.description]),
  ];
  const faults = [];
  for (const [name, schema, parameterDescription] of fields) {
    if (typeof name !== "string" || !REVISION_FIELD.test(name)) continue;
    const description = resolveSchema(manifest, schema)?.description ?? parameterDescription ?? "";
    const named = new Set([...description.matchAll(TICKED_NAME)].map((match) => match[1]).filter((word) => REVISION_WORDS.has(word)));
    if (named.size === 0) continue;
    for (const { read, carried } of reads) {
      if (![...carried].some((word) => named.has(word))) {
        faults.push(`${operation.operationId} ${name} does not name ${[...carried].map((word) => `\`${word}\``).join(", ")}, the field ${read.operationId} carries`);
      }
    }
    for (const [, word, readId] of description.matchAll(NAMED_IN_READ)) {
      const read = operations.get(readId);
      if (read && !readRevisionFields(manifest, read).has(word)) faults.push(`${operation.operationId} ${name} says ${readId} carries \`${word}\`, which it does not`);
    }
  }
  return faults;
}

/**
 * What agent guidance outside the recipes says that the operations do not
 * bear out: an operation's "when" line naming a field neither its request nor
 * its answer has, or a value its request refuses; a revision field's
 * description naming a field the record's read does not carry; a hand-written
 * skill reference, or a workflow route's rule, naming a field none of the
 * operations it names has. (Recipe steps fail the generation itself.)
 */
export function guidanceFaults(manifest, skillsRoot = join(packageRoot, "skills")) {
  const operations = new Map(manifest.operations.map((operation) => [operation.operationId, operation]));
  const unknownIn = (text, ids) => unresolvedNames(manifest, text, ids.map((id) => operations.get(id)).filter(Boolean));
  const faults = [];
  for (const operation of manifest.operations) {
    if (operation.when) {
      const unknown = unknownIn(operation.when, [operation.operationId]);
      if (unknown.length > 0) faults.push(`${operation.operationId} when line names ${unknown.join(", ")}, which its request and answer do not have`);
      const claims = refusedValueClaims(manifest, operation, operation.when);
      if (claims.length > 0) faults.push(`${operation.operationId} when line claims ${claims.join(", ")}, which its request refuses`);
    }
    faults.push(...revisionDescriptionFaults(manifest, operations, operation));
  }
  // A workflow read's rules name its projection's fields, which no single operation carries.
  for (const route of manifest.workflowCatalog?.routes ?? []) {
    if (route.workflowId) continue;
    for (const rule of [route.summary ?? "", ...(route.rules ?? [])]) {
      const unknown = unknownIn(rule, [...route.operationIds, ...(rule.match(OPERATION_ID) ?? [])]);
      if (unknown.length > 0) faults.push(`workflow route ${route.id} names ${unknown.join(", ")}, which its operations do not have`);
    }
  }
  for (const skill of readdirSync(skillsRoot)) {
    const references = join(skillsRoot, skill, "references");
    const files = ["SKILL.md", ...readdirSync(references).map((name) => join("references", name))];
    for (const file of files) {
      const text = readFileSync(join(skillsRoot, skill, file), "utf8");
      if (text.includes("Generated by scripts/generate-recipes.mjs")) continue;
      for (const line of text.split("\n")) {
        const ids = line.match(OPERATION_ID) ?? [];
        // A line about an MCP resource names that resource's fields.
        if (ids.length === 0 || line.includes("scalius://")) continue;
        const unknown = unknownIn(line, ids);
        if (unknown.length > 0) faults.push(`${skill}/${file} names ${unknown.join(", ")} beside ${ids.join(", ")}, which they do not have`);
        for (const id of ids) {
          const operation = operations.get(id);
          const claims = operation ? refusedValueClaims(manifest, operation, line) : [];
          if (claims.length > 0) faults.push(`${skill}/${file} claims ${claims.join(", ")} for ${id}, which its request refuses`);
        }
      }
    }
  }
  return faults;
}

/** Every operation id the source references, with whether it is an optional (planned) one. */
export function referencedOperations(source) {
  const ids = [];
  for (const spec of Object.values(source.skills)) {
    for (const recipe of spec.recipes ?? []) {
      for (const variant of recipe.variants ?? [{ steps: recipe.steps }]) {
        const planned = new Set(variant.requires ?? []);
        for (const step of variant.steps ?? []) {
          if (["read", "write", "verify"].includes(step[0])) ids.push({ id: step[1], planned: planned.has(step[1]) });
        }
      }
    }
  }
  return ids;
}

function main() {
  const check = process.argv.includes("--check");
  const files = generateRecipeFiles(loadManifest(), loadSource());
  let stale = 0;
  for (const file of files) {
    const target = join(packageRoot, file.path);
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = "";
    }
    if (current === file.content) continue;
    stale += 1;
    if (check) {
      console.error(`stale: ${file.path}`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    console.log(`wrote ${file.path}`);
  }
  const faults = guidanceFaults(loadManifest());
  for (const fault of faults) console.error(`guidance: ${fault}`);
  if (check && stale > 0) {
    console.error("Run: pnpm --filter scalius generate:recipes");
    process.exit(1);
  }
  if (faults.length > 0) process.exit(1);
  if (!check) console.log(`${files.length} reference files, ${stale} updated.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
