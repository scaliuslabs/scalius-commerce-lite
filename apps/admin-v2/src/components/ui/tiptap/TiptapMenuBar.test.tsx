// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "~/i18n";
import { TiptapMenuBar } from "./TiptapMenuBar";

vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...actual,
    useEditorState: ({
      editor,
      selector,
    }: {
      editor: Editor;
      selector: (snapshot: { editor: Editor; transactionNumber: number }) => unknown;
    }) => selector({ editor, transactionNumber: 0 }),
  };
});

vi.mock("@tiptap/pm/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/pm/state")>();
  return {
    ...actual,
    TextSelection: {
      ...actual.TextSelection,
      near: (position: { pos: number }) => ({ from: position.pos }),
    },
  };
});

vi.mock("~/components/admin/media-manager", () => ({
  MediaManager: ({ open, onSelect, onOpenChange }: {
    open: boolean;
    onSelect: (file: { url: string; filename: string }) => void;
    onOpenChange: (open: boolean) => void;
  }) => open ? <button type="button" data-pick-image onClick={() => {
    onOpenChange(false);
    onSelect({ url: "https://example.com/section-image.jpg", filename: "section-image.jpg" });
  }}>Choose image</button> : null,
}));

vi.mock("./TiptapTablePopover", () => ({
  TiptapTablePopover: () => <button type="button">Table</button>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const makeEditor = () => {
  const setImage = vi.fn();
  const setVideoEmbed = vi.fn();
  const focusEditor = vi.fn();
  const run = vi.fn(() => true);
  const chain = {
    focus: vi.fn(() => chain),
    setTextSelection: vi.fn(() => chain),
    extendMarkRange: vi.fn(() => chain),
    setLink: vi.fn(() => chain),
    unsetLink: vi.fn(() => chain),
    setImage: vi.fn((attrs: unknown) => {
      setImage(attrs);
      return chain;
    }),
    setVideoEmbed: vi.fn((attrs: unknown) => {
      setVideoEmbed(attrs);
      return chain;
    }),
    toggleBold: vi.fn(() => chain),
    toggleItalic: vi.fn(() => chain),
    toggleUnderline: vi.fn(() => chain),
    setTextAlign: vi.fn(() => chain),
    setParagraph: vi.fn(() => chain),
    toggleHeading: vi.fn(() => chain),
    toggleBulletList: vi.fn(() => chain),
    toggleOrderedList: vi.fn(() => chain),
    toggleBlockquote: vi.fn(() => chain),
    undo: vi.fn(() => chain),
    redo: vi.fn(() => chain),
    run,
  };

  return {
    editor: {
      chain: vi.fn(() => chain),
      commands: {
        focus: focusEditor,
      },
      can: vi.fn(() => ({
        undo: () => true,
        redo: () => true,
        toggleBlockquote: () => true,
      })),
      isActive: vi.fn(() => false),
      getAttributes: vi.fn(() => ({})),
      state: {
        doc: { resolve: (position: number) => ({ pos: position }) },
        selection: { empty: false, to: 1 },
      },
    } as unknown as Editor,
    setImage,
    setVideoEmbed,
    focusEditor,
    chain,
  };
};

describe("TiptapMenuBar", () => {
  let host: HTMLDivElement;
  let root: Root;
  let requestAnimationFrameSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    requestAnimationFrameSpy = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrameSpy);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    vi.unstubAllGlobals();
    setLocale("en");
  });

  async function openMenu(label: string, index = 0) {
    const trigger = host.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)[index];
    expect(trigger).toBeDefined();
    act(() => { trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, cancelable: true })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  async function selectItem(label: string) {
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role^="menuitem"]')).find((node) => node.textContent === label);
    expect(item).toBeDefined();
    act(() => item?.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it("keeps media-library insertion scoped to the clicked editor", async () => {
    const first = makeEditor();
    const second = makeEditor();
    act(() => root.render(<><TiptapMenuBar editor={first.editor} toggleModal={vi.fn()} /><TiptapMenuBar editor={second.editor} toggleModal={vi.fn()} /></>));
    await openMenu("Insert", 1);
    await selectItem("Media library");
    act(() => host.querySelector<HTMLButtonElement>("[data-pick-image]")?.click());
    expect(first.setImage).not.toHaveBeenCalled();
    expect(second.setImage).toHaveBeenCalledWith({ src: "https://example.com/section-image.jpg", alt: "section-image.jpg" });
    expect(second.chain.setTextSelection).toHaveBeenCalledWith(1);
  });

  it("commits a picked image before waiting for dialog focus restoration", async () => {
    const instance = makeEditor();
    act(() => root.render(<TiptapMenuBar editor={instance.editor} toggleModal={vi.fn()} />));
    await openMenu("Insert");
    await selectItem("Media library");
    const restoreFocus: FrameRequestCallback[] = [];
    requestAnimationFrameSpy.mockImplementationOnce((callback: FrameRequestCallback) => { restoreFocus.push(callback); return 1; });
    act(() => host.querySelector<HTMLButtonElement>("[data-pick-image]")?.click());
    expect(instance.setImage).toHaveBeenCalledOnce();
    expect(instance.focusEditor).not.toHaveBeenCalled();
    restoreFocus[0]?.(0);
    expect(instance.focusEditor).toHaveBeenCalledWith(undefined, { scrollIntoView: false });
  });

  it("runs direct formatting and history commands on the active editor", () => {
    const { editor, chain } = makeEditor();
    act(() => root.render(<TiptapMenuBar editor={editor} toggleModal={vi.fn()} />));
    for (const [label, command] of [
      ["Bold (Ctrl+B)", chain.toggleBold], ["Italic (Ctrl+I)", chain.toggleItalic],
      ["Underline (Ctrl+U)", chain.toggleUnderline], ["Bullet list", chain.toggleBulletList],
      ["Numbered list", chain.toggleOrderedList], ["Undo (Ctrl+Z)", chain.undo], ["Redo (Ctrl+Shift+Z)", chain.redo],
    ] as const) {
      act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click());
      expect(command).toHaveBeenCalled();
    }
  });

  it("keeps heading, paragraph and quote in Text style, separate from Alignment", async () => {
    const { editor, chain } = makeEditor();
    act(() => root.render(<TiptapMenuBar editor={editor} toggleModal={vi.fn()} />));
    for (const [label, command] of [["Heading 2", chain.toggleHeading], ["Paragraph", chain.setParagraph], ["Blockquote", chain.toggleBlockquote]] as const) {
      await openMenu("Text style: Paragraph");
      expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Align center");
      await selectItem(label);
      expect(command).toHaveBeenCalled();
    }
    expect(chain.toggleHeading).toHaveBeenCalledWith({ level: 2 });
    expect(chain.setTextAlign).not.toHaveBeenCalled();
  });

  it("keeps all four alignment commands in their own menu", async () => {
    const { editor, chain } = makeEditor();
    act(() => root.render(<TiptapMenuBar editor={editor} toggleModal={vi.fn()} />));
    for (const [label, value] of [["Align left", "left"], ["Align center", "center"], ["Align right", "right"], ["Justify", "justify"]] as const) {
      await openMenu("Alignment: Align left");
      expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Paragraph");
      await selectItem(label);
      expect(chain.setTextAlign).toHaveBeenCalledWith(value);
      expect(chain.focus).toHaveBeenCalled();
    }
  });

  it("names and illustrates the current alignment", () => {
    const { editor } = makeEditor();
    vi.mocked(editor.isActive).mockImplementation((value: unknown) => typeof value === "object" && value !== null && "textAlign" in value && value.textAlign === "center");
    act(() => root.render(<TiptapMenuBar editor={editor} toggleModal={vi.fn()} />));
    expect(host.querySelector('button[aria-label="Alignment: Align center"] .lucide-text-align-center')).not.toBeNull();
  });

  it("keeps narrow-layout formatting and history reachable through More", async () => {
    const { editor, chain } = makeEditor();
    act(() => root.render(<TiptapMenuBar editor={editor} toggleModal={vi.fn()} compact />));
    for (const [label, command] of [["Italic (Ctrl+I)", chain.toggleItalic], ["Underline (Ctrl+U)", chain.toggleUnderline], ["Bullet list", chain.toggleBulletList], ["Numbered list", chain.toggleOrderedList], ["Undo (Ctrl+Z)", chain.undo], ["Redo (Ctrl+Shift+Z)", chain.redo]] as const) {
      await openMenu("More formatting");
      await selectItem(label);
      expect(command).toHaveBeenCalled();
    }
  });

  it("shows the current Italic state in More", async () => {
    const { editor } = makeEditor();
    vi.mocked(editor.isActive).mockImplementation((value: unknown) => value === "italic");
    act(() => root.render(<TiptapMenuBar editor={editor} toggleModal={vi.fn()} />));
    await openMenu("More formatting");
    const item = Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find((node) => node.textContent === "Italic (Ctrl+I)");
    expect(item?.getAttribute("aria-checked")).toBe("true");
  });

  it("names the toolbar, menus and actions in Bangla", async () => {
    const { editor } = makeEditor();
    act(() => setLocale("bn"));
    act(() => root.render(<TiptapMenuBar editor={editor} toggleModal={vi.fn()} />));
    expect(host.querySelector('[role="toolbar"]')?.getAttribute("aria-label")).toBe("লেখার ফরম্যাটিং");
    for (const label of ["বোল্ড (Ctrl+B)", "লিংক যোগ করুন", "পূর্ণ স্ক্রিন", "আরও ফরম্যাটিং", "লেখার ধরন: অনুচ্ছেদ", "অবস্থান: বাঁয়ে সাজান"]) {
      expect(host.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
    }
    await openMenu("লেখার ধরন: অনুচ্ছেদ");
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("হেডিং ২");
  });
});
