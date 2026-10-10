// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.fn(async () => undefined);
const match = { routeId: "/admin/orders/_list/", fullPath: "/admin/orders/", params: {}, meta: [{ title: "Orders · Scalius" }] };
vi.mock("~/components/admin/states/store-owner", () => ({ useStoreOwnerName: () => null }));
vi.mock("@tanstack/react-router", () => ({
  rootRouteId: "__root__",
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useRouter: () => ({ invalidate }),
  useMatch: ({ select }: { select: (value: typeof match) => unknown }) => select(match),
}));

const { RouteErrorComponent, pendingKindForPath } = await import("./route-error");
const { RouteNotFoundComponent } = await import("./route-not-found");
const { AdminApiResponseError } = await import("./admin-api-error");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(match, { routeId: "/admin/orders/_list/", fullPath: "/admin/orders/", params: {}, meta: [{ title: "Orders · Scalius" }] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Lets a lazily loaded view resolve and render. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

function show(error: Error, reset = vi.fn()) {
  act(() => root.render(<RouteErrorComponent error={error} reset={reset} />));
  return reset;
}

const text = (selector: string) => container.querySelector(selector)?.textContent;

describe("route error page (polish bar R1)", () => {
  it("keeps the page title, says what failed, offers one retry and copies only safe details", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    window.history.replaceState(null, "", "/admin/orders?search=01712345678");
    const reset = show(new Error("D1_ERROR: no such column: secret_internal"));
    const state = container.querySelector("[data-slot=error-state]")!;
    expect(state.querySelector("h1")?.textContent).toBe("Orders");
    expect(text("h2")).toBe("This page didn't load");
    expect(container.textContent).not.toContain("D1_ERROR");
    expect(container.textContent).not.toContain("Nothing changed");

    const [retry, copy] = [...container.querySelectorAll("button")];
    expect(retry?.textContent).toBe("Try again");
    act(() => retry!.click());
    expect(reset).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();

    await act(async () => copy!.click());
    const details = String((writeText.mock.calls[0] as unknown[])[0]);
    expect(details).toContain("D1_ERROR: no such column");
    expect(details).toContain("/admin/orders");
    expect(details).not.toContain("01712345678");
    expect(details).not.toMatch(/\bat\s/);
    expect(copy!.textContent).toBe("Copied");
  });

  it("tells a lost connection apart from a broken page", () => {
    show(new TypeError("Failed to fetch"));
    expect(container.textContent).toContain("Check your internet connection");
    expect(container.querySelector("[data-state-kind=unreachable]")).not.toBeNull();
  });

  it("says Scalius isn't responding on a gateway error, and offline when the browser is offline", () => {
    const reset = show(new AdminApiResponseError("API error: 502", 502));
    expect(container.textContent).toContain("Scalius isn't responding");
    expect(container.textContent).not.toContain("internet connection");
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Try again"]);
    act(() => buttons[0]!.click());
    expect(reset).toHaveBeenCalledOnce();

    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    show(new AdminApiResponseError("API error: 502", 502));
    expect(container.textContent).toContain("You're offline");
    onLine.mockRestore();
  });

  it("retries a page by itself when the connection comes back", () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const reset = show(new TypeError("Failed to fetch"));
    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(reset).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
    onLine.mockRestore();
  });

  it("never reloads while offline when a page's code failed to download", () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const setItem = vi.spyOn(window.sessionStorage, "setItem");
    show(new TypeError("Failed to fetch dynamically imported module: /assets/immutable/orders.js"));
    expect(setItem).not.toHaveBeenCalled();
    expect(container.querySelector("[data-state-kind=offline]")).not.toBeNull();
    onLine.mockRestore();
  });
});

describe("missing records and pages (R2, R4)", () => {
  it("names a missing record and links back to its list", async () => {
    Object.assign(match, { fullPath: "/admin/gift-cards/$giftCardId", params: { giftCardId: "gc_1" }, meta: [] });
    show(new AdminApiResponseError("Gift card not found", 404));
    await settle();
    expect(text("h1")).toBe("This gift card doesn't exist or was deleted");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/admin/gift-cards");
    expect(container.querySelector("a")?.textContent).toBe("Back to gift cards");
  });

  it("fills a nested list's params: a missing entry goes back to its content type", () => {
    Object.assign(match, { fullPath: "/admin/metaobjects/$definitionId/entries/$entryId", params: { definitionId: "def_1", entryId: "e_9" } });
    act(() => root.render(<RouteNotFoundComponent />));
    expect(text("h1")).toBe("This entry doesn't exist or was deleted");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/admin/metaobjects/def_1");
  });

  it("sends an address that is no page at all to Home, and a forbidden one says who to ask", async () => {
    Object.assign(match, { fullPath: "/admin", params: {} });
    act(() => root.render(<RouteNotFoundComponent />));
    expect(text("h1")).toBe("There's no page at this address");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/admin");

    show(new AdminApiResponseError("Forbidden", 403));
    await settle();
    expect(text("h1")).toBe("You don't have access to this page");
    expect(container.textContent).toContain("Ask the store owner");
  });
});

describe("route pending view", () => {
  it("draws a detail, settings or page skeleton inside the shell, and the boot spinner elsewhere", () => {
    expect(pendingKindForPath("/admin/orders/$orderId/")).toBe("detail");
    expect(pendingKindForPath("/admin/settings/users/$userId")).toBe("settings");
    expect(pendingKindForPath("/admin/analytics")).toBe("page");
    expect(pendingKindForPath("/invoice/$orderId")).toBeNull();
    // The shell itself keeps the boot spinner until its session guard answers.
    expect(pendingKindForPath("/admin")).toBeNull();
  });
});
