import { defineAgent, type AgentRouteHandler } from "@flue/runtime";
import type { CanaryAuthEnv } from "../auth";
import { buildAdminCopilotInstructions } from "../admin-copilot-policy";
import { createAdminComputerTool } from "../computer";
import { createAdminScaliusTool, type AdminScaliusEnv } from "../scalius";

export const route: AgentRouteHandler = async (_context, next) => next();
export const description = "Operates the authenticated Scalius Admin dashboard.";

export default defineAgent<CanaryAuthEnv & AdminScaliusEnv>(({ id, env }) => ({
  model: "cloudflare/@cf/moonshotai/kimi-k2.6",
  thinkingLevel: "medium",
  instructions: buildAdminCopilotInstructions(),
  tools: [
    createAdminComputerTool(id, env.COMPUTER_TICKET_SIGNING_KEY),
    createAdminScaliusTool(id, env.API),
  ],
}));
