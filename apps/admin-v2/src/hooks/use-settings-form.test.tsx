// @vitest-environment happy-dom

import { act, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  caption?: string;
  policy?: { enabled: boolean; channels: string[] };
}

interface HookSnapshot {
  values: Values;
  setValue: <K extends keyof Values>(key: K, value: Values[K]) => void;
  setValues: Dispatch<SetStateAction<Values>>;
  isDirty: boolean;
  isSaving: boolean;
  reset: () => void;
  handleSubmit: () => Promise<void>;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("useSettingsForm freshness", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function mountForm(options: {
    fetchFn?: () => Promise<Partial<Values>>;
    saveFn: (values: Values) => Promise<Values>;
    canonical?: boolean;
  }) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const queryKey = ["settings", "draft"];
    const hook: { current: HookSnapshot | null } = { current: null };
    function Harness() {
      hook.current = useSettingsForm<Values, Values>({
        queryKey,
        fetchFn: options.fetchFn ?? (async () => ({ label: "before", caption: "before" })),
        saveFn: options.saveFn,
        resolveSavedValues: options.canonical ? (result) => result : undefined,
        defaultValues: { label: "", caption: "" },
      });
      return null;
    }
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(hook.current?.values.label).toBe("before"));
    return { hook, queryClient, queryKey };
  }

  it("preserves newer fields while acknowledging normalized untouched fields", async () => {
    const save = deferred<Values>();
    const saveFn = vi.fn((_values: Values) => save.promise);
    const { hook, queryClient, queryKey } = await mountForm({ saveFn, canonical: true });
    act(() => hook.current?.setValues((values) => ({ ...values, label: "submitted", caption: " normalize " })));
    let submission!: Promise<void>;
    await act(async () => { submission = hook.current!.handleSubmit(); });
    expect(saveFn.mock.calls[0]?.[0]).toEqual({ label: "submitted", caption: " normalize " });
    act(() => hook.current?.setValue("label", "newer"));
    await act(async () => {
      save.resolve({ label: "submitted", caption: "normalized" });
      await submission;
    });
    expect(hook.current?.values).toEqual({ label: "newer", caption: "normalized" });
    expect(hook.current?.isDirty).toBe(true);
    expect(queryClient.getQueryData(queryKey)).toEqual({ label: "submitted", caption: "normalized" });
    act(() => hook.current?.reset());
    expect(hook.current?.values).toEqual({ label: "submitted", caption: "normalized" });
    expect(hook.current?.isDirty).toBe(false);
  });

  it("preserves a revert to the old saved value while a different value is saving", async () => {
    const save = deferred<Values>();
    const { hook } = await mountForm({ saveFn: () => save.promise, canonical: true });
    act(() => hook.current?.setValue("label", "submitted"));
    let submission!: Promise<void>;
    await act(async () => { submission = hook.current!.handleSubmit(); });
    act(() => hook.current?.setValue("label", "before"));
    expect(hook.current?.isDirty).toBe(false);
    expect(hook.current?.isSaving).toBe(true);
    await act(async () => {
      save.resolve({ label: "submitted", caption: "before" });
      await submission;
    });
    expect(hook.current?.values.label).toBe("before");
    expect(hook.current?.isDirty).toBe(true);
  });

  it("preserves edits across both save acknowledgment and its deferred canonical refetch", async () => {
    const save = deferred<Values>();
    const refresh = deferred<Partial<Values>>();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ label: "before", caption: "before" })
      .mockImplementationOnce(() => refresh.promise);
    const { hook } = await mountForm({ fetchFn, saveFn: () => save.promise });
    act(() => hook.current?.setValues({ label: "submitted", caption: " normalize " }));
    let submission!: Promise<void>;
    await act(async () => { submission = hook.current!.handleSubmit(); });
    act(() => hook.current?.setValue("label", "newer"));
    await act(async () => { save.resolve({ label: "unused" }); });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(hook.current?.values.label).toBe("newer");
    expect(hook.current?.isSaving).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
    act(() => hook.current?.setValue("label", "newest"));
    await act(async () => {
      refresh.resolve({ label: "submitted", caption: "normalized" });
      await submission;
    });
    await vi.waitFor(() => expect(hook.current?.values.caption).toBe("normalized"));
    expect(hook.current?.values.label).toBe("newest");
    expect(hook.current?.isDirty).toBe(true);
    act(() => hook.current?.reset());
    expect(hook.current?.values).toEqual({ label: "submitted", caption: "normalized" });
  });

  it("keeps edited top-level fields across query refreshes and adopts untouched server fields", async () => {
    const { hook, queryClient, queryKey } = await mountForm({ saveFn: async (values) => values });
    act(() => hook.current?.setValues((values) => ({
      ...values,
      label: "draft",
      policy: { enabled: true, channels: ["email"] },
    })));
    await act(async () => {
      queryClient.setQueryData(queryKey, {
        label: "server",
        caption: "server caption",
        policy: { enabled: false, channels: ["sms"] },
      });
    });
    await vi.waitFor(() => expect(hook.current?.values.caption).toBe("server caption"));
    expect(hook.current?.values).toEqual({
      label: "draft",
      caption: "server caption",
      policy: { enabled: true, channels: ["email"] },
    });
    expect(hook.current?.isDirty).toBe(true);
    act(() => hook.current?.reset());
    expect(hook.current?.values.label).toBe("server");
    expect(hook.current?.values.policy).toEqual({ enabled: false, channels: ["sms"] });
    expect(hook.current?.isDirty).toBe(false);
  });

  it("preserves newer input on save failure and keeps reset tied to the prior saved value", async () => {
    const save = deferred<Values>();
    const { hook } = await mountForm({ saveFn: () => save.promise });
    act(() => hook.current?.setValue("label", "submitted"));
    let submission!: Promise<void>;
    await act(async () => { submission = hook.current!.handleSubmit(); });
    const failure = expect(submission).rejects.toThrow("Save failed");
    act(() => hook.current?.setValue("label", "newer"));
    await act(async () => {
      save.reject(new Error("Save failed"));
      await failure;
    });
    expect(hook.current?.values.label).toBe("newer");
    expect(hook.current?.isDirty).toBe(true);
    expect(toast.error).toHaveBeenCalledWith("Save failed");
    act(() => hook.current?.reset());
    expect(hook.current?.values.label).toBe("before");
    expect(hook.current?.isDirty).toBe(false);
  });

  it("adopts normalization when a save refetch returns the unchanged cached value", async () => {
    const { hook } = await mountForm({ saveFn: async (values) => values });
    act(() => hook.current?.setValue("label", " before "));
    await act(async () => { await hook.current?.handleSubmit(); });
    await vi.waitFor(() => expect(hook.current?.values.label).toBe("before"));
    expect(hook.current?.isDirty).toBe(false);
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
