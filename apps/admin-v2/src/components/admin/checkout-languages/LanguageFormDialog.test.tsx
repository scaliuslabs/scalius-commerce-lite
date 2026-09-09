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
});
