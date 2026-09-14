// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FormCard } from "./FormCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("FormCard", () => {
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

  it("renders a heading, description, actions and footer", async () => {
    await render(
      <FormCard
        title="Shipment"
        description="Courier and tracking for this order."
        actions={<button type="button">Refresh</button>}
        footer={<span>Updated 2 minutes ago</span>}
      >
        <p>Body</p>
      </FormCard>,
    );

    const card = host.querySelector<HTMLElement>('[data-testid="form-card"]')!;
    const heading = host.querySelector("h2")!;
    expect(heading.textContent).toBe("Shipment");
    expect(card.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(host.textContent).toContain("Courier and tracking");
    expect(host.querySelector("button")!.textContent).toBe("Refresh");
    expect(host.textContent).toContain("Updated 2 minutes ago");
  });

  it("renders only the content when no header or footer is supplied", async () => {
    await render(
      <FormCard>
        <p>Body</p>
      </FormCard>,
    );

    const card = host.querySelector<HTMLElement>('[data-testid="form-card"]')!;
    expect(host.querySelector("h2")).toBeNull();
    expect(card.getAttribute("aria-labelledby")).toBeNull();
    expect(card.textContent).toBe("Body");
  });
});
