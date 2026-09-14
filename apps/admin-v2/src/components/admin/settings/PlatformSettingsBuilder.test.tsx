// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  PlatformSettingsBuilder,
  buildPlatformPatch,
  toPlatformDraft,
  validatePlatformDraft,
} from "./PlatformSettingsBuilder";
import { queryKeys } from "~/lib/query-keys";
import type { PlatformSettingsPayload } from "~/lib/api-functions/platform";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  blocker: vi.fn(),
  permission: vi.fn(),
}));
vi.mock("~/lib/api-functions/platform", () => ({
  getPlatformSettings: api.get,
  updatePlatformSettings: api.update,
}));
vi.mock("~/contexts/PermissionContext", () => ({
  usePermissions: () => ({ hasPermission: api.permission }),
}));
vi.mock("@tanstack/react-router", () => ({ useBlocker: api.blocker }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const configured: PlatformSettingsPayload = {
  storefrontUrl: "https://shop.example.com",
  apiUrl: "https://api.example.com",
  dashboardUrl: "https://dashboard.example.com",
  mediaUrl: "https://cdn.example.com",
  customerAuthCookieDomain: "example.com",
  corsAllowedOrigins: ["https://app.example.com"],
  readiness: { complete: true, missing: [] },
  effective: {
    storefrontUrl: "https://shop.example.com",
    apiUrl: "https://api.example.com",
    dashboardUrl: "https://dashboard.example.com",
    mediaUrl: "https://cdn.example.com",
  },
};

const unconfigured: PlatformSettingsPayload = {
  storefrontUrl: "http://localhost:4322",
  apiUrl: "",
  dashboardUrl: "",
  mediaUrl: "",
  customerAuthCookieDomain: "",
  corsAllowedOrigins: [],
  readiness: { complete: false, missing: ["apiUrl", "dashboardUrl", "mediaUrl"] },
  effective: {
    storefrontUrl: "http://localhost:4322",
    apiUrl: "http://localhost:8787",
    dashboardUrl: "http://localhost:4323",
    mediaUrl: "http://localhost:8787/api/v1/media",
  },
};

describe("Platform settings draft helpers", () => {
  it("sends only changed fields as a partial update", () => {
    const saved = toPlatformDraft(configured);
    expect(buildPlatformPatch(saved, saved)).toEqual({});
    expect(
      buildPlatformPatch(
        { ...saved, apiUrl: " https://api2.example.com ", corsAllowedOrigins: [] },
        saved,
      ),
    ).toEqual({ apiUrl: "https://api2.example.com", corsAllowedOrigins: [] });
    expect(
      buildPlatformPatch({ ...saved, customerAuthCookieDomain: "" }, saved),
    ).toEqual({ customerAuthCookieDomain: "" });
  });

  it("validates origins, media base, and cookie domain before save", () => {
    const draft = toPlatformDraft(configured);
    expect(validatePlatformDraft(draft)).toEqual({});
    expect(validatePlatformDraft({ ...draft, storefrontUrl: "" })).toMatchObject({
      storefrontUrl: expect.stringContaining("cannot be cleared"),
    });
    expect(validatePlatformDraft({ ...draft, apiUrl: "http://api.example.com" })).toMatchObject({
      apiUrl: expect.stringContaining("HTTPS origin"),
    });
    expect(validatePlatformDraft({ ...draft, dashboardUrl: "https://dashboard.example.com/admin" })).toMatchObject({
      dashboardUrl: expect.stringContaining("without credentials, path"),
    });
    expect(validatePlatformDraft({ ...draft, mediaUrl: "https://cdn.example.com/media?x=1" })).toMatchObject({
      mediaUrl: expect.stringContaining("HTTPS base URL"),
    });
    expect(validatePlatformDraft({ ...draft, mediaUrl: "https://cdn.example.com/media" })).toEqual({});
    expect(validatePlatformDraft({ ...draft, customerAuthCookieDomain: "https://example.com" })).toMatchObject({
      customerAuthCookieDomain: expect.stringContaining("bare hostname"),
    });
    // Optional values may be cleared.
    expect(
      validatePlatformDraft({ ...draft, apiUrl: "", dashboardUrl: "", mediaUrl: "", customerAuthCookieDomain: "" }),
    ).toEqual({});
  });
});

describe("PlatformSettingsBuilder", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.resetAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.blocker.mockReturnValue({ status: "idle", proceed: vi.fn(), reset: vi.fn() });
    api.permission.mockReturnValue(true);
    api.get.mockResolvedValue(configured);
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  // TanStack Query publishes results through a macrotask; flush until the
  // loading spinner is gone (bounded so a broken render still fails fast).
  async function settle() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (!host.querySelector(".animate-spin")) return;
    }
  }
  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PlatformSettingsBuilder />
        </QueryClientProvider>,
      );
    });
    await settle();
  }
  function input(id: string) {
    return host.querySelector<HTMLInputElement>(`#${id}`)!;
  }
  function button(label: string) {
    return Array.from(host.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === label,
    );
  }
  async function type(target: HTMLInputElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(target, value);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(target: HTMLElement) {
    await act(async () => {
      target.click();
    });
    await settle();
  }
  function readiness() {
    return host.querySelector<HTMLElement>('[data-testid="platform-readiness"]')!;
  }

  it("loads the saved origins and reports complete readiness", async () => {
    await render();

    expect(input("platform-storefrontUrl").value).toBe("https://shop.example.com");
    expect(input("platform-apiUrl").value).toBe("https://api.example.com");
    expect(input("platform-dashboardUrl").value).toBe("https://dashboard.example.com");
    expect(input("platform-mediaUrl").value).toBe("https://cdn.example.com");
    expect(input("platform-customerAuthCookieDomain").value).toBe("example.com");
    expect(host.textContent).toContain("https://app.example.com");
    expect(readiness().getAttribute("role")).toBe("status");
    expect(readiness().textContent).toContain("Platform origins configured");
    expect(host.textContent).not.toContain("automatic fallback");
    expect(button("Save platform")).toBeUndefined();
  });

  it("shows missing origins prominently and the effective fallback per field", async () => {
    api.get.mockResolvedValue(unconfigured);
    await render();

    expect(readiness().getAttribute("role")).toBe("alert");
    expect(readiness().textContent).toContain("Platform origins not configured");
    expect(readiness().textContent).toContain("Missing: API URL, Dashboard URL, Media URL");
    expect(host.textContent).toContain("http://localhost:8787/api/v1/media");
    expect(host.textContent).toContain("http://localhost:4323");
    expect(host.textContent).toContain("automatic fallback");
    // The saved storefront origin is not a fallback.
    expect(input("platform-storefrontUrl").value).toBe("http://localhost:4322");
    expect(host.textContent?.match(/automatic fallback/g)).toHaveLength(3);
  });

  it("saves a partial patch, keeps the acknowledged response, and refreshes dependent queries", async () => {
    const saved: PlatformSettingsPayload = {
      ...configured,
      apiUrl: "https://api2.example.com",
      corsAllowedOrigins: ["https://app.example.com", "https://portal.example.com"],
    };
    api.update.mockResolvedValue(saved);
    queryClient.setQueryData(queryKeys.settings.storefrontUrl(), { storefrontUrl: "https://shop.example.com" });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await render();

    await type(input("platform-apiUrl"), "https://api2.example.com");
    await type(input("platform-cors-draft"), "https://portal.example.com");
    await click(button("Add origin")!);
    expect(host.textContent).toContain("https://portal.example.com");
    await click(button("Save platform")!);

    expect(api.update).toHaveBeenCalledWith({
      data: {
        apiUrl: "https://api2.example.com",
        corsAllowedOrigins: ["https://app.example.com", "https://portal.example.com"],
      },
    });
    expect(queryClient.getQueryData(queryKeys.settings.platform())).toEqual(saved);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.settings.storefrontUrl() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["settings", "security", "inherited-sources"] });
    expect(toast.success).toHaveBeenCalledWith("Platform origins saved");
    expect(button("Save platform")).toBeUndefined();
    expect(input("platform-apiUrl").value).toBe("https://api2.example.com");
  });

  it("blocks saving invalid values and surfaces the field error", async () => {
    await render();

    await type(input("platform-apiUrl"), "http://api.example.com");

    const save = button("Save platform")!;
    expect(save.disabled).toBe(true);
    expect(input("platform-apiUrl").getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector("#platform-apiUrl-help")?.textContent).toContain("HTTPS origin");
    expect(api.update).not.toHaveBeenCalled();

    await click(button("Reset")!);
    expect(input("platform-apiUrl").value).toBe("https://api.example.com");
    expect(button("Save platform")).toBeUndefined();
  });

  it("rejects malformed or duplicate extra CORS origins before they reach the draft", async () => {
    await render();

    await type(input("platform-cors-draft"), "https://app.example.com");
    await click(button("Add origin")!);
    expect(host.querySelector("#platform-cors-help")?.textContent).toContain("already listed");

    await type(input("platform-cors-draft"), "not a url");
    await click(button("Add origin")!);
    expect(host.querySelector("#platform-cors-help")?.textContent).toContain("HTTPS origin");
    expect(host.querySelectorAll('[aria-label^="Remove "]')).toHaveLength(1);
  });

  it("keeps the failed save draft and reports the API error", async () => {
    api.update.mockRejectedValue(new Error("API URL must be an HTTPS origin"));
    await render();

    await type(input("platform-dashboardUrl"), "https://dash2.example.com");
    await click(button("Save platform")!);

    expect(toast.error).toHaveBeenCalledWith("API URL must be an HTTPS origin");
    expect(input("platform-dashboardUrl").value).toBe("https://dash2.example.com");
    expect(button("Save platform")).toBeDefined();
  });

  it("locks editing without the general settings edit permission", async () => {
    api.permission.mockReturnValue(false);
    await render();

    expect(host.textContent).toContain("cannot change them");
    expect(input("platform-apiUrl").disabled).toBe(true);
    expect(input("platform-cors-draft").disabled).toBe(true);
  });

  it("fails closed when the settings cannot be loaded", async () => {
    api.get.mockRejectedValue(new Error("boom"));
    await render();

    expect(host.textContent).toContain("Platform origins unavailable");
    expect(host.querySelector("#platform-apiUrl")).toBeNull();
  });
});
