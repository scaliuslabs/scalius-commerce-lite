import type { Extensions } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TextAlign } from "@tiptap/extension-text-align";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table/row";
import { TableHeader } from "@tiptap/extension-table/header";
import { TableCell } from "@tiptap/extension-table/cell";
import { Youtube } from "@tiptap/extension-youtube";
import { ResizableImage } from "../tiptap-extensions/resizable-image";

export function createTiptapExtensions(placeholder: string): Extensions {
  return [
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
          class: "list-disc pl-5",
        },
      },
      orderedList: {
        HTMLAttributes: {
          class: "list-decimal pl-5",
        },
      },
      listItem: {},
      code: false,
      codeBlock: false,
      strike: false,
      horizontalRule: false,
    }),
    ResizableImage,
    Placeholder.configure({
      placeholder,
    }),
    TextAlign.configure({
      types: ["heading", "paragraph"],
    }),
    Youtube.configure({
      inline: false,
      allowFullscreen: true,
    }),
    Table.configure({
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
  ];
}
