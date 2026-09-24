// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnclaimedGuestOrders } from "./api/customer-auth";

const api = vi.hoisted(() => ({ sendGuestOrdersCode: vi.fn(), verifyGuestOrders: vi.fn() }));
vi.mock("./api/customer-auth", () => api);

const { guestOrdersNotice, renderGuestOrderNotices } = await import("./account-guest-orders");

const entry: UnclaimedGuestOrders = { id: "cust_guest_1", destination: "01•••••011", orderCount: 1, canVerify: true };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let container: HTMLDivElement;
let onClaimed: ReturnType<typeof vi.fn<(message: string) => void>>;

beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  onClaimed = vi.fn();
});

afterEach(() => {
  renderGuestOrderNotices(container, [], { onClaimed });
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function show(entries: UnclaimedGuestOrders[] = [entry]) {
  renderGuestOrderNotices(container, entries, { onClaimed });
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent?.startsWith(label));
const status = () => container.querySelector("[role=status]")?.textContent ?? "";
const form = () => container.querySelector("form")!;
const input = () => container.querySelector<HTMLInputElement>("input[name=code]")!;

describe("orders placed with an unverified phone", () => {
  it.each([
    [{ orderCount: 1, canVerify: true }, "1 more order was placed with 01•••••011. Verify this phone to add it."],
    [{ orderCount: 3, canVerify: true }, "3 more orders were placed with 01•••••011. Verify this phone to add them."],
    [{ orderCount: 1, canVerify: false }, "1 more order was placed with 01•••••011. Contact the store to add it to your account."],
    [{ orderCount: 3, canVerify: false }, "3 more orders were placed with 01•••••011. Contact the store to add them to your account."],
  ])("says %j", (facts, text) => {
    expect(guestOrdersNotice({ destination: "01•••••011", ...facts })).toBe(text);
    show([{ ...entry, ...facts }]);
    expect(container.textContent).toContain(text);
  });

  it("offers no button when the store can't text codes", () => {
    show([{ ...entry, canVerify: false }]);

    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });

  it("sends a code, then shows the code field focused with the server's message", async () => {
    api.sendGuestOrdersCode.mockResolvedValue({ success: true, message: "We sent a code to 01•••••011.", destination: "01•••••011", resendAfterSeconds: 60 });
    show();
    expect(form().classList.contains("hidden")).toBe(true);

    button("Verify this phone")!.click();
    await flush();

    expect(api.sendGuestOrdersCode).toHaveBeenCalledWith("cust_guest_1");
    expect(status()).toBe("We sent a code to 01•••••011.");
    expect(form().classList.contains("hidden")).toBe(false);
    expect(document.activeElement).toBe(input());
    expect(input().inputMode).toBe("numeric");
    expect(input().getAttribute("autocomplete")).toBe("one-time-code");
    expect(button("Send a new code in")?.textContent).toBe("Send a new code in 1:00");
    expect(button("Send a new code in")?.disabled).toBe(true);
    expect(form().getAttribute("action")).toBeNull();
  });

  it("shows the unavailable message as it is and keeps the code field closed", async () => {
    const message = "Text message codes are unavailable right now. Contact the store.";
    api.sendGuestOrdersCode.mockResolvedValue({ success: false, status: 503, error: message });
    show();

    button("Verify this phone")!.click();
    await flush();

    expect(status()).toBe(message);
    expect(form().classList.contains("hidden")).toBe(true);
    expect(button("Verify this phone")?.disabled).toBe(false);
  });

  it("holds the button through a rate-limit wait and counts it down", async () => {
    vi.useFakeTimers();
    api.sendGuestOrdersCode.mockResolvedValue({ success: false, status: 429, error: "Too many codes.", retryAfterSeconds: 61 });
    show();

    button("Verify this phone")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(status()).toBe("Too many codes. Try again in 1:01.");
    expect(button("Verify this phone")?.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);
    expect(status()).toBe("Too many codes. Try again in 0:59.");

    await vi.advanceTimersByTimeAsync(59_000);
    expect(status()).toBe("");
    expect(button("Verify this phone")?.disabled).toBe(false);
  });

  it("adds the orders with the code and hands the server's message to the reload", async () => {
    api.sendGuestOrdersCode.mockResolvedValue({ success: true, message: "We sent a code to 01•••••011.", destination: "01•••••011", resendAfterSeconds: 60 });
    api.verifyGuestOrders.mockResolvedValue({ success: true, movedOrders: 1, message: "1 order was added to your account." });
    show();
    button("Verify this phone")!.click();
    await flush();

    input().value = " 123 456 ";
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(api.verifyGuestOrders).toHaveBeenCalledWith("cust_guest_1", "123456");
    expect(onClaimed).toHaveBeenCalledWith("1 order was added to your account.");
  });

  it("keeps the code field open on a wrong code and says how many tries are left", async () => {
    api.sendGuestOrdersCode.mockResolvedValue({ success: true, message: "We sent a code to 01•••••011.", destination: "01•••••011", resendAfterSeconds: 60 });
    api.verifyGuestOrders.mockResolvedValue({ success: false, status: 400, error: "That code isn't right. 4 attempts left." });
    show();
    button("Verify this phone")!.click();
    await flush();

    input().value = "000000";
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(status()).toBe("That code isn't right. 4 attempts left.");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(button("Add orders")?.disabled).toBe(false);
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it("asks for the code instead of sending an empty one", async () => {
    api.sendGuestOrdersCode.mockResolvedValue({ success: true, message: "We sent a code to 01•••••011.", destination: "01•••••011", resendAfterSeconds: 60 });
    show();
    button("Verify this phone")!.click();
    await flush();

    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(api.verifyGuestOrders).not.toHaveBeenCalled();
    expect(status()).toBe("Enter the code we sent.");
  });
});
