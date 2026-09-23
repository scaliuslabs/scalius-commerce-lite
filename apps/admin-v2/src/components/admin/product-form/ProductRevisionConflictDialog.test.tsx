// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import { ProductRevisionConflictDialog } from "./ProductRevisionConflictDialog";

const t = (key: ProductMessageKey) => translate(productMessages, key);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("ProductRevisionConflictDialog", () => {
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
    vi.restoreAllMocks();
  });

  it("keeps the edits by default and focuses the safe action", async () => {
    const keepDraft = vi.fn();
    await act(async () => {
      root.render(
        <ProductRevisionConflictDialog
          open
          conflict={{ expectedRevision: 7, currentRevision: 9 }}
          isReloading={false}
          reloadError={null}
          onOpenChange={vi.fn()}
          onKeepDraft={keepDraft}
          onReloadLatest={vi.fn(async () => undefined)}
          onProductUnavailable={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(t("conflictTitle"));

    const keepButton = buttonNamed(t("keepMyEdits"));
    expect(document.activeElement).toBe(keepButton);
    act(() => keepButton.click());
    expect(keepDraft).toHaveBeenCalledTimes(1);
  });

  it("offers a terminal return action when the product no longer exists", async () => {
    const reloadLatest = vi.fn(async () => undefined);
    const productUnavailable = vi.fn();
    await act(async () => {
      root.render(
        <ProductRevisionConflictDialog
          open
          conflict={{ expectedRevision: 2, currentRevision: null }}
          isReloading={false}
          reloadError={null}
          onOpenChange={vi.fn()}
          onKeepDraft={vi.fn()}
          onReloadLatest={reloadLatest}
          onProductUnavailable={productUnavailable}
        />,
      );
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(t("conflictDeletedTitle"));
    const returnButton = buttonNamed(t("backToProducts"));
    act(() => returnButton.click());
    expect(productUnavailable).toHaveBeenCalledTimes(1);
    expect(reloadLatest).not.toHaveBeenCalled();
  });

  it("starts reload without dismissing the dialog and lets Escape keep the draft", async () => {
    const reloadLatest = vi.fn(async () => undefined);
    const openChange = vi.fn();
    await act(async () => {
      root.render(
        <ProductRevisionConflictDialog
          open
          conflict={{ expectedRevision: 3, currentRevision: 4 }}
          isReloading={false}
          reloadError={null}
          onOpenChange={openChange}
          onKeepDraft={vi.fn()}
          onReloadLatest={reloadLatest}
          onProductUnavailable={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      buttonNamed(t("loadLatest")).click();
      await Promise.resolve();
    });
    expect(reloadLatest).toHaveBeenCalledTimes(1);
    expect(openChange).not.toHaveBeenCalledWith(false);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(openChange).toHaveBeenCalledWith(false);
  });
});

function buttonNamed(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button ${name} was not rendered`);
  }
  return button;
}
