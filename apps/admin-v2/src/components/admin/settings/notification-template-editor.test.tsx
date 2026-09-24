// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATION_TEMPLATES } from "@scalius/core/modules/notifications/notification-templates";

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsBusiness: vi.fn(),
  getApiV1AdminSettingsNotificationChannels: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const client = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("~/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/api")>()),
  apiClient: client,
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { NotificationTemplateEditor } from "./NotificationTemplateEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function type(field: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("notification message editor", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    sdk.getApiV1AdminSettingsBusiness.mockImplementation(() => envelope({ companyName: "Nokshi Kantha", legalName: "" }));
    sdk.getApiV1AdminSettingsNotificationChannels.mockImplementation(() => envelope({
      channels: { order_confirmed: ["email"] },
      whatsappTemplate: { templateName: "order_update_bn", languageCode: "bn" },
    }));
    client.get.mockImplementation(() => envelope({ templates: DEFAULT_NOTIFICATION_TEMPLATES, revision: 3 }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function renderEditor() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <NotificationTemplateEditor event="order_confirmed" />
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.querySelector("#template-sms-body")).not.toBeNull());
    return container.querySelector<HTMLTextAreaElement>("#template-sms-body")!;
  }

  const preview = () => container.querySelector("[data-testid=sms-preview]")!.textContent;
  const counter = () => container.querySelector("[aria-live=polite]")!.textContent;

  it("previews the SMS with sample data and counts its parts, switching to Unicode for Bangla", async () => {
    const sms = await renderEditor();
    expect(preview()).toBe("Hi Rahim Uddin, your order #1001 has been confirmed and is being prepared.");
    expect(counter()).toBe("74 characters · 1 SMS · Standard");

    type(sms, "{{customer_name}}, আপনার অর্ডার {{order_number}} কনফার্ম হয়েছে। মোট {{order_total}}। ধন্যবাদ, {{store_name}}");

    expect(preview()).toBe("Rahim Uddin, আপনার অর্ডার #1001 কনফার্ম হয়েছে। মোট ৳1,250। ধন্যবাদ, Nokshi Kantha");
    expect(counter()).toMatch(/^\d+ characters · 2 SMS · Unicode$/);
    expect(container.textContent).toContain("Customers don't get this by SMS.");
    expect(container.textContent).toContain("“order_update_bn”");
  });

  it("names a variable this event can't fill once the merchant leaves the field", async () => {
    const sms = await renderEditor();
    type(sms, "Hi {{customer_name}}, tracking {{tracking_id}}");
    // Quiet while typing: the help line is still showing.
    expect(container.querySelector("#template-sms-body-note")?.getAttribute("role")).toBeNull();
    act(() => { sms.focus(); sms.blur(); });
    expect(container.querySelector("#template-sms-body-note")?.textContent).toBe("{{tracking_id}} can't be used in this message.");
    expect(sms.getAttribute("aria-invalid")).toBe("true");
  });

  it("resets a changed message to the default copy", async () => {
    const sms = await renderEditor();
    type(sms, "Thanks {{customer_name}}");
    const reset = [...container.querySelectorAll("button")].filter((button) => button.textContent === "Reset to default")[1]!;
    expect(reset.disabled).toBe(false);

    act(() => reset.click());

    expect(sms.value).toBe(DEFAULT_NOTIFICATION_TEMPLATES.sms.order_confirmed.body);
    expect(reset.disabled).toBe(true);
  });

  it("renders the real email markup, escaped, in a sandboxed preview", async () => {
    await renderEditor();
    const body = container.querySelector<HTMLTextAreaElement>("#template-email-body")!;
    type(body, "Hi {{customer_name}} <script>alert(1)</script>");

    const frame = container.querySelector<HTMLIFrameElement>("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("");
    const html = frame.getAttribute("srcdoc")!;
    expect(html).toContain("Hi Rahim Uddin &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Nokshi Kantha");
  });
});
