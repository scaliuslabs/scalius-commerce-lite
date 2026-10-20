// @vitest-environment happy-dom
// Home's setup guide: steps come from the store's data, a step is checked only
// when the data says so, a role sees only the steps it can open, and
// dismissing is a request to the server.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ postApiV1AdminDashboardSetupGuideDismiss: vi.fn(), postApiV1AdminDashboardSetupGuideShow: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => sdk);
const toasts = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("~/lib/toast", () => toasts);
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
  onlinePayment: { ready: null, blockedProducts: 0 },
  drafts: { count: 0, newestId: null },
  testOrderUrl: null,
};
const guide = (patch: Partial<Omit<SetupGuideData, "steps">> & { steps?: Partial<SetupGuideData["steps"]> } = {}): SetupGuideData => ({
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

  it("never shows a regional step for another country, whatever the data holds", () => {
    const steps = setupGuideSteps(guide({ countryCode: "US", bangladeshPack: { active: false } }), everything);
    expect(steps.some((step) => step.key === "pack")).toBe(false);
  });

  it("opens the new-store setup while it still applies, and Settings after", () => {
    expect(setupGuideSteps(guide({ setupNeeded: true }), everything)[0]?.to).toBe("/admin/welcome");
    expect(setupGuideSteps(guide(), everything)[0]?.to).toBe("/admin/settings/store");
  });

  it("counts only live products, and opens the drafts to make them active", () => {
    const one = setupGuideSteps(guide({ drafts: { count: 1, newestId: "prod_1" } }), everything).find((step) => step.key === "product");
    expect(one).toMatchObject({ done: false, draftCount: 1, action: "draftsAction", to: "/admin/products/$productId/edit", params: { productId: "prod_1" } });
    const many = setupGuideSteps(guide({ drafts: { count: 3, newestId: "prod_3" } }), everything).find((step) => step.key === "product");
    expect(many).toMatchObject({ draftCount: 3, to: "/admin/products", search: { status: "draft" } });
    // A live product finishes the step, drafts or not.
    const live = setupGuideSteps(guide({ steps: { product: true }, drafts: { count: 3, newestId: "prod_3" } }), everything).find((step) => step.key === "product");
    expect(live).toMatchObject({ done: true, to: "/admin/products/new" });
    expect(live?.draftCount).toBeUndefined();
  });

  it("tests an order through the storefront once it can, and the order form until then", () => {
    const manual = setupGuideSteps(guide(), everything).find((step) => step.key === "order");
    expect(manual).toMatchObject({ to: "/admin/orders/new", body: "orderBodyManual", action: "orderManualAction" });
    const storefront = setupGuideSteps(guide({ testOrderUrl: "https://shop.example.com/buy/panjabi" }), everything).find((step) => step.key === "order");
    expect(storefront).toMatchObject({ href: "https://shop.example.com/buy/panjabi", body: "orderBody" });
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
    const open = container.querySelector("button[aria-expanded=true][aria-controls^=setup-step]")!;
    expect(open.textContent).toContain(t("theme"));
    expect(container.querySelectorAll("button[aria-expanded=true][aria-controls^=setup-step]")).toHaveLength(1);
    expect(container.querySelector(`#${open.getAttribute("aria-controls")} a`)?.getAttribute("href")).toBe("/admin/online-store/theme");
    // Choosing another step opens it and closes the first.
    const details = container.querySelector("button[aria-controls=setup-step-details]") as HTMLButtonElement;
    act(() => details.click());
    expect(container.querySelector("button[aria-expanded=true][aria-controls^=setup-step]")?.textContent).toContain(t("details"));
  });

  it("on a phone shows only the next step until asked for the rest", () => {
    (window as unknown as { happyDOM: { setViewport: (size: { width: number; height: number }) => void } }).happyDOM.setViewport({ width: 390, height: 844 });
    try {
      show(guide({ steps: { details: true, product: true } }));
      expect(container.querySelectorAll("button[aria-controls^=setup-step]")).toHaveLength(1);
      expect(container.querySelector("button[aria-controls^=setup-step]")?.textContent).toContain(t("theme"));
      const more = [...container.querySelectorAll("button")].find((button) => button.textContent === t("showAllSteps", { count: 7 }))!;
      act(() => more.click());
      expect(container.querySelectorAll("button[aria-controls^=setup-step]")).toHaveLength(7);
      expect(container.textContent).toContain(t("showFewerSteps"));
    } finally {
      (window as unknown as { happyDOM: { setViewport: (size: { width: number; height: number }) => void } }).happyDOM.setViewport({ width: 1024, height: 768 });
    }
  });

  it("says the store is ready when every step is done", () => {
    show(guide({ steps: { product: true, details: true, theme: true, payments: true, shipping: true, domain: true, order: true } }));
    expect(container.textContent).toContain(t("allDoneTitle"));
  });

  it("collapses to its header", async () => {
    show(guide());
    expect(container.querySelector("ul")).not.toBeNull();
    const toggle = container.querySelector(`button[aria-label="${t("collapse")}"]`) as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(container.querySelector("ul")).toBeNull();
    expect(container.querySelector(`button[aria-label="${t("expand")}"]`)?.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the dismissal on the server and hides the card from the cache", async () => {
    sdk.postApiV1AdminDashboardSetupGuideDismiss.mockResolvedValue({ data: { success: true, data: { dismissed: true } }, response: { status: 200 } });
    queryClient.setQueryData(queryKeys.dashboard.setupGuide(), guide());
    show(guide());
    const dismiss = [...container.querySelectorAll("button")].find((button) => button.textContent === t("dismiss"))!;
    await act(async () => dismiss.click());
    await vi.waitFor(() => expect(sdk.postApiV1AdminDashboardSetupGuideDismiss).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(queryClient.getQueryData<SetupGuideData>(queryKeys.dashboard.setupGuide())?.dismissed).toBe(true));
    // The toast's Undo brings it back.
    expect(toasts.toast).toHaveBeenCalledWith(t("dismissed"), expect.objectContaining({ duration: 10_000, action: expect.objectContaining({ label: t("undo") }) }));
    sdk.postApiV1AdminDashboardSetupGuideShow.mockResolvedValue({ data: { success: true, data: { dismissed: false } }, response: { status: 200 } });
    const options = toasts.toast.mock.calls[0]![1] as { action: { onClick: () => void } };
    await act(async () => options.action.onClick());
    await vi.waitFor(() => expect(sdk.postApiV1AdminDashboardSetupGuideShow).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(queryClient.getQueryData<SetupGuideData>(queryKeys.dashboard.setupGuide())?.dismissed).toBe(false));
  });

  it("names the drafts on the product step and opens the storefront for a test order in a new tab", () => {
    show(guide({ steps: { details: true }, drafts: { count: 2, newestId: "prod_2" }, testOrderUrl: "https://shop.example.com/buy/panjabi" }));
    expect(container.textContent).toContain(t("draftsNote", { count: 2 }));
    expect(container.querySelector("#setup-step-product a")?.textContent).toBe(t("draftsAction"));
    act(() => (container.querySelector("button[aria-controls=setup-step-order]") as HTMLButtonElement).click());
    const link = container.querySelector("#setup-step-order a")!;
    expect(link.getAttribute("href")).toBe("https://shop.example.com/buy/panjabi");
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
