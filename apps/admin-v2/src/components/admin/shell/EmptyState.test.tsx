// @vitest-environment happy-dom

import { Inbox } from "lucide-react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmptyState } from "./EmptyState";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("EmptyState", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render(ui: ReactNode) {
    await act(async () => {
      root.render(ui);
    });
  }

  it("names the state with its heading and shows the icon and body", async () => {
    await render(
      <EmptyState
        icon={Inbox}
        heading="No delivery providers"
        body="Connect a courier to print labels and track parcels."
      />,
    );

    const state = host.querySelector<HTMLElement>('[data-testid="empty-state"]')!;
    const heading = host.querySelector("h3")!;
    expect(heading.textContent).toBe("No delivery providers");
    expect(state.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(state.textContent).toContain("Connect a courier");
    expect(state.querySelector("svg")).not.toBeNull();
  });

  it("fires the primary action and renders the secondary one as a link", async () => {
    const onClick = vi.fn();
    await render(
      <EmptyState
        heading="No providers"
        action={{ label: "Connect provider", onClick }}
        secondaryAction={{ label: "Read the guide", href: "/docs/delivery" }}
      />,
    );

    const primary = Array.from(host.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === "Connect provider",
    )!;
    await act(async () => primary.click());
    expect(onClick).toHaveBeenCalledTimes(1);

    const link = host.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe("/docs/delivery");
    expect(link.textContent).toContain("Read the guide");
  });

  it("respects a disabled action and can drop its border for in-table use", async () => {
    await render(
      <EmptyState
        heading="No providers"
        compact
        bordered={false}
        action={{ label: "Connect provider", disabled: true }}
      />,
    );

    expect(host.querySelector("button")!.disabled).toBe(true);
    expect(host.querySelector('[data-testid="empty-state"]')!.className).not.toContain("border");
  });
});
