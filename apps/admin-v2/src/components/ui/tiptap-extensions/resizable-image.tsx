import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ResizableImageView } from "./resizable-image-view";

export interface ResizableImageOptions {
  HTMLAttributes: Record<string, unknown>;
}

function readDisplayWidth(style: string): string | null {
  const match = style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i);
  const value = match?.[1]?.trim();
  if (!value || !/^\d+(?:\.\d+)?(?:px|%)$/i.test(value)) return null;
  return value;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    resizableImage: {
      setImage: (options: {
        src: string;
        alt?: string;
        title?: string;
        width?: string;
        textAlign?: string;
      }) => ReturnType;
    };
  }
}

export const ResizableImage = Node.create<ResizableImageOptions>({
  name: "image",

  group: "block",

  atom: true,

  draggable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      width: {
        default: null,
        parseHTML: (element) =>
          readDisplayWidth(element.getAttribute("style") || ""),
      },
      textAlign: { default: "center" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "img[src]",
        getAttrs: (dom) => {
          const element = dom as HTMLElement;
          const style = element.getAttribute("style") || "";
          // The HTML width/height attributes describe the transformed asset's
          // intrinsic dimensions. Merchant-selected layout width lives in CSS.
          const width = readDisplayWidth(style);

          let textAlign = "center";
          if (
            style.includes("margin-right: auto") &&
            !style.includes("margin-left: auto")
          ) {
            textAlign = "left";
          } else if (
            style.includes("margin-left: auto") &&
            !style.includes("margin-right: auto")
          ) {
            textAlign = "right";
          }

          return {
            src: element.getAttribute("src"),
            alt: element.getAttribute("alt"),
            title: element.getAttribute("title"),
            width,
            textAlign,
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const { textAlign, width, ...rest } = HTMLAttributes;
    const styles: string[] = [];

    if (width) {
      styles.push(`width: ${width}`);
    }
    styles.push("max-width: 100%");
    styles.push("height: auto");
    styles.push("border-radius: 0.375rem");

    if (textAlign === "center") {
      styles.push("margin-left: auto");
      styles.push("margin-right: auto");
      styles.push("display: block");
    } else if (textAlign === "right") {
      styles.push("margin-left: auto");
      styles.push("display: block");
    } else {
      styles.push("margin-right: auto");
      styles.push("display: block");
    }

    return [
      "img",
      mergeAttributes(this.options.HTMLAttributes, rest, {
        style: styles.join("; "),
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageView, {
      stopEvent: ({ event }) =>
        event.target instanceof Element &&
        Boolean(event.target.closest("[data-image-controls]")),
    });
  },

  addCommands() {
    return {
      setImage:
        (options) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: options,
          });
        },
    };
  },
});
