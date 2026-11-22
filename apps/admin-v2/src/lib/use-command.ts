import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IntentRequestKey } from "./intent-request-key";

/** What a screen says about its command's key: an earlier attempt may have landed, or did. */
export type KeyNotice = "may-have-landed" | "outcome-unknown" | "landed";

/** The callbacks of one call: they run when that call settles, while its screen is still there. */
export interface CommandCallbacks<TData, TInput> {
  onSuccess?: (data: TData, input: TInput) => unknown;
  onError?: (error: Error, input: TInput) => unknown;
  onSettled?: (data: TData | undefined, error: Error | null, input: TInput) => unknown;
}

export interface CommandOptions<TInput, TData> extends CommandCallbacks<TData, TInput> {
  /** Runs as a call is sent (not for a repeat that is dropped). */
  onMutate?: (input: TInput) => unknown;
  /** Sends the request. A server that takes a request key gets `requestKey`; others ignore it. */
  mutationFn: (input: TInput, requestKey: string) => Promise<TData>;
  /**
   * Names a command whose key must outlive the screen that sent it (money,
   * stock): a dialog closed after a lost answer and opened again keeps the
   * key, so the retry replays the request that may have landed.
   */
  name?: string;
  /** What a call acts on (default: its `orderId`, else `id`, else a string input, else the whole command). */
  subject?: (input: NoInfer<TInput>) => string;
  /** Makes a request key (default a UUID). */
  createKey?: () => string;
}

/** A command that takes no input is called with none. */
type InputArgs<TInput, Rest extends unknown[] = []> = undefined extends TInput ? [input?: TInput, ...Rest] : [input: TInput, ...Rest];

export interface Command<TInput, TData> {
  /** Runs the command, unless one for the same subject is running: then nothing is sent and nothing changes. */
  mutate: (...args: InputArgs<TInput, [callbacks?: CommandCallbacks<TData, TInput>]>) => void;
  /** As `mutate`; a repeat while one runs returns the running call. */
  mutateAsync: (...args: InputArgs<TInput>) => Promise<TData>;
  /** A call of this command is running. */
  isPending: boolean;
  /** The subjects with a call running (rows of a list). */
  pending: ReadonlySet<string>;
  /** The last failure, until the next attempt or `reset`. */
  error: Error | null;
  isError: boolean;
  /** The last call succeeded (until the next attempt or `reset`). */
  isSuccess: boolean;
  data: TData | undefined;
  /** What the latest call was sent with. */
  variables: TInput | undefined;
  /**
   * For this subject: an earlier send got no definite answer (`may-have-landed`),
   * or the server refused a different request under its key because the earlier
   * one was recorded (`landed`, until the next send; the failure is not `error`).
   */
  notice: (input: Partial<TInput>) => KeyNotice | null;
  reset: () => void;
  /** The person checked and starts over: ends this subject's key (never while a send of it is out). */
  forget: (input: Partial<TInput>) => void;
  /** A dialog's `onOpenChange` that cannot close it while a call runs. */
  guardClose: (onOpenChange: (open: boolean) => void) => (open: boolean) => void;
}

const WHOLE_COMMAND = "*";

/** What a call acts on unless the command says: its `orderId`, else `id`, else a string input, else the whole command. */
export function subjectOf(input: unknown): string {
  if (typeof input === "string" || typeof input === "number") return String(input);
  const subject = input as { orderId?: unknown; id?: unknown } | null;
  if (typeof subject?.orderId === "string") return subject.orderId;
  if (typeof subject?.id === "string") return subject.id;
  return WHOLE_COMMAND;
}

/** Keys of named commands: they live as long as the tab, so a reopened dialog finds an open one. */
const namedKeys = new Map<string, IntentRequestKey>();

interface CommandState<TInput, TData> {
  pending: ReadonlySet<string>;
  error: Error | null;
  succeeded: boolean;
  data: TData | undefined;
  variables: TInput | undefined;
  /** Bumped when a key's state changes, so `notice` is read again. */
  keysSeen: number;
}

// A callback that throws is reported, never left as an unhandled rejection, and the next still runs.
function report(run: (() => unknown) | undefined): void {
  if (!run) return;
  try {
    const result = run();
    if (result instanceof Promise) result.catch((error: unknown) => globalThis.reportError?.(error));
  } catch (error) {
    globalThis.reportError?.(error);
  }
}

async function settle(run: (() => unknown) | undefined): Promise<void> {
  if (!run) return;
  try {
    await run();
  } catch (error) {
    globalThis.reportError?.(error);
  }
}

/**
 * The one way the dashboard sends a command that writes. Per subject (an
 * order, a record), one call is in flight: a repeat while it runs (a double
 * click before React re-renders the disabled button) sends nothing and
 * leaves no loading state behind, while another subject's call runs. Each
 * call gets the request key of its attempt (`IntentRequestKey`: a key lives
 * until the server settles it, so a retry after a success or a refusal gets a
 * new one, and a key whose outcome is open is never renewed). Each call's own
 * callbacks run when it settles; the command's own run even after the
 * screen is gone, as cache refreshes and toasts must.
 */
export function useCommand<TInput, TData = unknown>(options: CommandOptions<TInput, TData>): Command<TInput, TData> {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const running = useRef(new Map<string, Promise<TData>>());
  const ownKeys = useRef(new Map<string, IntentRequestKey>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [state, setState] = useState<CommandState<TInput, TData>>({
    pending: new Set(), error: null, succeeded: false, data: undefined, variables: undefined, keysSeen: 0,
  });

  const keyHolder = useCallback((subject: string, create: boolean): IntentRequestKey | undefined => {
    const { name, createKey } = latest.current;
    const holders = name ? namedKeys : ownKeys.current;
    const id = name ? `${name}\u0000${subject}` : subject;
    let holder = holders.get(id);
    if (!holder && create) {
      holder = new IntentRequestKey(createKey ? () => createKey() : undefined);
      holders.set(id, holder);
    }
    return holder;
  }, []);

  const start = useCallback((input: TInput, callbacks?: CommandCallbacks<TData, TInput>): Promise<TData> => {
    const subject = (latest.current.subject ?? subjectOf)(input);
    const already = running.current.get(subject);
    if (already) return already;
    report(latest.current.onMutate && (() => latest.current.onMutate!(input)));
    const holder = keyHolder(subject, true)!;
    const requestKey = holder.get();
    const update = (change: (state: CommandState<TInput, TData>) => Partial<CommandState<TInput, TData>>) => {
      if (mounted.current) setState((current) => ({ ...current, ...change(current) }));
    };
    update((current) => ({
      pending: new Set(current.pending).add(subject), error: null, succeeded: false, variables: input,
    }));
    // As React Query does: the command's own callbacks (cache refreshes) finish before
    // the call stops being pending and before the call's own callbacks (close the dialog).
    const finish = async (data: TData | undefined, error: Error | null) => {
      // The earlier request landed: the screen says so through `notice`, not as this call's error.
      const landed = holder.settled(error ?? undefined) === "landed";
      const own = latest.current;
      await settle(error ? own.onError && (() => own.onError!(error, input)) : own.onSuccess && (() => own.onSuccess!(data as TData, input)));
      await settle(own.onSettled && (() => own.onSettled!(data, error, input)));
      running.current.delete(subject);
      update((current) => {
        const pending = new Set(current.pending);
        pending.delete(subject);
        return { pending, keysSeen: current.keysSeen + 1, ...(error ? { error: landed ? null : error } : { data, succeeded: true }) };
      });
      const local = mounted.current ? callbacks : undefined;
      // A screen words its own failures; the earlier request having landed is the notice's to say.
      if (error) {
        if (!landed) report(local?.onError && (() => local.onError!(error, input)));
      } else {
        report(local?.onSuccess && (() => local.onSuccess!(data as TData, input)));
      }
      report(local?.onSettled && (() => local.onSettled!(data, error, input)));
    };
    const call = Promise.resolve()
      .then(() => latest.current.mutationFn(input, requestKey))
      .then(
        async (data) => {
          await finish(data, null);
          return data;
        },
        async (reason: unknown) => {
          const error = reason as Error;
          await finish(undefined, error);
          throw error;
        },
      );
    running.current.set(subject, call);
    return call;
  }, [keyHolder]);

  const mutate = useCallback((...[input, callbacks]: InputArgs<TInput, [callbacks?: CommandCallbacks<TData, TInput>]>) => {
    const subject = (latest.current.subject ?? subjectOf)(input as TInput);
    if (running.current.has(subject)) return;
    // The failure is the command's state (`error`) and its callbacks', never an unhandled rejection.
    start(input as TInput, callbacks).catch(() => undefined);
  }, [start]);

  const mutateAsync = useCallback((...[input]: InputArgs<TInput>) => start(input as TInput), [start]);
  // A clean command stays the same state, so a reset on open renders nothing.
  const reset = useCallback(() => setState((current) =>
    current.error === null && !current.succeeded && current.data === undefined && current.variables === undefined
      ? current
      : { ...current, error: null, succeeded: false, data: undefined, variables: undefined }), []);
  const forget = useCallback((input: Partial<TInput>) => {
    const subject = (latest.current.subject ?? subjectOf)(input as TInput);
    if (running.current.has(subject)) return;
    keyHolder(subject, false)?.clear();
    setState((current) => ({ ...current, error: null, keysSeen: current.keysSeen + 1 }));
  }, [keyHolder]);
  const isPending = state.pending.size > 0;
  // Read from the ref: a close in the same tick as the submit is refused too.
  const guardClose = useCallback(
    (onOpenChange: (open: boolean) => void) => (open: boolean) => {
      if (!open && running.current.size > 0) return;
      onOpenChange(open);
    },
    [],
  );
  const { keysSeen } = state;
  const notice = useCallback((input: Partial<TInput>): KeyNotice | null => {
    void keysSeen;
    const holder = keyHolder((latest.current.subject ?? subjectOf)(input as TInput), false);
    if (holder?.landedEarlier) return "landed";
    if (holder?.outcomeUnknown) return "outcome-unknown";
    return holder?.mayHaveLanded ? "may-have-landed" : null;
  }, [keyHolder, keysSeen]);

  return useMemo(() => ({
    mutate,
    mutateAsync,
    isPending,
    pending: state.pending,
    error: state.error,
    isError: state.error !== null,
    isSuccess: state.succeeded,
    data: state.data,
    variables: state.variables,
    notice,
    reset,
    forget,
    guardClose,
  }), [forget, guardClose, isPending, notice, mutate, mutateAsync, reset, state]);
}
