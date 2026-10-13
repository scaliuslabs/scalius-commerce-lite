// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useForm } from "react-hook-form";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("./use-form-save-bar", () => ({ useFormSaveBar: state.register }));
vi.mock("./SaveBar", () => ({ SaveBarProvider: ({ children }: { children: ReactNode }) => children, SaveErrorBanner: () => null, useSaveScope: () => null }));
vi.mock("~/lib/realtime/store", () => ({ PresenceSlot: () => null, announceSave: vi.fn() }));
vi.mock("@/components/admin/resource/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/admin/resource/ReadOnlyNotice", () => ({ ReadOnlyNotice: () => <p>View only</p> }));
import { FormContainer } from "./FormContainer";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div");
let root = createRoot(host);
const save = vi.fn();
function Harness({ handlesReadOnly = false }: { handlesReadOnly?: boolean }) {
  const form = useForm({ defaultValues: { name: "Saved" } });
  return <FormContainer heading="Saved" backUrl="/admin/customers" canSave={false} disableFieldsWhenReadOnly={!handlesReadOnly} isSubmitting={false} form={form} onSave={save}><button type="button">Browse history</button></FormContainer>;
}
afterEach(() => { act(() => root.unmount()); root = createRoot(host); save.mockClear(); state.register.mockClear(); });
it("keeps the default consumer boundary disabled while an explicit reader remains browsable and cannot save", async () => {
  await act(async () => root.render(<Harness />));
  expect(host.querySelector("button")?.closest("fieldset[disabled]")).not.toBeNull();
  await act(async () => root.render(<Harness handlesReadOnly />));
  expect(host.querySelector("button")?.closest("fieldset[disabled]")).toBeNull();
  expect(state.register).toHaveBeenLastCalledWith(expect.objectContaining({ locked: true }));
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(save).not.toHaveBeenCalled();
});
