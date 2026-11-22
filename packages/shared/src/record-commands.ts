// The commands a caller sends to a record with a lifecycle (a return, a
// purchase order, a transfer), each named by its operation's last word
// (`dashboard.purchase_orders.<command>`), over the record's machine
// (`./machine`). One declaration answers three questions the same way: which
// states a command is taken in (the writer's WHERE), what a refusal names as
// open instead, and what the record's read lists as available.
import type { Machine, MachineMoves, MachineRefusal } from "./machine";

/**
 * A command makes one of its machine moves (its input decides which: a
 * receipt that takes the last units completes the record), or, for an edit
 * that moves nothing, is taken in the states it names.
 */
export type RecordCommand<S extends string, E extends string> =
  | { readonly moves: readonly E[] }
  | { readonly in: readonly S[] };

export type RecordCommands<S extends string, E extends string> = Readonly<Record<string, RecordCommand<S, E>>>;

/** A record's machine and its commands, declared once. */
export interface RecordLifecycle<S extends string, M extends MachineMoves<S>, C extends RecordCommands<S, keyof M & string>> {
  readonly machine: Machine<S, M>;
  readonly commands: C;
}

export function defineRecordLifecycle<S extends string, M extends MachineMoves<S>, const C extends RecordCommands<S, keyof M & string>>(
  machine: Machine<S, M>,
  commands: C,
): RecordLifecycle<S, M, C> {
  return { machine, commands };
}

/** The states a command is taken in: the source states of its moves, or the states it names. */
export function commandSources<S extends string, M extends MachineMoves<S>, C extends RecordCommands<S, keyof M & string>>(
  lifecycle: RecordLifecycle<S, M, C>,
  command: keyof C & string,
): S[] {
  const spec = lifecycle.commands[command]!;
  if ("in" in spec) return [...spec.in];
  return [...new Set(spec.moves.flatMap((event) => lifecycle.machine.moves[event]?.from ?? []))];
}

/** The commands a record in `state` may be sent, in declaration order. */
export function commandsFrom<S extends string, M extends MachineMoves<S>, C extends RecordCommands<S, keyof M & string>>(
  lifecycle: RecordLifecycle<S, M, C>,
  state: string,
): (keyof C & string)[] {
  return (Object.keys(lifecycle.commands) as (keyof C & string)[])
    .filter((command) => (commandSources(lifecycle, command) as string[]).includes(state));
}

/** What a command its record's state refuses answers: where the record is and the commands open from there. */
export function commandRefusal<S extends string, M extends MachineMoves<S>, C extends RecordCommands<S, keyof M & string>>(
  lifecycle: RecordLifecycle<S, M, C>,
  current: string,
  command: keyof C & string,
): MachineRefusal {
  return { reason: "state_conflict", machine: lifecycle.machine.name, current, move: command, allowed: commandsFrom(lifecycle, current) };
}

/** One command as a read lists it: available, or blocked with a stable reason (`status`: the record's state refuses it). */
export interface RecordActionState<R extends string = string> {
  available: boolean;
  /** Null exactly when available. */
  reason: R | "status" | null;
}

/**
 * Every command of the lifecycle for a record in `state`: blocked by the
 * state first, then by the first other reason `blocks` gives for it.
 */
export function recordActions<S extends string, M extends MachineMoves<S>, C extends RecordCommands<S, keyof M & string>, R extends string>(
  lifecycle: RecordLifecycle<S, M, C>,
  state: string,
  blocks: Partial<Record<keyof C & string, R | null | undefined>>,
): Record<keyof C & string, RecordActionState<R>> {
  const open = new Set<string>(commandsFrom(lifecycle, state));
  const actions = {} as Record<keyof C & string, RecordActionState<R>>;
  for (const command of Object.keys(lifecycle.commands) as (keyof C & string)[]) {
    const blocked = open.has(command) ? blocks[command] ?? null : "status";
    actions[command] = blocked === null ? { available: true, reason: null } : { available: false, reason: blocked };
  }
  return actions;
}
