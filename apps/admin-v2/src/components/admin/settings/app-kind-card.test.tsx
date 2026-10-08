// @vitest-environment happy-dom
// The settings cards of the new app provider kinds (chat apps, exchange rates,
// address autocomplete, sign-in with other accounts, search): each lists the
// installed apps' providers of its kind with readiness and a setup button, or
// says in one line that none is installed, with a link to Apps.

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsProviders: vi.fn(),
  postApiV1AdminSettingsProvidersByIdTest: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: (options?: { select?: (location: { hash: string }) => unknown }) => (options?.select ? options.select({ hash: "" }) : { hash: "" }),
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { setLocale } from "~/i18n";
import { AppProviderSheetHost } from "../apps/AppProviderSheetHost";
import { APP_KIND_CARDS, AppKindCard } from "./AppKindCard";
import { SETTINGS_CARDS } from "./settings-search";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = (data: unknown) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });

function provider(kind: string, configured: boolean) {
  return {
    id: `acme.apps:${kind}`,
    kind,
    pluginId: "acme.apps",
    appName: "Acme apps",
    appIcon: null,
    icon: null,
    name: `Acme ${kind}`,
    operations: [],
    canTestConnection: false,
    readiness: { configured, enabled: true, usable: configured, missingFields: configured ? [] : ["key"], credentialErrors: [] },
    environment: "unknown",
  };
}

let host: HTMLDivElement;
let root: Root;

async function render(kind: keyof typeof APP_KIND_CARDS, options: { superAdmin?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <PermissionProvider isSuperAdmin={options.superAdmin ?? true}>
        <AppProviderSheetHost>
          <AppKindCard kind={kind} />
        </AppProviderSheetHost>
      </PermissionProvider>
    </QueryClientProvider>,
  ));
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  setLocale("en");
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  sdk.getApiV1AdminSettingsProviders.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const KINDS = Object.keys(APP_KIND_CARDS) as Array<keyof typeof APP_KIND_CARDS>;

describe("app provider kind cards", () => {
  it("are settings cards the settings search lists", () => {
    for (const kind of KINDS) {
      expect(SETTINGS_CARDS.some((card) => card.card === APP_KIND_CARDS[kind].id), kind).toBe(true);
    }
  });

  it.each(KINDS)("%s: says in one line that no app is installed, and links to Apps", async (kind) => {
    sdk.getApiV1AdminSettingsProviders.mockImplementation(() => ok({ providers: [] }));
    await render(kind);
    await vi.waitFor(() => expect(host.querySelector('a[href="/admin/apps"]')).not.toBeNull());
    expect(host.querySelector(`#${APP_KIND_CARDS[kind].id}`)).not.toBeNull();
    expect(host.textContent).toContain("is installed.");
    expect(sdk.getApiV1AdminSettingsProviders).toHaveBeenCalledWith({ query: { kind } });
  });

  it.each(KINDS)("%s: lists each app's provider with its readiness and a setup button", async (kind) => {
    sdk.getApiV1AdminSettingsProviders.mockImplementation(() => ok({ providers: [provider(kind, false), { ...provider(kind, true), id: `acme.apps:${kind}2`, name: `Acme ${kind} two` }] }));
    await render(kind);
    await vi.waitFor(() => expect(host.textContent).toContain(`Acme ${kind} two`));
    expect(host.textContent).toContain("Not ready");
    expect(host.textContent).toContain("Ready");
    const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toContain(`Set up Acme ${kind}`);
    expect(buttons).toContain(`Edit Acme ${kind} two settings`);
    expect(host.querySelector('a[href="/admin/apps"]')).toBeNull();
  });
});
