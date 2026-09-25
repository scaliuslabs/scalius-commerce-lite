// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutConfig } from "@/lib/api/checkout";

const mocks = vi.hoisted(() => ({
  sendCustomerOtp: vi.fn(),
  verifyCustomerOtp: vi.fn(),
  getCustomerSession: vi.fn(),
  logoutCustomer: vi.fn(),
}));
vi.mock("@/lib/api/customer-auth", () => mocks);
vi.mock("@/lib/api/transport", () => ({ createApiUrl: (path: string) => `/api/v1${path}` }));

import AuthModal from "./AuthModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const customer = { customerId: "customer_1", name: "Rahim", email: "rahim@example.test", phone: "+8801712345678" };
let root: Root;
let host: HTMLDivElement;

async function type(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submit = () => act(async () => host.querySelector("form")!.requestSubmit());
const title = () => host.querySelector("h2")?.textContent;
const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? "";

async function open(detail?: object) {
  await act(async () => root.render(<AuthModal />));
  await act(async () => window.dispatchEvent(new CustomEvent("open-auth-modal", { detail })));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  window.__CHECKOUT_CONFIG__ = { authVerificationMethod: "email", allowedCountries: ["BD"] } as CheckoutConfig;
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  delete window.__CHECKOUT_CONFIG__;
  delete window.__scaliusAuthModalOpenPending;
  delete window.__scaliusAuthModalDetailPending;
  vi.useRealTimers();
});

describe("sign-in dialog", () => {
  it("signs a returning buyer in with one flow, without putting contacts in the form's fields", async () => {
    mocks.sendCustomerOtp.mockResolvedValue({ success: true, resendAfterSeconds: 60 });
    mocks.verifyCustomerOtp.mockResolvedValue({ success: true, status: "signed_in", customer, isNewUser: false });
    const onLogin = vi.fn();
    window.addEventListener("customer-login", onLogin);
    await open();

    expect(title()).toBe("Sign in");
    await vi.waitFor(() => expect(document.activeElement?.id).toBe("auth-contact"));
    const form = host.querySelector("form")!;
    expect(form.method).toBe("post");
    expect(form.querySelector("input[name]")).toBeNull();

    await type("#auth-contact", "Rahim@Example.test");
    await act(async () => { form.requestSubmit(); form.requestSubmit(); });
    expect(mocks.sendCustomerOtp).toHaveBeenCalledTimes(1);
    expect(mocks.sendCustomerOtp).toHaveBeenCalledWith({ method: "email", channel: "email", identifier: "rahim@example.test" });
    expect(host.textContent).toContain("Send a new code in 1:00");

    await type("#customer-otp", "123456");
    await submit();
    expect(mocks.verifyCustomerOtp).toHaveBeenCalledWith(expect.not.objectContaining({ account: expect.anything() }));
    expect(title()).toBe("You're signed in");
    expect(onLogin).toHaveBeenCalledTimes(1);
    window.removeEventListener("customer-login", onLogin);
  });

  it("asks a new buyer for their name and phone after the code, prefilled from the order", async () => {
    mocks.sendCustomerOtp.mockResolvedValue({ success: true, resendAfterSeconds: 60 });
    mocks.verifyCustomerOtp
      .mockResolvedValueOnce({ success: true, status: "needs_account_details", suggestion: null })
      .mockResolvedValueOnce({ success: true, status: "signed_in", customer, isNewUser: true });
    await open({ prefill: { name: "Rahim Uddin", email: "rahim@example.test", phone: "+8801712345678" } });

    expect(host.querySelector<HTMLInputElement>("#auth-contact")?.value).toBe("rahim@example.test");
    await submit();
    await type("#customer-otp", "123456");
    await submit();

    expect(title()).toBe("Create your account");
    expect(host.querySelector<HTMLInputElement>("#auth-name")?.value).toBe("Rahim Uddin");
    expect(host.querySelector<HTMLInputElement>("#auth-phone")?.value).toBe("01712-345678");
    await type("#auth-name", "");
    await type("#auth-phone", "");
    await submit();
    expect(host.querySelector("#auth-name-error")?.textContent).toBe("Enter your name.");
    expect(host.querySelector("#auth-phone-error")?.textContent).toBe("Enter your phone number.");
    expect(document.activeElement?.id).toBe("auth-name");
    await type("#auth-name", "Rahim Uddin");
    expect(host.querySelector("#auth-name-error")).toBeNull();
    expect(host.querySelector("#auth-phone-error")).not.toBeNull();
    await type("#auth-phone", "01712-345678");
    await submit();
    expect(mocks.verifyCustomerOtp).toHaveBeenLastCalledWith(expect.objectContaining({
      code: "123456",
      account: { name: "Rahim Uddin", phone: "+8801712345678", saveOrderAddress: false },
    }));
    expect(title()).toBe("You're signed in");
  });

  it("fills a new buyer's details from their latest order and offers to save its address", async () => {
    mocks.sendCustomerOtp.mockResolvedValue({ success: true, resendAfterSeconds: 60 });
    mocks.verifyCustomerOtp
      .mockResolvedValueOnce({
        success: true,
        status: "needs_account_details",
        suggestion: {
          name: "R2-SJ Test", phone: "+8801712345678", email: "r2-sj@example.test",
          address: { orderNumber: 1057, text: "House 1, Road 2, Mirpur, Dhaka" },
        },
      })
      .mockResolvedValueOnce({ success: true, status: "signed_in", customer, isNewUser: true });
    await open();
    await type("#auth-contact", "r2-sj@example.test");
    await submit();
    await type("#customer-otp", "123456");
    await submit();

    expect(title()).toBe("Create your account");
    expect(host.querySelector<HTMLInputElement>("#auth-name")?.value).toBe("R2-SJ Test");
    expect(host.querySelector<HTMLInputElement>("#auth-phone")?.value).toBe("01712-345678");
    const save = host.querySelector<HTMLInputElement>("#auth-save-address")!;
    expect(save.checked).toBe(true);
    expect(save.closest("label")?.textContent).toBe("Save the delivery address from order #1057House 1, Road 2, Mirpur, Dhaka");

    await act(async () => save.click());
    expect(save.checked).toBe(false);
    await submit();
    expect(mocks.verifyCustomerOtp).toHaveBeenLastCalledWith(expect.objectContaining({
      account: { name: "R2-SJ Test", phone: "+8801712345678", saveOrderAddress: false },
    }));
    expect(JSON.stringify(mocks.verifyCustomerOtp.mock.lastCall)).not.toContain("Road 2");
  });

  it("keeps what the buyer already typed and says 'your last order' without an order number", async () => {
    mocks.sendCustomerOtp.mockResolvedValue({ success: true, resendAfterSeconds: 60 });
    mocks.verifyCustomerOtp
      .mockResolvedValueOnce({
        success: true,
        status: "needs_account_details",
        suggestion: { name: "Old Name", phone: "+8801799999999", email: null, address: { orderNumber: null, text: "House 9, Uttara, Dhaka" } },
      })
      .mockResolvedValueOnce({ success: true, status: "signed_in", customer, isNewUser: true });
    await open({ prefill: { name: "Rahim Uddin", email: "rahim@example.test", phone: "+8801712345678" } });
    await submit();
    await type("#customer-otp", "123456");
    await submit();

    expect(host.querySelector<HTMLInputElement>("#auth-name")?.value).toBe("Rahim Uddin");
    expect(host.querySelector<HTMLInputElement>("#auth-phone")?.value).toBe("01712-345678");
    expect(host.querySelector("#auth-save-address")?.closest("label")?.textContent)
      .toBe("Save the delivery address from your last orderHouse 9, Uttara, Dhaka");
    await submit();
    expect(mocks.verifyCustomerOtp).toHaveBeenLastCalledWith(expect.objectContaining({
      account: { name: "Rahim Uddin", phone: "+8801712345678", saveOrderAddress: true },
    }));
  });

  it("shows attempts left, and after a lockout disables Continue and offers a new code at once", async () => {
    mocks.sendCustomerOtp.mockResolvedValue({ success: true, resendAfterSeconds: 60 });
    mocks.verifyCustomerOtp
      .mockResolvedValueOnce({ success: false, error: "That code isn't right. Check it and try again.", attemptsLeft: 1 })
      .mockResolvedValueOnce({ success: false, error: "Too many wrong codes. Send a new code to try again.", attemptsLeft: 0 });
    await open();
    await type("#auth-contact", "rahim@example.test");
    await submit();
    await type("#customer-otp", "111111");
    await submit();
    expect(alertText()).toBe("That code isn't right. Check it and try again. 1 attempt left.");

    await submit();
    const continueButton = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(continueButton.disabled).toBe(true);
    const resend = [...host.querySelectorAll("button")].find((button) => button.textContent === "Send a new code")!;
    expect(resend.disabled).toBe(false);
  });

  it("moves focus to the page's main heading after signing in, not to the body", async () => {
    mocks.sendCustomerOtp.mockResolvedValue({ success: true, resendAfterSeconds: 60 });
    mocks.verifyCustomerOtp.mockResolvedValue({ success: true, status: "signed_in", customer, isNewUser: false });
    const page = document.createElement("main");
    page.innerHTML = `<div id="signedOut"><h1>Sign in to see your orders</h1><button id="opener">Sign in</button></div><div id="signedIn" class="hidden"><h1>Account</h1></div>`;
    document.body.prepend(page);
    // The account page swaps its signed-out prompt for the account on sign-in.
    const onLogin = () => {
      page.querySelector("#signedOut")!.classList.add("hidden");
      page.querySelector("#signedIn")!.classList.remove("hidden");
    };
    window.addEventListener("customer-login", onLogin);
    page.querySelector<HTMLButtonElement>("#opener")!.focus();

    await open();
    await type("#auth-contact", "rahim@example.test");
    await submit();
    await type("#customer-otp", "123456");
    await submit();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_600); });
    window.removeEventListener("customer-login", onLogin);

    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Account"));
    expect(document.activeElement?.tagName).toBe("H1");
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });

  it("returns focus to the opener when the dialog closes without a sign-in", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Account";
    document.body.prepend(opener);
    opener.focus();
    await open();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());

    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("counts down an honest wait when codes are rate limited, never mentioning IP", async () => {
    mocks.sendCustomerOtp.mockResolvedValue({ success: false, error: "Too many codes.", retryAfterSeconds: 120 });
    await open();
    await type("#auth-contact", "rahim@example.test");
    await submit();
    expect(alertText()).toBe("Too many codes. Try again in 2:00.");
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(alertText()).toContain("Try again in 1:59.");
  });

  it("returns to the code already sent when the contact's code limit is reached", async () => {
    mocks.sendCustomerOtp
      .mockResolvedValueOnce({ success: true, resendAfterSeconds: 60 })
      .mockResolvedValueOnce({ success: false, error: "Too many codes. Enter the latest code we sent.", retryAfterSeconds: 1800 });
    await open();
    await type("#auth-contact", "rahim@example.test");
    await submit();
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Use a different email")!.click());
    expect(title()).toBe("Sign in");
    await submit();
    expect(host.querySelector("#customer-otp")).not.toBeNull();
    // The wait shows once, on the resend button, not again in the alert.
    expect(alertText()).toBe("Too many codes. Enter the latest code we sent.");
    expect(host.textContent).toContain("Send a new code in 30:00");
    expect(host.textContent?.match(/\d+:\d\d/g)).toEqual(["30:00"]);
  });

  it("shows a rate-limited resend's wait once, on the resend button", async () => {
    mocks.sendCustomerOtp
      .mockResolvedValueOnce({ success: true, resendAfterSeconds: 0 })
      .mockResolvedValueOnce({ success: false, error: "Too many codes.", retryAfterSeconds: 52 });
    await open();
    await type("#auth-contact", "rahim@example.test");
    await submit();
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Send a new code")!.click());

    expect(alertText()).toBe("Too many codes.");
    expect(host.textContent).toContain("Send a new code in 0:52");
    expect(host.textContent).not.toContain("Try again in");
  });

  it("reopens on the new-account step with the accepted code instead of asking for a new one", async () => {
    mocks.sendCustomerOtp.mockResolvedValue({ success: true, resendAfterSeconds: 60 });
    mocks.verifyCustomerOtp
      .mockResolvedValueOnce({ success: true, status: "needs_account_details", suggestion: null })
      .mockResolvedValueOnce({ success: true, status: "signed_in", customer, isNewUser: true });
    await open();
    await type("#auth-contact", "rahim@example.test");
    await submit();
    await type("#customer-otp", "123456");
    await submit();
    expect(title()).toBe("Create your account");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    await act(async () => window.dispatchEvent(new CustomEvent("open-auth-modal")));

    expect(title()).toBe("Create your account");
    await type("#auth-name", "Rahim");
    await type("#auth-phone", "01712345678");
    await submit();
    expect(mocks.sendCustomerOtp).toHaveBeenCalledTimes(1);
    expect(mocks.verifyCustomerOtp).toHaveBeenLastCalledWith(expect.objectContaining({
      identifier: "rahim@example.test", code: "123456", account: { name: "Rahim", phone: "+8801712345678", saveOrderAddress: false },
    }));
    expect(title()).toBe("You're signed in");
  });

  it("opened from a receipt, offers no guest tracking link and no fixed country prefix", async () => {
    await open({ prefill: { email: "rahim@example.test" }, source: "receipt" });
    expect(title()).toBe("Sign in");
    expect(host.textContent).not.toContain("Track your order");
    expect(host.textContent).not.toContain("+880");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    await act(async () => window.dispatchEvent(new CustomEvent("open-auth-modal")));
    expect(host.querySelector('a[href="/track-order"]')?.textContent).toBe("Track your order");
  });

  it.each([
    [["email"], true],
    [["email", "sms"], false],
    [["email", "whatsapp"], false],
    [["sms"], false],
  ])("with sign-in channels %j, says phone sign-in isn't available: %s", async (otpChannels, noted) => {
    window.__CHECKOUT_CONFIG__ = {
      authVerificationMethod: "email",
      allowedCountries: ["BD"],
      customerAuthPolicy: { otpChannels, defaultOtpChannel: otpChannels[0], requiredContactFields: [], optionalContactFields: [] },
    } as unknown as CheckoutConfig;
    await open();

    const note = host.querySelector("[data-phone-sign-in-note]");
    expect(Boolean(note)).toBe(noted);
    if (noted) expect(note?.textContent?.trim()).toBe("Phone sign-in isn't available yet. Use your email.");
  });

  it("closes on Esc and the close button, and shows the signed-in state on reopen", async () => {
    document.cookie = "cs_auth=1; path=/";
    mocks.getCustomerSession.mockResolvedValue({ authenticated: true, customer });
    await open();
    await vi.waitFor(() => expect(title()).toBe("You're signed in"));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => window.dispatchEvent(new CustomEvent("open-auth-modal")));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    document.cookie = "cs_auth=; Max-Age=0; path=/";
  });
});
