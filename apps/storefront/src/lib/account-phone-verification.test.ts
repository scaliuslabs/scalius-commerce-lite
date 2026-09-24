// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ sendPhoneVerificationCode: vi.fn(), verifyPhone: vi.fn() }));
vi.mock("./api/customer-auth", () => api);

const { phoneVerificationNotice, renderPhoneVerification } = await import("./account-phone-verification");

const prompt = { phone: "+8801712345678" };
const sent = { success: true, message: "We sent a code to 01•••••678.", resendAfterSeconds: 60 };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let container: HTMLDivElement;
let contactSource: HTMLParagraphElement;
let onVerified: ReturnType<typeof vi.fn<(message: string) => void>>;

beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  contactSource = document.createElement("p");
  contactSource.id = "phoneVerificationContact";
  contactSource.dataset.storeContact = "";
  contactSource.hidden = true;
  contactSource.innerHTML = `Contact the store: <a href="tel:+8801711000000">01711-000000</a> · <a href="https://wa.me/8801711000000">WhatsApp</a>`;
  document.body.append(container, contactSource);
  onVerified = vi.fn();
});

afterEach(() => {
  renderPhoneVerification(container, null, { onVerified });
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function show(storeContact: HTMLElement | null = contactSource) {
  renderPhoneVerification(container, prompt, { onVerified, storeContact });
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent?.startsWith(label));
const status = () => container.querySelector("[role=status]")?.textContent ?? "";
const form = () => container.querySelector("form")!;
const input = () => container.querySelector<HTMLInputElement>("input[name=code]")!;
const contact = () => container.querySelector<HTMLElement>("[data-store-contact]");

describe("verifying the account's own phone", () => {
  it("names only the buyer's own phone, formatted, and nothing about orders counts or other people", () => {
    expect(phoneVerificationNotice("+8801712345678")).toBe(
      "Verify your phone number 01712-345678 to add orders you placed with it.",
    );
    show();

    expect(container.classList.contains("hidden")).toBe(false);
    expect(container.textContent).toContain("Verify your phone number 01712-345678 to add orders you placed with it.");
    expect(container.textContent).not.toMatch(/more order|•|contact the store to add/i);
    expect(button("Verify phone")).toBeDefined();
    expect(form().classList.contains("hidden")).toBe(true);
  });

  it("shows nothing when the API doesn't ask for it", () => {
    show();
    renderPhoneVerification(container, null, { onVerified });

    expect(container.classList.contains("hidden")).toBe(true);
    expect(container.textContent).toBe("");
  });

  it("sends a code, then shows the code field focused with the server's message", async () => {
    api.sendPhoneVerificationCode.mockResolvedValue(sent);
    show();

    button("Verify phone")!.click();
    await flush();

    expect(api.sendPhoneVerificationCode).toHaveBeenCalledWith();
    expect(status()).toBe("We sent a code to 01•••••678.");
    expect(form().classList.contains("hidden")).toBe(false);
    expect(button("Verify phone")?.hidden).toBe(true);
    expect(document.activeElement).toBe(input());
    expect(input().inputMode).toBe("numeric");
    expect(input().getAttribute("autocomplete")).toBe("one-time-code");
    expect(button("Send a new code in")?.textContent).toBe("Send a new code in 1:00");
    expect(button("Send a new code in")?.disabled).toBe(true);
    expect(form().getAttribute("action")).toBeNull();
    expect(contact()?.hidden).toBe(true);
  });

  it("shows the unavailable message with the store's contact links and keeps the code field closed", async () => {
    const message = "Text message codes aren't available right now.";
    api.sendPhoneVerificationCode.mockResolvedValue({ success: false, status: 503, error: message });
    show();

    button("Verify phone")!.click();
    await flush();

    expect(status()).toBe(message);
    expect(contact()?.hidden).toBe(false);
    expect(contact()?.querySelector("a[href='https://wa.me/8801711000000']")).not.toBeNull();
    expect(contact()?.id).toBe("");
    expect(contactSource.hidden).toBe(true);
    expect(form().classList.contains("hidden")).toBe(true);
    expect(button("Verify phone")?.disabled).toBe(false);
  });

  it("shows the unavailable message alone when the store has no contact", async () => {
    api.sendPhoneVerificationCode.mockResolvedValue({ success: false, status: 503, error: "Text message codes aren't available right now." });
    show(null);

    button("Verify phone")!.click();
    await flush();

    expect(status()).toBe("Text message codes aren't available right now.");
    expect(contact()).toBeNull();
  });

  it("holds the button through a rate-limit wait and counts it down", async () => {
    vi.useFakeTimers();
    api.sendPhoneVerificationCode.mockResolvedValue({ success: false, status: 429, error: "Too many codes.", retryAfterSeconds: 61 });
    show();

    button("Verify phone")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(status()).toBe("Too many codes. Try again in 1:01.");
    expect(button("Verify phone")?.disabled).toBe(true);
    expect(contact()?.hidden).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);
    expect(status()).toBe("Too many codes. Try again in 0:59.");

    await vi.advanceTimersByTimeAsync(59_000);
    expect(status()).toBe("");
    expect(button("Verify phone")?.disabled).toBe(false);
  });

  it("verifies with the code alone and hands the server's message to the reload", async () => {
    api.sendPhoneVerificationCode.mockResolvedValue(sent);
    api.verifyPhone.mockResolvedValue({ success: true, movedOrders: 1, message: "Your phone number is verified. 1 order was added to your account." });
    show();
    button("Verify phone")!.click();
    await flush();

    input().value = " 123 456 ";
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(api.verifyPhone).toHaveBeenCalledWith("123456");
    expect(onVerified).toHaveBeenCalledWith("Your phone number is verified. 1 order was added to your account.");
  });

  it.each([
    [400, "That code isn't right. 4 attempts left."],
    [409, "This phone number is verified on another account. Sign in with it instead."],
  ])("keeps the code field open on a %i and says why", async (code, message) => {
    api.sendPhoneVerificationCode.mockResolvedValue(sent);
    api.verifyPhone.mockResolvedValue({ success: false, status: code, error: message });
    show();
    button("Verify phone")!.click();
    await flush();

    input().value = "000000";
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(status()).toBe(message);
    expect(input().getAttribute("aria-invalid")).toBe("true");
    const submit = form().querySelector<HTMLButtonElement>("button[type=submit]")!;
    expect(submit.textContent).toBe("Verify");
    expect(submit.disabled).toBe(false);
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("asks for the code instead of sending an empty one", async () => {
    api.sendPhoneVerificationCode.mockResolvedValue(sent);
    show();
    button("Verify phone")!.click();
    await flush();

    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(api.verifyPhone).not.toHaveBeenCalled();
    expect(status()).toBe("Enter the code we sent.");
  });
});
