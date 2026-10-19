import type { Command, Option } from "commander";
import { EXIT_CONFIRMATION_REQUIRED, EXIT_DRY_RUN_ONLY } from "./errors.js";
import { packageVersion } from "./version.js";

// `--help --json`: the command tree, its arguments and flags, and the exit
// codes, as one JSON document an agent can read instead of scraping help text.

interface OptionJson {
  flags: string;
  name: string;
  description: string;
  takesValue: boolean;
  required?: true;
  default?: unknown;
  choices?: readonly string[];
}

interface CommandJson {
  name: string;
  path: string;
  description: string;
  aliases?: string[];
  arguments?: Array<{ name: string; required: boolean; variadic: boolean; description?: string; choices?: readonly string[] }>;
  options?: OptionJson[];
  commands?: CommandJson[];
}

export const EXIT_CODES = {
  0: "success",
  2: "usage error",
  3: "authentication: pair again (scalius auth login or scalius init)",
  4: "authorization: the grant lacks this permission",
  5: "validation: fix the input (see error.field and error.hint)",
  6: "conflict: reread the revision in error.current and retry",
  7: "temporary: retry after error.retryAfterMs",
  8: "server or contract failure",
  [EXIT_CONFIRMATION_REQUIRED]: "needs the merchant's approval: nothing was written; show the summary, then --yes",
  [EXIT_DRY_RUN_ONLY]: "dry run only: the preview printed, nothing was written",
  130: "interrupted",
} as const;

function optionJson(option: Option): OptionJson {
  const takesValue = option.required || option.optional;
  return {
    flags: option.flags,
    name: option.attributeName(),
    description: option.description,
    takesValue,
    ...(option.mandatory ? { required: true as const } : {}),
    ...(option.defaultValue !== undefined && !(option.negate && option.defaultValue === true) ? { default: option.defaultValue } : {}),
    ...(option.argChoices ? { choices: option.argChoices } : {}),
  };
}

function commandJson(command: Command, prefix: string): CommandJson {
  const path = prefix ? `${prefix} ${command.name()}` : command.name();
  const args = command.registeredArguments.map((argument) => ({
    name: argument.name(),
    required: argument.required,
    variadic: argument.variadic,
    ...(argument.description ? { description: argument.description } : {}),
    ...(argument.argChoices ? { choices: argument.argChoices } : {}),
  }));
  const options = command.options.map(optionJson);
  const children = command.commands.map((child) => commandJson(child, path));
  return {
    name: command.name(),
    path,
    description: command.description(),
    ...(command.aliases().length > 0 ? { aliases: command.aliases() } : {}),
    ...(args.length > 0 ? { arguments: args } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(children.length > 0 ? { commands: children } : {}),
  };
}

/** The tree for the command named by the leading words of argv (the whole program when none). */
export function commandTree(program: Command, argv: readonly string[]): Record<string, unknown> {
  let target = program;
  const path: string[] = [];
  for (const word of argv) {
    if (word.startsWith("-")) continue;
    const child = target.commands.find((candidate) => candidate.name() === word || candidate.aliases().includes(word));
    if (!child) break;
    path.push(child.name());
    target = child;
  }
  const prefix = ["scalius", ...path.slice(0, -1)].join(" ");
  const tree = target === program ? commandJson(program, "") : commandJson(target, prefix);
  return {
    version: packageVersion(),
    ...(target === program ? { globalOptions: tree.options ?? [] } : {}),
    command: tree,
    exitCodes: EXIT_CODES,
    output: "JSON when stdout is not a terminal: {ok, data, meta} on stdout; errors as {ok:false, error:{code, message, status, retryable, hint, current, field}} on stderr.",
  };
}
