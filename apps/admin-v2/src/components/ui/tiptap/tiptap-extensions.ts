import { Extension, type Extensions } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import { pastedHtml } from "@scalius/shared/pasted-html";
import { translate } from "~/i18n";
import { richTextMessages } from "~/i18n/rich-text";
import { toast } from "~/lib/toast";
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
 * Whether a pasted image stays: one on the dashboard's own origin, or the
 * store's media copied from one of the dashboard's editors (ProseMirror marks
 * its own copies with `data-pm-slice`). Anything else is another site's
 * address (a Google Docs image is a link to Google's server) that would break
 * or track buyers, so it is left out and the merchant is told to upload it.
 */
export function keepsPastedImage(src: string, fromEditor: boolean, origin = window.location.origin): boolean {
  if (!src) return false;
  let url: URL;
  try {
    url = new URL(src, origin);
  } catch {
    return false;
  }
  if (url.origin === origin) return true;
  return fromEditor && url.protocol === "https:" && /(?:^|\/)media\//.test(url.pathname);
}

/** Pasted HTML as the editor may parse it: marks and Word lists written out, other sites' images left out. */
export function transformPastedHtml(html: string): string {
  const fromEditor = /\sdata-pm-slice=/.test(html);
  const pasted = pastedHtml(html, { keepImage: (src) => keepsPastedImage(src, fromEditor) });
  if (pasted.droppedImages > 0) {
    toast.warning(translate(richTextMessages, "pastedImagesDropped", { count: pasted.droppedImages }));
  }
  return sanitizeHtml(pasted.html);
}

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
        // Bold, italic and underline a word processor says with styles become marks first.
        props: { transformPastedHTML: transformPastedHtml },
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
