// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useForm, type UseFormReturn } from "react-hook-form";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ registration: undefined as undefined | { dirty: boolean; navigationDirty: boolean; save: () => Promise<void> } }));
vi.mock("./SaveBar", async (original) => ({ ...await original<object>(), useSaveScope: () => null, useSaveBar: (value: typeof state.registration) => { state.registration = value; } }));
import { useFormSaveBar } from "./use-form-save-bar";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("revocation masks the save bar, rejects an already captured save and restores the untouched draft on regrant", async () => {
  const root = createRoot(document.createElement("div"));
  const save = vi.fn();
  let form!: UseFormReturn<{ title: string }>;
  function Form({ locked }: { locked: boolean }) {
    form = useForm({ defaultValues: { title: "Saved" } });
    useFormSaveBar({ form, save, saving: false, locked });
    return null;
  }
  try {
    await act(async () => root.render(<Form locked={false} />));
    await act(async () => form.setValue("title", "Draft", { shouldDirty: true }));
    const staleSave = state.registration!.save;
    expect(state.registration!.dirty).toBe(true);
    await act(async () => root.render(<Form locked />));
    expect(state.registration!.dirty).toBe(false);
    expect(state.registration!.navigationDirty).toBe(true);
    await expect(staleSave()).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    await act(async () => root.render(<Form locked={false} />));
    expect(form.getValues().title).toBe("Draft");
    expect(state.registration!.dirty).toBe(true);
    expect(state.registration!.navigationDirty).toBe(true);
    await act(async () => form.setValue("title", "Saved", { shouldDirty: true }));
    expect(state.registration!.navigationDirty).toBe(false);
  } finally { act(() => root.unmount()); }
});
