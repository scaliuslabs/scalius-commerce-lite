// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import AllowedCountriesBuilder from "./AllowedCountriesBuilder";
import { queryKeys } from "~/lib/query-keys";
import type { AllowedCountriesPayload } from "~/lib/api-functions/settings";

const api = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), blocker: vi.fn(), proceed: vi.fn(), reset: vi.fn(),
}));
vi.mock("~/lib/api-functions/settings", () => ({
  getAllowedCountries: api.get, updateAllowedCountries: api.update,
}));
vi.mock("@tanstack/react-router", () => ({ useBlocker: api.blocker }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: AllowedCountriesPayload = {
  allowedCountries: ["BD", "US", "AE"], allowedCountriesMode: "include",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("AllowedCountriesBuilder save acknowledgment", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.resetAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.blocker.mockReturnValue({ status: "idle", proceed: api.proceed, reset: api.reset });
    api.get.mockResolvedValue(base);
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  async function render() {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><AllowedCountriesBuilder /></QueryClientProvider>);
    });
  }
  function radio(mode: string) {
    return host.querySelector<HTMLButtonElement>(`#mode-${mode}`)!;
  }
  function button(label: string) {
    return Array.from(document.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
  }
  function countries() {
    return Array.from(host.querySelectorAll('[aria-label^="Remove "]'))
      .map((item) => item.getAttribute("aria-label")!.replace("Remove ", ""));
  }
  async function click(target: HTMLElement) {
    await act(async () => { target.click(); });
  }
  async function toggleCountry(name: string) {
    if (!host.querySelector("#country-picker")) await click(button("Edit countries")!);
    const option = Array.from(host.querySelectorAll<HTMLButtonElement>("#country-picker button"))
      .find((item) => item.textContent?.startsWith(`${name} (`))!;
    await click(option);
  }
  function expectProtected(protectedState: boolean) {
    const guard = api.blocker.mock.calls.at(-1)![0];
    const current = {
      routeId: "/admin/settings/", fullPath: "/admin/settings/", pathname: "/admin/settings",
      search: { section: "countries" },
    };
    expect(guard.enableBeforeUnload).toBe(protectedState);
    expect(guard.shouldBlockFn({
      current,
      next: { routeId: "/admin/orders/", fullPath: "/admin/orders/", pathname: "/admin/orders" },
    })).toBe(protectedState);
    expect(guard.shouldBlockFn({
      current, next: { ...current, search: { section: "business" } },
    })).toBe(false);
  }
  function deferSave() {
    const write = deferred<void>();
    const refresh = deferred<AllowedCountriesPayload>();
    api.update.mockReturnValueOnce(write.promise);
    api.get.mockReturnValueOnce(refresh.promise);
    return { write, refresh };
  }

  it.each(["write", "refresh"])("preserves a country-list revert during the pending %s and resets to the acknowledged policy", async (phase) => {
    await render();
    await toggleCountry("Canada");
    const { write, refresh } = deferSave();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await click(button("Save country policy")!);
    expect(api.update).toHaveBeenCalledWith({ data: {
      allowedCountries: ["BD", "US", "AE", "CA"], mode: "include",
    } });
    if (phase === "refresh") await act(async () => { write.resolve(); });
    await toggleCountry("Canada");
    if (phase === "write") await act(async () => { write.resolve(); });
    const canonical = { ...base, allowedCountries: ["BD", "US", "AE", "CA"] };
    await act(async () => { refresh.resolve(canonical); });

    expect(countries()).toEqual(["Bangladesh", "United States", "United Arab Emirates"]);
    expect(button("Save country policy")?.disabled).toBe(false);
    expectProtected(true);
    expect(toast.success).toHaveBeenCalledWith("Country policy saved");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.settings.checkoutReadiness() });
    expect(queryClient.getQueryData(queryKeys.settings.allowedCountries())).toEqual(canonical);
    await click(button("Reset")!);
    expect(countries()).toContain("Canada");
    expect(button("Save country policy")).toBeUndefined();
    expectProtected(false);
  });

  it("guards an exact original-policy revert while pending and saves that preserved draft next", async () => {
    await render();
    await toggleCountry("Bangladesh");
    await click(radio("exclude"));
    const { write, refresh } = deferSave();
    await click(button("Save country policy")!);
    await click(radio("include"));
    await toggleCountry("Bangladesh");
    expect(button("Save country policy")?.disabled).toBe(true);
    expect(button("Reset")?.disabled).toBe(true);
    expectProtected(true);
    api.blocker.mockReturnValue({ status: "blocked", proceed: api.proceed, reset: api.reset });
    await render();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(api.reset).not.toHaveBeenCalled();
    await click(button("Keep Editing")!);
    expect(api.reset).toHaveBeenCalled();
    expect(api.proceed).not.toHaveBeenCalled();
    api.blocker.mockReturnValue({ status: "idle", proceed: api.proceed, reset: api.reset });
    await render();
    await act(async () => {
      write.resolve();
      refresh.resolve({ allowedCountries: ["US", "AE"], allowedCountriesMode: "exclude" });
    });
    expect(radio("include").getAttribute("data-state")).toBe("checked");
    expect(countries()).toEqual(["United States", "United Arab Emirates", "Bangladesh"]);
    expectProtected(true);
    expect(button("Save country policy")?.disabled).toBe(false);

    api.get.mockResolvedValueOnce(base);
    await click(button("Save country policy")!);
    expect(api.update).toHaveBeenLastCalledWith({ data: {
      allowedCountries: ["US", "AE", "BD"], mode: "include",
    } });
    expect(countries()).toEqual(["Bangladesh", "United States", "United Arab Emirates"]);
    expect(button("Save country policy")).toBeUndefined();
    expectProtected(false);
  });

  it("accepts canonical country ordering for an equivalent set while preserving a newer mode", async () => {
    await render();
    await toggleCountry("Canada");
    const { write, refresh } = deferSave();
    await click(button("Save country policy")!);
    await toggleCountry("Bangladesh");
    await toggleCountry("Bangladesh");
    await click(radio("exclude"));
    await act(async () => {
      write.resolve();
      refresh.resolve({ ...base, allowedCountries: ["AE", "BD", "CA", "US"] });
    });
    expect(countries()).toEqual(["United Arab Emirates", "Bangladesh", "Canada", "United States"]);
    expect(radio("exclude").getAttribute("data-state")).toBe("checked");
    expectProtected(true);
  });

  it("keeps unchanged pending saves guarded and cancels blocked navigation after acknowledgment", async () => {
    await render();
    await click(radio("exclude"));
    const { write, refresh } = deferSave();
    await click(button("Save country policy")!);
    expectProtected(true);
    await click(button("Save country policy")!);
    expect(api.update).toHaveBeenCalledTimes(1);
    api.blocker.mockReturnValue({ status: "blocked", proceed: api.proceed, reset: api.reset });
    await render();
    expect(api.reset).not.toHaveBeenCalled();
    await act(async () => {
      write.resolve();
      refresh.resolve({ ...base, allowedCountriesMode: "exclude" });
    });
    expectProtected(false);
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(api.proceed).not.toHaveBeenCalled();
  });

  it("retains later edits and the original baseline after write failure, then allows retry", async () => {
    await render();
    await click(radio("exclude"));
    const write = deferred<void>();
    api.update.mockReturnValueOnce(write.promise);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await click(button("Save country policy")!);
    await toggleCountry("Canada");
    await act(async () => { write.reject(new Error("Save unavailable")); });
    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(countries()).toContain("Canada");
    expect(radio("exclude").getAttribute("data-state")).toBe("checked");
    expect(button("Save country policy")?.disabled).toBe(false);
    expectProtected(true);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
    await click(button("Reset")!);
    expect(countries()).not.toContain("Canada");
    expect(radio("include").getAttribute("data-state")).toBe("checked");
    await click(radio("exclude"));
    api.get.mockResolvedValueOnce({ ...base, allowedCountriesMode: "exclude" });
    await click(button("Save country policy")!);
    expect(api.update).toHaveBeenCalledTimes(2);
    expectProtected(false);
  });

  it("acknowledges the submitted fallback after a failed refresh without discarding later edits", async () => {
    await render();
    await click(radio("exclude"));
    const { write, refresh } = deferSave();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await click(button("Save country policy")!);
    await click(radio("include"));
    await toggleCountry("Canada");
    await act(async () => { write.resolve(); });
    await act(async () => { refresh.reject(new Error("Refresh unavailable")); });
    expect(countries()).toContain("Canada");
    expect(radio("include").getAttribute("data-state")).toBe("checked");
    expectProtected(true);
    expect(toast.warning).toHaveBeenCalledWith("Country policy was saved, but its current value could not be refreshed.");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.settings.checkoutReadiness() });
    expect(queryClient.getQueryData(queryKeys.settings.allowedCountries())).toEqual({ ...base, allowedCountriesMode: "exclude" });
    await click(button("Reset")!);
    expect(countries()).not.toContain("Canada");
    expect(radio("exclude").getAttribute("data-state")).toBe("checked");
    expectProtected(false);
  });

  it("locks the editor after initial read failure and recovers through Retry", async () => {
    api.get.mockRejectedValueOnce(new Error("Read unavailable"));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Country policy unavailable");
    expect(button("Save country policy")).toBeUndefined();
    expect(radio("include")).toBeNull();
    expect(api.update).not.toHaveBeenCalled();
    await click(button("Retry")!);
    expect(countries()).toEqual(["Bangladesh", "United States", "United Arab Emirates"]);
    expectProtected(false);
  });

  it("does not hydrate the local draft from background cache updates", async () => {
    await render();
    await click(radio("exclude"));
    await act(async () => {
      queryClient.setQueryData(queryKeys.settings.allowedCountries(), {
        allowedCountries: ["US"], allowedCountriesMode: "include",
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.allowedCountries() });
    });
    expect(countries()).toEqual(["Bangladesh", "United States", "United Arab Emirates"]);
    expect(radio("exclude").getAttribute("data-state")).toBe("checked");
    expectProtected(true);
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
