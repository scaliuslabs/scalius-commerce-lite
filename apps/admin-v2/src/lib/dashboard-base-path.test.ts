// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DASHBOARD_BASE_PATH_META_NAME,
  getDashboardBasePath,
  resetDashboardBasePathCache,
  withDashboardBasePath,
} from "./dashboard-base-path";

function setMeta(content: string | null) {
  document.head.querySelector(`meta[name="${DASHBOARD_BASE_PATH_META_NAME}"]`)?.remove();
  if (content === null) return;
  const meta = document.createElement("meta");
  meta.setAttribute("name", DASHBOARD_BASE_PATH_META_NAME);
  meta.setAttribute("content", content);
  document.head.append(meta);
}

describe("dashboard base path", () => {
  beforeEach(() => {
    resetDashboardBasePathCache();
  });

  afterEach(() => {
    setMeta(null);
    resetDashboardBasePathCache();
  });

  it("reads the meta tag the API Worker writes into the shell", () => {
    setMeta("/dashboard/");
    expect(getDashboardBasePath()).toBe("/dashboard");
    expect(withDashboardBasePath("/api/v1/admin/products")).toBe("/dashboard/api/v1/admin/products");
    // Absolute and inlined asset URLs already carry their location.
    expect(withDashboardBasePath("https://admin.example.com/assets/immutable/logo.png"))
      .toBe("https://admin.example.com/assets/immutable/logo.png");
    expect(withDashboardBasePath("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    // Memoized: a later DOM change does not move the dashboard.
    setMeta("/other");
    expect(getDashboardBasePath()).toBe("/dashboard");
  });

  it("falls back to the host root without a meta tag or with an invalid one", () => {
    setMeta(null);
    expect(getDashboardBasePath()).toBe("");
    expect(withDashboardBasePath("/auth/login")).toBe("/auth/login");
    resetDashboardBasePathCache();
    setMeta("/Not Valid");
    expect(getDashboardBasePath()).toBe("");
  });
});
