// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SettingsSection } from "./SettingsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SettingsSection", () => {
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

  function section() {
    return host.querySelector<HTMLElement>('[data-testid="settings-section"]')!;
  }

  it("annotates the card with a heading and description", async () => {
    await render(
      <SettingsSection
        title="Public origins"
        description="Shared by the API, storefront, and dashboard Workers."
        id="platform-origins"
      >
        <input aria-label="Storefront URL" />
      </SettingsSection>,
    );

    const heading = host.querySelector("h2")!;
    expect(heading.textContent).toBe("Public origins");
    expect(section().getAttribute("aria-labelledby")).toBe(heading.id);
    expect(section().id).toBe("platform-origins");
    expect(host.textContent).toContain("Shared by the API");
    expect(host.querySelector('input[aria-label="Storefront URL"]')).not.toBeNull();
  });

  it("omits the description, footer and action row when they are not supplied", async () => {
    await render(
      <SettingsSection title="Customer sessions">
        <p>Body</p>
      </SettingsSection>,
    );

    expect(host.querySelectorAll("p")).toHaveLength(1);
    expect(host.textContent).toBe("Customer sessionsBody");
  });

  it("renders the footer note and the header actions slot", async () => {
    await render(
      <SettingsSection
        title="Extra CORS origins"
        footer={<span>At most 10 origins.</span>}
        actions={<button type="button">Add origin</button>}
      >
        <p>Body</p>
      </SettingsSection>,
    );

    expect(host.textContent).toContain("At most 10 origins.");
    const action = host.querySelector("button")!;
    expect(action.textContent).toBe("Add origin");
  });

  it("stacks to a single column below lg", async () => {
    await render(
      <SettingsSection title="Public origins">
        <p>Body</p>
      </SettingsSection>,
    );

    // Grid columns are only declared from `lg` upward, so narrow widths stack.
    expect(section().className).toContain("@3xl:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]");
    expect(section().className).toContain("@container");
    expect(section().className).not.toMatch(/(^|\s)grid-cols-/);
  });
});
