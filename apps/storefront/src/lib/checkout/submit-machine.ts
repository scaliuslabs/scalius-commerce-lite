// The press of the cart's Place order / Continue to payment and of the
// payment step's Pay, as one declared machine. A press is taken only from a
// state that declares `press`; each wait is a step of `validating` (never a
// re-entered submit); every way out of a press is a move, so no branch can
// forget to give the buyer the button back. One render draws the button,
// the loading overlay and (through the page's view) its controls from the
// state, and one Back/Forward-cache handler returns the machine to idle.
import { defineMachine } from "@scalius/shared/machine";
import { hideCheckoutLoadingOverlay, showCheckoutLoadingOverlay } from "./loading-overlay";

export const SUBMIT_STATES = ["idle", "validating", "handing_off", "placing", "redirecting", "failed", "conflict", "expired"] as const;
export type SubmitStatus = (typeof SUBMIT_STATES)[number];

export const SUBMIT_MACHINE = defineMachine({
  name: "checkout submit",
  states: SUBMIT_STATES,
  initial: ["idle"],
  // A page outlives its press: Back/Forward and a fresh start reset every state.
  final: [],
  moves: {
    press: { from: ["idle", "failed"], to: "validating" },
    // The press waits on something else (the account, the total, the cart): still validating.
    step: { from: ["validating"], to: "validating" },
    // The cart writes the payment step's transfer.
    hand_off: { from: ["validating"], to: "handing_off" },
    // The cart posts a cash order; the payment step asks its method to place it.
    place: { from: ["validating"], to: "placing" },
    // The page leaves: the payment step, a provider, the receipt, an active attempt, or the cart to repair it.
    redirect: { from: ["validating", "handing_off", "placing"], to: "redirecting" },
    // A refusal the page answers by pricing the order again before the buyer may press.
    reprice: { from: ["placing"], to: "validating" },
    fail: { from: ["validating", "handing_off", "placing"], to: "failed" },
    // Another attempt holds this checkout (found at load or by a press).
    conflict: { from: ["idle", "validating", "placing", "failed"], to: "conflict" },
    expire: { from: ["idle", "validating", "placing", "failed"], to: "expired" },
    reset: { from: SUBMIT_STATES, to: "idle" },
  },
});
export type SubmitEvent = keyof typeof SUBMIT_MACHINE.moves & string;

/** What a validating press waits on. */
export type SubmitStep = "start" | "buyer_ui" | "phone" | "account" | "quote" | "cart" | "recovery" | "reprice";

export interface SubmitOverlay {
  title: string;
  message: string;
}

export interface SubmitState {
  readonly status: SubmitStatus;
  readonly step?: SubmitStep;
  /** Why a press failed (the page has said it where it belongs). */
  readonly reason?: string;
  readonly overlay?: SubmitOverlay | null;
}

export interface SubmitView {
  readonly button: HTMLButtonElement | null;
  readonly label: HTMLElement | null;
  /** The button's words in `state`; null: its label (what a press does now). */
  text(state: SubmitState): string | null;
  labelText(): string;
  /** A state that takes a press: the page enables the button or says why not. */
  ready(): void;
  /** After a move: the page's own controls (null `previous`: not a move). */
  moved?(state: SubmitState, previous: SubmitState): void;
  /** After every render, with whether the button shows its label. */
  rendered?(showsLabel: boolean): void;
}

/**
 * How long a press waits on one check before the order (an account, a total,
 * the cart, an app's fields) before it gives the button back. The order
 * request itself is never raced: its own deadlines bound it, and an abandoned
 * request could still place an order.
 */
export const SUBMIT_STEP_LIMIT_MS = 30_000;

/** A check that did not answer within `SUBMIT_STEP_LIMIT_MS`. */
export class SubmitStepTimeout extends Error {}

/** `work`, or a `SubmitStepTimeout` once the step limit passes. */
export function withinStepLimit<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SubmitStepTimeout("A checkout check did not answer.")), SUBMIT_STEP_LIMIT_MS);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Whether a press is under way (the button is held and a second press is refused). */
export const submitBusy = (status: SubmitStatus): boolean =>
  status === "validating" || status === "handing_off" || status === "placing" || status === "redirecting";

/** Draws the button and, on a move, the overlay and the page's controls. */
export function renderSubmit(view: SubmitView, state: SubmitState, previous?: SubmitState): void {
  const text = view.text(state);
  const words = text ?? view.labelText();
  if (view.label && view.label.textContent !== words) view.label.textContent = words;
  if (SUBMIT_MACHINE.can(state.status, "press")) view.ready();
  else if (view.button) view.button.disabled = true;
  if (previous) {
    if (state.overlay && state.overlay !== previous.overlay) showCheckoutLoadingOverlay(state.overlay);
    // Back/Forward and a redirect leave focus where the browser puts it.
    else if (!state.overlay && (previous.overlay || state.status === "idle")) {
      hideCheckoutLoadingOverlay(state.status === "idle" || state.status === "redirecting" ? { restoreFocus: false } : {});
    }
    view.moved?.(state, previous);
  }
  view.rendered?.(text === null);
}

export interface Submit {
  readonly state: SubmitState;
  /** Makes `event` when the current state declares it; false (and nothing drawn) when it does not. */
  move(event: SubmitEvent, detail?: Omit<SubmitState, "status">): boolean;
  /** Draws the current state again (the label or the page's readiness changed). */
  render(): void;
}

export function createSubmit(view: SubmitView): Submit {
  let state: SubmitState = { status: "idle" };
  return {
    get state() {
      return state;
    },
    move(event, detail = {}) {
      if (!SUBMIT_MACHINE.can(state.status, event)) return false;
      const previous = state;
      const status = SUBMIT_MACHINE.next(state.status, event);
      // An overlay stays up while the press is on its way out, unless the move names another (or none).
      const overlay = "overlay" in detail ? detail.overlay : submitBusy(status) && event !== "reprice" ? previous.overlay : null;
      state = { ...detail, status, overlay };
      renderSubmit(view, state, previous);
      return true;
    },
    render: () => renderSubmit(view, state),
  };
}

/**
 * The one Back/Forward-cache handler: a page restored from history resumes,
 * and its resume starts with the machine's `reset` (no press under way).
 */
export function onHistoryRestore(resume: () => unknown, signal?: AbortSignal): void {
  window.addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) void resume();
  }, { signal });
}
