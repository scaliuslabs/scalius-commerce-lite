import { defineAgent, type AgentRouteHandler } from "@flue/runtime";
import type { CanaryAuthEnv } from "../auth";
import { buildAdminCopilotInstructions } from "../admin-copilot-policy";
import {
  ADMIN_AGENT_DURABILITY,
  ADMIN_CAPABILITY_ONLY_SANDBOX,
  createAdminCapabilityCallBudget,
} from "../capability-runtime";
import { createAdminComputerTool } from "../computer";
import { createAdminScaliusTool, type AdminScaliusEnv } from "../scalius";

export const route: AgentRouteHandler = async (_context, next) => next();
export const description = "Operates the authenticated Scalius Admin dashboard.";

export default defineAgent<CanaryAuthEnv & AdminScaliusEnv>(({ id, env }) => {
  const beforeCapabilityCall = createAdminCapabilityCallBudget();
  return {
    model: "cloudflare/@cf/moonshotai/kimi-k2.6",
    thinkingLevel: "medium",
    instructions: buildAdminCopilotInstructions(),
    durability: ADMIN_AGENT_DURABILITY,
    sandbox: ADMIN_CAPABILITY_ONLY_SANDBOX,
    tools: [
      createAdminComputerTool(id, env.COMPUTER_TICKET_SIGNING_KEY, {
        beforeRun: beforeCapabilityCall,
      }),
      createAdminScaliusTool(id, env.API, { beforeRun: beforeCapabilityCall }),
    ],
  };
});
