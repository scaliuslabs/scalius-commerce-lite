// @vitest-environment happy-dom
// Settings → Notifications → SMS: the gateway picker lists every SMS
// provider of every installed app, and choosing one that is not set up yet
// says so with a link to its own page in its app (its switch and its fields,
// never another gateway's), without leaving the choice.

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsNotificationChannels: vi.fn(),
  getApiV1AdminSettingsEmail: vi.fn(),
  getApiV1AdminSettingsSms: vi.fn(),
  postApiV1AdminSettingsSms: vi.fn(),
  getApiV1AdminSettingsProviders: vi.fn(),
  postApiV1AdminSettingsProvidersByIdTest: vi.fn(),
  getApiV1AdminAppsById: vi.fn(),
  putApiV1AdminAppsByIdSettings: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("~/components/admin/shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: (options?: { select?: (location: { hash: string }) => unknown }) => (options?.select ? options.select({ hash: "" }) : { hash: "" }),
  Link: ({ to, params, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={params ? to.replace("$pluginId", params.pluginId ?? "") : to} {...props}>{children}</a>
  ),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { setLocale } from "~/i18n";
import { SendingCard } from "./NotificationSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = (data: unknown) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const ready = { status: "ready", issues: [] };
const incomplete = { status: "incomplete", issues: [] };

function smsProvider(pluginId: string, appName: string, providerId: string, name: string, configured: boolean) {
  return {
    id: `${pluginId}:${providerId}`,
    kind: "sms",
    pluginId,
    appName,
    appIcon: null,
    icon: null,
    name,
    operations: ["send"],
    canTestConnection: false,
    readiness: { configured, enabled: true, usable: configured, missingFields: configured ? [] : ["key"], credentialErrors: [] },
    environment: "unknown",
  };
}

const field = (overrides: Record<string, unknown>) => ({
  help: null, required: false, options: null, default: null, min: null, max: null, integer: false, maxLength: null, ...overrides,
});

/** The Bangladesh-style pack: two gateways, each with its own fields. */
const packDetail = {
  id: "acme.pack",
  name: "Acme pack",
  version: "1.0.0",
  description: "Gateways.",
  translations: null,
  status: "active",
  revision: 7,
  settings: {
    fields: [
      field({ key: "alpha_key", label: "API key", type: "secret", group: "alpha" }),
      field({ key: "beta_token", label: "Token", type: "secret", group: "beta" }),
      field({ key: "beta_sender", label: "Sender name", type: "text", group: "beta" }),
    ],
    values: { beta_sender: "" },
    secrets: { alpha_key: true, beta_token: false },
    missing: [],
    sections: [],
  },
  providers: [
    { id: "acme.pack:alpha", providerId: "alpha", kind: "sms", name: "Alpha SMS", icon: null, settings: ["alpha_key"], own: true, required: ["alpha_key"] },
    { id: "acme.pack:beta", providerId: "beta", kind: "sms", name: "Beta SMS", icon: null, settings: ["beta_token", "beta_sender"], own: true, required: ["beta_token"] },
  ],
};

let host: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

beforeEach(() => {
  setLocale("en");
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  sdk.getApiV1AdminSettingsNotificationChannels.mockImplementation(() => ok({ email: ready, sms: incomplete, whatsapp: incomplete, push: incomplete }));
  sdk.getApiV1AdminSettingsEmail.mockImplementation(() => ok({ provider: "cloudflare", sender: "", apiKey: "", revision: 1 }));
  sdk.getApiV1AdminSettingsSms.mockImplementation(() => ok({ activeProvider: null, activeProviderConfigured: false, activeProviderError: null, revision: 1 }));
  sdk.getApiV1AdminSettingsProviders.mockImplementation(({ query }: { query: { kind: string } }) => ok({
    providers: query.kind === "sms"
      ? [
        smsProvider("acme.pack", "Acme pack", "alpha", "Alpha SMS", true),
        smsProvider("acme.pack", "Acme pack", "beta", "Beta SMS", false),
        smsProvider("other.texts", "Other texts", "gamma", "Gamma SMS", true),
      ]
      : [],
  }));
  sdk.getApiV1AdminAppsById.mockImplementation(() => ok({ app: packDetail }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("SMS gateway picker", () => {
  it("lists every app's gateways and links the chosen one to its own setup page", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <PermissionProvider isSuperAdmin>
          <SendingCard />
        </PermissionProvider>
      </QueryClientProvider>,
    ));
    await vi.waitFor(() => expect([...host.querySelectorAll("button")].some((element) => element.textContent?.startsWith("SMS"))).toBe(true));
    const row = [...host.querySelectorAll("button")].find((element) => element.textContent?.startsWith("SMS"))!;
    await vi.waitFor(() => expect(row.disabled).toBe(false));
    await act(async () => row.click());
    await flush();

    await vi.waitFor(() => expect(document.querySelector("#sms-provider")).not.toBeNull());
    const trigger = document.querySelector<HTMLButtonElement>("#sms-provider")!;
    await act(async () => trigger.click());
    await flush();
    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(3));
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    // Every gateway of every app, each named with its app.
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Alpha SMS"),
      expect.stringContaining("Beta SMS"),
      expect.stringContaining("Gamma SMS"),
    ]);
    expect(options[2]!.textContent).toContain("by Other texts");

    // Beta is not set up: choosing it says so and links to its page in the app; nothing opens over the choice.
    await act(async () => options[1]!.click());
    await flush();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Not ready"));
    const setUp = [...document.querySelectorAll("a")].find((link) => link.textContent === "Set up Beta SMS");
    expect(setUp?.getAttribute("href")).toBe("/admin/apps/acme.pack/beta");
    expect(document.querySelector("#provider-setting-beta_token")).toBeNull();
  });
});
