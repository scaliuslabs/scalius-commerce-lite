// @vitest-environment happy-dom
// The Bangladesh pack step after store setup: Activate when the deployment
// bundles the pack (a Super Admin's consent, as on the Apps page), the
// operator's command when it does not, and a way on either way.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionProvider } from "~/contexts/PermissionContext";
import { translate } from "~/i18n";
import { storeSetupMessages } from "~/i18n/store-setup";
import { BangladeshPackStep } from "./BangladeshPackStep";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sdk = vi.hoisted(() => ({
  getApiV1AdminApps: vi.fn(),
  getApiV1AdminAppsById: vi.fn(),
  postApiV1AdminAppsByIdFeaturesByFeatureIdEnable: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", async (importOriginal) => ({ ...(await importOriginal<object>()), ...sdk }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: import("react").ReactNode }) => <a href={to}>{children}</a>,
}));

const ok = (data: unknown) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const t = (key: keyof (typeof storeSetupMessages)["en"]) => translate(storeSetupMessages, key);
const pack = { id: "scalius.bangladesh", name: "Bangladesh pack", icon: null, status: "installed", needsApproval: false };

let host: HTMLDivElement;
let root: Root;

async function render(options: { superAdmin: boolean; permissions?: string[] }, onDone = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <PermissionProvider permissions={options.permissions ?? ["apps.view"]} isSuperAdmin={options.superAdmin}>
        <BangladeshPackStep onDone={onDone} />
      </PermissionProvider>
    </QueryClientProvider>,
  ));
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
  return onDone;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("Bangladesh pack step", () => {
  it("offers a Super Admin Activate when the deployment bundles the pack", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok({ apps: [pack], available: [], sandboxAvailable: false }));
    sdk.getApiV1AdminAppsById.mockImplementation(() => new Promise(() => undefined));
    await render({ superAdmin: true });
    await vi.waitFor(() => expect(host.textContent).toContain(t("bdPackActivateBody")));
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes(t("bdPackActivate")))).toBe(true);
    expect(sdk.getApiV1AdminAppsById).toHaveBeenCalledWith({ path: { id: "scalius.bangladesh" } });
  });

  it("asks staff who are not Super Admins to have one activate it", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok({ apps: [pack], available: [], sandboxAvailable: false }));
    await render({ superAdmin: false });
    await vi.waitFor(() => expect(host.textContent).toContain(t("bdPackAskSuperAdmin")));
    expect(sdk.getApiV1AdminAppsById).not.toHaveBeenCalled();
  });

  it("shows the operator's command when the deployment does not bundle it, and lets setup go on", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok({ apps: [], available: [{ ...pack, installCommand: "pnpm plugin add plugins/bangladesh" }], sandboxAvailable: false }));
    const onDone = await render({ superAdmin: true });
    await vi.waitFor(() => expect(host.querySelector("code")?.textContent).toBe("pnpm plugin add plugins/bangladesh"));
    const skip = [...host.querySelectorAll("button")].find((button) => button.textContent === t("skip"))!;
    await act(async () => skip.click());
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("reads no app list without the permission to see apps", async () => {
    await render({ superAdmin: false, permissions: [] });
    expect(host.textContent).toContain(t("bdPackNoAccess"));
    expect(sdk.getApiV1AdminApps).not.toHaveBeenCalled();
  });
  it("ticks the recommended features, reviews the chosen ones' access once and turns each on with its own key", async () => {
    const request = (overrides: Record<string, unknown>) => ({
      scopes: [], allowedHosts: [], providers: [], events: [], functions: [], publicRoutes: false, storefront: false, admin: false, cron: [], ...overrides,
    });
    const feature = (id: string, overrides: Record<string, unknown> = {}) => ({
      id, name: id, description: `${id} description`, enabled: false, recommended: false, request: request({}), grantKey: `key-${id}`, settings: [], pages: [], ...overrides,
    });
    const app = (features: unknown[], revision: number) => ({
      ...pack, status: "active", revision, runtimeAvailable: true, translations: null, features,
      settings: { fields: [], values: {}, secrets: {}, missing: [], sections: [] }, providers: [], cron: [], admin: { pages: [], cards: [], actions: [], widgets: [] },
    });
    const places = feature("places", { recommended: true, request: request({ scopes: [{ name: "write_places", risk: "write", sensitive: false }], cron: ["places-sync"] }) });
    const bkash = feature("bkash", { request: request({ allowedHosts: ["tokenized.pay.bka.sh"], providers: [{ id: "scalius.bangladesh:bkash", kind: "payment", name: "bKash", icon: null }] }) });
    sdk.getApiV1AdminApps.mockImplementation(() => ok({ apps: [{ ...pack, status: "active" }], available: [], sandboxAvailable: false }));
    sdk.getApiV1AdminAppsById.mockImplementation(() => ok({ app: app([places, bkash], 3) }));
    sdk.postApiV1AdminAppsByIdFeaturesByFeatureIdEnable.mockImplementation(({ path }: { path: { featureId: string } }) => ok({
      app: path.featureId === "places"
        ? app([{ ...places, enabled: true, grantKey: null }, { ...bkash, grantKey: "key-bkash-after-places" }], 4)
        : app([{ ...places, enabled: true, grantKey: null }, { ...bkash, enabled: true, grantKey: null }], 5),
      changed: true,
      hookError: null,
    }));
    await render({ superAdmin: true, permissions: ["apps.view", "apps.manage"] });
    await vi.waitFor(() => expect(host.querySelector("#setup-feature-places")).not.toBeNull());

    const box = (id: string) => host.querySelector<HTMLButtonElement>(`#setup-feature-${id}`)!;
    expect(box("places").getAttribute("aria-checked")).toBe("true");
    expect(box("bkash").getAttribute("aria-checked")).toBe("false");
    await act(async () => box("bkash").click());
    const review = [...host.querySelectorAll("button")].find((button) => button.textContent === "Review 2 features")!;
    await act(async () => review.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Turn on 2 features?");
    expect(dialog.textContent).toContain("tokenized.pay.bka.sh");
    expect(dialog.textContent).toContain("Run scheduled jobs");
    const turnOn = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Turn on")!;
    await act(async () => turnOn.click());
    await vi.waitFor(() => expect(sdk.postApiV1AdminAppsByIdFeaturesByFeatureIdEnable).toHaveBeenCalledTimes(2));
    // Each feature with its own key, the second with the key the first answer carried.
    expect(sdk.postApiV1AdminAppsByIdFeaturesByFeatureIdEnable.mock.calls.map(([call]) => call)).toEqual([
      { path: { id: "scalius.bangladesh", featureId: "places" }, body: { expectedRevision: 3, grantKey: "key-places" } },
      { path: { id: "scalius.bangladesh", featureId: "bkash" }, body: { expectedRevision: 4, grantKey: "key-bkash-after-places" } },
    ]);
  });
});
