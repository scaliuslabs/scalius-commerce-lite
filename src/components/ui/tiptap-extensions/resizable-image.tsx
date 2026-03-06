import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ResizableImageView } from "./resizable-image-view";
import {
  getOriginalImageUrl,
  getRichTextOptimizedImageUrl,
} from "@/shared/image-optimizer";

export interface ResizableImageOptions {
  HTMLAttributes: Record<string, unknown>;
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
        optimize?: boolean;
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
      width: { default: null },
      textAlign: { default: "center" },
      optimize: { default: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: "img[src]",
        getAttrs: (dom) => {
          const element = dom as HTMLElement;
          const style = element.getAttribute("style") || "";
          const width =
            element.getAttribute("data-image-width") ||
            element.getAttribute("width") ||
            element.style.width ||
            null;
          const originalSrc =
            element.getAttribute("data-original-src") ||
            getOriginalImageUrl(element.getAttribute("src"));
          const explicitAlignment = element.getAttribute("data-image-align");
          const optimize =
            element.getAttribute("data-image-optimize") === "true" ||
            Boolean(element.getAttribute("data-original-src"));

          let textAlign = "center";
          if (explicitAlignment === "left" || explicitAlignment === "center" || explicitAlignment === "right") {
            textAlign = explicitAlignment;
          } else if (
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
            src: originalSrc,
            alt: element.getAttribute("alt"),
            title: element.getAttribute("title"),
            width,
            textAlign,
            optimize,
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const {
      src,
      textAlign,
      width,
      optimize,
      ...rest
    } = HTMLAttributes as {
      src?: string | null;
      textAlign?: string | null;
      width?: string | null;
      optimize?: boolean;
    };
    const styles: string[] = [];
    const normalizedTextAlign =
      textAlign === "left" || textAlign === "right" ? textAlign : "center";
    const originalSrc = getOriginalImageUrl(src);
    const renderedSrc =
      optimize && originalSrc
        ? getRichTextOptimizedImageUrl(originalSrc, width)
        : originalSrc;

    if (width) {
      styles.push(`width: ${width}`);
    }
    styles.push("max-width: 100%");
    styles.push("height: auto");
    styles.push("border-radius: 0.375rem");

    if (normalizedTextAlign === "center") {
      styles.push("margin-left: auto");
      styles.push("margin-right: auto");
      styles.push("display: block");
    } else if (normalizedTextAlign === "right") {
      styles.push("margin-left: auto");
      styles.push("display: block");
    } else {
      styles.push("margin-right: auto");
      styles.push("display: block");
    }

    return [
      "img",
      mergeAttributes(this.options.HTMLAttributes, rest, {
        src: renderedSrc,
        "data-original-src": optimize && originalSrc ? originalSrc : null,
        "data-image-optimize": optimize ? "true" : null,
        "data-image-align": normalizedTextAlign,
        "data-image-width": width,
        style: styles.join("; "),
        loading: "lazy",
        decoding: "async",
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageView);
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
