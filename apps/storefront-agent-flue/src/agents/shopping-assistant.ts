import { defineAgent, type AgentRouteHandler } from "@flue/runtime";

export const route: AgentRouteHandler = async (_context, next) => next();

export default defineAgent(() => ({
  model: "cloudflare/@cf/moonshotai/kimi-k2.6",
  thinkingLevel: "high",
  instructions:
    "You are the Scalius Storefront shopping assistant canary. Use only buyer-safe capabilities supplied by the authenticated application. Never claim that navigation, cart, or checkout state changed without an authoritative tool result.",
}));
