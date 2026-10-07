// @vitest-environment happy-dom
// Home's setup guide: steps come from the store's data, a step is checked only
// when the data says so, a role sees only the steps it can open, and
// dismissing is a request to the server.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ postApiV1AdminDashboardSetupGuideDismiss: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...props }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)} {...props}>{children}</a>
  ),
}));

import { translate } from "~/i18n";
import { setupGuideMessages } from "~/i18n/setup-guide";
import { queryKeys } from "~/lib/query-keys";
import SetupGuide, { setupGuideSteps, type SetupGuideData } from "./SetupGuide";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof (typeof setupGuideMessages)["en"], vars?: Record<string, string | number>) => translate(setupGuideMessages, key, vars);

const NOTHING_DONE: SetupGuideData = {
  dismissed: false,
  countryCode: "US",
  setupNeeded: false,
  steps: { product: false, details: false, theme: false, payments: false, shipping: false, domain: false, order: false },
  bangladeshPack: null,
};
const guide = (patch: Partial<SetupGuideData> & { steps?: Partial<SetupGuideData["steps"]> } = {}): SetupGuideData => ({
  ...NOTHING_DONE,
  ...patch,
  steps: { ...NOTHING_DONE.steps, ...patch.steps },
});
const everything = () => true;

describe("setup guide steps", () => {
  it("lists a store's first steps in order, each done only when its data says so", () => {
    const steps = setupGuideSteps(guide({ steps: { product: true, payments: true } }), everything);
    expect(steps.map((step) => [step.key, step.done])).toEqual([
      ["details", false],
      ["product", true],
      ["theme", false],
      ["payments", true],
      ["shipping", false],
      ["domain", false],
      ["order", false],
    ]);
  });

  it("shows the Bangladesh pack only for a Bangladesh store whose deployment has it", () => {
    expect(setupGuideSteps(guide(), everything).some((step) => step.key === "pack")).toBe(false);
    const withPack = setupGuideSteps(guide({ countryCode: "BD", bangladeshPack: { active: true } }), everything);
    expect(withPack.find((step) => step.key === "pack")).toMatchObject({ done: true, to: "/admin/apps/$pluginId", params: { pluginId: "scalius.bangladesh" } });
    expect(withPack.find((step) => step.key === "payments")?.body).toBe("paymentsBodyBd");
  });

  it("opens the new-store setup while it still applies, and Settings after", () => {
    expect(setupGuideSteps(guide({ setupNeeded: true }), everything)[0]?.to).toBe("/admin/welcome");
    expect(setupGuideSteps(guide(), everything)[0]?.to).toBe("/admin/settings/store");
  });

  it("drops the steps a role cannot open", () => {
    const steps = setupGuideSteps(guide(), (to) => to === "/admin/products/new" || to === "/admin/orders/new");
    expect(steps.map((step) => step.key)).toEqual(["product", "order"]);
  });
});

describe("setup guide card", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const show = (data: SetupGuideData) => act(() => root.render(
    <QueryClientProvider client={queryClient}>
      <SetupGuide guide={data} canOpen={everything} />
    </QueryClientProvider>,
  ));

  it("counts the finished steps and opens the first one left", () => {
    show(guide({ steps: { details: true, product: true } }));
    expect(container.textContent).toContain(t("title"));
    expect(container.textContent).toContain(t("progress", { done: 2, total: 7 }));
    expect(container.querySelector("[role=progressbar]")).not.toBeNull();
    // The first unfinished step (theme) is open, with its action.
    const open = container.querySelector("[data-state=open][data-slot=accordion-item]")!;
    expect(open.textContent).toContain(t("theme"));
    expect(open.querySelector("a")?.getAttribute("href")).toBe("/admin/online-store/theme");
  });

  it("says the store is ready when every step is done", () => {
    show(guide({ steps: { product: true, details: true, theme: true, payments: true, shipping: true, domain: true, order: true } }));
    expect(container.textContent).toContain(t("allDoneTitle"));
  });

  it("collapses to its header", async () => {
    show(guide());
    expect(container.querySelector("[data-slot=accordion]")).not.toBeNull();
    const toggle = container.querySelector(`button[aria-label="${t("collapse")}"]`) as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(container.querySelector("[data-slot=accordion]")).toBeNull();
    expect(container.querySelector(`button[aria-label="${t("expand")}"]`)?.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the dismissal on the server and hides the card from the cache", async () => {
    sdk.postApiV1AdminDashboardSetupGuideDismiss.mockResolvedValue({ data: { success: true, data: { dismissed: true } }, response: { status: 200 } });
    queryClient.setQueryData(queryKeys.dashboard.setupGuide(), guide());
    show(guide());
    const trigger = container.querySelector(`button[aria-label="${t("options")}"]`) as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    });
    const item = [...document.body.querySelectorAll("[role=menuitem]")].find((entry) => entry.textContent === t("dismiss")) as HTMLElement;
    await act(async () => item.click());
    await vi.waitFor(() => expect(sdk.postApiV1AdminDashboardSetupGuideDismiss).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(queryClient.getQueryData<SetupGuideData>(queryKeys.dashboard.setupGuide())?.dismissed).toBe(true));
  });
});
