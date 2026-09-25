// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA as copy } from "@scalius/shared/checkout-language";
import { getOrderLookupFieldErrors } from "./order-lookup";
import { enhanceOrderCodeForm } from "./order-lookup-form";

function renderForm({ errorSlots = false } = {}) {
  const slot = (name: string) => (errorSlots ? `<p id="${name}Error" data-field-error="${name}" hidden></p>` : "");
  document.body.innerHTML = `
    <form data-order-code-form data-send-url="/api/order-lookup/send-code" data-verify-url="/api/order-lookup/verify">
      <input name="reference" value="#1001" required />${slot("reference")}
      <p data-order-code-order hidden>Order number <span data-order-number></span></p>
      <div data-order-code-step hidden><input name="code" /></div>
      <p data-order-code-message></p>
      <p data-store-contact hidden>Contact the store: 01711-000000</p>
      <button type="submit" name="intent" value="send" data-order-code-submit>Send code</button>
      <button type="submit" name="intent" value="resend" data-order-code-resend hidden>Send a new code</button>
    </form>`;
  const form = document.querySelector<HTMLFormElement>("form")!;
  enhanceOrderCodeForm(form, copy, {
    verifyCode: "View order",
    codeSent: copy.trackOrderCodeSentText,
    unavailable: copy.trackOrderUnavailableText,
    validate: (fields) => getOrderLookupFieldErrors(copy, fields.reference ?? ""),
  });
  const submit = form.querySelector<HTMLButtonElement>("[data-order-code-submit]")!;
  const resend = form.querySelector<HTMLButtonElement>("[data-order-code-resend]")!;
  return {
    form,
    submit,
    resend,
    message: () => form.querySelector("[data-order-code-message]")!.textContent,
    input: (name: string) => form.querySelector<HTMLInputElement>(`input[name='${name}']`)!,
    fieldError: (name: string) => form.querySelector<HTMLElement>(`[data-field-error='${name}']`)!,
    orderLine: () => form.querySelector<HTMLElement>("[data-order-code-order]")!,
    storeContactHidden: () => form.querySelector<HTMLElement>("[data-store-contact]")!.hidden,
    codeStepHidden: () => form.querySelector<HTMLElement>("[data-order-code-step]")!.hidden,
    setCode: (code: string) => { form.querySelector<HTMLInputElement>("input[name='code']")!.value = code; },
  };
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function submitWith(form: HTMLFormElement, button: HTMLButtonElement) {
  form.dispatchEvent(Object.assign(new Event("submit", { cancelable: true }), { submitter: button }));
  for (let index = 0; index < 5; index += 1) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("order code form", () => {
  it("sends the code without a page load, then counts down to a resend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ success: true, resendAfterSeconds: 45 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderForm();

    await submitWith(view.form, view.submit);

    expect(fetchMock).toHaveBeenCalledWith("/api/order-lookup/send-code", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ reference: "#1001", code: "" }),
    }));
    expect(view.codeStepHidden()).toBe(false);
    expect(view.message()).toBe(copy.trackOrderCodeSentText);
    expect(view.submit.textContent).toBe("View order");
    expect(view.resend.hidden).toBe(false);
    expect(view.resend.disabled).toBe(true);
    expect(view.resend.textContent).toBe("Send a new code in 0:45");

    await vi.advanceTimersByTimeAsync(15_000);
    expect(view.resend.textContent).toBe("Send a new code in 0:30");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(view.resend.disabled).toBe(false);
    expect(view.resend.textContent).toBe("Send a new code");
  });

  it("says where the code went and shows the short order number", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({
      success: true, sent: true, message: "We sent a code to 01•••••678.", orderNumber: 1048, resendAfterSeconds: 60,
    })));
    const view = renderForm();

    await submitWith(view.form, view.submit);

    expect(view.message()).toBe("We sent a code to 01•••••678.");
    expect(view.orderLine().hidden).toBe(false);
    expect(view.orderLine().textContent).toBe("Order number #1048");
    expect(view.codeStepHidden()).toBe(false);
  });

  it("shows no code field and no countdown when nothing was sent", async () => {
    const neutral = "If this order still needs an online payment, we've sent a code to the phone number or email saved on it.";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ success: true, sent: false, message: neutral })));
    const view = renderForm();

    await submitWith(view.form, view.submit);

    expect(view.message()).toBe(neutral);
    expect(view.codeStepHidden()).toBe(true);
    expect(view.resend.hidden).toBe(true);
    expect(view.submit.textContent).toBe("Send code");
    expect(view.submit.disabled).toBe(false);
  });

  it("says the order wasn't found, or that it can't be reached and how to contact the store", async () => {
    const notFound = "We couldn't find an order with that number. Check it and try again.";
    const noChannel = "This order has no email address, and this store can't send text messages.";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(reply({ success: false, errorCode: "NOT_FOUND", message: notFound }, 404))
      .mockResolvedValueOnce(reply({ success: false, errorCode: "NO_CODE_CHANNEL", message: noChannel }, 409))
      .mockResolvedValueOnce(reply({ success: false, errorCode: "NOT_FOUND", message: notFound }, 404))
      .mockResolvedValueOnce(reply({ success: false, errorCode: "SERVICE_UNAVAILABLE", message: "Unavailable." }, 503)));
    const view = renderForm();

    await submitWith(view.form, view.submit);
    expect(view.message()).toBe(notFound);
    expect(view.storeContactHidden()).toBe(true);

    await submitWith(view.form, view.submit);
    expect(view.message()).toBe(noChannel);
    expect(view.storeContactHidden()).toBe(false);
    expect(view.codeStepHidden()).toBe(true);
    expect(view.resend.hidden).toBe(true);

    await submitWith(view.form, view.submit);
    expect(view.storeContactHidden()).toBe(true);

    // Codes unavailable: the catalog line, and the store's contact under it.
    await submitWith(view.form, view.submit);
    expect(view.message()).toBe(copy.trackOrderUnavailableText);
    expect(view.message()).not.toMatch(/contact the store/i);
    expect(view.storeContactHidden()).toBe(false);
  });

  it("checks the fields before sending anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const view = renderForm();
    view.input("reference").value = "#ab";

    await submitWith(view.form, view.submit);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.message()).toBe(copy.trackOrderNumberInvalidText);
  });

  it("shows each bad field's message under it and focuses the first, instead of the browser tooltip", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const view = renderForm({ errorSlots: true });
    view.input("reference").value = "";

    await submitWith(view.form, view.submit);

    expect(view.form.noValidate).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    for (const [name, message] of [["reference", copy.trackOrderNumberInvalidText]] as const) {
      expect(view.fieldError(name).hidden).toBe(false);
      expect(view.fieldError(name).textContent).toBe(message);
      expect(view.input(name).getAttribute("aria-invalid")).toBe("true");
      expect(view.input(name).getAttribute("aria-describedby")).toBe(`${name}Error`);
    }
    expect(document.activeElement).toBe(view.input("reference"));
    expect(view.message()).toBe("");

    view.input("reference").value = "#1001";
    view.input("reference").dispatchEvent(new Event("input", { bubbles: true }));
    expect(view.fieldError("reference").hidden).toBe(true);
    expect(view.input("reference").hasAttribute("aria-invalid")).toBe(false);
    expect(view.input("reference").hasAttribute("aria-describedby")).toBe(false);
  });

  it("asks for the code under its field when View order is pressed without one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ success: true, resendAfterSeconds: 60 })));
    const view = renderForm();
    await submitWith(view.form, view.submit);

    await submitWith(view.form, view.submit);

    expect(view.message()).toBe(copy.paymentRecoveryEnterCodeText);
    expect(view.input("code").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(view.input("code"));
  });

  it("says how many attempts are left, and offers a new code when none are", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ success: true, resendAfterSeconds: 60 }))
      .mockResolvedValueOnce(reply({ success: false, errorCode: "VALIDATION_ERROR", attemptsLeft: 1 }, 400))
      .mockResolvedValueOnce(reply({ success: false, errorCode: "VALIDATION_ERROR", attemptsLeft: 0 }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderForm();
    await submitWith(view.form, view.submit);
    view.setCode("111111");

    await submitWith(view.form, view.submit);
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/order-lookup/verify");
    expect(view.message()).toBe("That code isn't right. 1 attempt left.");
    expect(view.resend.disabled).toBe(true);

    await submitWith(view.form, view.submit);
    expect(view.message()).toBe("This code can't be used anymore. Send a new code.");
    expect(view.resend.disabled).toBe(false);
    expect(view.submit.disabled).toBe(false);
  });

  it("opens the code field when a send is rate limited, since the last code still works", async () => {
    // A buyer who reloads the page (or comes back from their inbox) and asks
    // again is refused, but still has the code: it must be enterable.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ success: false, errorCode: "RATE_LIMIT", message: "Too many codes. Enter the latest code we sent.", retryAfterSeconds: 120 }, 429))
      .mockResolvedValueOnce(reply({ success: true, redirectUrl: "/order-success?orderId=JJEHCFQ3C1JJ35GX" }));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const view = renderForm();

    await submitWith(view.form, view.submit);
    expect(view.message()).toBe("Too many codes. Enter the latest code we sent.");
    expect(view.codeStepHidden()).toBe(false);
    expect(view.submit.disabled).toBe(false);
    expect(view.submit.textContent).toBe("View order");
    expect(view.resend.hidden).toBe(false);
    expect(view.resend.disabled).toBe(true);
    expect(view.resend.textContent).toBe("Send a new code in 2:00");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(view.resend.disabled).toBe(false);

    view.setCode("123456");
    await submitWith(view.form, view.submit);
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/order-lookup/verify");
    expect(assign).toHaveBeenCalledWith("/order-success?orderId=JJEHCFQ3C1JJ35GX");
  });

  it("counts a rate-limited resend down on the resend button", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ success: true, resendAfterSeconds: 1 }))
      .mockResolvedValueOnce(reply({ success: false, errorCode: "RATE_LIMIT", message: "Too many codes.", retryAfterSeconds: 120 }, 429));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderForm();
    await submitWith(view.form, view.submit);
    await vi.advanceTimersByTimeAsync(1_000);

    await submitWith(view.form, view.resend);
    expect(view.message()).toBe("Too many codes. Try again in 2:00.");
    expect(view.resend.disabled).toBe(true);
    expect(view.submit.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(view.resend.disabled).toBe(false);
    expect(view.message()).toBe("");
  });

  it("opens the receipt after a correct code, and only the receipt", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ success: true, resendAfterSeconds: 60 }))
      .mockResolvedValueOnce(reply({ success: true, redirectUrl: "https://evil.example/order-success?orderId=1" }))
      .mockResolvedValueOnce(reply({ success: true, redirectUrl: "/order-success?orderId=JJEHCFQ3C1JJ35GX" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderForm();
    await submitWith(view.form, view.submit);
    view.setCode("123456");

    await submitWith(view.form, view.submit);
    expect(assign).not.toHaveBeenCalled();
    expect(view.message()).toBe(copy.paymentRecoveryVerificationFailedText);

    await submitWith(view.form, view.submit);
    expect(assign).toHaveBeenCalledWith("/order-success?orderId=JJEHCFQ3C1JJ35GX");
  });
});
