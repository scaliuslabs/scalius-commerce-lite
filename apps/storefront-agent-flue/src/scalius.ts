import { defineTool } from "@flue/runtime";
import {
  SCALIUS_COMMAND_LIMITS,
  SCALIUS_COMMAND_TOOL_DESCRIPTION,
} from "@scalius/shared/assistant-command";
import {
  runScaliusCommand,
  type RunScaliusCommandOptions,
  type ScaliusCommandApiBinding,
} from "@scalius/shared/assistant-command-client";
import * as v from "valibot";

const input = v.object({
  program: v.pipe(v.string(), v.maxLength(SCALIUS_COMMAND_LIMITS.programChars)),
});

const failure = v.object({
  ok: v.literal(false),
  authoritative: v.boolean(),
  code: v.string(),
  message: v.string(),
  retryable: v.boolean(),
});

const output = v.union([
  v.object({
    ok: v.literal(true),
    authoritative: v.literal(true),
    code: v.literal("ok"),
    message: v.literal("Authoritative Scalius result received."),
    retryable: v.literal(false),
    data: v.record(v.string(), v.unknown()),
  }),
  failure,
]);

export interface StorefrontScaliusEnv {
  API?: ScaliusCommandApiBinding;
}

export function createStorefrontScaliusTool(
  instanceId: string,
  api?: ScaliusCommandApiBinding,
  testOptions: Pick<RunScaliusCommandOptions, "timeoutMs"> = {},
) {
  return defineTool({
    name: "scalius",
    description: SCALIUS_COMMAND_TOOL_DESCRIPTION,
    input,
    output,
    async run({ input: { program } }) {
      return runScaliusCommand({
        surface: "storefront",
        instanceId,
        program,
        api,
        ...testOptions,
      });
    },
  });
}
