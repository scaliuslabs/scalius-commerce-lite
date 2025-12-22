import { useEffect, useState } from "react";
import { useEditor, EditorContent, Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Heading from "@tiptap/extension-heading";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import { cn } from "@/lib/utils";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Link as LinkIcon,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  List,
  ListOrdered,
  Image as ImageIcon,
  Heading1,
  Heading2,
  Heading3,
  Undo,
  Redo,
  Table as TableIcon,
  Eraser,
  Merge,
  Split,
  Rows,
  Columns,
  Maximize,
  ChevronsLeftRight,
} from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";
import { Switch } from "./switch";

interface TiptapEditorProps {
  content: string;
  onChange: (content: string) => void;
  placeholder?: string;
  className?: string;
  compact?: boolean;
}

const MenuBar = ({
  editor,
  toggleModal,
  compact = false,
}: {
  editor: Editor | null;
  toggleModal: () => void;
  compact?: boolean;
}) => {
  const [linkUrl, setLinkUrl] = useState<string>("");
  const [imageUrl, setImageUrl] = useState<string>("");
  const [tableRows, setTableRows] = useState<string>("3");
  const [tableCols, setTableCols] = useState<string>("3");
  const [tableWithHeader, setTableWithHeader] = useState<boolean>(true);

  if (!editor) {
    return null;
  }

  const setLink = () => {
    if (linkUrl) {
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: linkUrl })
        .run();
      setLinkUrl("");
    } else {
      editor.chain().focus().unsetLink().run();
    }
  };

  const addImage = () => {
    if (imageUrl) {
      editor.chain().focus().setImage({ src: imageUrl }).run();
      setImageUrl("");
    }
  };

  const addTable = () => {
    const rows = parseInt(tableRows, 10);
    const cols = parseInt(tableCols, 10);
    if (rows > 0 && cols > 0) {
      editor
        .chain()
        .focus()
        .insertTable({ rows, cols, withHeaderRow: tableWithHeader })
        .run();
    }
  };

  const buttonSize = compact ? "h-7 w-7" : "h-9 w-9";
  const iconSize = compact ? "h-3 w-3" : "h-4 w-4";
  const gapSize = compact ? "gap-0.5" : "gap-1";
  const padding = compact ? "p-0.5" : "p-1";

  return (
    <div className={cn("border border-input rounded-t-md bg-background flex flex-wrap items-center justify-between", padding, gapSize)}>
      <div className={cn("flex flex-wrap items-center", gapSize)}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={cn(buttonSize, editor.isActive("bold") ? "bg-accent" : "")}
        >
          <Bold className={iconSize} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={cn(buttonSize, editor.isActive("italic") ? "bg-accent" : "")}
        >
          <Italic className={iconSize} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          className={cn(buttonSize, editor.isActive("underline") ? "bg-accent" : "")}
        >
          <UnderlineIcon className={iconSize} />
        </Button>

        <div className="w-px h-6 bg-border mx-1" />

        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(buttonSize, editor.isActive("link") ? "bg-accent" : "")}
            >
              <LinkIcon className={iconSize} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-2">
            <div className="flex gap-2">
              <Input
                type="url"
                placeholder="https://example.com"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                className="flex-1"
              />
              <Button type="button" size="sm" onClick={setLink}>
                Set Link
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon">
              <ImageIcon className={iconSize} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-2">
            <div className="flex gap-2">
              <Input
                type="url"
                placeholder="https://example.com/image.jpg"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                className="flex-1"
              />
              <Button type="button" size="sm" onClick={addImage}>
                Add Image
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <div className="w-px h-6 bg-border mx-1" />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => editor.chain().focus().setTextAlign("left").run()}
          className={cn(buttonSize, editor.isActive({ textAlign: "left" }) ? "bg-accent" : "")}
        >
          <AlignLeft className={iconSize} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => editor.chain().focus().setTextAlign("center").run()}
          className={
            editor.isActive({ textAlign: "center" }) ? "bg-accent" : ""
          }
        >
          <AlignCenter className={iconSize} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => editor.chain().focus().setTextAlign("right").run()}
          className={cn(buttonSize, editor.isActive({ textAlign: "right" }) ? "bg-accent" : "")}
        >
          <AlignRight className={iconSize} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => editor.chain().focus().setTextAlign("justify").run()}
          className={
            editor.isActive({ textAlign: "justify" }) ? "bg-accent" : ""
          }
        >
          <AlignJustify className={iconSize} />
        </Button>

        <div className="w-px h-6 bg-border mx-1" />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 1 }).run()
          }
          className={
            editor.isActive("heading", { level: 1 }) ? "bg-accent" : ""
          }
        >
          <Heading1 className={iconSize} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
          className={
            editor.isActive("heading", { level: 2 }) ? "bg-accent" : ""
          }
        >
          <Heading2 className={iconSize} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 3 }).run()
          }
          className={
            editor.isActive("heading", { level: 3 }) ? "bg-accent" : ""
          }
        >
          <Heading3 className={iconSize} />
        </Button>

        <div className="w-px h-6 bg-border mx-1" />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={cn(buttonSize, editor.isActive("bulletList") ? "bg-accent" : "")}
        >
          <List className={iconSize} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={cn(buttonSize, editor.isActive("orderedList") ? "bg-accent" : "")}
        >
          <ListOrdered className={iconSize} />
        </Button>

        <div className="w-px h-6 bg-border mx-1" />

        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon">
              <TableIcon className={iconSize} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2 space-y-2">
            <div className="grid grid-cols-2 gap-2 items-center">
              <Input
                type="number"
                value={tableRows}
                onChange={(e) => setTableRows(e.target.value)}
                placeholder="Rows"
                className="h-8 text-xs"
                min="1"
              />
              <Input
                type="number"
                value={tableCols}
                onChange={(e) => setTableCols(e.target.value)}
                placeholder="Cols"
                className="h-8 text-xs"
                min="1"
              />
            </div>
            <div className="flex items-center space-x-2">
              <Switch
                id="table-header"
                checked={tableWithHeader}
                onCheckedChange={setTableWithHeader}
              />
              <label
                htmlFor="table-header"
                className="text-xs text-muted-foreground"
              >
                Include header row
              </label>
            </div>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={addTable}
              className="w-full text-xs"
            >
              <TableIcon className="h-3 w-3 mr-1" /> Insert Table
            </Button>

            <hr className="my-2" />
            <p className="text-xs font-medium text-muted-foreground mb-1">
              Quick Actions:
            </p>
            <div className="grid grid-cols-3 gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().addColumnBefore().run()}
                disabled={!editor.can().addColumnBefore()}
                className="flex items-center gap-1 text-xs"
              >
                <ChevronsLeftRight className="h-3 w-3 transform rotate-90" />{" "}
                Col Before
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().addColumnAfter().run()}
                disabled={!editor.can().addColumnAfter()}
                className="flex items-center gap-1 text-xs"
              >
                <ChevronsLeftRight className="h-3 w-3 transform rotate-90" />{" "}
                Col After
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().deleteColumn().run()}
                disabled={!editor.can().deleteColumn()}
                className="flex items-center gap-1 text-xs"
              >
                <Columns className="h-3 w-3" /> Del Col
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().addRowBefore().run()}
                disabled={!editor.can().addRowBefore()}
                className="flex items-center gap-1 text-xs"
              >
                <Rows className="h-3 w-3" /> Row Before
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().addRowAfter().run()}
                disabled={!editor.can().addRowAfter()}
                className="flex items-center gap-1 text-xs"
              >
                <Rows className="h-3 w-3" /> Row After
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().deleteRow().run()}
                disabled={!editor.can().deleteRow()}
                className="flex items-center gap-1 text-xs"
              >
                <Rows className="h-3 w-3" /> Del Row
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().deleteTable().run()}
                disabled={!editor.can().deleteTable()}
                className="flex items-center gap-1 text-xs"
              >
                <Eraser className="h-3 w-3" /> Del Table
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().mergeCells().run()}
                disabled={!editor.can().mergeCells()}
                className="flex items-center gap-1 text-xs"
              >
                <Merge className="h-3 w-3" /> Merge
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().splitCell().run()}
                disabled={!editor.can().splitCell()}
                className="flex items-center gap-1 text-xs"
              >
                <Split className="h-3 w-3" /> Split
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  editor.chain().focus().toggleHeaderColumn().run()
                }
                disabled={!editor.can().toggleHeaderColumn()}
                className="flex items-center gap-1 text-xs"
              >
                <ChevronsLeftRight className="h-3 w-3" /> H Col
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().toggleHeaderRow().run()}
                disabled={!editor.can().toggleHeaderRow()}
                className="flex items-center gap-1 text-xs"
              >
                <Rows className="h-3 w-3" /> H Row
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().toggleHeaderCell().run()}
                disabled={!editor.can().toggleHeaderCell()}
                className="flex items-center gap-1 text-xs"
              >
                <TableIcon className="h-3 w-3" /> H Cell
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <div className="w-px h-6 bg-border mx-1" />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
        >
          <Undo className={iconSize} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
        >
          <Redo className={iconSize} />
        </Button>
      </div>

      <div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggleModal}
          title="Open in fullscreen"
        >
          <Maximize className={iconSize} />
        </Button>
      </div>
    </div>
  );
};

export function TiptapEditor({
  content,
  onChange,
  placeholder = "Write something...",
  className,
  compact = false,
}: TiptapEditorProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const toggleModal = () => {
    setIsModalOpen(!isModalOpen);
  };

  const editorInstance = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
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
        blockquote: false,
        code: false,
        codeBlock: false,
        strike: false,
        horizontalRule: false,
      }),
      Heading.configure({
        levels: [1, 2, 3, 4, 5, 6],
        HTMLAttributes: (level: number) => {
          alert(`Standalone Heading style TEST for level ${level}`);
          return {
            style: {
              color: level === 1 ? "magenta" : level === 2 ? "cyan" : "lime",
              fontSize: `${5 - level}rem`,
              border: "4px solid yellow",
              padding: "8px",
              display: "block",
              margin: "12px 0",
              backgroundColor: "#333",
            },
            class: `debug-standalone-heading-level-${level}`,
          };
        },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: "text-primary underline",
        },
      }),
      Image.configure({
        inline: true,
        allowBase64: true,
        HTMLAttributes: {
          class: "max-w-full h-auto rounded-md border",
        },
      }),
      Placeholder.configure({
        placeholder,
      }),
      Underline,
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none p-4 min-h-[200px] focus-visible:outline-none",
      },
    },
    immediatelyRender: false,
  });

  useEffect(() => {
    if (editorInstance && content !== editorInstance.getHTML() && isMounted) {
      editorInstance.commands.setContent(content);
    }
  }, [content, editorInstance, isMounted]);

  const editorUI = (currentEditor: Editor | null) => (
    <div className={cn("border rounded-md flex flex-col", className)}>
      {currentEditor && (
        <MenuBar editor={currentEditor} toggleModal={toggleModal} compact={compact} />
      )}
      <div className="border-t overflow-y-auto" style={{ maxHeight: '300px' }}>
        <EditorContent editor={currentEditor} className="prose-sm max-w-none" />
      </div>
    </div>
  );

  if (!isMounted) {
    return (
      <div className={cn("border rounded-md", className)}>
        <div className="border border-input rounded-t-md p-1 bg-background h-10"></div>
        <div className="prose prose-sm max-w-none p-4 min-h-[200px] focus-visible:outline-none border-t">
          <div className="text-muted-foreground">{placeholder}</div>
        </div>
      </div>
    );
  }

  if (isModalOpen) {
    return (
      <AlertDialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <AlertDialogContent className="max-w-4xl w-full h-[90vh] flex flex-col p-0">
          <AlertDialogHeader className="p-4 border-b">
            <AlertDialogTitle>Edit Content</AlertDialogTitle>
          </AlertDialogHeader>
          {editorInstance && (
            <MenuBar editor={editorInstance} toggleModal={toggleModal} compact={compact} />
          )}
          <div className="flex-grow overflow-y-auto p-0 border-t">
            <EditorContent editor={editorInstance} />
          </div>
          <AlertDialogFooter className="p-4 border-t">
            <AlertDialogCancel onClick={() => setIsModalOpen(false)}>
              Close
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return editorUI(editorInstance);
}
