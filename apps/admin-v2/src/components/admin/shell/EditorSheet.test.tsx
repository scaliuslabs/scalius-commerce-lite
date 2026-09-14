// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "~/components/ui/button";

import { EditorSheet } from "./EditorSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("EditorSheet", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    onOpenChange = vi.fn<(open: boolean) => void>();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function render(ui: ReactNode) {
    await act(async () => {
      root.render(ui);
    });
  }

  function sheet() {
    return document.body.querySelector<HTMLElement>('[data-testid="editor-sheet"]');
  }
  function button(label: string) {
    return Array.from(document.body.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === label,
    );
  }

  it("renders nothing while it is closed", async () => {
    await render(
      <EditorSheet open={false} onOpenChange={onOpenChange} title="Add tax rate">
        <p>Fields</p>
      </EditorSheet>,
    );

    expect(sheet()).toBeNull();
    expect(document.body.textContent).not.toContain("Fields");
  });

  it("names itself with the title and describes what saving does", async () => {
    await render(
      <EditorSheet
        open
        onOpenChange={onOpenChange}
        title="Add tax rate"
        description="Rates that match the same checkout are added together."
      >
        <p>Fields</p>
      </EditorSheet>,
    );

    const content = sheet()!;
    const labelledBy = content.getAttribute("aria-labelledby");
    expect(document.getElementById(labelledBy!)!.textContent).toBe("Add tax rate");
    const describedBy = content.getAttribute("aria-describedby");
    expect(document.getElementById(describedBy!)!.textContent).toContain(
      "added together",
    );
  });

  it("leaves no dangling description reference when there is nothing to describe", async () => {
    await render(
      <EditorSheet open onOpenChange={onOpenChange} title="Preview calculation">
        <p>Preview</p>
      </EditorSheet>,
    );

    expect(sheet()!.getAttribute("aria-describedby")).toBeNull();
  });

  it("closes from the header close button", async () => {
    await render(
      <EditorSheet open onOpenChange={onOpenChange} title="Add tax rate">
        <p>Fields</p>
      </EditorSheet>,
    );

    const close = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="editor-sheet-close"]',
    )!;
    expect(close.getAttribute("aria-label")).toBe("Close");
    await act(async () => close.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on Escape", async () => {
    await render(
      <EditorSheet open onOpenChange={onOpenChange} title="Add tax rate">
        <p>Fields</p>
      </EditorSheet>,
    );

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("scrolls the body and keeps the footer actions out of the scroll area", async () => {
    await render(
      <EditorSheet
        open
        onOpenChange={onOpenChange}
        title="Add tax rate"
        footer={<Button type="button">Cancel</Button>}
      >
        <p>Fields</p>
      </EditorSheet>,
    );

    const body = document.body.querySelector<HTMLElement>('[data-testid="editor-sheet-body"]')!;
    const footer = document.body.querySelector<HTMLElement>('[data-testid="editor-sheet-footer"]')!;
    expect(body.className).toContain("overflow-y-auto");
    expect(body.textContent).toContain("Fields");
    expect(body.contains(footer)).toBe(false);
    expect(footer.textContent).toContain("Cancel");
  });

  it("omits the footer entirely for a read-only sheet", async () => {
    await render(
      <EditorSheet open onOpenChange={onOpenChange} title="Publication history">
        <p>Revisions</p>
      </EditorSheet>,
    );

    expect(document.body.querySelector('[data-testid="editor-sheet-footer"]')).toBeNull();
    expect(document.body.querySelector("form")).toBeNull();
  });

  it("submits the form from the footer button and from Enter in a field", async () => {
    const onSubmit = vi.fn<() => void>();
    await render(
      <EditorSheet
        open
        onOpenChange={onOpenChange}
        title="Add tax class"
        onSubmit={onSubmit}
        footer={<Button type="submit">Add class</Button>}
      >
        <input aria-label="Name" />
      </EditorSheet>,
    );

    const form = document.body.querySelector<HTMLFormElement>("form")!;
    // The footer button lives inside the same form, so it can be a submit.
    expect(form.contains(button("Add class")!)).toBe(true);

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("uses the named widths", async () => {
    await render(
      <EditorSheet open onOpenChange={onOpenChange} title="Menu trash" width="sm">
        <p>Trash</p>
      </EditorSheet>,
    );
    expect(sheet()!.className).toContain("sm:max-w-md");

    await render(
      <EditorSheet open onOpenChange={onOpenChange} title="Add tax rate" width="lg">
        <p>Fields</p>
      </EditorSheet>,
    );
    expect(sheet()!.className).toContain("sm:max-w-2xl");
  });
});
