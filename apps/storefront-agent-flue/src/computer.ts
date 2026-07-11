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
  // A browser command is asynchronous from the model's perspective: its tool
  // output is only a signed request, and the real page result arrives in a
  // later Flue dispatch. Permit exactly one request in this submission so a
  // model cannot fan out repeated observes/clicks before seeing that result.
  let commandPending = false;
  return defineTool({
    name: "computer",
    description:
      "Inspect or control the shopper's active Storefront page with one compact program. Start with observe. The returned client_command is pending until a later UNTRUSTED_CLIENT_RESULT arrives.",
    input,
    output,
    async run({ input: { program }, signal }) {
      if (commandPending) {
        throw new Error(
          "A Storefront page command is already pending. Wait for its UNTRUSTED_CLIENT_RESULT before using computer again.",
        );
      }
      callBudget.consume(signal);
      commandPending = true;
      try {
        return await issueScaliusComputerCommand({
          surface: "storefront",
          agentName: "shopping-assistant",
          instanceId,
          program,
          signingKey,
          ...testOptions,
        });
      } catch (error) {
        // Issuance failed before a signed browser command existed, so a later
        // corrected call may safely claim this submission's single slot.
        commandPending = false;
        throw error;
      }
    },
  });
}
