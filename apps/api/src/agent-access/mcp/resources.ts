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
export const RECIPES_MAX_BYTES = 24 * 1024;

interface ResourceDependencies {
  surface: AgentResource;
  env: Env;
  ctx: ExecutionContext;
  principal: () => Promise<AgentPrincipal>;
}

function json(uri: URL, value: unknown) {
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }] };
}

export type CatalogEntry = { id: string; surface: string; title: string; summary: string; operationIds?: string[]; rules?: string[] };

function catalogEntries(surface: AgentResource): CatalogEntry[] {
  const catalog = AGENT_WORKFLOW_CATALOG as unknown as { cards: CatalogEntry[]; routes: CatalogEntry[] };
  return [...catalog.cards, ...catalog.routes].filter((entry) => entry.surface === surface);
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/**
 * The reviewed routes as terse recipes. Same source as the skills. Every route of the
 * surface is listed: as many as fit in full (title, id, steps in order, rules), the rest
 * in the compact `id: operations` form. Only if even the compact form outgrows the cap,
 * a closing notice names how many routes were left out and how to find them.
 */
export function buildRecipes(surface: AgentResource, limits: { routes?: CatalogEntry[]; maxBytes?: number } = {}): string {
  const maxBytes = limits.maxBytes ?? RECIPES_MAX_BYTES;
  const catalog = AGENT_WORKFLOW_CATALOG as unknown as { routes: CatalogEntry[] };
  const routes = (limits.routes ?? catalog.routes).filter((entry) => entry.surface === surface);
  const steps = (route: CatalogEntry) => (route.operationIds ?? []).join(" -> ");
  const full = (route: CatalogEntry) => [
    `\n## ${route.title} (${route.id})`,
    route.summary,
    `ops: ${steps(route)}`,
    ...(route.rules ?? []).slice(0, 3).map((rule) => `- ${rule}`),
  ].join("\n") + "\n";
  const compact = (route: CatalogEntry) => `- ${route.id}: ${steps(route)}\n`;
  const compactHeading = "\n## More recipes (compact: id: operations; read scalius://workflows/{id} for the card)\n";
  const notice = (omitted: number) => `\n${omitted} more recipe${omitted === 1 ? "" : "s"} omitted to fit the size limit; find them with scalius_search (workflows) or read scalius://workflows/{id}.\n`;

  let text = `# Scalius ${surface} recipes (workflow catalog ${String((AGENT_WORKFLOW_CATALOG as { version?: string }).version ?? "")})\n`;
  // Reserve room for the compact form of everything not yet written in full, so the
  // full blocks never crowd a route out of the list.
  const compactTail = (from: number) => routes.slice(from).reduce((sum, route) => sum + byteLength(compact(route)), 0);
  let fullCount = 0;
  while (fullCount < routes.length) {
    const block = full(routes[fullCount]!);
    const rest = fullCount + 1 < routes.length ? byteLength(compactHeading) + compactTail(fullCount + 1) : 0;
    if (byteLength(text) + byteLength(block) + rest > maxBytes) break;
    text += block;
    fullCount += 1;
  }
  if (fullCount === routes.length) return text;
  text += compactHeading;
  let listed = fullCount;
  // When every remaining route fits compactly there is nothing to say; otherwise keep
  // room for the notice and list what fits.
  const everyoneFits = byteLength(text) + compactTail(fullCount) <= maxBytes;
  for (const route of routes.slice(fullCount)) {
    const after = routes.length - listed - 1;
    const reserve = everyoneFits || after === 0 ? 0 : byteLength(notice(after));
    if (byteLength(text) + byteLength(compact(route)) + reserve > maxBytes) break;
    text += compact(route);
    listed += 1;
  }
  return listed === routes.length ? text : text + notice(routes.length - listed);
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
