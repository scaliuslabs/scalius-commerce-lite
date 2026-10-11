// @vitest-environment happy-dom

import { act, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { saveBarMessages } from "~/i18n/save-bar";
import { useSettingsForm } from "./use-settings-form";
import { normalizeAdminPhone } from "~/components/admin/shared/AdminPhoneInput";
import { AdminApiResponseError } from "~/lib/admin-api-error";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Values {
  label: string;
  phone?: string;
  caption?: string;
  policy?: { enabled: boolean; channels: string[] };
  rules?: Array<{ event: string; enabled: boolean }>;
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
    saveFn: (values: Values, expectedRevision: number) => Promise<Values>;
    canonical?: boolean;
    cached?: Partial<Values>;
    toDraft?: (values: Values) => Values;
  }) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const queryKey = ["settings", "draft"];
    if (options.cached) queryClient.setQueryData(queryKey, options.cached);
    const hook: { current: HookSnapshot | null } = { current: null };
    function Harness() {
      hook.current = useSettingsForm<Values, Values>({
        queryKey,
        fetchFn: options.fetchFn ?? (async () => ({ label: "before", caption: "before" })),
        saveFn: options.saveFn,
        resolveSavedValues: options.canonical ? (result) => result : undefined,
        defaultValues: { label: "", caption: "" },
        toDraft: options.toDraft,
      });
      return null;
    }
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(hook.current?.values.label).toBe("before"));
    return { hook, queryClient, queryKey };
  }

  it("uses one draft representation for cached/read values, save acknowledgement, refetch and discard", async () => {
    const raw = { label: "before", caption: "", phone: "+880 1712-345678" };
    const { hook, queryClient, queryKey } = await mountForm({
      cached: raw,
      fetchFn: async () => raw,
      saveFn: async (values) => ({ ...values, phone: "+8801712345678" }),
      canonical: true,
      toDraft: (values) => ({ ...values, phone: normalizeAdminPhone(values.phone ?? "") }),
    });
    expect(hook.current?.values.phone).toBe("01712345678");
    expect(hook.current?.isDirty).toBe(false);
    act(() => hook.current?.setValue("phone", "01812345678"));
    expect(hook.current?.isDirty).toBe(true);
    act(() => hook.current?.setValue("phone", "01712345678"));
    expect(hook.current?.isDirty).toBe(false);
    act(() => hook.current?.setValue("label", "saved"));
    await act(async () => { await hook.current?.handleSubmit(); });
    expect(hook.current?.isDirty).toBe(false);
    expect(hook.current?.values.phone).toBe("01712345678");
    // Query consumers still see the server representation, not the editor's.
    expect(queryClient.getQueryData(queryKey)).toMatchObject({ phone: "+8801712345678" });
    await act(async () => { queryClient.setQueryData(queryKey, { ...raw, label: "saved", phone: "+880 1812-345678" }); });
    await vi.waitFor(() => expect(hook.current?.values.phone).toBe("01812345678"));
    expect(hook.current?.isDirty).toBe(false);
    act(() => hook.current?.setValue("phone", "01912345678"));
    act(() => hook.current?.reset());
    expect(hook.current?.values.phone).toBe("01812345678");
    expect(hook.current?.isDirty).toBe(false);
  });

  it("normalizes a conflict reload before merging and resubmitting the draft", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ label: "before", caption: "", phone: "+8801712345678", revision: 1 })
      .mockResolvedValue({ label: "before", caption: "their caption", phone: "+880 1712-345678", revision: 2 });
    const saveFn = vi.fn<(values: Values, revision: number) => Promise<Values>>()
      .mockRejectedValueOnce(new AdminApiResponseError("Changed", 409, "SETTINGS_REVISION_CONFLICT", {
        document: "business", expectedRevision: 1, currentRevision: 2,
      }))
      .mockImplementation(async (values) => ({ ...values, phone: "+8801712345678" }));
    const { hook } = await mountForm({
      fetchFn, saveFn, canonical: true,
      toDraft: (values) => ({ ...values, phone: normalizeAdminPhone(values.phone ?? "") }),
    });
    act(() => hook.current?.setValue("label", "mine"));
    await act(async () => { await hook.current?.handleSubmit(); });
    expect(saveFn.mock.calls[1]).toEqual([{ label: "mine", caption: "their caption", phone: "01712345678" }, 2]);
    expect(hook.current?.isDirty).toBe(false);
  });

  it("clears dirty after reverting equivalent values with reconstructed object keys", async () => {
    const { hook } = await mountForm({
      fetchFn: async () => ({ label: "before", caption: "before", policy: { enabled: true, channels: ["email", "sms"] } }),
      saveFn: async (values) => values,
    });
    act(() => hook.current?.setValue("policy", { enabled: false, channels: ["email", "sms"] }));
    expect(hook.current?.isDirty).toBe(true);
    act(() => hook.current?.setValues({ policy: { channels: ["email", "sms"], enabled: true }, caption: "before", label: "before" }));
    expect(hook.current?.isDirty).toBe(false);
    // Ordered settings (for example payment methods) must still report a move.
    act(() => hook.current?.setValue("policy", { channels: ["sms", "email"], enabled: true }));
    expect(hook.current?.isDirty).toBe(true);
  });

  it("adopts refetched rows after an edit was reverted with different object key order", async () => {
    const { hook, queryClient, queryKey } = await mountForm({
      fetchFn: async () => ({ label: "before", rules: [{ event: "order", enabled: true }] }),
      saveFn: async (values) => values,
    });
    act(() => hook.current?.setValue("rules", [{ event: "order", enabled: false }]));
    act(() => hook.current?.setValue("rules", [{ enabled: true, event: "order" }]));
    expect(hook.current?.isDirty).toBe(false);
    await act(async () => {
      queryClient.setQueryData(queryKey, { label: "before", rules: [{ event: "order", enabled: false }] });
    });
    await vi.waitFor(() => expect(hook.current?.values.rules).toEqual([{ event: "order", enabled: false }]));
    expect(hook.current?.isDirty).toBe(false);
  });

  it("rebases a pending save after an equivalent row revert, then compares with the resolved baseline", async () => {
    const save = deferred<Values>();
    const { hook } = await mountForm({
      fetchFn: async () => ({ label: "before", rules: [{ event: " order ", enabled: true }] }),
      saveFn: () => save.promise,
      canonical: true,
    });
    act(() => hook.current?.setValue("label", "submitted"));
    let submission!: Promise<void>;
    await act(async () => { submission = hook.current!.handleSubmit(); });
    act(() => hook.current?.setValue("rules", [{ event: " order ", enabled: false }]));
    act(() => hook.current?.setValue("rules", [{ enabled: true, event: " order " }]));
    await act(async () => {
      save.resolve({ label: "submitted", caption: "", rules: [{ event: "order", enabled: true }] });
      await submission;
    });
    expect(hook.current?.values.rules).toEqual([{ event: "order", enabled: true }]);
    expect(hook.current?.isDirty).toBe(false);
    act(() => hook.current?.setValue("rules", [{ event: "order", enabled: false }]));
    expect(hook.current?.isDirty).toBe(true);
    act(() => hook.current?.setValue("rules", [{ enabled: true, event: "order" }]));
    expect(hook.current?.isDirty).toBe(false);
  });

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

  it("fences a pre-acknowledgment read before Retry preserves a post-submit revert", async () => {
    const save = deferred<Values>();
    const background = deferred<Partial<Values>>();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ label: "before", caption: "before" })
      .mockImplementationOnce(() => background.promise)
      .mockRejectedValueOnce(new Error("Confirming read failed"))
      .mockResolvedValueOnce({ label: "after", caption: "before" });
    const { hook, queryClient, queryKey } = await mountForm({
      fetchFn,
      saveFn: () => save.promise,
    });

    act(() => hook.current?.setValue("label", "after"));
    let submission!: Promise<void>;
    await act(async () => { submission = hook.current!.handleSubmit(); });
    act(() => hook.current?.setValue("label", "before"));

    act(() => { void queryClient.refetchQueries({ queryKey }); });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    await act(async () => {
      background.resolve({ label: "before", caption: "before" });
      await Promise.resolve();
      save.resolve({ label: "after", caption: "before" });
      await submission;
    });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(3));

    expect(hook.current?.values.label).toBe("before");
    expect(hook.current?.isDirty).toBe(true);

    await act(async () => { await queryClient.refetchQueries({ queryKey }); });
    expect(hook.current?.values.label).toBe("before");
    expect(hook.current?.isDirty).toBe(true);
    act(() => hook.current?.reset());
    expect(hook.current?.values.label).toBe("after");
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
    expect(toast.success).toHaveBeenCalledWith(saveBarMessages.en.saved);
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

  it("sends the loaded revision beside the values, and two cards on one document never conflict with each other", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let stored = { label: "before", caption: "before", revision: 1 };
    const fetchFn = vi.fn(async () => ({ ...stored }));
    const save = (field: "label" | "caption") => vi.fn(async (values: Values, expectedRevision: number) => {
      if (expectedRevision !== stored.revision) throw new Error("stale");
      stored = { ...stored, [field]: values[field], revision: stored.revision + 1 };
      return { message: "saved", revision: stored.revision };
    });
    const saveLabel = save("label");
    const saveCaption = save("caption");
    const hooks: Record<"label" | "caption", HookSnapshot | null> = { label: null, caption: null };

    function Harness() {
      hooks.label = useSettingsForm<Values, { message: string; revision: number }>({
        queryKey: ["settings", "shared"],
        fetchFn,
        saveFn: saveLabel,
        defaultValues: { label: "", caption: "" },
      });
      hooks.caption = useSettingsForm<Values, { message: string; revision: number }>({
        queryKey: ["settings", "shared"],
        fetchFn,
        saveFn: saveCaption,
        defaultValues: { label: "", caption: "" },
      });
      return null;
    }
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(hooks.label?.values.label).toBe("before"));
    expect(hooks.label!.values).toEqual({ label: "before", caption: "before" });

    act(() => hooks.label!.setValue("label", "new label"));
    act(() => hooks.caption!.setValue("caption", "new caption"));
    await act(async () => { await hooks.label!.handleSubmit(); });
    await act(async () => { await hooks.caption!.handleSubmit(); });

    expect(saveLabel.mock.calls[0]?.[1]).toBe(1);
    expect(saveCaption.mock.calls[0]?.[1]).toBe(2);
    expect(stored).toEqual({ label: "new label", caption: "new caption", revision: 3 });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("outside a page save bar, a conflict offers to reload keeping the edits", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ label: "before", caption: "before", revision: 1 })
      .mockResolvedValue({ label: "before", caption: "theirs", revision: 2 });
    const hook: { current: HookSnapshot | null } = { current: null };
    function Harness() {
      hook.current = useSettingsForm<Values>({
        queryKey: ["settings", "conflict"],
        fetchFn,
        saveFn: async () => {
          throw Object.assign(new Error("changed"), {
            status: 409,
            code: "SETTINGS_REVISION_CONFLICT",
            details: { document: "demo", expectedRevision: 1, currentRevision: 2 },
          });
        },
        defaultValues: { label: "", caption: "" },
      });
      return null;
    }
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(hook.current?.values.label).toBe("before"));
    act(() => hook.current!.setValue("label", "mine"));
    await act(async () => { await expect(hook.current!.handleSubmit()).rejects.toThrow(); });

    const [message, options] = vi.mocked(toast.error).mock.calls[0] as unknown as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe("Someone else changed these settings since you opened them.");
    expect(options.action.label).toBe("Reload and keep my edits");
    await act(async () => { options.action.onClick(); });
    await vi.waitFor(() => expect(hook.current?.values.caption).toBe("theirs"));
    expect(hook.current!.values.label).toBe("mine");
    expect(hook.current!.isDirty).toBe(true);
  });
});
