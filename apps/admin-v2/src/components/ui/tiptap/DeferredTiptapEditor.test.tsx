// @vitest-environment happy-dom

import { StrictMode, act, useState } from "react";
import type { Editor } from "@tiptap/react";
import { closeHistory } from "@tiptap/pm/history";
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
  });

  const mountEditor = async (content: string, onChange: (html: string) => void) => {
    await act(async () => {
      root.render(<DeferredTiptapEditor content={content} onChange={onChange} ariaLabel="Description" />);
    });
    await vi.waitFor(() => expect(host.querySelector(".ProseMirror")).not.toBeNull(), { timeout: 5_000 });
    return (host.querySelector(".ProseMirror") as unknown as { editor: Editor }).editor;
  };

  it("tells the form an emptied editor is \"\", never <p></p>", async () => {
    const onChange = vi.fn();
    const editor = await mountEditor("<p>Some description text</p>", onChange);
    await act(async () => { editor.commands.setContent("<p></p>", { emitUpdate: true }); });
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("stays silent while an empty field is still empty (an Enter, an empty paragraph)", async () => {
    const onChange = vi.fn();
    const editor = await mountEditor("", onChange);
    await act(async () => { editor.commands.setContent("<p></p><p></p>", { emitUpdate: true }); });
    await act(async () => { editor.commands.setContent("<p></p>", { emitUpdate: true }); });
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["<b>x</b>", '<p style="text-align:left">x</p>'])("restores the incoming representation after editing and reverting %s", async (baseline) => {
    const onChange = vi.fn();
    function Form() {
      const [draft, setDraft] = useState(baseline);
      return <>
        <DeferredTiptapEditor content={draft} onChange={(html) => { onChange(html); setDraft(html); }} ariaLabel="Description" />
        <output data-dirty>{String(draft !== baseline)}</output>
      </>;
    }
    await act(async () => { root.render(<Form />); });
    await vi.waitFor(() => expect(host.querySelector(".ProseMirror")).not.toBeNull(), { timeout: 5_000 });
    const editor = (host.querySelector(".ProseMirror") as unknown as { editor: Editor }).editor;
    await act(async () => { editor.commands.focus("end"); });
    expect(onChange).not.toHaveBeenCalled();
    expect(host.querySelector("[data-dirty]")?.textContent).toBe("false");

    await act(async () => { editor.view.dispatch(editor.state.tr.insertText("y", 2)); });
    expect(editor.state.doc.textContent).toBe("xy");
    expect(host.querySelector("[data-dirty]")?.textContent).toBe("true");

    await act(async () => { editor.view.dispatch(closeHistory(editor.state.tr.delete(2, 3))); });
    expect(editor.state.doc.textContent).toBe("x");
    expect(onChange).toHaveBeenLastCalledWith(baseline);
    expect(host.querySelector("[data-dirty]")?.textContent).toBe("false");

    await act(async () => { editor.commands.undo(); });
    expect(editor.state.doc.textContent).toBe("xy");
    expect(host.querySelector("[data-dirty]")?.textContent).toBe("true");
    await act(async () => { editor.commands.redo(); });
    expect(onChange).toHaveBeenLastCalledWith(baseline);
    expect(host.querySelector("[data-dirty]")?.textContent).toBe("false");
  });

  it("treats changed marks as an edit even when the text matches the loaded document", async () => {
    const baseline = "<b>x</b>";
    const onChange = vi.fn();
    const editor = await mountEditor(baseline, onChange);
    await act(async () => { editor.chain().setTextSelection({ from: 1, to: 2 }).toggleBold().run(); });
    expect(editor.state.doc.textContent).toBe("x");
    expect(onChange).toHaveBeenLastCalledWith("<p>x</p>");
    await act(async () => { editor.commands.toggleBold(); });
    expect(onChange).toHaveBeenLastCalledWith(baseline);
  });

  it("uses a real external load as the new baseline without emitting or remounting", async () => {
    const onChange = vi.fn();
    const editor = await mountEditor("<b>x</b>", onChange);
    const canvas = host.querySelector(".ProseMirror");
    const baseline = "<i>new description</i>";
    await act(async () => {
      root.render(<DeferredTiptapEditor content={baseline} onChange={onChange} ariaLabel="Description" />);
    });
    expect(host.querySelector(".ProseMirror")).toBe(canvas);
    expect(editor.state.doc.textContent).toBe("new description");
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => { editor.view.dispatch(editor.state.tr.insertText("y", 2)); });
    expect(onChange).not.toHaveBeenLastCalledWith(baseline);
    await act(async () => { editor.view.dispatch(editor.state.tr.delete(2, 3)); });
    expect(onChange).toHaveBeenLastCalledWith(baseline);
  });
});
