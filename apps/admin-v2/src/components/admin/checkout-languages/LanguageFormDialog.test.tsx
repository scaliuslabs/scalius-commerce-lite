// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageFormDialog } from "./LanguageFormDialog";
import type { ManagerCheckoutLanguage } from "./hooks/useLanguages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const existing: ManagerCheckoutLanguage = {
  id: "language_test", name: "English UK", code: "en-GB", isActive: false, isDefault: false,
  languageData: { customerNameLabel: "Your full name", termsText: "Saved terms" },
  fieldVisibility: {}, createdAt: 1, updatedAt: 1, deletedAt: null,
};

function ControlledLanguageDialog({
  onSubmit,
}: {
  onSubmit: (
    formData: Partial<ManagerCheckoutLanguage>,
    editingLanguageId: string | null,
  ) => Promise<boolean>;
}) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [editingLanguage, setEditingLanguage] =
    React.useState<ManagerCheckoutLanguage | null>(null);

  return (
    <>
      <button type="button" onClick={() => {
        setEditingLanguage(null);
        setIsOpen(true);
      }}>Open add</button>
      <button type="button" onClick={() => {
        setEditingLanguage(existing);
        setIsOpen(true);
      }}>Open edit</button>
      <LanguageFormDialog
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        editingLanguage={editingLanguage}
        isActionLoading={false}
        onSubmit={onSubmit}
      />
    </>
  );
}

function dialogButton(label: string): HTMLButtonElement {
  const dialog = document.querySelector('[role="dialog"]');
  const button = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Expected dialog button labeled ${label}`);
  return button;
}

function setInputValue(id: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`Expected input #${id}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("checkout language field labels", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it.each([null, existing])("names all 17 copy fields in add/edit mode (%j)", async (editingLanguage) => {
    const submit = vi.fn();
    await act(async () => root.render(<LanguageFormDialog
      isOpen onOpenChange={() => {}} editingLanguage={editingLanguage}
      isActionLoading={false} onSubmit={submit}
    />));
    const dialog = document.querySelector('[role="dialog"]')!;
    for (const id of ["name", "code"]) {
      expect(dialog.querySelector<HTMLInputElement>(`#${id}`)?.labels).toHaveLength(1);
    }

    const fieldIds = new Set<string>();
    for (const [tabName, count] of [["Labels", 12], ["Messages", 5]] as const) {
      const tab = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        .find((element) => element.textContent === tabName)!;
      await act(async () => tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      const panel = document.getElementById(tab.getAttribute("aria-controls")!)!;
      const fields = panel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
      expect(fields).toHaveLength(count);
      for (const field of fields) {
        expect(field.labels).toHaveLength(1);
        const label = field.labels![0]!;
        expect(label.textContent?.trim()).toBeTruthy();
        expect(label.control).toBe(field);
        expect(field.id).not.toBe("");
        expect(fieldIds.has(field.id)).toBe(false);
        fieldIds.add(field.id);
        if (editingLanguage && label.textContent === "Customer Name Label") expect(field.value).toBe("Your full name");
        if (editingLanguage && label.textContent === "Terms & Conditions Text") expect(field.value).toBe("Saved terms");
      }
    }
    expect(fieldIds.size).toBe(17);
    expect(submit).not.toHaveBeenCalled();
  });

  it("resets on each actual open while preserving a failed draft", async () => {
    const submit = vi.fn<
      (formData: Partial<ManagerCheckoutLanguage>, editingLanguageId: string | null) => Promise<boolean>
    >();
    submit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await act(async () => root.render(<ControlledLanguageDialog onSubmit={submit} />));

    await act(async () => (document.querySelector("button") as HTMLButtonElement).click());
    setInputValue("name", "Created language");
    setInputValue("code", "en-US");
    await act(async () => dialogButton("Add language").click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => (document.querySelector("button") as HTMLButtonElement).click());
    expect(document.querySelector<HTMLInputElement>("#name")?.value).toBe("");
    expect(document.querySelector<HTMLInputElement>("#code")?.value).toBe("");
    await act(async () => dialogButton("Cancel").click());

    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Open edit")?.click();
    });
    setInputValue("name", "Cancelled draft");
    await act(async () => dialogButton("Cancel").click());
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Open edit")?.click();
    });
    expect(document.querySelector<HTMLInputElement>("#name")?.value).toBe(existing.name);
    expect(document.querySelector<HTMLInputElement>("#code")?.value).toBe(existing.code);
    await act(async () => dialogButton("Cancel").click());

    await act(async () => (document.querySelector("button") as HTMLButtonElement).click());
    setInputValue("name", "Failed draft");
    setInputValue("code", "en-US");
    await act(async () => dialogButton("Add language").click());
    expect(submit).toHaveBeenCalledTimes(2);
    expect(document.querySelector<HTMLInputElement>("#name")?.value).toBe("Failed draft");
    expect(document.querySelector<HTMLInputElement>("#code")?.value).toBe("en-US");
  });
});
