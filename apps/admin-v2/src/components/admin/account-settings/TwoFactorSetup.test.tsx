// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { TwoFactorSetup } from "./TwoFactorSetup";
import type { User } from "./ProfileHeader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ challenge: vi.fn(), method: vi.fn() }));
const auth = vi.hoisted(() => ({ enable: vi.fn(), sendOtp: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({}),
  useBlocker: () => ({ proceed: vi.fn(), reset: vi.fn(), status: "idle" }),
}));
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("~/lib/admin-route-context", () => ({ refreshAdminRouteContext: vi.fn() }));
vi.mock("~/lib/auth-client", () => ({ authClient: { twoFactor: auth } }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminAuth2FaMethodChallenge: api.challenge,
  postApiV1AdminAuth2FaMethod: api.method,
}));
vi.mock("qrcode", () => ({ toDataURL: async () => "data:image/png;base64,AAAA" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const user: User = {
  id: "user_1",
  name: "Owner",
  email: "owner@example.com",
  image: null,
  role: "admin",
  twoFactorEnabled: true,
  twoFactorMethod: "totp",
};

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

describe("TwoFactorSetup", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    Object.values(api).forEach((mock) => mock.mockReset());
    Object.values(auth).forEach((mock) => mock.mockReset());
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const button = (name: string) => [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === name)!;
  function type(selector: string, value: string) {
    const field = host.querySelector<HTMLInputElement>(selector)!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
  }

  it("issues new recovery codes only after the password and a code from the new app entry", async () => {
    api.challenge.mockResolvedValue({ challengeId: "tfmc_1", totpUri: "otpauth://totp/Store:owner?secret=JBSWY3DPEHPK3PXP&issuer=Store", expiresAt: "" });
    api.method.mockResolvedValue({ backupCodes: ["code-one", "code-two"] });
    act(() => root.render(<TwoFactorSetup user={user} />));

    act(() => button("Get new recovery codes").click());
    type("#two-step-password", "account-password");
    await submit();
    expect(api.challenge).toHaveBeenCalledWith({ body: { method: "totp", password: "account-password" } });
    // The key reads in blocks of four, and the card keeps its title through the flow.
    expect(host.textContent).toContain("JBSW Y3DP EHPK 3PXP");
    expect(host.querySelector(".text-heading-sm")?.textContent).toBe("Two-step verification");

    act(() => button("Continue").click());
    type("#two-step-code", "12a3456");
    await submit();
    expect(api.method).toHaveBeenCalledWith({ body: { method: "totp", challengeId: "tfmc_1", code: "123456" } });
    expect(host.textContent).toContain("code-one");
    expect(button("Download codes")).toBeDefined();

    act(() => button("Done").click());
    expect(host.textContent).not.toContain("code-one");
    expect(host.textContent).toContain("On");
  });

  it("says a wrong code in plain words and stays on the code step", async () => {
    auth.enable.mockResolvedValue({ data: { method: "totp", totpURI: "otpauth://totp/x?secret=ABC", backupCodes: ["r1"] } });
    api.method.mockRejectedValue(new AdminApiResponseError("The verification code is wrong", 400, "TWO_FACTOR_CODE_INVALID"));
    act(() => root.render(<TwoFactorSetup user={{ ...user, twoFactorEnabled: false, twoFactorMethod: null }} />));

    act(() => button("Turn on").click());
    act(() => button("Continue").click());
    type("#two-step-password", "account-password");
    await submit();
    expect(auth.enable).toHaveBeenCalledWith({ password: "account-password", method: "totp" });

    act(() => button("Continue").click());
    type("#two-step-code", "000000");
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("That code didn't work. Check your app and try again.");
    expect(host.querySelector("#two-step-code")).not.toBeNull();
  });

  it("never shows raw server text when the server fails", async () => {
    api.challenge.mockRejectedValue(new AdminApiResponseError("API error: 502", 502));
    act(() => root.render(<TwoFactorSetup user={user} />));
    act(() => button("Change method").click());
    act(() => button("Continue").click());
    type("#two-step-password", "account-password");
    await submit();
    const alert = host.querySelector('[role="alert"]')?.textContent;
    expect(alert).toBe("Something went wrong on our side. Try again in a moment.");
    expect(host.textContent).not.toContain("502");
  });
});
