// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsAuth: vi.fn(),
  getApiV1AdminSettingsNotificationChannels: vi.fn(),
  postApiV1AdminSettingsAuth: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, hash, children, ...props }: { to: string; hash?: string; children: ReactNode }) => (
    <a href={hash ? `${to}#${hash}` : to} {...props}>{children}</a>
  ),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { SaveScope } from "../shared/SaveBar";
import { CustomerSignInCard } from "./CustomerSignInCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
const ready = { status: "ready", issues: [] };

describe("customer sign-in", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminSettingsNotificationChannels.mockImplementation(() =>
      envelope({ email: ready, sms: { status: "incomplete", issues: [] }, whatsapp: { status: "incomplete", issues: [] } }));
    // The stored policy the tester saw: codes by email only, yet "Don't ask" for email.
    sdk.getApiV1AdminSettingsAuth.mockImplementation(() => envelope({
      authVerificationMethod: "email",
      customerAuthPolicy: { otpChannels: ["email"], requiredContactFields: ["phone"], optionalContactFields: [], defaultOtpChannel: "email" },
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    notifyManager.setNotifyFunction((callback) => callback());
  });

  it("asks for email when codes go by email only, and points to SMS setup", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <SaveScope render={() => null}>
              <CustomerSignInCard />
            </SaveScope>
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Ask for email"));

    const radio = (label: string) =>
      [...container.querySelectorAll("label")].find((element) => element.textContent === label)!.querySelector("button")!;
    expect(radio("Required").getAttribute("aria-checked")).toBe("true");
    expect(radio("Don't ask").disabled).toBe(true);
    expect(radio("Optional").disabled).toBe(true);
    expect(container.textContent).toContain("Codes go by email only, so email is required.");

    // Adding SMS frees the choice again, and its missing setup links to Notifications.
    const smsBox = [...container.querySelectorAll("label")].find((element) => element.textContent === "SMS")!.querySelector("button")!;
    await act(async () => smsBox.click());
    expect(radio("Don't ask").disabled).toBe(false);
    const hint = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent?.includes("Set up SMS"));
    expect(hint?.getAttribute("href")).toBe("/admin/settings/notifications#sending");
  });
});
