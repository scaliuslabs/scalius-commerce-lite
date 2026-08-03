// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useSettingsForm } from "./use-settings-form";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Values {
  label: string;
}

interface HookSnapshot {
  values: Values;
  setValue: <K extends keyof Values>(key: K, value: Values[K]) => void;
  handleSubmit: () => Promise<void>;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("useSettingsForm freshness", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("waits for dependent invalidations before reporting a successful save", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const dependentInvalidation = deferred<void>();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
      .mockImplementation((filters) => {
        const key = filters?.queryKey as readonly unknown[] | undefined;
        return key?.[0] === "dependent"
          ? dependentInvalidation.promise
          : Promise.resolve();
      });
    const saveFn = vi.fn(async (_values: Values) => ({ message: "saved" }));
    const hook: { current: HookSnapshot | null } = { current: null };

    function Harness() {
      hook.current = useSettingsForm<Values, { message: string }>({
        queryKey: ["settings", "example"],
        fetchFn: async () => ({ label: "before" }),
        saveFn,
        defaultValues: { label: "" },
        invalidateQueryKeys: [["dependent"]],
      });
      return null;
    }

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(hook.current?.values.label).toBe("before"));

    act(() => hook.current?.setValue("label", "after"));
    await act(async () => {
      const submit = hook.current?.handleSubmit();
      await vi.waitFor(() => expect(saveFn).toHaveBeenCalled());
      expect(saveFn.mock.calls[0]?.[0]).toEqual({ label: "after" });
      expect(toast.success).not.toHaveBeenCalled();
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dependent"] });

      dependentInvalidation.resolve();
      await submit;
    });
    expect(toast.success).toHaveBeenCalledWith("Settings saved");
  });

  it("keeps a canonical save response instead of refetching stale form data", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const cancel = vi.spyOn(queryClient, "cancelQueries");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const hook: { current: HookSnapshot | null } = { current: null };

    function Harness() {
      hook.current = useSettingsForm<Values, Values>({
        queryKey: ["settings", "canonical"],
        fetchFn: async () => ({ label: "before" }),
        saveFn: async () => ({ label: "normalized" }),
        resolveSavedValues: (result) => result,
        defaultValues: { label: "" },
      });
      return null;
    }

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(hook.current?.values.label).toBe("before"));

    act(() => hook.current?.setValue("label", "submitted"));
    await act(async () => {
      await hook.current?.handleSubmit();
    });

    expect(hook.current?.values.label).toBe("normalized");
    expect(queryClient.getQueryData(["settings", "canonical"])).toEqual({
      label: "normalized",
    });
    expect(cancel).toHaveBeenCalledWith({ queryKey: ["settings", "canonical"] });
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: ["settings", "canonical"],
    });
  });
});
