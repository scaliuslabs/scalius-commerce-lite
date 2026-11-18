// One shape for every state machine: its states, where a record starts,
// where it ends, and each named move from its source states to its target.
// The server writes a state only as a move (the update names the move's
// source states, so a write that lost a race changes nothing), refuses one
// with the moves that are legal instead, and can send those moves with the
// record; the dashboard, the storefront, apps and agents read the same
// declaration instead of keeping a copy of the rule.
//
// A machine is plain data plus pure reads: nothing here throws at import.
// `machineFaults` is the soundness check a test runs over every machine.

export interface MachineMove<S extends string = string> {
  readonly from: readonly S[];
  readonly to: S;
  /** Who may make the move. Absent: whoever the caller already authorised. */
  readonly by?: readonly string[];
}

export type MachineMoves<S extends string = string> = Readonly<Record<string, MachineMove<S> | undefined>>;

export interface MachineSpec<S extends string = string, M extends MachineMoves<S> = MachineMoves<S>> {
  /** What a refusal calls the record ("order", "payment session"). */
  readonly name: string;
  readonly states: readonly S[];
  /** The states a new record may be written in. */
  readonly initial: readonly S[];
  /** The states no move leaves. Declared, so a state added without a way out fails `machineFaults`. */
  readonly final: readonly S[];
  readonly moves: M;
}

export interface Machine<S extends string = string, M extends MachineMoves<S> = MachineMoves<S>> extends MachineSpec<S, M> {
  /** Whether `value` is one of the machine's states. */
  is(value: string): value is S;
  /** Whether `event` moves a record that is in `state` (for `actor`, when the move names who may make it). */
  can(state: string, event: keyof M & string, actor?: string): boolean;
  /** The state after `event`: its target when the source holds, else `state` unchanged. */
  next(state: S, event: keyof M & string): S;
  /** The moves open from `state`, in declaration order. */
  movesFrom(state: string, actor?: string): (keyof M & string)[];
  /** The states one move away from `state`, in declaration order, without `state` itself. */
  targetsFrom(state: string, actor?: string): S[];
  /** Whether one move takes `from` to `to`. A record already in `to` has not moved: false. */
  reaches(from: string, to: string, actor?: string): boolean;
}

/** Any machine, for code that reads one without knowing its states or moves (a refusal, the inventory). */
export interface AnyMachine extends MachineSpec {
  is(value: string): boolean;
  can(state: string, event: string, actor?: string): boolean;
  movesFrom(state: string, actor?: string): string[];
  targetsFrom(state: string, actor?: string): string[];
  reaches(from: string, to: string, actor?: string): boolean;
}

export function defineMachine<S extends string, const M extends MachineMoves<S>>(spec: MachineSpec<S, M>): Machine<S, M> {
  type E = keyof M & string;
  const events = Object.keys(spec.moves) as E[];
  const open = (event: E, state: string, actor?: string): MachineMove<S> | undefined => {
    const move = spec.moves[event];
    if (!move || !(move.from as readonly string[]).includes(state)) return undefined;
    return actor === undefined || move.by === undefined || move.by.includes(actor) ? move : undefined;
  };
  const movesFrom = (state: string, actor?: string) => events.filter((event) => open(event, state, actor));
  const targetsFrom = (state: string, actor?: string) => [
    ...new Set(movesFrom(state, actor).map((event) => spec.moves[event]!.to).filter((to) => to !== state)),
  ];
  return {
    ...spec,
    is: (value): value is S => (spec.states as readonly string[]).includes(value),
    can: (state, event, actor) => open(event, state, actor) !== undefined,
    next: (state, event) => open(event, state)?.to ?? state,
    movesFrom,
    targetsFrom,
    reaches: (from, to, actor) => (targetsFrom(from, actor) as string[]).includes(to),
  };
}

/** What a refused move tells its caller: where the record is and what can be done from there. */
export interface MachineRefusal {
  reason: "state_conflict";
  machine: string;
  current: string;
  move: string;
  allowed: string[];
}

export function machineRefusal(machine: AnyMachine, current: string, move: string, actor?: string): MachineRefusal {
  return { reason: "state_conflict", machine: machine.name, current, move, allowed: machine.movesFrom(current, actor) };
}

/**
 * The moves of a table written as "from this state, these states": one move
 * per target, named after it. For a lifecycle whose callers ask for a state
 * ("mark it shipped") instead of reporting an event. A state nothing moves to
 * has no move.
 */
export function movesByTarget<T extends Readonly<Record<string, readonly (keyof T & string)[]>>>(
  table: T,
): Partial<Record<keyof T & string, MachineMove<keyof T & string>>> {
  type S = keyof T & string;
  const moves: Partial<Record<S, { from: S[]; to: S }>> = {};
  for (const from of Object.keys(table) as S[]) {
    for (const to of table[from]!) (moves[to] ??= { from: [], to }).from.push(from);
  }
  return moves;
}

/**
 * What is wrong with a machine's declaration, in words; empty when it is
 * sound. Sound means: every state named anywhere is declared once; the final
 * states are exactly the ones no move leaves (so no state is stuck by
 * accident); every state can be reached from an initial one; and, when the
 * machine has final states, every state can still reach one.
 */
export function machineFaults(machine: MachineSpec): string[] {
  const faults: string[] = [];
  const states = new Set(machine.states);
  if (states.size !== machine.states.length) faults.push("a state is declared twice");
  const undeclared = (where: string, values: readonly string[]) => {
    for (const value of values) if (!states.has(value)) faults.push(`${where} names "${value}", which is not a state`);
  };
  undeclared("initial", machine.initial);
  undeclared("final", machine.final);
  if (machine.initial.length === 0) faults.push("no initial state");

  const exits = new Map<string, Set<string>>(machine.states.map((state) => [state, new Set<string>()]));
  for (const [event, move] of Object.entries(machine.moves)) {
    if (!move) continue;
    undeclared(`move "${event}"`, [...move.from, move.to]);
    if (move.from.length === 0) faults.push(`move "${event}" has no source state`);
    for (const from of move.from) if (from !== move.to) exits.get(from)?.add(move.to);
  }
  for (const state of machine.states) {
    const leaves = (exits.get(state)?.size ?? 0) > 0;
    const final = machine.final.includes(state);
    if (final && leaves) faults.push(`"${state}" is declared final but a move leaves it`);
    if (!final && !leaves) faults.push(`"${state}" has no way out and is not declared final`);
  }

  const reachableFrom = (starts: readonly string[]) => {
    const seen = new Set(starts.filter((state) => states.has(state)));
    const queue = [...seen];
    for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
      for (const to of exits.get(state) ?? []) {
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    return seen;
  };
  const reachable = reachableFrom(machine.initial);
  for (const state of machine.states) {
    if (!reachable.has(state)) faults.push(`"${state}" cannot be reached from an initial state`);
    if (machine.final.length > 0 && ![...reachableFrom([state])].some((reached) => machine.final.includes(reached))) {
      faults.push(`"${state}" can never reach a final state`);
    }
  }
  return faults;
}
