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
}));
vi.mock("@scalius/api-client/sdk", async (importOriginal) => ({ ...(await importOriginal<object>()), ...sdk }));

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
});
