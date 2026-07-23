import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const listSource = readFileSync(resolve(import.meta.dirname, "AnalyticsList.tsx"), "utf8");
const mobileSource = readFileSync(resolve(import.meta.dirname, "AnalyticsMobileCard.tsx"), "utf8");
const healthSource = readFileSync(resolve(import.meta.dirname, "AnalyticsProviderHealth.tsx"), "utf8");
const formSource = readFileSync(resolve(import.meta.dirname, "AnalyticsForm.tsx"), "utf8");
const routeSource = readFileSync(
  resolve(import.meta.dirname, "../../routes/admin/analytics/index.tsx"),
  "utf8",
);

describe("analytics list presentation boundaries", () => {
  it("uses a dedicated mobile card without changing the desktop table", () => {
    expect(listSource).toContain("useIsMobile");
    expect(listSource).toContain("<AnalyticsMobileCard");
    expect(listSource).toContain("<Table>");
    expect(mobileSource).not.toContain("<Table");
    expect(mobileSource).toContain("Placement");
    expect(mobileSource).toContain("Execution");
    expect(mobileSource).toContain("Move to trash");
  });

  it("distinguishes empty results from an empty account and offers recovery", () => {
    expect(listSource).toContain("No integrations match these filters");
    expect(listSource).toContain("No analytics integrations yet");
    expect(listSource).toContain("Clear filters");
    expect(listSource).toContain("Add integration");
    expect(routeSource).toContain("status: search.trashed ? undefined : search.status");
  });

  it("keeps loading and read failure truthful", () => {
    expect(routeSource).toContain("pendingComponent: AnalyticsPagePending");
    expect(routeSource).toContain("errorComponent: AnalyticsPageError");
    expect(routeSource).toContain(
      "Try again to load the integration list and current provider status.",
    );
    expect(routeSource).toContain("Loading analytics integrations");
  });

  it("keeps readiness legible in dark mode and executable source out of list UI", () => {
    expect(healthSource).toContain("dark:text-emerald-300");
    expect(healthSource).toContain("dark:text-amber-300");
    expect(listSource).not.toMatch(/script\.config(?!Issue)/);
    expect(mobileSource).not.toMatch(/script\.config(?!Issue)/);
  });

  it("keeps mobile actions touch-friendly and filter controls named", () => {
    expect(mobileSource).toContain('className="h-11 px-3"');
    expect(routeSource).toContain('className="h-11 sm:h-9"');
    expect(routeSource).toContain('aria-label="Filter by analytics provider"');
    expect(routeSource).toContain('aria-label="Filter by analytics status"');
    expect(routeSource).toContain('searchPlaceholder="Search integrations…"');
    expect(routeSource).not.toContain("Control what measures buyer activity");
    expect(healthSource).toContain("Browser ready:");
    expect(healthSource).toContain("Server ready:");
    expect(healthSource).not.toContain("browser and ${summary.serverReadyProviders} server integrations");
  });

  it("states storefront activation once without draft-safety filler", () => {
    expect(formSource).toContain("Not loaded on buyer pages.");
    expect(formSource).toContain("Loads on buyer pages after save.");
    expect(formSource.match(/getAnalyticsProviderDeliveryDefaults\(/g)).toHaveLength(3);
    expect(formSource).not.toContain("Draft-safe setup");
    expect(formSource).not.toContain("Inactive draft");
    expect(formSource).not.toContain("remains a draft until explicitly activated");
  });
});
