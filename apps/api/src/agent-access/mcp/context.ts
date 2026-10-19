// Live store context for the MCP instructions and the `scalius://store`
// resource: store name, shop currency, time zone, markets and what is not set
// up yet, read through the same reviewed operations (and the grant's own
// authority) as every other agent read. A fact the grant cannot read is left
// out, never guessed.

import type { AgentPrincipal, AgentResource } from "../types";
import { dispatchAgentOperation } from "../dispatch";
import { getAuthorizedOperation } from "./operations";
import { unwrapRouteBody } from "./shape";

export interface StoreContext {
  name?: string;
  currency?: string;
  country?: string;
  locale?: string;
  timeZone?: string;
  markets?: Array<{ name: string; currency?: string; countries?: number; backup?: true }>;
  checkout?: string;
  notSetUp?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown, length = 80) => typeof value === "string" && value.trim() ? value.trim().slice(0, length) : undefined;

async function readOperation(
  operationId: string,
  surface: AgentResource,
  principal: AgentPrincipal,
  env: Env,
  ctx: ExecutionContext,
): Promise<unknown> {
  try {
    const operation = await getAuthorizedOperation(operationId, surface, principal);
    if (!operation || operation.risk !== "read") return null;
    const result = await dispatchAgentOperation({ operation, input: {}, principal, env, ctx });
    return result.ok && !result.redacted ? unwrapRouteBody(result.data) : null;
  } catch {
    return null;
  }
}

function marketsFrom(value: unknown): StoreContext["markets"] {
  const list = isRecord(value) ? (Array.isArray(value.items) ? value.items : Array.isArray(value.markets) ? value.markets : null) : null;
  if (!list) return undefined;
  return list.filter(isRecord)
    .filter((market) => market.status === undefined || market.status === "active")
    .slice(0, 8)
    .map((market) => ({
      name: text(market.name, 40) ?? text(market.handle, 40) ?? "market",
      ...(text(market.currencyCode, 3) ? { currency: text(market.currencyCode, 3) } : {}),
      ...(Array.isArray(market.countries) ? { countries: market.countries.length } : {}),
      ...(market.isBackup === true ? { backup: true as const } : {}),
    }));
}

/** Reads the store context for one principal; two bounded waves of in-process reads. */
export async function loadStoreContext(input: {
  surface: AgentResource;
  principal: AgentPrincipal;
  env: Env;
  ctx: ExecutionContext;
}): Promise<StoreContext> {
  const { surface, principal, env, ctx } = input;
  const context: StoreContext = {};
  if (surface === "storefront") {
    const markets = marketsFrom(await readOperation("storefront.markets.get", surface, principal, env, ctx));
    if (markets) {
      context.markets = markets;
      const backup = markets.find((market) => market.backup) ?? markets[0];
      if (backup?.currency) context.currency = backup.currency;
    }
    return context;
  }
  const [setup, markets] = await Promise.all([
    readOperation("dashboard.settings.store_setup_get", surface, principal, env, ctx),
    readOperation("dashboard.markets.list", surface, principal, env, ctx),
  ]);
  const readiness = await readOperation("dashboard.checkout.readiness_get", surface, principal, env, ctx);
  const current = isRecord(setup) && isRecord(setup.current) ? setup.current : null;
  if (current) {
    if (text(current.storeName)) context.name = text(current.storeName);
    if (text(current.currencyCode, 3)) context.currency = text(current.currencyCode, 3);
    if (text(current.countryCode, 2)) context.country = text(current.countryCode, 2);
    if (text(current.locale, 5)) context.locale = text(current.locale, 5);
    if (text(current.timeZone, 64)) context.timeZone = text(current.timeZone, 64);
  }
  const marketList = marketsFrom(markets);
  if (marketList) context.markets = marketList;
  if (isRecord(readiness)) {
    if (text(readiness.status, 16)) context.checkout = text(readiness.status, 16);
    const issues = Array.isArray(readiness.issues) ? readiness.issues.filter(isRecord) : [];
    const notSetUp = issues.map((issue) => text(issue.message, 80) ?? text(issue.code, 48)).filter((value): value is string => Boolean(value));
    if (notSetUp.length > 0) context.notSetUp = notSetUp.slice(0, 4);
  }
  if (isRecord(setup) && setup.needed === true) {
    context.notSetUp = ["Store setup is not finished (Settings > Markets)", ...(context.notSetUp ?? [])].slice(0, 4);
  }
  return context;
}

/** One short line for the instructions: `Store: Name · BDT · Asia/Dhaka · markets: … · not set up: …`. */
export function storeContextLine(context: StoreContext, maxChars = 240): string {
  const parts: string[] = [];
  if (context.name) parts.push(context.name);
  if (context.currency) parts.push(context.currency);
  if (context.timeZone) parts.push(context.timeZone);
  if (context.markets && context.markets.length > 0) {
    parts.push(`markets: ${context.markets.map((market) => market.currency ? `${market.name} (${market.currency})` : market.name).join(", ")}`);
  }
  if (context.checkout && context.checkout !== "ready") parts.push(`checkout ${context.checkout}`);
  if (context.notSetUp && context.notSetUp.length > 0) parts.push(`not set up: ${context.notSetUp.join("; ")}`);
  if (parts.length === 0) return "";
  const line = `Store: ${parts.join(" · ")}.`;
  return line.length > maxChars ? `${line.slice(0, maxChars - 3)}...` : line;
}
