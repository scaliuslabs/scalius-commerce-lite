import { defineTool } from "@flue/runtime";
import { SCALIUS_COMPUTER_LIMITS } from "@scalius/shared/assistant-computer";
import { issueScaliusComputerCommand } from "@scalius/shared/assistant-computer-handoff";
import * as v from "valibot";
import {
  createStorefrontToolCallBudget,
  type StorefrontToolCallBudget,
} from "./tool-call-budget";

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
  surface: v.literal("storefront"),
  requestId: v.string(),
  program: v.string(),
  expiresAt: v.string(),
  ticket: v.string(),
});

export function createStorefrontComputerTool(
  instanceId: string,
  signingKey: string,
  testOptions: { now?: number; randomBytes?: Uint8Array } = {},
  callBudget: StorefrontToolCallBudget = createStorefrontToolCallBudget(),
) {
  return defineTool({
    name: "computer",
    description:
      "Inspect or control the shopper's active Storefront page with one compact program. Start with observe. The returned client_command is pending until a later UNTRUSTED_CLIENT_RESULT arrives.",
    input,
    output,
    async run({ input: { program }, signal }) {
      callBudget.consume(signal);
      return issueScaliusComputerCommand({
        surface: "storefront",
        agentName: "shopping-assistant",
        instanceId,
        program,
        signingKey,
        ...testOptions,
      });
    },
  });
}
