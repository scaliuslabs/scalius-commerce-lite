// /account: orders placed with a phone the signed-in buyer hasn't verified yet.
// The buyer proves the phone with a texted code and the orders move to the
// account. Only the opaque guest-record id and the code go to the server, in
// request bodies and paths, never in page URLs; the page only ever sees the
// masked phone.

import {
  sendGuestOrdersCode,
  verifyGuestOrders,
  type UnclaimedGuestOrders,
} from "@/lib/api/customer-auth";
import { formatWait } from "@/lib/customer-auth-ui";

const field = "w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20 aria-[invalid=true]:border-destructive disabled:opacity-50";
const linkButton = "inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline";
const VERIFY_LABEL = "Verify this phone";
const RESEND_LABEL = "Send a new code";
const SUBMIT_LABEL = "Add orders";

/** "1 more order was placed with 01•••••011. Verify this phone to add it." */
export function guestOrdersNotice(entry: Pick<UnclaimedGuestOrders, "destination" | "orderCount" | "canVerify">): string {
  const one = entry.orderCount === 1;
  const placed = one
    ? `1 more order was placed with ${entry.destination}.`
    : `${entry.orderCount} more orders were placed with ${entry.destination}.`;
  const next = entry.canVerify
    ? `Verify this phone to add ${one ? "it" : "them"}.`
    : `Contact the store to add ${one ? "it" : "them"} to your account.`;
  return `${placed} ${next}`;
}

/** Countdowns of the notices on screen; a re-render stops the old ones. */
const timers = new Set<number>();

function stopTimers(): void {
  for (const timer of timers) window.clearInterval(timer);
  timers.clear();
}

/** Calls `render(left)` now and once a second, then `done()`. Returns a stop function. */
function countdown(seconds: number, render: (left: number) => void, done: () => void): () => void {
  let left = Math.max(0, Math.ceil(seconds));
  if (left <= 0) {
    done();
    return () => undefined;
  }
  render(left);
  const timer = window.setInterval(() => {
    left -= 1;
    if (left > 0) return render(left);
    stop();
    done();
  }, 1000);
  timers.add(timer);
  function stop() {
    window.clearInterval(timer);
    timers.delete(timer);
  }
  return stop;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface GuestOrderNoticeOptions {
  /** Runs after a phone is verified with the server's message; reloads the orders. */
  onClaimed: (message: string) => void | Promise<void>;
}

function renderNotice(entry: UnclaimedGuestOrders, index: number, options: GuestOrderNoticeOptions): HTMLElement {
  const notice = element("section", "rounded-xl border border-border bg-card p-4");
  notice.dataset.guestOrders = "";
  const text = element("p", "text-sm text-foreground", guestOrdersNotice(entry));
  notice.append(text);
  if (!entry.canVerify) return notice;

  const statusId = `guestOrdersStatus-${index}`;
  const codeId = `guestOrdersCode-${index}`;
  const verify = element("button", `${linkButton} mt-1`, VERIFY_LABEL);
  verify.type = "button";

  const form = element("form", "mt-3 hidden space-y-3");
  form.method = "post";
  form.noValidate = true;
  const label = element("label", "mb-1.5 block text-sm font-medium text-foreground", "Code");
  label.htmlFor = codeId;
  const input = element("input", `${field} max-w-48`);
  input.id = codeId;
  input.name = "code";
  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "one-time-code";
  input.required = true;
  input.maxLength = 10;
  input.setAttribute("aria-describedby", statusId);
  const actions = element("div", "flex flex-wrap items-center gap-x-4 gap-y-1");
  const submit = element("button", "inline-flex min-h-11 items-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50", SUBMIT_LABEL);
  submit.type = "submit";
  const resend = element("button", linkButton, RESEND_LABEL);
  resend.type = "button";
  const inputWrap = element("div", "");
  inputWrap.append(label, input);
  actions.append(submit, resend);
  form.append(inputWrap, actions);

  const status = element("p", "mt-2 text-sm text-muted-foreground empty:hidden");
  status.id = statusId;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  notice.append(verify, form, status);

  const say = (message: string, tone: "info" | "error" = "info") => {
    status.textContent = message;
    status.className = `mt-2 text-sm empty:hidden ${tone === "error" ? "text-destructive" : "text-muted-foreground"}`;
  };
  /** Stops a running "Try again in" wait. */
  let stopWait: () => void = () => undefined;

  const waitToResend = (seconds: number) => {
    resend.disabled = true;
    countdown(
      seconds,
      (left) => { resend.textContent = `${RESEND_LABEL} in ${formatWait(left)}`; },
      () => { resend.disabled = false; resend.textContent = RESEND_LABEL; },
    );
  };

  const send = async (trigger: HTMLButtonElement, idleLabel: string) => {
    if (trigger.disabled) return;
    stopWait();
    trigger.disabled = true;
    trigger.textContent = "Sending…";
    say("");
    const result = await sendGuestOrdersCode(entry.id);
    trigger.textContent = idleLabel;
    if (result.success) {
      say(result.message);
      verify.hidden = true;
      form.classList.remove("hidden");
      trigger.disabled = false;
      waitToResend(result.resendAfterSeconds);
      input.focus();
      return;
    }
    if (result.retryAfterSeconds && result.retryAfterSeconds > 0) {
      // Too many codes: say so with the honest wait, and hold the button until it passes.
      stopWait = countdown(
        result.retryAfterSeconds,
        (left) => say(`${result.error} Try again in ${formatWait(left)}.`, "error"),
        () => { trigger.disabled = false; say(""); },
      );
      return;
    }
    trigger.disabled = false;
    say(result.error, "error");
  };

  verify.addEventListener("click", () => void send(verify, VERIFY_LABEL));
  resend.addEventListener("click", () => void send(resend, RESEND_LABEL));
  input.addEventListener("input", () => input.removeAttribute("aria-invalid"));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const code = input.value.replace(/\s+/g, "");
    if (!code) {
      input.setAttribute("aria-invalid", "true");
      say("Enter the code we sent.", "error");
      input.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = "Adding…";
    say("");
    const result = await verifyGuestOrders(entry.id, code);
    if (result.success) {
      stopWait();
      await options.onClaimed(result.message);
      return;
    }
    submit.disabled = false;
    submit.textContent = SUBMIT_LABEL;
    input.setAttribute("aria-invalid", "true");
    say(result.error, "error");
    input.select();
    input.focus();
  });

  return notice;
}

/** One notice per guest record, above the order list; an empty list clears them. */
export function renderGuestOrderNotices(
  container: HTMLElement,
  entries: UnclaimedGuestOrders[],
  options: GuestOrderNoticeOptions,
): void {
  stopTimers();
  container.replaceChildren(...entries.map((entry, index) => renderNotice(entry, index, options)));
  container.classList.toggle("hidden", entries.length === 0);
}
