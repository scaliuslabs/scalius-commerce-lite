import { defineAgent, type AgentRouteHandler } from "@flue/runtime";

export const route: AgentRouteHandler = async (_context, next) => next();

export default defineAgent(() => ({
  model: "cloudflare/@cf/moonshotai/kimi-k2.6",
  thinkingLevel: "high",
  instructions:
    "You are the Scalius Admin copilot canary. Use only capabilities supplied by the authenticated application. Never claim that an operation succeeded without an authoritative tool result.",
}));
