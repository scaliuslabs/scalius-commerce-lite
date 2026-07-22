// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("~/components/admin/media-manager", async () => {
  const React = await import("react");

  return {
    MediaManager: ({
      onSelect,
      trigger,
    }: {
      onSelect: (file: { url: string; filename: string }) => void;
      trigger: React.ReactElement<{ onClick?: React.MouseEventHandler }>;
    }) =>
      React.cloneElement(trigger, {
        onClick: (event: React.MouseEvent) => {
          trigger.props.onClick?.(event);
          onSelect({
            url: "https://example.com/section-image.jpg",
            filename: "section-image.jpg",
          });
        },
      }),
  };
});

vi.mock("@scalius/shared/image-optimizer", () => ({
  getOptimizedImageUrl: (url: string) => `optimized:${url}`,
}));

vi.mock("./TiptapTablePopover", () => ({
  TiptapTablePopover: () => <button type="button">Table</button>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const makeEditor = () => {
  const setImage = vi.fn();
  const setVideoEmbed = vi.fn();
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
  });

  it("keeps media-library insertion scoped to the clicked editor", () => {
    const first = makeEditor();
    const second = makeEditor();

    act(() => {
      root.render(
        <div>
          <TiptapMenuBar editor={first.editor} toggleModal={vi.fn()} />
          <TiptapMenuBar editor={second.editor} toggleModal={vi.fn()} />
        </div>,
      );
    });

    const mediaButtons = host.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Media Library"]',
    );
    expect(mediaButtons).toHaveLength(2);

    act(() => {
      mediaButtons[1]?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(first.setImage).not.toHaveBeenCalled();
    expect(second.setImage).toHaveBeenCalledWith({
      src: "https://example.com/section-image.jpg",
      alt: "section-image.jpg",
    });
    expect(second.chain.setTextSelection).toHaveBeenCalledWith(1);
  });

  it("keeps compact editor actions touch-sized on mobile", () => {
    const { editor } = makeEditor();

    act(() => {
      root.render(
        <TiptapMenuBar
          editor={editor}
          toggleModal={vi.fn()}
          compact
        />,
      );
    });

    const namedActions = Array.from(
      host.querySelectorAll<HTMLButtonElement>("button[aria-label]"),
    );
    expect(namedActions.length).toBeGreaterThan(10);
    for (const action of namedActions) {
      expect(action.className).toContain("h-11");
      expect(action.className).toContain("w-11");
      expect(action.className).toContain("sm:h-7");
      expect(action.className).toContain("sm:w-7");
    }
  });

  it("runs lists, blockquotes, headings, alignment, formatting, and history on the active editor", () => {
    const { editor, chain } = makeEditor();
    act(() => {
      root.render(<TiptapMenuBar editor={editor} toggleModal={vi.fn()} />);
    });

    const actions = [
      ["Bold (Ctrl+B)", chain.toggleBold],
      ["Italic (Ctrl+I)", chain.toggleItalic],
      ["Underline (Ctrl+U)", chain.toggleUnderline],
      ["Align center", chain.setTextAlign],
      ["Heading 2", chain.toggleHeading],
      ["Bullet list", chain.toggleBulletList],
      ["Numbered list", chain.toggleOrderedList],
      ["Blockquote", chain.toggleBlockquote],
      ["Undo (Ctrl+Z)", chain.undo],
      ["Redo (Ctrl+Shift+Z)", chain.redo],
    ] as const;

    for (const [label, command] of actions) {
      act(() => {
        host
          .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
          ?.click();
      });
      expect(command).toHaveBeenCalled();
    }
  });
});
