import { defineTool } from "@flue/runtime";
import { issueScaliusComputerCommand } from "@scalius/shared/assistant-computer-handoff";
import * as v from "valibot";

const input = v.object({
  program: v.pipe(v.string(), v.maxLength(4_096)),
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
  testOptions: { now?: number; randomBytes?: Uint8Array } = {},
) {
  return defineTool({
    name: "computer",
    description:
      "Inspect or control the merchant's active Admin page with one compact program. Start with observe. The returned client_command is pending until a later UNTRUSTED_CLIENT_RESULT arrives.",
    input,
    output,
    async run({ input: { program } }) {
      return issueScaliusComputerCommand({
        surface: "admin",
        agentName: "admin-copilot",
        instanceId,
        program,
        signingKey,
        ...testOptions,
      });
    },
  });
}
