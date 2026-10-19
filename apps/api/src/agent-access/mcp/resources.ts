// MCP resources: the live store context, one operation's full schema, one
// curated workflow card, and the reviewed recipes. Every read re-resolves the
// connection's principal; operation schemas are only served when the grant
// could run the operation.

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { AGENT_WORKFLOW_CATALOG } from "../../generated/agent-operations.gen";
import type { AgentPrincipal, AgentResource } from "../types";
import { loadStoreContext } from "./context";
import { describeForAgent } from "./describe";
import { describeOperation, getAuthorizedOperation } from "./operations";

const STORE_TTL_MS = 60_000;
const STATIC_TTL_MS = 3_600_000;
const RECIPES_MAX_BYTES = 24 * 1024;

interface ResourceDependencies {
  surface: AgentResource;
  env: Env;
  ctx: ExecutionContext;
  principal: () => Promise<AgentPrincipal>;
}

function json(uri: URL, value: unknown) {
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }] };
}

type CatalogEntry = { id: string; surface: string; title: string; summary: string; operationIds?: string[]; rules?: string[] };

function catalogEntries(surface: AgentResource): CatalogEntry[] {
  const catalog = AGENT_WORKFLOW_CATALOG as unknown as { cards: CatalogEntry[]; routes: CatalogEntry[] };
  return [...catalog.cards, ...catalog.routes].filter((entry) => entry.surface === surface);
}

/** The reviewed routes as terse recipes: title, steps in order, rules. Same source as the skills. */
export function buildRecipes(surface: AgentResource): string {
  const catalog = AGENT_WORKFLOW_CATALOG as unknown as { routes: CatalogEntry[] };
  let text = `# Scalius ${surface} recipes (workflow catalog ${String((AGENT_WORKFLOW_CATALOG as { version?: string }).version ?? "")})\n`;
  for (const route of catalog.routes.filter((entry) => entry.surface === surface)) {
    const block = [
      `\n## ${route.title}`,
      route.summary,
      `ops: ${(route.operationIds ?? []).join(" -> ")}`,
      ...(route.rules ?? []).slice(0, 3).map((rule) => `- ${rule}`),
    ].join("\n");
    if (new TextEncoder().encode(text + block).byteLength > RECIPES_MAX_BYTES) break;
    text += `${block}\n`;
  }
  return text;
}

export function registerAgentResources(server: McpServer, deps: ResourceDependencies): void {
  server.registerResource("store", "scalius://store", {
    title: "Store context",
    description: "Store name, shop currency, time zone, markets and what is not set up.",
    mimeType: "application/json",
    cacheHint: { ttlMs: STORE_TTL_MS, cacheScope: "private" },
  }, async (uri) => {
    const principal = await deps.principal();
    return json(uri, await loadStoreContext({ surface: deps.surface, principal, env: deps.env, ctx: deps.ctx }));
  });

  server.registerResource("operation", new ResourceTemplate("scalius://ops/{operationId}", { list: undefined }), {
    title: "Operation schema",
    description: "The full input and output schema of one operation this connection can run.",
    mimeType: "application/json",
    cacheHint: { ttlMs: STATIC_TTL_MS, cacheScope: "private" },
  }, async (uri, variables) => {
    const operationId = String(Array.isArray(variables.operationId) ? variables.operationId[0] : variables.operationId);
    const principal = await deps.principal();
    const operation = await getAuthorizedOperation(operationId, deps.surface, principal);
    if (!operation) throw new Error("Operation is unavailable or not authorized");
    const described = describeForAgent(operation, "compact");
    return json(uri, { ...describeOperation(operation, true), brief: described.value });
  });

  server.registerResource("workflow", new ResourceTemplate("scalius://workflows/{id}", { list: undefined }), {
    title: "Workflow card",
    description: "A curated workflow: construction rules, steps and operation ids.",
    mimeType: "application/json",
    cacheHint: { ttlMs: STATIC_TTL_MS, cacheScope: "private" },
  }, async (uri, variables) => {
    await deps.principal();
    const id = String(Array.isArray(variables.id) ? variables.id[0] : variables.id);
    const entry = catalogEntries(deps.surface).find((candidate) => candidate.id === id);
    if (!entry) throw new Error("Workflow is unavailable");
    return json(uri, entry);
  });

  server.registerResource("recipes", "scalius://skills/recipes", {
    title: "Recipes",
    description: "Reviewed recipes: each task's operations in order and its rules.",
    mimeType: "text/markdown",
    cacheHint: { ttlMs: STATIC_TTL_MS, cacheScope: "private" },
  }, async (uri) => {
    await deps.principal();
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildRecipes(deps.surface) }] };
  });
}
