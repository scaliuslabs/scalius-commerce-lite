// @vitest-environment happy-dom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeferredTiptapEditor } from "./DeferredTiptapEditor";

vi.mock("~/components/admin/media-manager", () => ({
  MediaManager: () => null,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("DeferredTiptapEditor", () => {
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

  it("mounts the editable canvas through the StrictMode effect replay", async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <DeferredTiptapEditor
            content="<p>Editable content</p>"
            onChange={vi.fn()}
            ariaLabel="Strict mode content"
          />
        </StrictMode>,
      );
    });

    await vi.waitFor(
      () => {
        expect(
          host.querySelector(
            '[contenteditable="true"][aria-label="Strict mode content"]',
          ),
        ).not.toBeNull();
      },
      { timeout: 5_000 },
    );
    expect(host.querySelector(".ProseMirror")).not.toBeNull();
  }, 10_000);

  type EditorHandle = { commands: { setContent: (html: string, options?: { emitUpdate?: boolean }) => boolean } };
  const mountEditor = async (content: string, onChange: (html: string) => void) => {
    await act(async () => {
      root.render(<DeferredTiptapEditor content={content} onChange={onChange} ariaLabel="Description" />);
    });
    await vi.waitFor(() => expect(host.querySelector(".ProseMirror")).not.toBeNull(), { timeout: 5_000 });
    return (host.querySelector(".ProseMirror") as unknown as { editor: EditorHandle }).editor;
  };

  it("tells the form an emptied editor is \"\", never <p></p>", async () => {
    const onChange = vi.fn();
    const editor = await mountEditor("<p>Some description text</p>", onChange);
    await act(async () => { editor.commands.setContent("<p></p>", { emitUpdate: true }); });
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(onChange).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("stays silent while an empty field is still empty (an Enter, an empty paragraph)", async () => {
    const onChange = vi.fn();
    const editor = await mountEditor("", onChange);
    await act(async () => { editor.commands.setContent("<p></p><p></p>", { emitUpdate: true }); });
    await act(async () => { editor.commands.setContent("<p></p>", { emitUpdate: true }); });
    expect(onChange).not.toHaveBeenCalled();
  }, 10_000);
});
