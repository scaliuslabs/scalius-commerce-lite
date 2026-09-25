// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultNotificationTemplates, type TemplatedNotificationType } from "@scalius/core/modules/notifications/browser";

const DEFAULTS = defaultNotificationTemplates("en");

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
const READY = { status: "ready", issues: [] };

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsNotificationChannels: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, hash, children, ...props }: { to: string; hash?: string; children: ReactNode }) => (
    <a href={hash ? `${to}#${hash}` : to} {...props}>{children}</a>
  ),
}));
const client = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("~/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/api")>()),
  apiClient: client,
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { NotificationTemplateEditor } from "./NotificationTemplateEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function type(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
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
    sdk.getApiV1AdminSettingsNotificationChannels.mockImplementation(() => envelope({
      channels: { order_confirmed: ["email"] },
      whatsappTemplate: { templateName: "order_update_bn", languageCode: "bn" },
      email: READY,
      sms: { status: "incomplete", issues: [] },
    }));
    client.get.mockImplementation(() => envelope({
      templates: DEFAULTS,
      revision: 3,
      language: "en",
      store: { name: "Nokshi Kantha", logoUrl: null, storefrontUrl: "https://shop.example.test", nameFromAddress: false },
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function renderEditor(event: TemplatedNotificationType = "order_confirmed") {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <NotificationTemplateEditor event={event} />
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

  it("edits a gift card message in its own frame, without order details or WhatsApp", async () => {
    const sms = await renderEditor("gift_card_issued");
    expect(preview()).toContain("SAMPLE0000000000");
    expect(container.textContent).toContain("Shown with sample details.");
    expect(container.textContent).not.toContain("“order_update_bn”");

    const html = container.querySelector<HTMLIFrameElement>("iframe")!.getAttribute("srcdoc")!;
    expect(html).toContain("SAMPLE0000000000");
    expect(html).not.toContain("track-order");

    // Order-only variables aren't offered to a gift card message.
    type(sms, "Code {{gift_card_code}}, order {{order_total}}");
    act(() => { sms.focus(); sms.blur(); });
    expect(container.querySelector("#template-sms-body-note")?.textContent).toBe("{{order_total}} can't be used in this message.");
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

    expect(sms.value).toBe(DEFAULTS.sms.order_confirmed.body);
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
    // The real frame: the guest's order link on the store's address.
    expect(html).toContain('href="https://shop.example.test/track-order?order=1001"');
  });

  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((element) => element.textContent === label);

  it("shows an unknown variable once, next to the field, and can't send the draft as a test", async () => {
    const { toast } = await import("sonner");
    await renderEditor();
    const subject = container.querySelector<HTMLInputElement>("#template-email-subject")!;
    type(subject, "Order {{bogus}}");
    act(() => { subject.focus(); subject.blur(); });

    expect(container.querySelector("#template-email-subject-note")?.textContent).toBe("{{bogus}} can't be used in this message.");
    expect(container.querySelectorAll("[role=alert]")).toHaveLength(1);
    expect(button("Send test email")!.disabled).toBe(true);
    act(() => button("Send test email")!.click());
    expect(client.post).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();

    type(subject, "Order {{order_number}}");
    expect(button("Send test email")!.disabled).toBe(false);
  });

  it("says a failed test send inline, not in a toast", async () => {
    const { toast } = await import("sonner");
    client.post.mockRejectedValue(new Error("Couldn't send the test email. Check the email sending setup under Sending."));
    await renderEditor();
    await act(async () => button("Send test email")!.click());

    expect(container.querySelector("[role=alert]")?.textContent).toBe("Couldn't send the test email. Check the email sending setup under Sending.");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("points to SMS setup instead of offering a test SMS while SMS isn't set up", async () => {
    await renderEditor();
    await vi.waitFor(() => expect(container.textContent).toContain("Set up SMS to send a test"));
    const link = [...container.querySelectorAll("a")].find((element) => element.textContent === "Set up SMS to send a test");
    expect(link?.getAttribute("href")).toBe("/admin/settings/notifications#sending");
    expect(button("Send test SMS")).toBeUndefined();
    expect(button("Send test email")).toBeDefined();
  });

  it("offers a test SMS once SMS is set up, and not while the draft has a problem", async () => {
    sdk.getApiV1AdminSettingsNotificationChannels.mockImplementation(() => envelope({
      channels: {}, whatsappTemplate: { templateName: "t", languageCode: "en" }, email: READY, sms: READY,
    }));
    const sms = await renderEditor();
    await vi.waitFor(() => expect(button("Send test SMS")!.disabled).toBe(false));
    type(sms, "Hi {{courier}}");
    expect(button("Send test SMS")!.disabled).toBe(true);
  });

  it("says what {{store_name}} becomes while the store has no name, and the preview heading matches the send", async () => {
    client.get.mockImplementation(() => envelope({
      templates: DEFAULTS,
      revision: 3,
      language: "en",
      store: { name: "shop.example.test", logoUrl: null, storefrontUrl: "https://shop.example.test", nameFromAddress: true },
    }));
    const sms = await renderEditor();
    expect(container.textContent).not.toContain("Your store name isn't set");

    type(sms, "{{store_name}}: order {{order_number}} confirmed");
    expect(container.textContent).toContain("Your store name isn't set, so {{store_name}} shows your store address, shop.example.test.");
    const link = [...container.querySelectorAll("a")].find((element) => element.textContent === "Add store name");
    expect(link?.getAttribute("href")).toBe("/admin/settings/store#business");
    expect(preview()).toBe("shop.example.test: order #1001 confirmed");

    type(container.querySelector<HTMLInputElement>("#template-email-subject")!, "Order {{order_number}} {{customer_name}}");
    expect(container.querySelector("iframe")!.getAttribute("srcdoc")).toContain(">Order #1001 Rahim Uddin</h1>");
  });
});
