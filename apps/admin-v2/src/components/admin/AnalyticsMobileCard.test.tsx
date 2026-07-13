// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsMobileCard } from "./AnalyticsMobileCard";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AnalyticsMobileCard", () => {
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

  it("exposes readiness, delivery, repair context, and named mobile actions", async () => {
    const onActivate = vi.fn();
    const onTrash = vi.fn();

    await act(async () => root.render(
      <AnalyticsMobileCard
        script={{
          id: "analytics_1",
          name: "Storefront GA4",
          type: "google_analytics",
          isActive: false,
          usePartytown: true,
          location: "body_end",
          revision: 4,
          createdAt: new Date("2026-07-01T00:00:00Z"),
          updatedAt: new Date("2026-07-13T00:00:00Z"),
          deletedAt: null,
          identifier: "G-••••7AB",
          readiness: "ready_to_activate",
          configIssue: "Review consent settings before activation.",
        }}
        showTrashed={false}
        canEdit
        canToggle
        isMutating={false}
        onActivate={onActivate}
        onDeactivate={vi.fn()}
        onTrash={onTrash}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
      />,
    ));

    expect(host.querySelector("article")).toBeTruthy();
    expect(host.textContent).toContain("Storefront GA4");
    expect(host.textContent).toContain("Google Analytics 4");
    expect(host.querySelector('img[src="/provider-marks/google-analytics.svg"]')).toBeTruthy();
    expect(host.textContent).toContain("G-••••7AB");
    expect(host.textContent).toContain("Ready to activate");
    expect(host.textContent).toContain("Review consent settings before activation.");
    expect(host.textContent).toContain("Body end");
    expect(host.textContent).toContain("Worker");

    const activate = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Activate",
    );
    const trash = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Move to trash",
    );
    expect(activate).toBeTruthy();
    expect(trash).toBeTruthy();
    expect(host.querySelector("a")?.textContent?.trim()).toBe("Edit");

    act(() => activate?.click());
    act(() => trash?.click());
    expect(onActivate).toHaveBeenCalledOnce();
    expect(onTrash).toHaveBeenCalledOnce();
  });
});
