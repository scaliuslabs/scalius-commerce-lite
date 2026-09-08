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
  updateCustomerProfile: vi.fn(),
  getZones: vi.fn(),
}));
vi.mock("@/lib/api/customer-auth", () => mocks);
vi.mock("@/lib/api/client", () => ({ createApiUrl: (path: string) => `/api/v1${path}` }));
vi.mock("@/lib/api", () => ({ getZones: mocks.getZones, getAreas: vi.fn() }));
vi.mock("@/lib/checkout/session-state", () => ({ readCheckoutFormDraft: vi.fn() }));

import AuthModal from "./AuthModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const customer = {
  customerId: "customer_test", name: "Test customer", email: "customer@example.test",
  city: "city_dhaka", cityName: "Dhaka", zone: "zone_mirpur", zoneName: "Mirpur",
  address: "", needsProfileCompletion: true,
};
let root: Root;
let host: HTMLDivElement;

async function changeInput(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  window.__CHECKOUT_CONFIG__ = { authVerificationMethod: "email", allowedCountries: ["BD"] } as CheckoutConfig;
  window.__scaliusAuthModalOpenPending = true;
  mocks.getZones.mockResolvedValue([{ id: "zone_mirpur", name: "Mirpur" }]);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: [{ id: "city_dhaka", name: "Dhaka" }] }),
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  document.cookie = "cs_auth=; Max-Age=0; path=/";
  delete window.__CHECKOUT_CONFIG__;
  delete window.__scaliusAuthModalOpenPending;
  delete window.__scaliusAuthModalIntentPending;
  vi.unstubAllGlobals();
});

describe("account dialog forms", () => {
  it("uses native POST submission for identity and OTP, deduplicating repeated submits", async () => {
    let resolveSend!: (value: { success: boolean }) => void;
    let resolveVerify!: (value: { success: boolean; customer: typeof customer }) => void;
    mocks.sendCustomerOtp.mockReturnValue(new Promise((resolve) => { resolveSend = resolve; }));
    mocks.verifyCustomerOtp.mockReturnValue(new Promise((resolve) => { resolveVerify = resolve; }));
    await act(async () => root.render(<AuthModal />));
    await changeInput("#auth-primary-input", "customer@example.test");
    const form = host.querySelector("form")!;
    expect(form.method).toBe("post");
    expect(form.querySelector('input[name="email"], input[name="otp"], input[name="phone"]')).toBeNull();
    // requestSubmit exercises the native submit event used by Enter, without a field-specific key handler.
    await act(async () => { form.requestSubmit(); form.requestSubmit(); });
    expect(mocks.sendCustomerOtp).toHaveBeenCalledTimes(1);
    expect(mocks.sendCustomerOtp).toHaveBeenCalledWith(expect.objectContaining({ identifier: "customer@example.test", intent: "sign_in" }));
    await act(async () => resolveSend({ success: true }));
    expect(host.querySelector("h2")?.textContent).toBe("Verify your account");
    await changeInput("#customer-otp", "123456");
    await act(async () => form.requestSubmit());
    expect(mocks.verifyCustomerOtp).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLInputElement>("#customer-otp")?.disabled).toBe(true);
    await act(async () => resolveVerify({ success: true, customer }));
    expect(host.querySelector("h2")?.textContent).toBe("Complete your profile");
    expect(host.querySelector('[aria-label="Zone: Mirpur"]')).not.toBeNull();
  });

  it("resumes saved locations, consumes nested Escape, and submits profile fields natively", async () => {
    document.cookie = "cs_auth=1; path=/";
    let resolveSave!: (value: { success: boolean; error: string }) => void;
    mocks.getCustomerSession.mockResolvedValue({ authenticated: true, customer });
    mocks.updateCustomerProfile.mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
    await act(async () => root.render(<AuthModal />));
    expect(host.querySelectorAll("h2, h3")).toHaveLength(1);
    expect(host.querySelector("h2")?.textContent).toBe("Complete your profile");
    const city = host.querySelector<HTMLButtonElement>('[aria-label="City: Dhaka"]')!;
    expect(host.querySelector('[aria-label="Zone: Mirpur"]')).not.toBeNull();
    await act(async () => city.click());
    await act(async () => host.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(city));
    await act(async () => city.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Save your delivery profile or sign out to continue.");
    await changeInput("#profile-address", "House 10, Road 2");
    await act(async () => host.querySelector("form")!.requestSubmit());
    expect(mocks.updateCustomerProfile).toHaveBeenCalledWith({
      name: "Test customer", address: "House 10, Road 2", city: "city_dhaka", zone: "zone_mirpur", cityName: "Dhaka", zoneName: "Mirpur",
    });
    expect(host.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
    expect(host.querySelector("#profile-address")?.closest("fieldset")).toBe(city.closest("fieldset"));
    await act(async () => resolveSave({ success: false, error: "Please try saving again." }));
    expect(host.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Please try saving again.");
    expect(host.querySelector('[aria-label="Zone: Mirpur"]')).not.toBeNull();
    expect(mocks.getZones).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ok: false, success: true, data: [] },
    { ok: true, success: false, data: [] },
    { ok: true, success: true, data: null },
  ])("recovers a failed city load through Retry without losing the profile draft: %j", async (failure) => {
    document.cookie = "cs_auth=1; path=/";
    mocks.getCustomerSession.mockResolvedValue({ authenticated: true, customer });
    vi.mocked(fetch).mockResolvedValueOnce({ ok: failure.ok, json: async () => failure } as Response);
    await act(async () => root.render(<AuthModal />));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not load delivery locations.");
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await changeInput("#profile-address", "House 10, Road 2");
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>("#profile-address")?.value).toBe("House 10, Road 2");
    expect(host.querySelector('[aria-label="Zone: Mirpur"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });
});
