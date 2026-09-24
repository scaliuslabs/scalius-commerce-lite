// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import { ProductRevisionConflictDialog } from "./ProductRevisionConflictDialog";

const t = (key: ProductMessageKey, vars?: Record<string, string>) => translate(productMessages, key, vars);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof ProductRevisionConflictDialog>;

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

  async function render(overrides: Partial<Props>) {
    const props: Props = {
      open: true,
      conflict: { expectedRevision: 7, currentRevision: 9 },
      isReloading: false,
      reloadError: null,
      onOpenChange: vi.fn(),
      changedFields: [t("title")],
      variantsChanged: false,
      overlap: null,
      onApplyMine: vi.fn(async () => undefined),
      onReloadLatest: vi.fn(async () => undefined),
      onProductUnavailable: vi.fn(),
      ...overrides,
    };
    await act(async () => {
      root.render(<ProductRevisionConflictDialog {...props} />);
      await Promise.resolve();
    });
    return props;
  }

  it("names the merchant's changes and applies them on top of the latest version by default", async () => {
    const props = await render({});
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(t("conflictMineBody", { fields: t("title") }));

    const apply = buttonNamed(t("applyMine"));
    expect(document.activeElement).toBe(apply);
    await act(async () => apply.click());
    expect(props.onApplyMine).toHaveBeenCalledTimes(1);
    expect(props.onReloadLatest).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("discarding says so before loading the latest version", async () => {
    const props = await render({});
    await act(async () => buttonNamed(t("discardMineLoadLatest")).click());
    expect(props.onReloadLatest).toHaveBeenCalledTimes(1);
    expect(props.onApplyMine).not.toHaveBeenCalled();
  });

  it("when both saves changed the same fields, names them and offers only a safe way out", async () => {
    const props = await render({ overlap: [t("price")] });
    expect(document.body.textContent).toContain(t("conflictOverlapBody", { fields: t("price") }));
    expect(buttonNamed(t("keepEditing"))).toBe(document.activeElement);
    expect(Array.from(document.querySelectorAll("button")).some((button) => button.textContent === t("applyMine"))).toBe(false);
    await act(async () => buttonNamed(t("loadLatest")).click());
    expect(props.onReloadLatest).toHaveBeenCalledTimes(1);
  });

  it("offers a terminal return action when the product no longer exists", async () => {
    const props = await render({ conflict: { expectedRevision: 2, currentRevision: null } });
    expect(document.body.textContent).toContain(t("conflictDeletedTitle"));
    act(() => buttonNamed(t("backToProducts")).click());
    expect(props.onProductUnavailable).toHaveBeenCalledTimes(1);
    expect(props.onReloadLatest).not.toHaveBeenCalled();
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
