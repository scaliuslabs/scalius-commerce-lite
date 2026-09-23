// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    api.challenge.mockResolvedValue({ challengeId: "tfmc_1", totpUri: "otpauth://totp/Store:owner?secret=JBSWY3DP&issuer=Store", expiresAt: "" });
    api.method.mockResolvedValue({ backupCodes: ["code-one", "code-two"] });
    act(() => root.render(<TwoFactorSetup user={user} />));

    act(() => button("Get new recovery codes").click());
    type("#two-step-password", "account-password");
    await submit();
    expect(api.challenge).toHaveBeenCalledWith({ body: { method: "totp", password: "account-password" } });
    expect(host.textContent).toContain("JBSWY3DP");

    act(() => button("Continue").click());
    type("#two-step-code", "12a3456");
    await submit();
    expect(api.method).toHaveBeenCalledWith({ body: { method: "totp", challengeId: "tfmc_1", code: "123456" } });
    expect(host.textContent).toContain("code-one");

    act(() => button("Done").click());
    expect(host.textContent).not.toContain("code-one");
    expect(host.textContent).toContain("On");
  });

  it("shows the server's reason and stays on the code step when the code is wrong", async () => {
    auth.enable.mockResolvedValue({ data: { method: "totp", totpURI: "otpauth://totp/x?secret=ABC", backupCodes: ["r1"] } });
    api.method.mockRejectedValue(new Error("The verification code is invalid or expired"));
    act(() => root.render(<TwoFactorSetup user={{ ...user, twoFactorEnabled: false, twoFactorMethod: null }} />));

    act(() => button("Turn on").click());
    act(() => button("Continue").click());
    type("#two-step-password", "account-password");
    await submit();
    expect(auth.enable).toHaveBeenCalledWith({ password: "account-password", method: "totp" });

    act(() => button("Continue").click());
    type("#two-step-code", "000000");
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("invalid or expired");
    expect(host.querySelector("#two-step-code")).not.toBeNull();
  });
});
