// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { STATUS_TONE_CLASSES, StatusBadge, type StatusTone } from "./StatusBadge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tones: StatusTone[] = [
  "success",
  "attention",
  "warning",
  "critical",
  "info",
  "neutral",
];

describe("StatusBadge", () => {
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

  function badge() {
    return host.querySelector<HTMLElement>('[data-testid="status-badge"]')!;
  }

  it("defaults to the neutral tone with a dot", async () => {
    await render(<StatusBadge>Draft</StatusBadge>);

    expect(badge().getAttribute("data-tone")).toBe("neutral");
    expect(badge().textContent).toBe("Draft");
    expect(host.querySelector('[data-testid="status-badge-dot"]')).not.toBeNull();
  });

  it("applies every tone and keeps a dark-mode value for each", async () => {
    for (const tone of tones) {
      await render(<StatusBadge tone={tone}>{tone}</StatusBadge>);
      expect(badge().getAttribute("data-tone")).toBe(tone);
      expect(badge().className).toContain(STATUS_TONE_CLASSES[tone].split(" ")[0]);
      expect(STATUS_TONE_CLASSES[tone]).toMatch(/dark:/);
    }
  });

  it("gives each tone its own dot colour", async () => {
    const dotClasses = new Set<string>();
    for (const tone of tones) {
      await render(<StatusBadge tone={tone}>{tone}</StatusBadge>);
      dotClasses.add(host.querySelector('[data-testid="status-badge-dot"]')!.className);
    }
    expect(dotClasses.size).toBe(tones.length);
  });

  it("can drop the dot and can carry a screen-reader-only prefix", async () => {
    await render(
      <StatusBadge tone="critical" dot={false} srLabel="Payment status:">
        Failed
      </StatusBadge>,
    );

    expect(host.querySelector('[data-testid="status-badge-dot"]')).toBeNull();
    expect(host.querySelector(".sr-only")!.textContent).toContain("Payment status:");
    expect(badge().textContent).toContain("Failed");
  });
});
