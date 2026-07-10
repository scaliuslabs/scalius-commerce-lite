// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AssistantDock,
  AssistantDockLayout,
  AssistantDockResizeHandle,
} from "./assistant-dock";
import {
  AssistantFeaturedResult,
  AssistantResultList,
  AssistantShortAnswer,
  AssistantToolProgress,
  type AssistantResult,
} from "./assistant-results";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("AssistantDock", () => {
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

  it("renders bounded semantic regions in a real dock layout", () => {
    act(() => {
      root.render(
        <AssistantDockLayout
          mode="docked"
          side="start"
          width={410}
          dock={
            <AssistantDock
              id="test-assistant"
              mode="docked"
              side="start"
              heading="Shopping assistant"
              status="working"
              statusLabel="Finding products"
              context={<span>Running shoes</span>}
              conversation={<p>Conversation</p>}
              composer={<textarea aria-label="Ask a question" />}
              onModeChange={() => undefined}
            />
          }
        >
          <div>Storefront</div>
        </AssistantDockLayout>,
      );
    });

    const layout = host.querySelector<HTMLElement>(
      "[data-assistant-dock-layout]",
    );
    expect(layout?.dataset.mode).toBe("docked");
    expect(layout?.dataset.side).toBe("start");
    expect(layout?.style.getPropertyValue("--sc-assistant-dock-width")).toBe(
      "410px",
    );
    expect(
      host.querySelector("[data-assistant-page-slot]")?.textContent,
    ).toContain("Storefront");
    expect(host.querySelector("aside")?.getAttribute("aria-label")).toBe(
      "Shopping assistant",
    );
    expect(
      host.querySelector('[aria-label="Current page"]')?.textContent,
    ).toContain("Running shoes");
    expect(
      host.querySelector('[aria-label="Conversation"]')?.textContent,
    ).toContain("Conversation");
    expect(
      host.querySelector('[aria-label="Message composer"] textarea'),
    ).not.toBeNull();
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain(
      "Finding products",
    );
  });

  it("hides a closed dock without leaving a mobile backdrop", () => {
    act(() => {
      root.render(
        <AssistantDockLayout mode="closed" mobile dock={null}>
          <button>Page action</button>
        </AssistantDockLayout>,
      );
    });
    expect(
      host.querySelector<HTMLElement>("[data-assistant-dock-slot]")?.hidden,
    ).toBe(true);
    expect(
      host.querySelector("[data-assistant-page-slot]")?.hasAttribute("inert"),
    ).toBe(false);
  });

  it("makes the mobile sheet modal, inert, scroll-locked, and focus-contained", () => {
    act(() => {
      root.render(
        <AssistantDockLayout
          mode="floating"
          mobile
          dock={
            <AssistantDock
              id="mobile-assistant"
              mode="floating"
              heading="Shopping assistant"
              conversation={<button>First action</button>}
              composer={<textarea aria-label="Message" />}
              onModeChange={() => undefined}
            />
          }
        >
          <button>Page action</button>
        </AssistantDockLayout>,
      );
    });

    const page = host.querySelector<HTMLElement>("[data-assistant-page-slot]");
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
    const focusables =
      dialog?.querySelectorAll<HTMLElement>("button, textarea");
    expect(page?.hasAttribute("inert")).toBe(true);
    expect(page?.getAttribute("aria-hidden")).toBe("true");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(dialog);

    const first = focusables?.[0];
    const last = focusables?.[focusables.length - 1];
    act(() => {
      last?.focus();
      last?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(first);

    act(() => {
      root.render(
        <AssistantDockLayout
          mode="collapsed"
          mobile
          dock={
            <AssistantDock
              id="mobile-assistant"
              mode="collapsed"
              heading="Shopping assistant"
              conversation={null}
              composer={null}
              onModeChange={() => undefined}
            />
          }
        >
          <button>Page action</button>
        </AssistantDockLayout>,
      );
    });
    expect(document.body.style.overflow).toBe("");
    expect(document.documentElement.style.overflow).toBe("");
    expect(
      host.querySelector("[data-assistant-page-slot]")?.hasAttribute("inert"),
    ).toBe(false);
  });

  it("collapses on Escape and exposes an accessible launcher", () => {
    const onModeChange = vi.fn();
    const renderDock = (mode: "floating" | "collapsed") => (
      <AssistantDock
        id="test-assistant"
        mode={mode}
        heading="Store assistant"
        conversation={<p />}
        composer={<textarea />}
        onModeChange={onModeChange}
      />
    );

    act(() => root.render(renderDock("floating")));
    const dock = host.querySelector("aside");
    act(() =>
      dock?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(onModeChange).toHaveBeenCalledWith("collapsed");

    act(() => root.render(renderDock("collapsed")));
    const launcher = host.querySelector<HTMLButtonElement>("button");
    expect(launcher?.getAttribute("aria-controls")).toBe("test-assistant");
    expect(launcher?.getAttribute("aria-expanded")).toBe("false");
    expect(launcher?.getAttribute("aria-label")).toBe("Open Store assistant");
    act(() => launcher?.click());
    expect(onModeChange).toHaveBeenLastCalledWith("floating");
  });

  it("supports keyboard resizing with side-aware direction and limits", () => {
    const onWidthChange = vi.fn();
    act(() => {
      root.render(
        <AssistantDockResizeHandle
          side="end"
          width={392}
          minimumWidth={320}
          maximumWidth={420}
          onWidthChange={onWidthChange}
        />,
      );
    });
    const handle = host.querySelector<HTMLElement>('[role="separator"]');
    expect(handle?.getAttribute("aria-valuenow")).toBe("392");

    act(() =>
      handle?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      ),
    );
    expect(onWidthChange).toHaveBeenLastCalledWith(416);
    act(() =>
      handle?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    expect(onWidthChange).toHaveBeenLastCalledWith(420);
  });
});

describe("assistant rich-result bounds", () => {
  let host: HTMLDivElement;
  let root: Root;
  const results: AssistantResult[] = Array.from({ length: 6 }, (_, index) => ({
    id: String(index),
    title: `Product ${index + 1}`,
    description: "A compact product summary",
    action: { label: "Open", href: `/products/${index + 1}` },
  }));

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("never renders more than three result rows in the rail", () => {
    act(() => {
      root.render(
        <AssistantResultList
          items={results}
          maximumVisible={99}
          onShowAll={() => undefined}
        />,
      );
    });
    expect(host.querySelectorAll("[data-assistant-result-row]")).toHaveLength(
      3,
    );
    expect(
      host.querySelector("[data-assistant-result-list] button")?.textContent,
    ).toContain("View all 6 results");
  });

  it("fails closed for model-provided off-origin or malformed result paths", () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(
        <AssistantResultList
          items={[
            {
              id: "absolute",
              title: "Absolute",
              action: {
                label: "Unsafe absolute",
                href: "https://evil.example",
              },
            },
            {
              id: "protocol-relative",
              title: "Protocol relative",
              action: { label: "Unsafe host", href: "//evil.example/path" },
            },
            {
              id: "fallback",
              title: "Trusted callback",
              action: {
                label: "Use host action",
                href: "/products/../admin",
                onSelect,
              },
            },
          ]}
        />,
      );
    });

    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).not.toContain("Unsafe absolute");
    expect(host.textContent).not.toContain("Unsafe host");
    const fallback = host.querySelector<HTMLButtonElement>("button");
    expect(fallback?.textContent).toContain("Use host action");
    act(() => fallback?.click());
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("keeps details and tool work collapsed by default", () => {
    act(() => {
      root.render(
        <>
          <AssistantShortAnswer
            summary={"Clear answer ".repeat(80)}
            details={<p>Long explanation</p>}
          />
          <AssistantToolProgress
            label="Checking inventory"
            steps={[
              { id: "1", label: "Find product", status: "complete" },
              { id: "2", label: "Check stock", status: "running" },
            ]}
          />
        </>,
      );
    });

    const answer = host.querySelector("[data-assistant-short-answer] > p");
    expect(answer?.textContent.length ?? 0).toBeLessThanOrEqual(421);
    const disclosures = host.querySelectorAll<HTMLDetailsElement>("details");
    expect(disclosures).toHaveLength(2);
    expect([...disclosures].every((entry) => !entry.open)).toBe(true);
    expect(
      host.querySelector("[data-assistant-tool-progress] summary")?.textContent,
    ).toContain("Working · 1/2");
  });

  it("renders one featured recommendation without creating a grid", () => {
    act(() => {
      root.render(<AssistantFeaturedResult result={results[0]!} />);
    });
    expect(
      host.querySelectorAll("[data-assistant-featured-result]"),
    ).toHaveLength(1);
    expect(
      host.querySelector("[data-assistant-featured-result]")?.textContent,
    ).toContain("Product 1");
    expect(host.querySelector("table")).toBeNull();
  });
});
