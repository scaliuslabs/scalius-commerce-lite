// Progressive enhancement for the order-code forms. Without JavaScript the
// form posts to its own page and the server renders each step; with it, the
// same form talks to the JSON proxies, keeps what the buyer typed, says where
// the code went, and counts down resend and rate-limit waits. The code field
// appears only once a code was actually sent.
import {
  formatCheckoutLanguageText,
  type CheckoutLanguageData,
} from "@scalius/shared/checkout-language";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import {
  DEFAULT_RESEND_AFTER_SECONDS,
  failureNeedsStoreContact,
  formatCountdown,
  getOrderCodeFailureText,
  positiveSeconds,
} from "@/lib/order-lookup";

export interface OrderCodeFormText {
  verifyCode: string;
  codeSent: string;
  unavailable: string;
  /** Page-specific checks before any request: each bad field's message. */
  validate?: (fields: Record<string, string>) => Record<string, string>;
}

const RECEIPT_REDIRECT = /^\/order-success\?/;

export function enhanceOrderCodeForm(
  form: HTMLFormElement,
  copy: CheckoutLanguageData,
  text: OrderCodeFormText,
): void {
  const submit = form.querySelector<HTMLButtonElement>("[data-order-code-submit]");
  const resend = form.querySelector<HTMLButtonElement>("[data-order-code-resend]");
  const codeStep = form.querySelector<HTMLElement>("[data-order-code-step]");
  const message = form.querySelector<HTMLElement>("[data-order-code-message]");
  const codeInput = form.querySelector<HTMLInputElement>("input[name='code']");
  const orderLine = form.querySelector<HTMLElement>("[data-order-code-order]");
  const storeContact = form.querySelector<HTMLElement>("[data-store-contact]");
  if (!submit || !message) return;

  let codeSent = form.dataset.codeSent === "true";
  const timers = new Map<HTMLElement, number>();
  // Our own inline messages replace the browser's tooltip.
  form.noValidate = true;

  const setMessage = (value: string, tone: "neutral" | "danger" = "neutral") => {
    message.textContent = value;
    message.classList.toggle("text-destructive", tone === "danger");
    message.classList.toggle("text-muted-foreground", tone !== "danger");
  };

  /** One field's message under it (`[data-field-error=name]`), like checkout. */
  const setFieldError = (input: HTMLInputElement, error: string) => {
    const slot = form.querySelector<HTMLElement>(`[data-field-error="${input.name}"]`);
    if (error) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    if (!slot) return;
    slot.textContent = error;
    slot.hidden = !error;
    const describedBy = new Set((input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    if (error) describedBy.add(slot.id);
    else describedBy.delete(slot.id);
    if (describedBy.size > 0) input.setAttribute("aria-describedby", [...describedBy].join(" "));
    else input.removeAttribute("aria-describedby");
  };

  /** Shows every field's message and focuses the first bad field; returns a message with no place of its own. */
  const showFieldErrors = (errors: Record<string, string>): string => {
    let unplaced = "";
    let first: HTMLInputElement | null = null;
    for (const input of form.querySelectorAll<HTMLInputElement>("input[name]")) {
      const error = errors[input.name] ?? "";
      setFieldError(input, error);
      if (!error) continue;
      first ??= input;
      if (!unplaced && !form.querySelector(`[data-field-error="${input.name}"]`)) unplaced = error;
    }
    first?.focus();
    return unplaced;
  };

  form.addEventListener("input", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.getAttribute("aria-invalid") === "true") setFieldError(input, "");
  });

  /** Ticks `render` once a second, then calls `done`; one timer per element. */
  const countdown = (key: HTMLElement, seconds: number, render: (left: number) => void, done: () => void) => {
    window.clearInterval(timers.get(key));
    let left = Math.ceil(seconds);
    render(left);
    timers.set(key, window.setInterval(() => {
      left -= 1;
      if (left > 0) return render(left);
      window.clearInterval(timers.get(key));
      timers.delete(key);
      done();
    }, 1000));
  };

  const waitToResend = (seconds: number) => {
    if (!resend) return;
    resend.disabled = true;
    countdown(
      resend,
      seconds,
      (left) => { resend.textContent = formatCheckoutLanguageText(copy.orderCodeResendInText, { time: formatCountdown(left) }); },
      () => {
        resend.disabled = false;
        resend.textContent = copy.orderCodeSendNewText;
      },
    );
  };

  const allowResendNow = () => {
    if (!resend) return;
    window.clearInterval(timers.get(resend));
    timers.delete(resend);
    resend.disabled = false;
    resend.textContent = copy.orderCodeSendNewText;
  };

  const showCodeStep = () => {
    codeSent = true;
    codeStep?.removeAttribute("hidden");
    resend?.removeAttribute("hidden");
    submit.value = "verify";
    submit.textContent = text.verifyCode;
  };

  const initialWait = positiveSeconds(resend?.dataset.resendAfter);
  if (codeSent && initialWait) waitToResend(initialWait);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const intent = (event.submitter as HTMLButtonElement | null)?.value === "resend"
      ? "resend"
      : codeSent ? "verify" : "send";
    const fields = Object.fromEntries(
      [...new FormData(form)].flatMap(([key, value]) => (typeof value === "string" && key !== "intent" ? [[key, value.trim()]] : [])),
    ) as Record<string, string>;
    const errors = {
      ...text.validate?.(fields),
      ...(intent === "verify" && !fields.code ? { code: copy.paymentRecoveryEnterCodeText } : {}),
    };
    const unplaced = showFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setMessage(unplaced, "danger");
      return;
    }

    const button = intent === "resend" ? resend : submit;
    if (button) button.disabled = true;
    if (storeContact) storeContact.hidden = true;
    setMessage(intent === "verify" ? copy.paymentRecoveryVerifyingCodeText : copy.paymentRecoverySendingCodeText);
    const url = intent === "verify" ? form.dataset.verifyUrl : form.dataset.sendUrl;
    let status = 0;
    let data: Record<string, unknown> = {};
    try {
      const response = await fetch(url ?? "", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(fields),
      });
      status = response.status;
      data = await response.json().catch(() => ({}));
    } catch {
      // Treated as a failed send/verify below.
    }

    if (data.success === true) {
      if (intent === "verify") {
        const redirectUrl = typeof data.redirectUrl === "string" ? data.redirectUrl : "";
        if (RECEIPT_REDIRECT.test(redirectUrl)) {
          window.location.assign(redirectUrl);
          return;
        }
      } else {
        const sentMessage = typeof data.message === "string" && data.message ? data.message : text.codeSent;
        if (button && button !== resend) button.disabled = false;
        // A neutral answer: nothing was sent, so there is no code to enter.
        if (data.sent === false) {
          setMessage(sentMessage);
          return;
        }
        showCodeStep();
        setMessage(sentMessage);
        const orderNumber = orderLine?.querySelector("[data-order-number]");
        if (orderLine && orderNumber && typeof data.orderNumber === "number") {
          orderNumber.textContent = formatOrderNumber(data.orderNumber, "");
          orderLine.hidden = false;
        }
        waitToResend(positiveSeconds(data.resendAfterSeconds) ?? DEFAULT_RESEND_AFTER_SECONDS);
        codeInput?.focus();
        return;
      }
    }

    const failure = {
      status: status || 502,
      message: typeof data.message === "string" ? data.message : undefined,
      retryAfterSeconds: positiveSeconds(data.retryAfterSeconds),
      attemptsLeft: typeof data.attemptsLeft === "number" ? data.attemptsLeft : undefined,
    };
    if (storeContact && failureNeedsStoreContact({ status: failure.status, errorCode: typeof data.errorCode === "string" ? data.errorCode : undefined })) storeContact.hidden = false;
    const operation = intent === "verify" ? "verify" : "send";
    if (failure.status === 429 && failure.retryAfterSeconds && button) {
      countdown(
        button,
        failure.retryAfterSeconds,
        (left) => setMessage(getOrderCodeFailureText(copy, { ...failure, retryAfterSeconds: left }, operation, text.unavailable), "danger"),
        () => {
          button.disabled = false;
          setMessage("");
          if (button === resend) allowResendNow();
        },
      );
      return;
    }
    setMessage(getOrderCodeFailureText(copy, failure, operation, text.unavailable), "danger");
    if (button && (button !== resend || !timers.has(resend))) button.disabled = false;
    if (failure.attemptsLeft === 0) allowResendNow();
  });
}
