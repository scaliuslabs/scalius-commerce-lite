// @vitest-environment happy-dom

import { act } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FormActionBar } from "./FormStickyHeader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    children: ReactNode;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

describe("FormActionBar", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div><div id="form-action-bar-slot"></div>';
    host = document.getElementById("app") as HTMLDivElement;
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function renderActionBar(isFormValid: boolean, onSave = vi.fn()) {
    await act(async () => {
      root.render(
        <FormActionBar
          title="Customer"
          isEdit={false}
          isSubmitting={false}
          isDirty
          cancelUrl="/admin/customers"
          canSave
          isFormValid={isFormValid}
          onSave={onSave}
        />,
      );
    });

    const buttons = Array.from(document.querySelectorAll("button"));
    const saveButton = buttons.find((button) =>
      button.textContent?.includes("Create Customer"),
    );
    if (!saveButton) throw new Error("Save button was not rendered");
    return { saveButton, onSave };
  }

  it("keeps save disabled while the form contains invalid values", async () => {
    const { saveButton, onSave } = await renderActionBar(false);

    expect(saveButton.disabled).toBe(true);
    expect(saveButton.title).toBe("Fix the highlighted fields before saving");
    saveButton.click();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("enables save after live validation passes", async () => {
    const { saveButton, onSave } = await renderActionBar(true);

    expect(saveButton.disabled).toBe(false);
    saveButton.click();
    expect(onSave).toHaveBeenCalledOnce();
  });
});
