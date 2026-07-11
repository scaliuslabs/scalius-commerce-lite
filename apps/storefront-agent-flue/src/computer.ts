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

export const STOREFRONT_COMPUTER_DOCUMENTED_PROGRAMS = [
  "observe",
  "help",
  "help goto",
  'goto "/known-route?query=value"',
  "click @r1.e1",
  'fill @r1.e1 "text"',
  'select @r1.e1 "value or label"',
  "submit @r1.e1",
  "refresh",
  'fill @r1.e1 "text"; select @r1.e2 "value"; click @r1.e3',
] as const;

export const STOREFRONT_COMPUTER_TOOL_DESCRIPTION =
  'Input exactly one JSON object {"program":"..."}. Program grammar: observe; help [command]; goto "/known-route?query=value"; click @rN.eN; fill @rN.eN "text"; select @rN.eN "value or label"; submit @rN.eN; or refresh. observe, help, goto, and refresh must each be alone. Action programs may batch fill/select plus at most one final click/submit with semicolons; every handle must come from one observed revision. Never include prose or extra properties. A client_command remains pending until a matching UNTRUSTED_CLIENT_RESULT arrives.';

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
    description: STOREFRONT_COMPUTER_TOOL_DESCRIPTION,
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
