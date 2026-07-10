import { defineTool } from "@flue/runtime";
import {
  normalizeScaliusComputerRoute,
  parseScaliusComputerProgram,
  SCALIUS_COMPUTER_LIMITS,
} from "@scalius/shared/assistant-computer";
import { issueScaliusComputerCommand } from "@scalius/shared/assistant-computer-handoff";
import * as v from "valibot";
import { isKnownAdminEntryRoute } from "./admin-copilot-policy";

const input = v.object({
  program: v.pipe(
    v.string(),
    v.maxLength(SCALIUS_COMPUTER_LIMITS.programChars),
  ),
});

const output = v.object({
  type: v.literal("client_command"),
  capability: v.literal("computer"),
  protocolVersion: v.literal(1),
  status: v.literal("awaiting_client_execution"),
  authoritative: v.literal(false),
  replayPolicy: v.literal("client_dedupe_request_id_until_expiry"),
  surface: v.literal("admin"),
  requestId: v.string(),
  program: v.string(),
  expiresAt: v.string(),
  ticket: v.string(),
});

export function createAdminComputerTool(
  instanceId: string,
  signingKey: string,
  options: {
    now?: number;
    randomBytes?: Uint8Array;
    beforeRun?: () => void;
  } = {},
) {
  return defineTool({
    name: "computer",
    description:
      "Control the active Admin page with one compact program. For the latest direct request for one known entry page, use goto immediately without observing first. For page questions or element actions, observe first and use fresh handles. The returned object is a private pending UI handoff: never quote it or call computer again before its continuation.",
    input,
    output,
    async run({ input: { program } }) {
      options.beforeRun?.();
      const parsed = parseScaliusComputerProgram(program);
      const command = parsed.ok ? parsed.commands[0] : undefined;
      if (command?.name === "goto") {
        const route = normalizeScaliusComputerRoute(command.route);
        if (!route || !isKnownAdminEntryRoute(route)) {
          throw new Error("Admin navigation is not an allowed entry page");
        }
      }
      return issueScaliusComputerCommand({
        surface: "admin",
        agentName: "admin-copilot",
        instanceId,
        program,
        signingKey,
        now: options.now,
        randomBytes: options.randomBytes,
      });
    },
  });
}
