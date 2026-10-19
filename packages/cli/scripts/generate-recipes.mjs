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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
  "Every write: dryRun first. [approval] = destructive or financial: show confirmation.summary to the merchant, then send its confirmToken (CLI: --yes after they approve). [ask first] = a security change: confirm with the merchant before it. rev = send the revision your read returned. needs = required inputs; scalius_describe gives the exact shape and an example.",
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
  if (check && stale > 0) {
    console.error("Run: pnpm --filter scalius generate:recipes");
    process.exit(1);
  }
  if (!check) console.log(`${files.length} reference files, ${stale} updated.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
