// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SkeletonPage } from "./SkeletonPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SkeletonPage", () => {
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

  it("draws a header and two sections by default, and announces loading", async () => {
    await render(<SkeletonPage />);

    const page = host.querySelector<HTMLElement>('[data-testid="skeleton-page"]')!;
    expect(page.getAttribute("role")).toBe("status");
    expect(page.getAttribute("aria-busy")).toBe("true");
    expect(page.querySelector(".sr-only")!.textContent).toBe("Loading");
    expect(host.querySelectorAll('[data-testid="skeleton-page-header"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="skeleton-page-section"]')).toHaveLength(2);
  });

  it("never falls back to a spinner", async () => {
    await render(<SkeletonPage />);
    expect(host.querySelector(".animate-spin")).toBeNull();
    expect(host.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("takes the section, row and header shape from its props", async () => {
    await render(<SkeletonPage sections={1} rowsPerSection={2} showHeader={false} label="Loading settings" />);

    expect(host.querySelector('[data-testid="skeleton-page-header"]')).toBeNull();
    const sections = host.querySelectorAll('[data-testid="skeleton-page-section"]');
    expect(sections).toHaveLength(1);
    expect(sections[0].querySelectorAll(".animate-pulse")).toHaveLength(2 + 2 * 2);
    expect(host.querySelector(".sr-only")!.textContent).toBe("Loading settings");
  });
});
