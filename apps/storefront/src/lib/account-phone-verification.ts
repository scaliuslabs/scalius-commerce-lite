// /account: the signed-in buyer's own phone, not yet verified. The buyer proves
// it with two codes, both for this one change: one to how the account signs in
// now (`confirmWith`: its proven email, else its proven phone) and one texted
// to the phone. The server then moves the orders placed with that phone onto
// the account, signs out every session and sets a new cookie, so the page
// reloads. The page never says anything about orders or other people until
// the phone is proven. The server reads the phone from the session: only the
// codes are sent, in a request body, never in a URL.

import { pagePhone } from "@/lib/checkout-text";
import {
  sendPhoneVerificationCode,
  verifyPhone,
  type PhoneCodeConfirmWith,
  type PhoneCodeRefusal,
  type PhoneVerificationPrompt,
} from "@/lib/api/customer-auth";
import { pageWait } from "@/lib/rate-limit-wait";
import { pagePath } from "@/lib/presence-url";
import { pageLanguage } from "@/lib/store-time-zone";
import { storefrontLanguage, type StorefrontLanguage } from "@/lib/storefront-language";
import { buyerApiErrorCopy } from "@/lib/buyer-api-error-copy";

import { accountCopy } from "@/lib/account-copy";

const field = "w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20 aria-[invalid=true]:border-destructive disabled:opacity-50";
const linkButton = "inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline";
/** "Verify your phone number 01712-345678 to add orders you placed with it." (the phone keeps its Latin digits). */
export function phoneVerificationNotice(phone: string): string {
  return accountCopy().phone.notice(pagePhone(phone));
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

/** Where a code went, as the sentences below name it ("your email", "01712-345678"; Bangla in the locative). */
interface CodeTargets {
  email: string;
  phone: string;
  number: (phone: string) => string;
}

interface TwoCodeWords {
  targets: CodeTargets;
  /** "We sent a code to your email and one to 01712-345678." */
  sent: (current: string, number: string) => string;
  /** The label of each code field: "Code sent to your email". */
  codeSentTo: (target: string) => string;
  /** An empty or missing code: "Enter the code we sent to your email." */
  enterCodeSentTo: (target: string) => string;
  codesStillValid: string;
  wrongCode: string;
  expiredCode: string;
  noSignInToConfirm: string;
  phoneOnAnotherAccount: string;
}

const TWO_CODE_WORDS: Readonly<Record<StorefrontLanguage, TwoCodeWords>> = {
  en: {
    targets: { email: "your email", phone: "your current phone", number: (phone) => phone },
    sent: (current, number) => `We sent a code to ${current} and one to ${number}.`,
    codeSentTo: (target) => `Code sent to ${target}`,
    enterCodeSentTo: (target) => `Enter the code we sent to ${target}.`,
    codesStillValid: "The codes we already sent still work. Enter them below.",
    wrongCode: "One of the codes isn't right. Check both codes and try again.",
    expiredCode: "These codes can't be used anymore. Send new codes.",
    noSignInToConfirm: "We can't send a code to how you sign in now. Ask the store to verify your phone for you.",
    phoneOnAnotherAccount: "This phone number is verified on another account. Sign in with it instead.",
  },
  bn: {
    targets: { email: "আপনার ইমেইলে", phone: "আপনার বর্তমান ফোনে", number: (phone) => `${phone} নম্বরে` },
    sent: (current, number) => `${current} একটি কোড এবং ${number} আরেকটি কোড পাঠানো হয়েছে।`,
    codeSentTo: (target) => `${target} পাঠানো কোড`,
    enterCodeSentTo: (target) => `${target} পাঠানো কোডটি লিখুন।`,
    codesStillValid: "আগে পাঠানো কোডগুলো এখনো ব্যবহার করা যাবে। নিচে কোডগুলো লিখুন।",
    wrongCode: "একটি কোড সঠিক নয়। দুটি কোডই দেখে আবার চেষ্টা করুন।",
    expiredCode: "এই কোডগুলো আর ব্যবহার করা যাবে না। নতুন কোড পাঠান।",
    noSignInToConfirm: "আপনি এখন যেভাবে সাইন ইন করেন সেখানে কোড পাঠানো যাচ্ছে না। আপনার ফোন নম্বর যাচাই করে দিতে স্টোরকে বলুন।",
    phoneOnAnotherAccount: "এই ফোন নম্বরটি অন্য একটি অ্যাকাউন্টে যাচাই করা আছে। বরং এই নম্বর দিয়ে সাইন ইন করুন।",
  },
};

function twoCodeWords(): TwoCodeWords {
  return TWO_CODE_WORDS[storefrontLanguage(pageLanguage())];
}

/** "We sent a code to your email and one to 01712-345678." in the page's language. */
export function phoneCodesSentText(confirmWith: PhoneCodeConfirmWith, phone: string): string {
  const words = twoCodeWords();
  return words.sent(words.targets[confirmWith], words.targets.number(pagePhone(phone)));
}

/** A refusal of the phone routes in the page's words; `fallback` (the catalogue's) when it has none of its own. */
export function phoneCodeRefusalText(refusal: PhoneCodeRefusal | undefined, fallback: string, confirmWith: PhoneCodeConfirmWith): string {
  const words = twoCodeWords();
  switch (refusal) {
    case "no_sign_in_to_confirm": return words.noSignInToConfirm;
    case "phone_on_another_account": return words.phoneOnAnotherAccount;
    case "current_sign_in_code_required": return words.enterCodeSentTo(words.targets[confirmWith]);
    case "codes_still_valid": return words.codesStillValid;
    case "wrong_code": return words.wrongCode;
    case "expired_code": return words.expiredCode;
    case "codes_unavailable": return buyerApiErrorCopy(pageLanguage()).codesUnavailable;
    default: return fallback;
  }
}

/** After the phone is proven the session cookie is a new one: the page loads again with it. */
function reloadVerified(): void {
  window.location.assign(pagePath("/account?phone=verified"));
}

export interface PhoneVerificationOptions {
  /**
   * The page's hidden "Contact the store: …" line (StoreContact), or null when
   * the store has no contact. A copy is shown when codes can't be sent, or
   * only the store can verify the phone.
   */
  storeContact?: HTMLElement | null;
}

function codeField(id: string, name: string, statusId: string): { wrap: HTMLDivElement; label: HTMLLabelElement; input: HTMLInputElement } {
  const label = element("label", "mb-1.5 block text-sm font-medium text-foreground");
  label.htmlFor = id;
  const input = element("input", `${field} max-w-48`);
  input.id = id;
  input.name = name;
  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "one-time-code";
  input.required = true;
  input.maxLength = 12;
  input.setAttribute("aria-describedby", statusId);
  input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
  const wrap = element("div", "");
  wrap.append(label, input);
  return { wrap, label, input };
}

function renderNotice(prompt: PhoneVerificationPrompt, options: PhoneVerificationOptions): HTMLElement {
  const words = accountCopy().phone;
  const codeWords = twoCodeWords();
  const VERIFY_LABEL = words.verify;
  const RESEND_LABEL = words.resend;
  const SUBMIT_LABEL = words.submit;
  const notice = element("section", "rounded-xl border border-border bg-card p-4");
  notice.dataset.phoneVerification = "";
  notice.append(element("p", "text-sm text-foreground", phoneVerificationNotice(prompt.phone)));

  const statusId = "phoneVerificationCodeStatus";
  const verify = element("button", `${linkButton} mt-1`, VERIFY_LABEL);
  verify.type = "button";

  const form = element("form", "mt-3 hidden space-y-3");
  form.method = "post";
  form.noValidate = true;
  // The code to how the account signs in now, then the one texted to the phone (the order the sent message names them).
  const current = codeField("phoneVerificationCurrentCode", "currentCode", statusId);
  const proof = codeField("phoneVerificationCode", "code", statusId);
  const phoneTarget = codeWords.targets.number(pagePhone(prompt.phone));
  proof.label.textContent = codeWords.codeSentTo(phoneTarget);
  const actions = element("div", "flex flex-wrap items-center gap-x-4 gap-y-1");
  const submit = element("button", "inline-flex min-h-11 items-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50", SUBMIT_LABEL);
  submit.type = "submit";
  const resend = element("button", linkButton, RESEND_LABEL);
  resend.type = "button";
  actions.append(submit, resend);
  form.append(current.wrap, proof.wrap, actions);

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

  // The account's own phone is unproven, so the account signs in with its proven email:
  // a send refused as too soon (which names no `confirmWith`) still labels that field.
  let confirmWith: PhoneCodeConfirmWith = "email";
  const currentTarget = () => codeWords.targets[confirmWith];

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
      (left) => { resend.textContent = words.resendIn(pageWait(left)); },
      () => { resend.disabled = false; resend.textContent = RESEND_LABEL; },
    );
  };

  const openForm = (message: string, resendAfterSeconds: number) => {
    current.label.textContent = codeWords.codeSentTo(currentTarget());
    say(message);
    verify.hidden = true;
    form.classList.remove("hidden");
    waitToResend(resendAfterSeconds);
    current.input.focus();
  };

  const send = async (trigger: HTMLButtonElement, idleLabel: string) => {
    if (trigger.disabled) return;
    stopWait();
    trigger.disabled = true;
    trigger.textContent = words.sending;
    say("");
    const result = await sendPhoneVerificationCode();
    trigger.textContent = idleLabel;
    if (result.success) {
      confirmWith = result.confirmWith;
      trigger.disabled = false;
      openForm(phoneCodesSentText(confirmWith, prompt.phone), result.resendAfterSeconds);
      return;
    }
    if (result.refusal === "codes_still_valid") {
      // Too soon for new codes: the ones already sent still work.
      trigger.disabled = false;
      openForm(codeWords.codesStillValid, result.retryAfterSeconds ?? 60);
      return;
    }
    const message = phoneCodeRefusalText(result.refusal, result.error, confirmWith);
    if (result.retryAfterSeconds && result.retryAfterSeconds > 0) {
      // Too many codes: say so with the honest wait, and hold the button until it passes.
      stopWait = countdown(
        result.retryAfterSeconds,
        (left) => say(words.tryAgainIn(message, pageWait(left)), "error"),
        () => { trigger.disabled = false; say(""); },
      );
      return;
    }
    trigger.disabled = false;
    say(message, "error");
    // Codes can't be sent, or only the store can verify the phone: the buyer can still reach the store.
    if (contact && (result.refusal === "codes_unavailable" || result.refusal === "no_sign_in_to_confirm")) contact.hidden = false;
  };

  verify.addEventListener("click", () => void send(verify, VERIFY_LABEL));
  resend.addEventListener("click", () => void send(resend, RESEND_LABEL));

  const refuse = (message: string, invalid: HTMLInputElement[]) => {
    for (const input of invalid) input.setAttribute("aria-invalid", "true");
    say(message, "error");
    const first = invalid[0];
    if (first) {
      first.select();
      first.focus();
    }
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const currentCode = current.input.value.replace(/\s+/g, "");
    const code = proof.input.value.replace(/\s+/g, "");
    if (!currentCode) return refuse(codeWords.enterCodeSentTo(currentTarget()), [current.input]);
    if (!code) return refuse(codeWords.enterCodeSentTo(phoneTarget), [proof.input]);
    submit.disabled = true;
    submit.textContent = words.verifying;
    say("");
    const result = await verifyPhone({ code, currentCode });
    if (result.success) {
      stopWait();
      reloadVerified();
      return;
    }
    submit.disabled = false;
    submit.textContent = SUBMIT_LABEL;
    const message = phoneCodeRefusalText(result.refusal, result.error, confirmWith);
    if (result.refusal === "current_sign_in_code_required") return refuse(message, [current.input]);
    if (result.refusal === "wrong_code" || result.refusal === "expired_code") return refuse(message, [current.input, proof.input]);
    say(message, "error");
    if (contact && result.refusal === "no_sign_in_to_confirm") contact.hidden = false;
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
