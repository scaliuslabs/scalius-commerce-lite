import { Extension, type Extensions } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import { StarterKit } from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TextAlign } from "@tiptap/extension-text-align";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table/row";
import { TableHeader } from "@tiptap/extension-table/header";
import { TableCell } from "@tiptap/extension-table/cell";
import { ResizableImage } from "../tiptap-extensions/resizable-image";
import { VideoEmbed } from "../tiptap-extensions/video-embed";

/**
 * Pasted and dropped HTML is untrusted: ProseMirror parses it with
 * `innerHTML` (in a detached document, where an event-handler attribute still
 * trips the page's CSP), so it goes through the shared sanitizer's allow-list
 * first and the parser never sees a handler, a script or a `javascript:` URL.
 */
export const SanitizedPaste = Extension.create({
  name: "sanitizedPaste",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("sanitizedPaste"),
        props: { transformPastedHTML: (html) => sanitizeHtml(html) },
      }),
    ];
  },
});

export function createTiptapExtensions(placeholder: string): Extensions {
  return [
    SanitizedPaste,
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3],
      },
      link: {
        openOnClick: false,
        HTMLAttributes: {
          class: "text-primary underline",
        },
      },
      underline: {},
      bulletList: {
        HTMLAttributes: {
          class: "list-disc ps-5",
        },
      },
      orderedList: {
        HTMLAttributes: {
          class: "list-decimal ps-5",
        },
      },
      listItem: {},
      code: false,
      codeBlock: false,
      strike: false,
      horizontalRule: false,
    }),
    ResizableImage,
    VideoEmbed,
    Placeholder.configure({
      placeholder,
    }),
    TextAlign.configure({
      types: ["heading", "paragraph"],
    }),
    Table.configure({
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
  ];
}
