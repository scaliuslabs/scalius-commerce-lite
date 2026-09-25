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
    sdk.getApiV1AdminSettingsAuth.mockImplementation(() => envelope({
      revision: { customerAuth: 3, whatsapp: 0 },
      customerIdentity: { email: "optional", whatsapp: "off", channels: ["email"] },
    }));
    sdk.postApiV1AdminSettingsAuth.mockImplementation(() => envelope({ message: "ok", revision: { customerAuth: 4, whatsapp: 0 } }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    notifyManager.setNotifyFunction((callback) => callback());
  });

  const render = async () => {
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
    await vi.waitFor(() => expect(container.textContent).toContain("Contact information"));
  };
  const control = (label: string, index = 0) =>
    [...container.querySelectorAll("label")].filter((element) => element.textContent === label)[index]!.querySelector("button")!;

  it("locks phone as required and keeps a chosen channel's contact collected", async () => {
    await render();
    expect(container.textContent).toContain("Phone number");
    expect(container.textContent).toContain("Required (couriers need it)");
    // Email codes are on: email can't become "Don't ask", and the reason is shown.
    expect(control("Optional").getAttribute("aria-checked")).toBe("true");
    expect(control("Don't ask", 0).disabled).toBe(true);
    expect(container.textContent).toContain("Email codes are on, so checkout asks for email.");
    expect(container.textContent).toContain("Customers who skip their email can't get codes for their orders.");
    // The only channel can't be turned off.
    expect(control("Email code").disabled).toBe(true);
  });

  it("fails closed: channels without a provider or a collected contact can't be turned on", async () => {
    await render();
    expect(control("SMS code").disabled).toBe(true);
    const smsHint = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent?.includes("Set up SMS"));
    expect(smsHint?.getAttribute("href")).toBe("/admin/settings/notifications#sending");
    // WhatsApp isn't collected yet: that's the first thing to fix.
    expect(control("WhatsApp code").disabled).toBe(true);
    expect(container.textContent).toContain("Ask for a WhatsApp number above to use this.");
    await act(async () => control("Same as phone").click());
    expect(container.textContent).toContain("Connect a WhatsApp provider to use this.");
    expect(control("WhatsApp code").disabled).toBe(true);
  });
});
