// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.fn(async () => undefined);
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useRouter: () => ({ invalidate }),
}));

const { RouteErrorComponent } = await import("./route-error");
const { AdminApiResponseError } = await import("./admin-api-error");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function show(error: Error, reset = vi.fn()) {
  act(() => root.render(<RouteErrorComponent error={error} reset={reset} />));
  return reset;
}

describe("route error page", () => {
  it("offers one retry, keeps the raw error off screen and copies only safe details", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    window.history.replaceState(null, "", "/admin/orders?search=01712345678");
    const reset = show(new Error("D1_ERROR: no such column: secret_internal"));
    expect(container.querySelector("h1")?.textContent).toBe("This page didn't load");
    expect(container.textContent).not.toContain("D1_ERROR");

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
    expect(container.querySelector("h1")?.textContent).toBe("Couldn't reach Scalius");
  });

  it("says Scalius isn't responding when the server answered with a gateway error, not that the connection is down", () => {
    const reset = show(new AdminApiResponseError("API error: 502", 502));
    expect(container.querySelector("h1")?.textContent).toBe("Scalius isn't responding");
    expect(container.textContent).not.toContain("internet connection");
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Try again"]);
    act(() => buttons[0]!.click());
    expect(reset).toHaveBeenCalledOnce();

    // The browser itself says it's offline: that is the connection.
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    show(new AdminApiResponseError("API error: 502", 502));
    expect(container.querySelector("h1")?.textContent).toBe("Couldn't reach Scalius");
    onLine.mockRestore();
  });

  it("treats a missing or forbidden record as a page you can leave, with a link home", () => {
    show(new AdminApiResponseError("Order not found", 404));
    expect(container.querySelector("h1")?.textContent).toBe("There's no page at this address");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/admin");

    show(new AdminApiResponseError("Forbidden", 403));
    expect(container.querySelector("h1")?.textContent).toBe("You don't have access to this page");
  });
});
