// /account: the signed-in buyer's own phone, not yet verified. The buyer proves
// it with a texted code; the server then moves the orders placed with that
// phone onto the account. The page never says anything about orders or other
// people until the phone is proven. The server reads the phone from the
// session: only the code is sent, in a request body, never in a URL.

import {
  sendPhoneVerificationCode,
  verifyPhone,
  type PhoneVerificationPrompt,
} from "@/lib/api/customer-auth";
import { formatWait } from "@/lib/customer-auth-ui";
import { formatBdMobile } from "@scalius/shared/phone-input";

const field = "w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20 aria-[invalid=true]:border-destructive disabled:opacity-50";
const linkButton = "inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline";
const VERIFY_LABEL = "Verify phone";
const RESEND_LABEL = "Send a new code";
const SUBMIT_LABEL = "Verify";

/** "Verify your phone number 01712-345678 to add orders you placed with it." */
export function phoneVerificationNotice(phone: string): string {
  return `Verify your phone number ${formatBdMobile(phone)} to add orders you placed with it.`;
}

/** Countdowns of the notice on screen; a re-render stops the old ones. */
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

export interface PhoneVerificationOptions {
  /** Runs with the server's message once the phone is verified; reloads the orders. */
  onVerified: (message: string) => void | Promise<void>;
  /**
   * The page's hidden "Contact the store: …" line (StoreContact), or null when
   * the store has no contact. A copy is shown when codes can't be sent.
   */
  storeContact?: HTMLElement | null;
}

function renderNotice(prompt: PhoneVerificationPrompt, options: PhoneVerificationOptions): HTMLElement {
  const notice = element("section", "rounded-xl border border-border bg-card p-4");
  notice.dataset.phoneVerification = "";
  notice.append(element("p", "text-sm text-foreground", phoneVerificationNotice(prompt.phone)));

  const statusId = "phoneVerificationCodeStatus";
  const codeId = "phoneVerificationCode";
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

  const contact = options.storeContact ? (options.storeContact.cloneNode(true) as HTMLElement) : null;
  if (contact) {
    contact.removeAttribute("id");
    contact.hidden = true;
    contact.classList.add("mt-1");
    notice.append(contact);
  }

  const say = (message: string, tone: "info" | "error" = "info") => {
    status.textContent = message;
    status.className = `mt-2 text-sm empty:hidden ${tone === "error" ? "text-destructive" : "text-muted-foreground"}`;
    if (contact) contact.hidden = true;
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
    const result = await sendPhoneVerificationCode();
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
    // Codes can't be sent right now: the buyer can still reach the store.
    if (contact && result.status === 503) contact.hidden = false;
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
    submit.textContent = "Verifying…";
    say("");
    const result = await verifyPhone(code);
    if (result.success) {
      stopWait();
      await options.onVerified(result.message);
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

/** The notice above the order list when the API asks for it; null clears it. */
export function renderPhoneVerification(
  container: HTMLElement,
  prompt: PhoneVerificationPrompt | null | undefined,
  options: PhoneVerificationOptions,
): void {
  stopTimers();
  container.replaceChildren(...(prompt ? [renderNotice(prompt, options)] : []));
  container.classList.toggle("hidden", !prompt);
}
