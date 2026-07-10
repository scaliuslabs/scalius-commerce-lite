export const SCALIUS_COMPUTER_DESCRIPTION =
  "Control the visible Scalius page. Start with observe, use its revision-bound handles, and call help only when needed.";
export const SCALIUS_COMPUTER_RICH_TEXT_FILL_EVENT =
  "scalius:computer-rich-text-fill";
export const SCALIUS_COMPUTER_LIMITS = {
  programChars: 8_192,
  valueChars: 4_000,
  resultEnvelopeBytes: 48 * 1_024,
  resultOutputChars: 12_000,
} as const;
export const SCALIUS_COMPUTER_COMMANDS = [
  "observe",
  "help",
  "goto",
  "click",
  "fill",
  "select",
  "submit",
  "refresh",
] as const;
export type ScaliusComputerCommandName =
  (typeof SCALIUS_COMPUTER_COMMANDS)[number];
export type ScaliusComputerSurface = "admin" | "storefront";
export type ScaliusComputerAction = "click" | "fill" | "select" | "submit";
export interface ScaliusComputerBinding {
  surface: ScaliusComputerSurface;
  threadId: string;
  tabId: string;
}
export interface ScaliusComputerRequest {
  binding: ScaliusComputerBinding;
  program: string;
  /**
   * Trusted, application-derived routes authorized by the latest explicit user
   * navigation request. This is never model input. Both direct goto and visible
   * link clicks fail closed unless their exact normalized route appears here.
   */
  authorizedNavigationRoutes?: readonly string[];
}
export type ScaliusComputerCommand =
  | { name: "observe" }
  | { name: "help"; topic?: ScaliusComputerCommandName }
  | { name: "goto"; route: string }
  | { name: "click"; handle: string }
  | { name: "fill"; handle: string; value: string }
  | { name: "select"; handle: string; value: string }
  | { name: "submit"; handle: string }
  | { name: "refresh" };
export type ScaliusComputerErrorCode =
  | "INVALID_BINDING"
  | "INACTIVE_TAB"
  | "BUSY"
  | "INVALID_PROGRAM"
  | "ROUTE_BLOCKED"
  | "OBSERVE_REQUIRED"
  | "STALE_CONTEXT"
  | "TARGET_GONE"
  | "TARGET_DISABLED"
  | "SENSITIVE_CONTROL"
  | "HUMAN_REQUIRED"
  | "ACTION_NOT_ALLOWED"
  | "VALUE_NOT_FOUND"
  | "EXECUTION_FAILED";
export type ScaliusComputerResult =
  | {
      ok: true;
      code: "OBSERVED" | "HELP" | "NAVIGATED" | "REFRESHED" | "EXECUTED";
      output: string;
      revision?: string;
      changed: boolean;
    }
  | {
      ok: false;
      code: ScaliusComputerErrorCode;
      output: string;
      retryable: boolean;
    };
export interface ScaliusComputerTextNode {
  role: "heading" | "status" | "text";
  name: string;
}
export interface ScaliusComputerTarget {
  /** Adapter-private identifier. It is never shown to the model. */
  id: string;
  role: string;
  name: string;
  actions: readonly ScaliusComputerAction[];
  states?: readonly string[];
  route?: string;
  disabled?: boolean;
  sensitive?: boolean;
  humanOnly?: boolean;
}
export interface ScaliusComputerPageSnapshot {
  route: string;
  title: string;
  signature: string;
  targets: readonly ScaliusComputerTarget[];
  text: readonly ScaliusComputerTextNode[];
  truncated?: boolean;
}
export type ScaliusComputerAdapterAction =
  | { name: "click"; targetId: string }
  | { name: "fill"; targetId: string; value: string }
  | { name: "select"; targetId: string; value: string }
  | { name: "submit"; targetId: string };
export type ScaliusComputerAdapterResult =
  | { ok: true }
  | {
      ok: false;
      code: Extract<
        ScaliusComputerErrorCode,
        | "TARGET_GONE"
        | "TARGET_DISABLED"
        | "SENSITIVE_CONTROL"
        | "HUMAN_REQUIRED"
        | "ACTION_NOT_ALLOWED"
        | "VALUE_NOT_FOUND"
        | "EXECUTION_FAILED"
      >;
    };
export interface ScaliusComputerPageAdapter {
  capture(): ScaliusComputerPageSnapshot;
  act(action: ScaliusComputerAdapterAction):
    | ScaliusComputerAdapterResult
    | Promise<ScaliusComputerAdapterResult>;
  goto(route: string): void | Promise<void>;
  refresh(): void | Promise<void>;
  allowsRoute(route: string): boolean;
  isActive(): boolean;
}
export interface ScaliusComputerControllerOptions {
  binding: ScaliusComputerBinding;
  adapter: ScaliusComputerPageAdapter;
  maxOutputChars?: number;
}
interface ObservedPage {
  revisionNumber: number;
  signature: string;
  route: string;
  targets: Map<string, ScaliusComputerTarget>;
}
interface Lexeme {
  value: string;
  quoted: boolean;
}
const MAX_PROGRAM_CHARS = SCALIUS_COMPUTER_LIMITS.programChars;
const MAX_COMMANDS = 8;
const MAX_VALUE_CHARS = SCALIUS_COMPUTER_LIMITS.valueChars;
const MAX_BINDING_ID_CHARS = 160;
const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
const HANDLE_PATTERN = /^@r([1-9][0-9]{0,9})\.e([1-9][0-9]{0,3})$/;
const BINDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const COMMAND_SET = new Set<string>(SCALIUS_COMPUTER_COMMANDS);
export class ScaliusComputerController {
  readonly #binding: ScaliusComputerBinding;
  readonly #adapter: ScaliusComputerPageAdapter;
  readonly #maxOutputChars: number;
  #observed: ObservedPage | null = null;
  #revision = 0;
  #busy = false;
  constructor(options: ScaliusComputerControllerOptions) {
    if (!isValidBinding(options.binding)) {
      throw new Error("Invalid Scalius computer binding");
    }
    this.#binding = { ...options.binding };
    this.#adapter = options.adapter;
    this.#maxOutputChars = clampInteger(
      options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      1_000,
      DEFAULT_MAX_OUTPUT_CHARS,
    );
  }
  async execute(request: ScaliusComputerRequest): Promise<ScaliusComputerResult> {
    if (!bindingsMatch(this.#binding, request.binding)) {
      return failure("INVALID_BINDING", "This command belongs to another thread or tab.", false);
    }
    if (!this.#adapter.isActive()) {
      return failure("INACTIVE_TAB", "The bound browser tab is not active.", true);
    }
    if (this.#busy) {
      return failure("BUSY", "Another page command is still running.", true);
    }
    const parsed = parseScaliusComputerProgram(request.program);
    if (!parsed.ok) {
      return failure("INVALID_PROGRAM", parsed.error, false);
    }
    this.#busy = true;
    try {
      return await this.#run(
        parsed.commands,
        normalizeAuthorizedNavigationRoutes(request.authorizedNavigationRoutes),
      );
    } catch {
      this.#invalidate();
      return failure(
        "EXECUTION_FAILED",
        "The page could not complete that command. Observe and try again.",
        true,
      );
    } finally {
      this.#busy = false;
    }
  }
  async #run(
    commands: readonly ScaliusComputerCommand[],
    authorizedNavigationRoutes: ReadonlySet<string>,
  ): Promise<ScaliusComputerResult> {
    const first = commands[0];
    if (!first) {
      return failure("INVALID_PROGRAM", "Program is empty.", false);
    }
    if (first.name === "help") {
      return {
        ok: true,
        code: "HELP",
        output: computerHelp(first.topic),
        changed: false,
      };
    }
    if (first.name === "observe") return this.#observe();
    if (first.name === "goto") {
      const route = normalizeScaliusComputerRoute(first.route);
      if (
        !route ||
        !this.#adapter.allowsRoute(route) ||
        !authorizedNavigationRoutes.has(route)
      ) {
        return failure(
          "ROUTE_BLOCKED",
          "Navigation requires one exact route authorized by the latest user request.",
          false,
        );
      }
      await this.#adapter.goto(route);
      this.#invalidate();
      return {
        ok: true,
        code: "NAVIGATED",
        output: `Opened ${quote(route)}. Observe the new page.`,
        changed: true,
      };
    }
    if (first.name === "refresh") {
      await this.#adapter.refresh();
      this.#invalidate();
      return {
        ok: true,
        code: "REFRESHED",
        output: "Refreshed the page. Observe it again.",
        changed: true,
      };
    }
    return this.#act(commands, authorizedNavigationRoutes);
  }
  #observe(): ScaliusComputerResult {
    const snapshot = this.#adapter.capture();
    this.#revision += 1;
    const revision = `r${this.#revision}`;
    const targets = new Map<string, ScaliusComputerTarget>();
    const lines = [
      `PAGE rev=${revision} route=${quote(snapshot.route)} title=${quote(snapshot.title)}`,
      "UNTRUSTED_PAGE_CONTENT",
    ];
    snapshot.text.forEach((node) => {
      lines.push(`${node.role} ${quote(node.name)}`);
    });
    snapshot.targets.forEach((target, index) => {
      const handle = `@${revision}.e${index + 1}`;
      targets.set(handle, target);
      const flags = [
        ...(target.states ?? []),
        target.disabled ? "disabled" : "",
        target.sensitive ? "sensitive" : "",
        target.humanOnly ? "human-only" : "",
      ].filter(Boolean);
      const route = target.route ? ` route=${quote(target.route)}` : "";
      const state = flags.length > 0 ? ` [${flags.join(",")}]` : "";
      lines.push(`${handle} ${target.role} ${quote(target.name)}${route}${state}`);
    });
    if (snapshot.truncated) lines.push("... page snapshot truncated");
    lines.push("END_UNTRUSTED_PAGE_CONTENT");
    this.#observed = {
      revisionNumber: this.#revision,
      signature: snapshot.signature,
      route: snapshot.route,
      targets,
    };
    return {
      ok: true,
      code: "OBSERVED",
      output: boundedOutput(lines, this.#maxOutputChars),
      revision,
      changed: false,
    };
  }
  async #act(
    commands: readonly ScaliusComputerCommand[],
    authorizedNavigationRoutes: ReadonlySet<string>,
  ): Promise<ScaliusComputerResult> {
    const observed = this.#observed;
    if (!observed) {
      return failure("OBSERVE_REQUIRED", "Observe the page before using an element handle.", true);
    }
    const live = this.#adapter.capture();
    if (live.signature !== observed.signature || live.route !== observed.route) {
      this.#invalidate();
      return failure("STALE_CONTEXT", "The page changed. Observe it again.", true);
    }
    let completed = 0;
    for (const [commandIndex, command] of commands.entries()) {
      if (!isActionCommand(command)) {
        this.#invalidate();
        return failure("INVALID_PROGRAM", "Page actions cannot be mixed with navigation or help.", false);
      }
      const parsedHandle = parseHandle(command.handle);
      if (!parsedHandle || parsedHandle.revision !== observed.revisionNumber) {
        this.#invalidate();
        return failure("STALE_CONTEXT", "That element handle is stale. Observe the page again.", true);
      }
      const target = observed.targets.get(command.handle);
      if (!target) {
        this.#invalidate();
        return failure("STALE_CONTEXT", "That element handle is not part of this page snapshot.", true);
      }
      const preflight = targetPreflight(target, command.name);
      if (preflight) {
        if (completed > 0) this.#invalidate();
        return preflight;
      }
      if (
        command.name === "click" &&
        target.route &&
        (
          !this.#adapter.allowsRoute(target.route) ||
          !authorizedNavigationRoutes.has(target.route)
        )
      ) {
        if (completed > 0) this.#invalidate();
        return failure(
          "ROUTE_BLOCKED",
          "That link requires one exact destination authorized by the latest user request.",
          false,
        );
      }
      const result = await this.#adapter.act(toAdapterAction(command, target.id));
      if (!result.ok) {
        this.#invalidate();
        return failure(result.code, adapterFailureMessage(result.code), result.code !== "SENSITIVE_CONTROL");
      }
      completed += 1;
      if ((command.name === "fill" || command.name === "select") && commandIndex < commands.length - 1) {
        const afterDraft = this.#adapter.capture();
        if (afterDraft.route !== observed.route) {
          this.#invalidate();
          return failure("STALE_CONTEXT", "The page changed after the draft action. Observe it again.", true);
        }
        const freshById = new Map(afterDraft.targets.map((candidate) => [candidate.id, candidate]));
        for (const [handle, previous] of observed.targets) {
          const fresh = freshById.get(previous.id);
          if (fresh) observed.targets.set(handle, fresh);
        }
        observed.signature = afterDraft.signature;
      }
    }
    this.#invalidate();
    return {
      ok: true,
      code: "EXECUTED",
      output: `Completed ${completed} page ${completed === 1 ? "action" : "actions"}. Observe the result.`,
      changed: completed > 0,
    };
  }
  #invalidate(): void {
    this.#observed = null;
  }
}
export function parseScaliusComputerProgram(
  program: string,
): { ok: true; commands: ScaliusComputerCommand[] } | { ok: false; error: string } {
  if (typeof program !== "string" || program.length > MAX_PROGRAM_CHARS) {
    return { ok: false, error: `Program must be at most ${MAX_PROGRAM_CHARS} characters.` };
  }
  const split = splitCommands(program);
  if (!split.ok) return split;
  if (split.values.length === 0) return { ok: false, error: "Program is empty." };
  if (split.values.length > MAX_COMMANDS) {
    return { ok: false, error: `A program may contain at most ${MAX_COMMANDS} commands.` };
  }
  const commands: ScaliusComputerCommand[] = [];
  for (const source of split.values) {
    const lexed = lexCommand(source);
    if (!lexed.ok) return lexed;
    const parsed = parseCommand(lexed.values);
    if (!parsed.ok) return parsed;
    commands.push(parsed.command);
  }
  const boundary = commands.find((command) =>
    command.name === "observe" || command.name === "help" ||
    command.name === "goto" || command.name === "refresh"
  );
  if (boundary && commands.length !== 1) {
    return { ok: false, error: `${boundary.name} must be the only command in a program.` };
  }
  const revisions = new Set(
    commands.flatMap((command) => {
      if (!isActionCommand(command)) return [];
      const parsed = parseHandle(command.handle);
      return parsed ? [parsed.revision] : [];
    }),
  );
  if (revisions.size > 1) {
    return { ok: false, error: "All handles in a batch must come from one page revision." };
  }
  const terminalIndexes = commands.flatMap((command, index) =>
    command.name === "click" || command.name === "submit" ? [index] : []
  );
  if (
    terminalIndexes.length > 1 ||
    (terminalIndexes.length === 1 && terminalIndexes[0] !== commands.length - 1)
  ) {
    return { ok: false, error: "click or submit may appear once, as the final command in an action batch." };
  }
  return { ok: true, commands };
}
export function normalizeScaliusComputerRoute(value: string): string | null {
  const route = value.trim();
  if (
    !route.startsWith("/") || route.startsWith("//") ||
    route.length > 2_048 || route.includes("\\") || containsControlCharacters(route)
  ) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(route);
  } catch {
    return null;
  }
  if (decoded.startsWith("//") || decoded.includes("\\") || containsControlCharacters(decoded)) {
    return null;
  }
  try {
    const parsed = new URL(route, "https://scalius.invalid");
    if (parsed.origin !== "https://scalius.invalid") return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}
function normalizeAuthorizedNavigationRoutes(
  routes: readonly string[] | undefined,
): ReadonlySet<string> {
  if (!routes || routes.length === 0 || routes.length > 32) return new Set();
  const normalized = new Set<string>();
  for (const route of routes) {
    if (typeof route !== "string") return new Set();
    const candidate = normalizeScaliusComputerRoute(route);
    if (!candidate) return new Set();
    normalized.add(candidate);
  }
  return normalized;
}
function parseCommand(
  tokens: readonly Lexeme[],
): { ok: true; command: ScaliusComputerCommand } | { ok: false; error: string } {
  const name = tokens[0]?.value.toLowerCase();
  if (!name || !COMMAND_SET.has(name)) {
    return { ok: false, error: `Unknown command ${quote(name || "(empty)")}.` };
  }
  if (name === "observe" || name === "refresh") {
    return tokens.length === 1
      ? { ok: true, command: { name } }
      : { ok: false, error: `${name} takes no arguments.` };
  }
  if (name === "help") {
    if (tokens.length > 2) return { ok: false, error: "help accepts at most one command name." };
    const topic = tokens[1]?.value.toLowerCase();
    if (topic && !COMMAND_SET.has(topic)) {
      return { ok: false, error: "help topic must be a known command." };
    }
    return { ok: true, command: { name, ...(topic ? { topic: topic as ScaliusComputerCommandName } : {}) } };
  }
  if (name === "goto") {
    if (tokens.length !== 2) return { ok: false, error: "goto requires one route." };
    const route = tokens[1]?.value ?? "";
    if (!normalizeScaliusComputerRoute(route)) {
      return { ok: false, error: "goto requires a same-origin path route." };
    }
    return { ok: true, command: { name, route } };
  }
  const handle = tokens[1]?.value ?? "";
  if (!parseHandle(handle)) return { ok: false, error: `${name} requires a revision-bound handle such as @r1.e1.` };
  if (name === "click" || name === "submit") {
    return tokens.length === 2
      ? { ok: true, command: { name, handle } }
      : { ok: false, error: `${name} accepts exactly one handle.` };
  }
  if (name !== "fill" && name !== "select") {
    return { ok: false, error: "Unsupported command." };
  }
  if (tokens.length !== 3 || !tokens[2]?.quoted) {
    return { ok: false, error: `${name} requires a handle and one quoted value.` };
  }
  const value = tokens[2].value;
  if (value.length > MAX_VALUE_CHARS) {
    return { ok: false, error: `${name} value is too long.` };
  }
  return { ok: true, command: { name, handle, value } };
}
function splitCommands(
  source: string,
): { ok: true; values: string[] } | { ok: false; error: string } {
  const values: string[] = [];
  let current = "";
  let quoteChar = "";
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quoteChar && character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      current += character;
      quoteChar = quoteChar === character ? "" : quoteChar || character;
      continue;
    }
    if (!quoteChar && (character === ";" || character === "\n")) {
      if (current.trim()) values.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (quoteChar || escaped) return { ok: false, error: "Program contains an unterminated quoted value." };
  if (current.trim()) values.push(current.trim());
  return { ok: true, values };
}
function lexCommand(
  source: string,
): { ok: true; values: Lexeme[] } | { ok: false; error: string } {
  const values: Lexeme[] = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) break;
    const quoteChar = source[index];
    if (quoteChar === '"' || quoteChar === "'") {
      index += 1;
      let value = "";
      let closed = false;
      while (index < source.length) {
        const character = source[index] ?? "";
        index += 1;
        if (character === quoteChar) {
          closed = true;
          break;
        }
        if (character === "\\") {
          const escaped = source[index] ?? "";
          index += 1;
          const decoded = escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
          value += decoded;
        } else {
          value += character;
        }
      }
      if (!closed) return { ok: false, error: "Quoted value is not terminated." };
      values.push({ value, quoted: true });
      continue;
    }
    const start = index;
    while (index < source.length && !/\s/.test(source[index] ?? "")) index += 1;
    values.push({ value: source.slice(start, index), quoted: false });
  }
  return { ok: true, values };
}
function parseHandle(value: string): { revision: number; element: number } | null {
  const match = HANDLE_PATTERN.exec(value);
  if (!match) return null;
  return { revision: Number(match[1]), element: Number(match[2]) };
}
function isActionCommand(
  command: ScaliusComputerCommand,
): command is Extract<ScaliusComputerCommand, { name: ScaliusComputerAction }> {
  return command.name === "click" || command.name === "fill" ||
    command.name === "select" || command.name === "submit";
}
function toAdapterAction(
  command: Extract<ScaliusComputerCommand, { name: ScaliusComputerAction }>,
  targetId: string,
): ScaliusComputerAdapterAction {
  if (command.name === "fill" || command.name === "select") {
    return { name: command.name, targetId, value: command.value };
  }
  return { name: command.name, targetId };
}
function targetPreflight(
  target: ScaliusComputerTarget,
  action: ScaliusComputerAction,
): ScaliusComputerResult | null {
  if (target.sensitive) {
    return failure("SENSITIVE_CONTROL", "Protected controls must be completed by the person using the page.", false);
  }
  if (target.humanOnly) {
    return failure("HUMAN_REQUIRED", "This control requires direct human interaction.", false);
  }
  if (target.disabled) return failure("TARGET_DISABLED", "That control is disabled.", true);
  if (!target.actions.includes(action)) {
    return failure("ACTION_NOT_ALLOWED", `${action} is not allowed for that control.`, false);
  }
  return null;
}
function isValidBinding(binding: ScaliusComputerBinding): boolean {
  return (binding.surface === "admin" || binding.surface === "storefront") &&
    isValidBindingId(binding.threadId) && isValidBindingId(binding.tabId);
}
function isValidBindingId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_BINDING_ID_CHARS && BINDING_ID_PATTERN.test(value);
}
function bindingsMatch(expected: ScaliusComputerBinding, actual: ScaliusComputerBinding): boolean {
  return isValidBinding(actual) && expected.surface === actual.surface &&
    expected.threadId === actual.threadId && expected.tabId === actual.tabId;
}
function failure(
  code: ScaliusComputerErrorCode,
  output: string,
  retryable: boolean,
): ScaliusComputerResult {
  return { ok: false, code, output, retryable };
}
function adapterFailureMessage(code: ScaliusComputerErrorCode): string {
  const messages: Partial<Record<ScaliusComputerErrorCode, string>> = {
    TARGET_GONE: "That control is no longer on the page. Observe it again.",
    TARGET_DISABLED: "That control is disabled.",
    SENSITIVE_CONTROL: "Protected controls must be completed by the person using the page.",
    HUMAN_REQUIRED: "This control requires direct human interaction.",
    ACTION_NOT_ALLOWED: "That operation is not allowed for this control.",
    VALUE_NOT_FOUND: "That option is not available in the control.",
    EXECUTION_FAILED: "The page could not complete that command. Observe and try again.",
  };
  return messages[code] ?? "The page command failed safely.";
}
function computerHelp(topic?: ScaliusComputerCommandName): string {
  const help: Record<ScaliusComputerCommandName, string> = {
    observe: "observe — return a bounded page snapshot and fresh revision-bound handles.",
    help: "help [command] — show this compact command reference.",
    goto: "goto \"/path?query\" — open one allowed same-origin route; use it alone.",
    click: "click @rN.eN — activate a visible safe control.",
    fill: "fill @rN.eN \"text\" — replace a visible editable value; explicitly marked rich-text editors accept sanitized HTML.",
    select: "select @rN.eN \"value or label\" — choose one enabled option.",
    submit: "submit @rN.eN — submit a form explicitly registered for agent use.",
    refresh: "refresh — reload the current page; use it alone.",
  };
  return topic ? help[topic] : SCALIUS_COMPUTER_COMMANDS.map((name) => help[name]).join("\n");
}
function boundedOutput(lines: readonly string[], maxChars: number): string {
  let output = "";
  for (const line of lines) {
    const next = output ? `${output}\n${line}` : line;
    if (next.length > maxChars) {
      const suffix = "\n... output truncated";
      return `${output.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
    }
    output = next;
  }
  return output;
}
function quote(value: string): string {
  const safe = replaceControlCharacters(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${safe}"`;
}
function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
export interface ScaliusBrowserComputerOptions {
  document: unknown;
  origin: string;
  currentRoute(): string;
  goto(route: string): void | Promise<void>;
  refresh(): void | Promise<void>;
  allowsRoute(route: string): boolean;
  isActive(): boolean;
  textMode?: "headings" | "semantic";
  maxTargets?: number;
  maxTextNodes?: number;
}
interface ElementLike {
  localName?: string;
  tagName?: string;
  textContent?: string | null;
  parentElement?: ElementLike | null;
  isConnected?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  checked?: boolean;
  value?: string;
  form?: ElementLike | null;
  options?: ArrayLike<ElementLike>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelectorAll?(selector: string): ArrayLike<unknown>;
  click?(): void;
  focus?(): void;
  dispatchEvent?(event: unknown): boolean;
  requestSubmit?(submitter?: unknown): void;
}
interface DocumentLike {
  title?: string;
  defaultView?: {
    Event?: new (type: string, init?: { bubbles?: boolean }) => unknown;
    CustomEvent?: new (
      type: string,
      init?: { bubbles?: boolean; cancelable?: boolean; detail?: unknown },
    ) => unknown;
  };
  querySelectorAll(selector: string): ArrayLike<unknown>;
  getElementById(id: string): unknown;
}
const INTERACTIVE_SELECTOR = [
  "a[href]", "button", "input:not([type='hidden'])", "select", "textarea", "form",
  "[contenteditable='true']", "[role='button']", "[role='link']", "[role='textbox']",
  "[role='checkbox']", "[role='radio']", "[role='switch']", "[role='combobox']",
  "[role='tab']", "[role='menuitem']",
].join(",");
const HEADING_SELECTOR =
  "main h1,main h2,main h3,[role='heading'],[role='status'],[role='alert'],[data-scalius-computer-text]";
const SEMANTIC_TEXT_SELECTOR =
  `${HEADING_SELECTOR},main p,main li,main th,main td`;
const SENSITIVE_SELECTOR = [
  "input[type='password']", "input[type='file']", "[autocomplete='one-time-code']",
  "[autocomplete^='cc-']", "[data-scalius-computer-sensitive]",
].join(",");
const SENSITIVE_HINT =
  /(?:password|passcode|one.?time|\botp\b|secret|token|api.?key|card.?number|\bcvv\b|\bcvc\b|receipt|recovery)/i;
const CONSEQUENTIAL_HINT =
  /(?:\b(?:delete|refund|purchase|publish|archive|save|create|update|apply|approve|reject|fulfill|ship|invite|enable|disable|reset)\b|place order|pay now|send (?:message|email|code)|cancel order|remove permanently|confirm payment)/i;
export function createScaliusBrowserComputerAdapter(
  options: ScaliusBrowserComputerOptions,
): ScaliusComputerPageAdapter {
  const document = asDocument(options.document);
  const elements = new Map<string, ElementLike>();
  const stableIds = new WeakMap<object, string>();
  let nextId = 1;
  const maxTargets = clampInteger(options.maxTargets ?? 60, 1, 100);
  const maxText = clampInteger(options.maxTextNodes ?? 40, 0, 80);
  const idFor = (element: ElementLike): string => {
    const object = element as object;
    const current = stableIds.get(object);
    if (current) return current;
    const id = `dom-${nextId++}`;
    stableIds.set(object, id);
    return id;
  };
  const capture = (): ScaliusComputerPageSnapshot => {
    elements.clear();
    const candidates = arrayOfElements(document.querySelectorAll(INTERACTIVE_SELECTOR));
    const targets: ScaliusComputerTarget[] = [];
    for (const element of candidates) {
      if (targets.length >= maxTargets) break;
      const target = inspectTarget(document, element, options.origin, idFor(element));
      if (!target) continue;
      targets.push(target);
      elements.set(target.id, element);
    }
    const textCandidates = arrayOfElements(document.querySelectorAll(
      options.textMode === "semantic" ? SEMANTIC_TEXT_SELECTOR : HEADING_SELECTOR,
    ));
    const text: ScaliusComputerTextNode[] = [];
    const seen = new Set<string>();
    for (const element of textCandidates) {
      if (text.length >= maxText) break;
      if (isExcluded(element) || isSensitive(element) || isInsideInteractive(element)) continue;
      const name = cleanText(element.textContent ?? "", 180);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const role = elementRole(element) === "heading"
        ? "heading"
        : ["status", "alert"].includes(attribute(element, "role")) ? "status" : "text";
      text.push({ role, name });
    }
    const route = normalizeScaliusComputerRoute(options.currentRoute()) ?? "/";
    const title = cleanText(document.title ?? "", 160);
    const signature = hashSnapshot(route, title, targets, text, candidates.length, textCandidates.length);
    return {
      route,
      title,
      signature,
      targets,
      text,
      truncated: candidates.length > targets.length || textCandidates.length > text.length,
    };
  };
  const act = async (
    action: ScaliusComputerAdapterAction,
  ): Promise<ScaliusComputerAdapterResult> => {
    const element = elements.get(action.targetId);
    if (!element || element.isConnected === false) return { ok: false, code: "TARGET_GONE" };
    const target = inspectTarget(document, element, options.origin, action.targetId);
    if (!target) return { ok: false, code: "TARGET_GONE" };
    if (target.sensitive) return { ok: false, code: "SENSITIVE_CONTROL" };
    if (target.humanOnly) return { ok: false, code: "HUMAN_REQUIRED" };
    if (target.disabled) return { ok: false, code: "TARGET_DISABLED" };
    if (!target.actions.includes(action.name)) return { ok: false, code: "ACTION_NOT_ALLOWED" };
    if (action.name === "click") {
      if (!element.click) return { ok: false, code: "EXECUTION_FAILED" };
      element.focus?.();
      element.click();
      return { ok: true };
    }
    if (action.name === "fill") {
      if (element.readOnly) return { ok: false, code: "TARGET_DISABLED" };
      element.focus?.();
      const richTextBridge = ancestorWithAttribute(
        element,
        "data-scalius-computer-rich-text",
      );
      if (richTextBridge) {
        return dispatchRichTextFill(
            document,
            richTextBridge,
            action.value,
          )
          ? { ok: true }
          : { ok: false, code: "EXECUTION_FAILED" };
      }
      if (attribute(element, "contenteditable") === "true") element.textContent = action.value;
      else setElementValue(document, element, action.value);
      dispatch(document, element, "input");
      dispatch(document, element, "change");
      return { ok: true };
    }
    if (action.name === "select") {
      if (elementName(element) === "select") {
        const options = arrayOfElements(element.options ?? []);
        const matching = matchingOptions(options, action.value);
        const selected = matching[0];
        if (matching.length !== 1 || !selected || optionDisabled(selected)) {
          return { ok: false, code: "VALUE_NOT_FOUND" };
        }
        setElementValue(document, element, selected.value ?? action.value);
        dispatch(document, element, "input");
        dispatch(document, element, "change");
        return { ok: true };
      }

      // Radix/shadcn and similar accessible selects expose a trigger with
      // role=combobox and portal their choices as role=option. Operate that
      // semantic contract directly so the model does not need framework- or
      // selector-specific knowledge.
      if (!element.click) return { ok: false, code: "EXECUTION_FAILED" };
      element.focus?.();
      element.click();
      await Promise.resolve();
      await Promise.resolve();
      const options = arrayOfElements(document.querySelectorAll("[role='option']"))
        .filter((option) => !isExcluded(option) && !isHidden(option));
      const matching = matchingOptions(options, action.value);
      const selected = matching[0];
      if (
        matching.length !== 1 ||
        !selected ||
        optionDisabled(selected) ||
        !selected.click
      ) {
        // Best-effort close leaves the visible page in the state it started.
        element.click();
        return { ok: false, code: "VALUE_NOT_FOUND" };
      }
      selected.focus?.();
      selected.click();
      return { ok: true };
    }
    const form = elementName(element) === "form" ? element : element.form;
    if (!form || !submitAllowed(element, form) || containsSensitiveControl(form)) {
      return { ok: false, code: "HUMAN_REQUIRED" };
    }
    if (!form.requestSubmit) return { ok: false, code: "EXECUTION_FAILED" };
    form.requestSubmit(elementName(element) === "form" ? undefined : element);
    return { ok: true };
  };
  return {
    capture,
    act,
    goto: options.goto,
    refresh: options.refresh,
    allowsRoute: options.allowsRoute,
    isActive: options.isActive,
  };
}

function matchingOptions(
  options: readonly ElementLike[],
  requestedValue: string,
): ElementLike[] {
  return options.filter((option) =>
    option.value === requestedValue ||
    attribute(option, "data-value") === requestedValue ||
    attribute(option, "aria-label") === requestedValue ||
    cleanText(option.textContent ?? "", 160) === requestedValue
  );
}

function optionDisabled(option: ElementLike): boolean {
  return Boolean(option.disabled) || attribute(option, "aria-disabled") === "true";
}
function inspectTarget(
  document: DocumentLike,
  element: ElementLike,
  origin: string,
  id: string,
): ScaliusComputerTarget | null {
  if (isExcluded(element) || isHidden(element)) return null;
  const role = elementRole(element);
  if (!role) return null;
  const sensitive = isSensitive(element);
  const rawName = accessibleName(document, element, role);
  const name = sensitive ? (role === "textbox" ? "Protected input" : "Protected control") : rawName;
  const tag = elementName(element);
  const type = attribute(element, "type").toLowerCase();
  const form = tag === "form" ? element : element.form;
  const submitter = Boolean(form) && (
    (tag === "button" && (type === "" || type === "submit")) ||
    (tag === "input" && (type === "submit" || type === "image"))
  );
  const route = role === "link" ? safeLinkRoute(attribute(element, "href"), origin) : undefined;
  const disabled = Boolean(element.disabled) || attribute(element, "aria-disabled") === "true" || hasAncestorFlag(element, "inert");
  const explicitlyAllowed = attribute(element, "data-scalius-computer-action") === "allow";
  const humanOnly = hasAncestorFlag(element, "data-scalius-computer-human-only") ||
    type === "file" || (role === "link" && !route) ||
    (submitter || tag === "form") && (!form || !submitAllowed(element, form)) ||
    (!explicitlyAllowed && CONSEQUENTIAL_HINT.test(name));
  const actions: ScaliusComputerAction[] = submitter || tag === "form"
    ? ["submit"]
    : role === "textbox" ? ["fill"]
    : role === "combobox" ? ["select"]
    : ["link", "button", "checkbox", "radio", "switch", "tab", "menuitem"].includes(role) ? ["click"] : [];
  if (actions.length === 0) return null;
  const states: string[] = [];
  if (Boolean(element.checked) || attribute(element, "aria-checked") === "true") states.push("checked");
  if (attribute(element, "aria-expanded")) states.push(`expanded=${attribute(element, "aria-expanded")}`);
  if (element.readOnly) states.push("readonly");
  if (element.hasAttribute("required")) states.push("required");
  if (role === "combobox") {
    const selected = arrayOfElements(element.options ?? []).find((option) => Boolean((option as { selected?: boolean }).selected));
    const label = cleanText(selected?.textContent ?? "", 80);
    if (label && !sensitive) states.push(`selected=${quote(label)}`);
  } else if (!sensitive && attribute(element, "data-scalius-computer-expose-value") === "true") {
    const value = cleanText(element.value ?? "", 80);
    if (value) states.push(`value=${quote(value)}`);
  }
  return { id, role, name: name || `Unnamed ${role}`, actions, states, route, disabled, sensitive, humanOnly };
}
function accessibleName(document: DocumentLike, element: ElementLike, role: string): string {
  const direct = attribute(element, "aria-label");
  if (direct) return cleanText(direct, 160);
  const labelledBy = attribute(element, "aria-labelledby").split(/\s+/).filter(Boolean);
  const labelled = labelledBy.map((id) => asElement(document.getElementById(id))?.textContent ?? "").join(" ");
  if (labelled.trim()) return cleanText(labelled, 160);
  const id = attribute(element, "id");
  if (id) {
    const label = arrayOfElements(document.querySelectorAll("label")).find((candidate) => attribute(candidate, "for") === id);
    if (label?.textContent) return cleanText(label.textContent, 160);
  }
  const fallback = attribute(element, "alt") || attribute(element, "title") ||
    attribute(element, "placeholder") || (role === "button" ? element.value ?? "" : "") || element.textContent || "";
  return cleanText(fallback, 160);
}
function elementRole(element: ElementLike): string {
  const explicit = attribute(element, "role").toLowerCase();
  if (explicit) return explicit === "alert" ? "status" : explicit;
  const tag = elementName(element);
  const type = attribute(element, "type").toLowerCase();
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea" || attribute(element, "contenteditable") === "true") return "textbox";
  if (tag === "form") return "form";
  if (tag === "input") {
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    return "textbox";
  }
  return "";
}
function isSensitive(element: ElementLike): boolean {
  const autocomplete = attribute(element, "autocomplete").toLowerCase();
  const hint = [attribute(element, "type"), autocomplete, attribute(element, "name"), attribute(element, "id")].join(" ");
  return hasAncestorFlag(element, "data-scalius-computer-sensitive") ||
    ["password", "file"].includes(attribute(element, "type").toLowerCase()) ||
    autocomplete === "one-time-code" || autocomplete.startsWith("cc-") || SENSITIVE_HINT.test(hint);
}
function isExcluded(element: ElementLike): boolean {
  return hasAncestorFlag(element, "data-scalius-computer-exclude") || hasAncestorFlag(element, "inert");
}
function ancestorWithAttribute(
  element: ElementLike,
  name: string,
): ElementLike | null {
  let current: ElementLike | null | undefined = element;
  while (current) {
    if (current.hasAttribute(name)) return current;
    current = current.parentElement;
  }
  return null;
}
function dispatchRichTextFill(
  document: DocumentLike,
  bridge: ElementLike,
  value: string,
): boolean {
  const CustomEventConstructor = document.defaultView?.CustomEvent ??
    (globalThis as {
      CustomEvent?: new (
        type: string,
        init?: { bubbles?: boolean; cancelable?: boolean; detail?: unknown },
      ) => unknown;
    }).CustomEvent;
  if (!CustomEventConstructor || !bridge.dispatchEvent) return false;
  const accepted = bridge.dispatchEvent(new CustomEventConstructor(
    SCALIUS_COMPUTER_RICH_TEXT_FILL_EVENT,
    { bubbles: false, cancelable: true, detail: value },
  ));
  // The explicit bridge cancels only after it has sanitized and accepted the
  // value. A missing/misconfigured bridge therefore fails closed.
  return accepted === false;
}
function isHidden(element: ElementLike): boolean {
  return elementName(element) === "input" && attribute(element, "type") === "hidden" ||
    hasAncestorFlag(element, "hidden") || hasAncestorValue(element, "aria-hidden", "true");
}
function isInsideInteractive(element: ElementLike): boolean {
  let current = element.parentElement;
  while (current) {
    if (elementRole(current) && elementRole(current) !== "heading") return true;
    current = current.parentElement;
  }
  return false;
}
function submitAllowed(element: ElementLike, form: ElementLike): boolean {
  return attribute(element, "data-scalius-computer-submit") === "allow" ||
    attribute(form, "data-scalius-computer-submit") === "allow";
}
function containsSensitiveControl(form: ElementLike): boolean {
  return arrayOfElements(form.querySelectorAll?.(SENSITIVE_SELECTOR) ?? []).length > 0;
}
function safeLinkRoute(href: string, origin: string): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin) return undefined;
    return normalizeScaliusComputerRoute(`${url.pathname}${url.search}${url.hash}`) ?? undefined;
  } catch {
    return undefined;
  }
}
function setElementValue(document: DocumentLike, element: ElementLike, value: string): void {
  let prototype = Object.getPrototypeOf(element) as object | null;
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(element, value);
      return;
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  element.value = value;
  void document;
}
function dispatch(document: DocumentLike, element: ElementLike, type: string): void {
  const EventConstructor = document.defaultView?.Event ??
    (globalThis as { Event?: new (type: string, init?: { bubbles?: boolean }) => unknown }).Event;
  if (EventConstructor && element.dispatchEvent) element.dispatchEvent(new EventConstructor(type, { bubbles: true }));
}
function hashSnapshot(
  route: string,
  title: string,
  targets: readonly ScaliusComputerTarget[],
  text: readonly ScaliusComputerTextNode[],
  targetCount: number,
  textCount: number,
): string {
  const source = JSON.stringify([route, title, targetCount, textCount, targets, text]);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
function hasAncestorFlag(element: ElementLike, attributeName: string): boolean {
  let current: ElementLike | null | undefined = element;
  while (current) {
    if (current.hasAttribute(attributeName)) return true;
    current = current.parentElement;
  }
  return false;
}
function hasAncestorValue(element: ElementLike, attributeName: string, value: string): boolean {
  let current: ElementLike | null | undefined = element;
  while (current) {
    if (attribute(current, attributeName) === value) return true;
    current = current.parentElement;
  }
  return false;
}
function attribute(element: ElementLike, name: string): string {
  return element.getAttribute(name)?.trim() ?? "";
}
function elementName(element: ElementLike): string {
  return (element.localName ?? element.tagName ?? "").toLowerCase();
}
function cleanText(value: string, max: number): string {
  return replaceControlCharacters(value).replace(/\s+/g, " ").trim().slice(0, max);
}
function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
function replaceControlCharacters(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    output += code <= 31 || code === 127 ? " " : character;
  }
  return output;
}
function arrayOfElements(value: ArrayLike<unknown>): ElementLike[] {
  return Array.from(value).map(asElement).filter((element): element is ElementLike => Boolean(element));
}
function asDocument(value: unknown): DocumentLike {
  const candidate = value as Partial<DocumentLike> | null;
  if (!candidate?.querySelectorAll || !candidate.getElementById) throw new Error("Browser document is unavailable");
  return candidate as DocumentLike;
}
function asElement(value: unknown): ElementLike | null {
  const candidate = value as Partial<ElementLike> | null;
  return candidate?.getAttribute && candidate.hasAttribute ? candidate as ElementLike : null;
}
