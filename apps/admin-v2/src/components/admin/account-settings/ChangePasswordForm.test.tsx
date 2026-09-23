// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { ChangePasswordForm } from "./ChangePasswordForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const changePassword = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ proceed: vi.fn(), reset: vi.fn(), status: "idle" }),
}));
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({ postApiV1AdminAuthChangePassword: changePassword }));
vi.mock("sonner", () => ({ toast: toastMock }));

const CURRENT = "current-secret-123";
const NEXT = "brand-new-secret-456";

describe("ChangePasswordForm", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    changePassword.mockReset().mockResolvedValue({ success: true });
    toastMock.success.mockReset();
    act(() => root.render(<ChangePasswordForm />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const input = (id: string) => host.querySelector<HTMLInputElement>(`#password-${id}`)!;
  function type(id: string, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input(id), value);
      input(id).dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  it("is a POST form whose fields have no names, so passwords can't reach a URL", () => {
    const form = host.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect([...form.querySelectorAll("input")].every((field) => !field.name)).toBe(true);
  });

  it("refuses a short or mismatched new password without calling the API", async () => {
    type("current", CURRENT);
    type("next", "short");
    type("confirm", "short");
    await submit();
    expect(host.textContent).toContain("Use at least 12 characters.");

    type("next", NEXT);
    type("confirm", `${NEXT}x`);
    await submit();
    expect(host.textContent).toContain("The passwords don't match.");
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("marks a wrong current password on its field and keeps what was typed", async () => {
    changePassword.mockRejectedValueOnce(new AdminApiResponseError("Current password is incorrect", 400));
    type("current", CURRENT);
    type("next", NEXT);
    type("confirm", NEXT);
    await submit();

    expect(input("current").getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain("Your current password is wrong.");
    expect(input("next").value).toBe(NEXT);
  });

  it("sends the passwords only in the request body and clears them after saving", async () => {
    type("current", CURRENT);
    type("next", NEXT);
    type("confirm", NEXT);
    await submit();

    expect(changePassword).toHaveBeenCalledWith({ body: { currentPassword: CURRENT, newPassword: NEXT } });
    expect(toastMock.success).toHaveBeenCalledWith("Password changed");
    expect([input("current").value, input("next").value, input("confirm").value]).toEqual(["", "", ""]);
  });
});
