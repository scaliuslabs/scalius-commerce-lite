// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeEnv: {} as Record<string, unknown>,
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("./runtime-env.server", () => ({
  getRuntimeEnv: () => mocks.runtimeEnv,
}));

import {
  DASHBOARD_BASE_PATH_META_NAME,
  getDashboardBasePath,
  readDashboardBasePathFromDocument,
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

describe("server base path", () => {
  beforeEach(() => {
    mocks.runtimeEnv = {};
  });

  it("derives the base path from the request-scoped dashboard URL", () => {
    mocks.runtimeEnv = { PLATFORM_CONFIG: { dashboardUrl: "https://shop.example.com/dashboard" } };
    expect(getDashboardBasePath()).toBe("/dashboard");
    expect(withDashboardBasePath("/api/v1/admin/products")).toBe("/dashboard/api/v1/admin/products");
  });

  it("is empty at a host root and outside a request", () => {
    mocks.runtimeEnv = { PLATFORM_CONFIG: { dashboardUrl: "https://dashboard.example.com" } };
    expect(getDashboardBasePath()).toBe("");
    mocks.runtimeEnv = {};
    expect(withDashboardBasePath("/auth/login")).toBe("/auth/login");
  });
});

describe("browser base path", () => {
  beforeEach(() => {
    resetDashboardBasePathCache();
  });

  afterEach(() => {
    setMeta(null);
    resetDashboardBasePathCache();
  });

  it("reads the meta tag rendered by the root route and normalizes it", () => {
    setMeta("/dashboard/");
    expect(readDashboardBasePathFromDocument()).toBe("/dashboard");
    // Memoized: a later DOM change does not move the dashboard.
    setMeta("/other");
    expect(readDashboardBasePathFromDocument()).toBe("/dashboard");
  });

  it("falls back to the host root without a meta tag or with an invalid one", () => {
    setMeta(null);
    expect(readDashboardBasePathFromDocument()).toBe("");
    resetDashboardBasePathCache();
    setMeta("/Not Valid");
    expect(readDashboardBasePathFromDocument()).toBe("");
  });
});
