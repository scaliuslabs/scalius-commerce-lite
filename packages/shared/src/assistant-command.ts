/**
 * The complete model-facing command surface. Capability schemas stay behind the
 * API-owned registry and are discovered with find/show instead of being placed
 * in every model turn.
 */
export const SCALIUS_COMMAND_NAMES = [
  "help",
  "find",
  "show",
  "call",
  "prepare",
  "status",
  "cancel",
] as const;

export type ScaliusCommandName = (typeof SCALIUS_COMMAND_NAMES)[number];

export const SCALIUS_COMMAND_LIMITS = Object.freeze({
  programChars: 6_144,
  termsChars: 240,
  termsCount: 24,
  capabilityIdChars: 180,
  referenceIdChars: 180,
  jsonChars: 5_120,
  jsonDepth: 8,
  jsonKeys: 64,
  jsonKeyChars: 80,
  jsonArrayItems: 50,
  jsonStringChars: 2_048,
  jsonValues: 256,
});

export const SCALIUS_COMMAND_TOOL_DESCRIPTION =
  "Use Scalius through one bounded command string: help [query], find <terms>, show <capability-id>, call <capability-id> -- <JSON object>, prepare <capability-id> -- <JSON object>, status <id>, or cancel <workflow-id>. call requests a registry-verified read. prepare requests a server-authorized preview only; it never commits or self-approves. The API owns scope, permissions, risk, confirmation, idempotency, and execution.";

export const SCALIUS_COMMAND_HELP = [
  "help [query] — compact usage guidance",
  "find <terms> — search allowed capabilities",
  "show <capability-id> — get one bounded capability schema",
  "call <capability-id> -- <JSON object> — request a read-only call",
  "prepare <capability-id> -- <JSON object> — prepare, never commit, a mutation",
  "status <workflow-or-action-id> — read authoritative progress",
  "cancel <workflow-id> — request cancellation when policy allows",
].join("\n");

export type ScaliusCommandJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ScaliusCommandJsonValue[]
  | ScaliusCommandJsonObject;

export interface ScaliusCommandJsonObject {
  readonly [key: string]: ScaliusCommandJsonValue;
}

export type ScaliusCommand =
  | { readonly name: "help"; readonly query?: string }
  | { readonly name: "find"; readonly terms: string }
  | { readonly name: "show"; readonly capabilityId: string }
  | {
      readonly name: "call";
      readonly capabilityId: string;
      readonly arguments: ScaliusCommandJsonObject;
    }
  | {
      readonly name: "prepare";
      readonly capabilityId: string;
      readonly arguments: ScaliusCommandJsonObject;
    }
  | { readonly name: "status"; readonly targetId: string }
  | { readonly name: "cancel"; readonly workflowId: string };

export type ScaliusCommandParseErrorCode =
  | "INVALID_TYPE"
  | "EMPTY_PROGRAM"
  | "PROGRAM_TOO_LONG"
  | "MULTILINE"
  | "CONTROL_CHARACTER"
  | "CHAINING_NOT_ALLOWED"
  | "FORBIDDEN_COMMAND"
  | "UNKNOWN_COMMAND"
  | "ARGUMENTS_REQUIRED"
  | "UNEXPECTED_ARGUMENTS"
  | "TERMS_TOO_LONG"
  | "TOO_MANY_TERMS"
  | "INVALID_CAPABILITY_ID"
  | "INVALID_REFERENCE_ID"
  | "JSON_DELIMITER_REQUIRED"
  | "JSON_TOO_LONG"
  | "INVALID_JSON"
  | "JSON_OBJECT_REQUIRED"
  | "JSON_DEPTH_EXCEEDED"
  | "JSON_KEY_TOO_LONG"
  | "JSON_TOO_MANY_KEYS"
  | "JSON_ARRAY_TOO_LONG"
  | "JSON_STRING_TOO_LONG"
  | "JSON_TOO_MANY_VALUES"
  | "JSON_CONTROL_CHARACTER"
  | "JSON_NUMBER_UNSAFE"
  | "PROTOTYPE_KEY"
  | "SENSITIVE_KEY";

export interface ScaliusCommandParseError {
  readonly code: ScaliusCommandParseErrorCode;
  /** Stable and safe to render; it never includes the submitted program. */
  readonly message: string;
}

export type ScaliusCommandParseResult =
  | { readonly ok: true; readonly command: ScaliusCommand }
  | { readonly ok: false; readonly error: ScaliusCommandParseError };

const COMMANDS = new Set<string>(SCALIUS_COMMAND_NAMES);
const FORBIDDEN_COMMANDS = new Set([
  "approve",
  "bash",
  "confirm",
  "curl",
  "delete",
  "exec",
  "execute",
  "fetch",
  "get",
  "http",
  "https",
  "javascript",
  "js",
  "patch",
  "post",
  "put",
  "run",
  "sh",
  "shell",
  "sql",
  "wget",
]);
const CAPABILITY_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:[._:-][a-z0-9][a-z0-9-]*)*$/u;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const MULTILINE_PATTERN = /[\r\n\u2028\u2029]/u;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DIRECT_SENSITIVE_KEY_WORDS = new Set([
  "credential",
  "credentials",
  "hotp",
  "otp",
  "passcode",
  "passphrase",
  "password",
  "privatekey",
  "secret",
  "totp",
  "token",
  "tokens",
]);
const SENSITIVE_COMPACT_KEYS = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "authorization",
  "authtoken",
  "bearer",
  "clientsecret",
  "credentialid",
  "credentialref",
  "credentialreference",
  "encryptionkey",
  "hotpcode",
  "onetimecode",
  "onetimepassword",
  "otpcode",
  "otpvalue",
  "privatekey",
  "refreshtoken",
  "secretkey",
  "sessiontoken",
  "signingkey",
  "totpcode",
]);

export function parseScaliusCommandProgram(program: unknown): ScaliusCommandParseResult {
  if (typeof program !== "string") {
    return failure("INVALID_TYPE", "Program must be a string.");
  }
  if (program.length > SCALIUS_COMMAND_LIMITS.programChars) {
    return failure(
      "PROGRAM_TOO_LONG",
      `Program must be at most ${SCALIUS_COMMAND_LIMITS.programChars} characters.`,
    );
  }
  if (MULTILINE_PATTERN.test(program)) {
    return failure("MULTILINE", "Program must contain exactly one line.");
  }
  if (containsControlCharacter(program)) {
    return failure("CONTROL_CHARACTER", "Program contains a control character.");
  }
  if (hasUnquotedChainingSyntax(program)) {
    return failure("CHAINING_NOT_ALLOWED", "Command chaining is not allowed.");
  }

  const source = program.trim();
  if (!source) return failure("EMPTY_PROGRAM", "Program is empty.");

  const separator = source.indexOf(" ");
  const rawName = separator === -1 ? source : source.slice(0, separator);
  const name = rawName.toLowerCase();
  const rest = separator === -1 ? "" : source.slice(separator + 1).trim();

  if (FORBIDDEN_COMMANDS.has(name)) {
    return failure("FORBIDDEN_COMMAND", "That command is not available to the model.");
  }
  if (!COMMANDS.has(name)) {
    return failure("UNKNOWN_COMMAND", "Unknown Scalius command.");
  }

  const commandName = name as ScaliusCommandName;
  switch (commandName) {
    case "help": {
      if (!rest) return { ok: true, command: { name: "help" } };
      const query = parseTerms(rest);
      return query.ok
        ? { ok: true, command: { name: "help", query: query.value } }
        : query;
    }
    case "find": {
      if (!rest) return failure("ARGUMENTS_REQUIRED", "find requires search terms.");
      const terms = parseTerms(rest);
      return terms.ok
        ? { ok: true, command: { name: "find", terms: terms.value } }
        : terms;
    }
    case "show": {
      const capabilityId = parseSingleArgument(rest, "show");
      if (!capabilityId.ok) return capabilityId;
      if (!isCapabilityId(capabilityId.value)) {
        return failure("INVALID_CAPABILITY_ID", "Capability ID is invalid.");
      }
      return { ok: true, command: { name: "show", capabilityId: capabilityId.value } };
    }
    case "call":
    case "prepare":
      return parseCapabilityInvocation(commandName, rest);
    case "status": {
      const targetId = parseSingleArgument(rest, "status");
      if (!targetId.ok) return targetId;
      if (!isReferenceId(targetId.value)) {
        return failure("INVALID_REFERENCE_ID", "Status reference ID is invalid.");
      }
      return { ok: true, command: { name: "status", targetId: targetId.value } };
    }
    case "cancel": {
      const workflowId = parseSingleArgument(rest, "cancel");
      if (!workflowId.ok) return workflowId;
      if (!isReferenceId(workflowId.value)) {
        return failure("INVALID_REFERENCE_ID", "Workflow ID is invalid.");
      }
      return { ok: true, command: { name: "cancel", workflowId: workflowId.value } };
    }
  }
}

function parseCapabilityInvocation(
  name: "call" | "prepare",
  rest: string,
): ScaliusCommandParseResult {
  if (!rest) return failure("ARGUMENTS_REQUIRED", `${name} requires a capability and JSON object.`);

  const delimiter = rest.indexOf(" -- ");
  if (delimiter < 1) {
    return failure(
      "JSON_DELIMITER_REQUIRED",
      `${name} requires "<capability-id> -- <JSON object>".`,
    );
  }
  const capabilityId = rest.slice(0, delimiter).trim();
  const jsonSource = rest.slice(delimiter + 4).trim();
  if (capabilityId.includes(" ") || !isCapabilityId(capabilityId)) {
    return failure("INVALID_CAPABILITY_ID", "Capability ID is invalid.");
  }
  if (!jsonSource) {
    return failure("ARGUMENTS_REQUIRED", `${name} requires a JSON object.`);
  }
  const parsedArguments = parseBoundedJsonObject(jsonSource);
  if (!parsedArguments.ok) return parsedArguments;
  return {
    ok: true,
    command: { name, capabilityId, arguments: parsedArguments.value },
  };
}

function parseSingleArgument(
  source: string,
  command: "show" | "status" | "cancel",
): { readonly ok: true; readonly value: string } | Extract<ScaliusCommandParseResult, { ok: false }> {
  if (!source) return failure("ARGUMENTS_REQUIRED", `${command} requires one ID.`);
  if (source.includes(" ")) {
    return failure("UNEXPECTED_ARGUMENTS", `${command} accepts exactly one ID.`);
  }
  return { ok: true, value: source };
}

function parseTerms(
  source: string,
): { readonly ok: true; readonly value: string } | Extract<ScaliusCommandParseResult, { ok: false }> {
  const value = source.split(" ").filter(Boolean).join(" ");
  if (value.length > SCALIUS_COMMAND_LIMITS.termsChars) {
    return failure(
      "TERMS_TOO_LONG",
      `Search terms must be at most ${SCALIUS_COMMAND_LIMITS.termsChars} characters.`,
    );
  }
  if (value.split(" ").length > SCALIUS_COMMAND_LIMITS.termsCount) {
    return failure(
      "TOO_MANY_TERMS",
      `Search terms may contain at most ${SCALIUS_COMMAND_LIMITS.termsCount} words.`,
    );
  }
  return { ok: true, value };
}

function parseBoundedJsonObject(
  source: string,
): { readonly ok: true; readonly value: ScaliusCommandJsonObject } |
  Extract<ScaliusCommandParseResult, { ok: false }> {
  if (source.length > SCALIUS_COMMAND_LIMITS.jsonChars) {
    return failure(
      "JSON_TOO_LONG",
      `JSON must be at most ${SCALIUS_COMMAND_LIMITS.jsonChars} characters.`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return failure("INVALID_JSON", "Arguments must be valid JSON.");
  }
  if (!isPlainJsonObject(value)) {
    return failure("JSON_OBJECT_REQUIRED", "Arguments must be one JSON object.");
  }

  const validated = validateJsonValue(value, {
    keys: 0,
    values: 0,
  }, 1, []);
  if (!validated.ok) return validated;
  return {
    ok: true,
    value: deepFreeze(value as ScaliusCommandJsonObject),
  };
}

interface JsonValidationState {
  keys: number;
  values: number;
}

function validateJsonValue(
  value: unknown,
  state: JsonValidationState,
  depth: number,
  pathWords: readonly string[],
): { readonly ok: true } | Extract<ScaliusCommandParseResult, { ok: false }> {
  state.values += 1;
  if (state.values > SCALIUS_COMMAND_LIMITS.jsonValues) {
    return failure(
      "JSON_TOO_MANY_VALUES",
      `JSON may contain at most ${SCALIUS_COMMAND_LIMITS.jsonValues} values.`,
    );
  }
  if (typeof value === "string") {
    if (value.length > SCALIUS_COMMAND_LIMITS.jsonStringChars) {
      return failure(
        "JSON_STRING_TOO_LONG",
        `JSON strings must be at most ${SCALIUS_COMMAND_LIMITS.jsonStringChars} characters.`,
      );
    }
    return containsControlCharacter(value)
      ? failure("JSON_CONTROL_CHARACTER", "JSON strings may not contain control characters.")
      : { ok: true };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))
      ? { ok: true }
      : failure("JSON_NUMBER_UNSAFE", "JSON numbers must be finite and safely representable.");
  }
  if (value === null || typeof value === "boolean") return { ok: true };

  if (depth > SCALIUS_COMMAND_LIMITS.jsonDepth) {
    return failure(
      "JSON_DEPTH_EXCEEDED",
      `JSON nesting may be at most ${SCALIUS_COMMAND_LIMITS.jsonDepth} levels.`,
    );
  }
  if (Array.isArray(value)) {
    if (value.length > SCALIUS_COMMAND_LIMITS.jsonArrayItems) {
      return failure(
        "JSON_ARRAY_TOO_LONG",
        `JSON arrays may contain at most ${SCALIUS_COMMAND_LIMITS.jsonArrayItems} items.`,
      );
    }
    for (const item of value) {
      const result = validateJsonValue(item, state, depth + 1, pathWords);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (!isPlainJsonObject(value)) return failure("INVALID_JSON", "Arguments contain a non-JSON value.");

  for (const [key, child] of Object.entries(value)) {
    state.keys += 1;
    if (state.keys > SCALIUS_COMMAND_LIMITS.jsonKeys) {
      return failure(
        "JSON_TOO_MANY_KEYS",
        `JSON may contain at most ${SCALIUS_COMMAND_LIMITS.jsonKeys} object keys.`,
      );
    }
    if (key.length > SCALIUS_COMMAND_LIMITS.jsonKeyChars) {
      return failure(
        "JSON_KEY_TOO_LONG",
        `JSON keys must be at most ${SCALIUS_COMMAND_LIMITS.jsonKeyChars} characters.`,
      );
    }
    if (containsControlCharacter(key)) {
      return failure("JSON_CONTROL_CHARACTER", "JSON keys may not contain control characters.");
    }
    if (PROTOTYPE_KEYS.has(key.toLowerCase())) {
      return failure("PROTOTYPE_KEY", "JSON contains an unsafe object key.");
    }
    const keyWords = splitKeyWords(key);
    const childPathWords = [...pathWords, ...keyWords];
    if (isSensitiveKeyPath(keyWords, childPathWords)) {
      return failure("SENSITIVE_KEY", "Secrets and credential-shaped inputs are not allowed.");
    }
    const result = validateJsonValue(child, state, depth + 1, childPathWords);
    if (!result.ok) return result;
  }
  return { ok: true };
}

function splitKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function isSensitiveKeyPath(currentWords: readonly string[], pathWords: readonly string[]): boolean {
  const currentCompact = currentWords.join("");
  if (currentWords.some((word) => DIRECT_SENSITIVE_KEY_WORDS.has(word))) return true;
  if (SENSITIVE_COMPACT_KEYS.has(currentCompact)) return true;
  if (
    currentCompact.includes("credential") || currentCompact.includes("receiptproof") ||
    currentCompact.includes("proofofreceipt") || currentCompact.includes("token") ||
    /^(?:hotp|otp|totp)(?:code|configured|hash|id|secret|value)?$/u.test(currentCompact) ||
    /^(?:passcode|passphrase|password|(?:client)?secret)(?:configured|hash|id|value)?$/u
      .test(currentCompact) ||
    /^(?:access|api|auth|client|encryption|private|refresh|session|signing)key(?:hash|id|ref|reference|value)?$/u
      .test(currentCompact)
  ) return true;
  if (pathWords.includes("receipt") && pathWords.includes("proof")) return true;
  if (
    (pathWords.includes("verification") || pathWords.includes("recovery") ||
      pathWords.includes("security") || pathWords.includes("auth")) &&
    pathWords.includes("code")
  ) return true;
  return pathWords.includes("one") && pathWords.includes("time") &&
    (pathWords.includes("code") || pathWords.includes("password"));
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze<TValue extends ScaliusCommandJsonValue>(value: TValue): TValue {
  if (Array.isArray(value)) {
    (value as readonly ScaliusCommandJsonValue[]).forEach((item) => deepFreeze(item));
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => deepFreeze(item));
  } else {
    return value;
  }
  return Object.freeze(value);
}

function isCapabilityId(value: string): boolean {
  return value.length <= SCALIUS_COMMAND_LIMITS.capabilityIdChars &&
    CAPABILITY_ID_PATTERN.test(value);
}

function isReferenceId(value: string): boolean {
  return value.length <= SCALIUS_COMMAND_LIMITS.referenceIdChars &&
    REFERENCE_ID_PATTERN.test(value);
}

function hasUnquotedChainingSyntax(source: string): boolean {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (character === ";" || character === "|" || character === "&" ||
      character === "`" || (character === "$" && source[index + 1] === "("))) {
      return true;
    }
  }
  return false;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function failure(
  code: ScaliusCommandParseErrorCode,
  message: string,
): Extract<ScaliusCommandParseResult, { ok: false }> {
  return { ok: false, error: { code, message } };
}
