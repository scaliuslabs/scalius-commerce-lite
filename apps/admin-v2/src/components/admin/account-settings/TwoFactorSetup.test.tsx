// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { TwoFactorSetup } from "./TwoFactorSetup";
import type { User } from "./ProfileHeader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ challenge: vi.fn(), method: vi.fn(), disable: vi.fn() }));
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
  postApiV1AdminAuth2FaDisable: api.disable,
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
    act(() => button("Use email codes").click());
    type("#two-step-password", "account-password");
    await submit();
    const alert = host.querySelector('[role="alert"]')?.textContent;
    expect(alert).toBe("Something went wrong on our side. Try again in a moment.");
    expect(host.textContent).not.toContain("502");
  });

  it("makes the authenticator the method in one click from email codes, and says what changes", async () => {
    api.challenge.mockResolvedValue({ challengeId: "tfmc_2", totpUri: "otpauth://totp/Store:owner?secret=JBSWY3DPEHPK3PXP&issuer=Store", expiresAt: "" });
    api.method.mockResolvedValue({ backupCodes: ["code-one"] });
    act(() => root.render(<TwoFactorSetup user={{ ...user, twoFactorMethod: "email" }} />));
    // Both ways are rows: email is in use, the app is one click away.
    expect(host.querySelector('[data-method="email"]')?.textContent).toContain("In use");
    act(() => button("Use authenticator app").click());
    expect(host.textContent).toContain("Sign-in asks for the app's code from then on.");
    type("#two-step-password", "account-password");
    await submit();
    expect(api.challenge).toHaveBeenCalledWith({ body: { method: "totp", password: "account-password" } });
    act(() => button("Continue").click());
    type("#two-step-code", "123456");
    await submit();
    expect(api.method).toHaveBeenCalledWith({ body: { method: "totp", challengeId: "tfmc_2", code: "123456" } });
    act(() => button("Done").click());
    expect(host.querySelector('[data-method="totp"]')?.textContent).toContain("In use");
    expect(button("Get new recovery codes")).toBeDefined();
    // The rows run straight into the footer: the footer's top border closes the last row,
    // so no empty bordered band sits between "Recovery codes" and "Turn off".
    const rows = host.querySelector('[data-method="totp"]')!.parentElement!;
    expect(rows.className).not.toMatch(/\bborder-(y|b)\b/);
    expect(rows.className).toContain("-mb-4");
    expect(rows.nextElementSibling).toBeNull();
    expect(rows.parentElement!.nextElementSibling?.textContent).toContain("Turn off");
  });

  it("turns off with the password and a current code", async () => {
    auth.sendOtp.mockResolvedValue({});
    api.disable.mockResolvedValue({ message: "ok" });
    act(() => root.render(<TwoFactorSetup user={{ ...user, twoFactorMethod: "email" }} />));
    act(() => button("Turn off").click());
    await flush();
    // An emailed code is on its way; the step asks for it with the password.
    expect(auth.sendOtp).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Signing in will need only your password.");
    type("#two-step-password", "account-password");
    type("#two-step-code", "654321");
    await submit();
    expect(api.disable).toHaveBeenCalledWith({ body: { password: "account-password", code: "654321" } });
    expect(host.textContent).toContain("Off");
    expect(button("Turn on")).toBeDefined();
  });

  it("keeps it on for invited staff and says why", () => {
    act(() => root.render(<TwoFactorSetup user={user} required />));
    expect(button("Turn off")).toBeUndefined();
    expect(host.textContent).toContain("Your store requires two-step verification for staff it invited");
  });
});
