import { useEffect, useState } from "react";
import { useEditor, EditorContent, Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Heading from "@tiptap/extension-heading";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import Youtube from "@tiptap/extension-youtube";
import { ResizableImage } from "./tiptap-extensions/resizable-image";
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
  Minimize2,
  ChevronsLeftRight,
  TextQuote,
  Youtube as YoutubeIcon,
} from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "./tooltip";
import { Switch } from "./switch";

interface TiptapEditorProps {
  content: string;
  onChange: (content: string) => void;
  placeholder?: string;
  className?: string;
  compact?: boolean;
}

function ToolbarButton({
  onClick,
  isActive,
  disabled,
  tooltip,
  buttonSize,
  children,
}: {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  tooltip: string;
  buttonSize: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClick}
          disabled={disabled}
          className={cn(buttonSize, isActive && "bg-accent")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={5}>
        <p className="text-xs">{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}

const MenuBar = ({
  editor,
  toggleModal,
  compact = false,
  isFullscreen = false,
}: {
  editor: Editor | null;
  toggleModal: () => void;
  compact?: boolean;
  isFullscreen?: boolean;
}) => {
  const [linkUrl, setLinkUrl] = useState<string>("");
  const [imageUrl, setImageUrl] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [tableRows, setTableRows] = useState<string>("3");
  const [tableCols, setTableCols] = useState<string>("3");
  const [tableWithHeader, setTableWithHeader] = useState<boolean>(true);

  if (!editor) {
    return null;
  }

  const setLink = () => {
    if (linkUrl) {
      setLinkOpen(false);
      requestAnimationFrame(() => {
        editor
          .chain()
          .focus()
          .extendMarkRange("link")
          .setLink({ href: linkUrl })
          .run();
        setLinkUrl("");
      });
    } else {
      editor.chain().focus().unsetLink().run();
      setLinkOpen(false);
    }
  };

  const addImage = () => {
    if (!imageUrl) return;
    const url = imageUrl;
    setImageUrl("");
    setImageOpen(false);
    requestAnimationFrame(() => {
      editor.chain().focus().setImage({ src: url }).run();
    });
  };

  const addVideo = () => {
    if (!videoUrl) return;
    const url = videoUrl;
    setVideoUrl("");
    setVideoOpen(false);
    requestAnimationFrame(() => {
      editor.chain().focus().run();
      editor.commands.setYoutubeVideo({ src: url });
    });
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
        {/* Text formatting */}
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          isActive={editor.isActive("bold")}
          tooltip="Bold (Ctrl+B)"
          buttonSize={buttonSize}

        >
          <Bold className={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          isActive={editor.isActive("italic")}
          tooltip="Italic (Ctrl+I)"
          buttonSize={buttonSize}

        >
          <Italic className={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          isActive={editor.isActive("underline")}
          tooltip="Underline (Ctrl+U)"
          buttonSize={buttonSize}

        >
          <UnderlineIcon className={iconSize} />
        </ToolbarButton>

        <div className="w-px h-6 bg-border mx-1" />

        {/* Links, images, video */}
        <Popover open={linkOpen} onOpenChange={setLinkOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(buttonSize, editor.isActive("link") && "bg-accent")}
            >
              <LinkIcon className={iconSize} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-2" onOpenAutoFocus={(e) => e.preventDefault()}>
            <div className="flex gap-2">
              <Input
                type="url"
                placeholder="https://example.com"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                className="flex-1"
                onKeyDown={(e) => e.key === "Enter" && setLink()}
              />
              <Button type="button" size="sm" onClick={setLink}>
                Set
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <Popover open={imageOpen} onOpenChange={setImageOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={buttonSize}
            >
              <ImageIcon className={iconSize} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-2" onOpenAutoFocus={(e) => e.preventDefault()}>
            <div className="flex gap-2">
              <Input
                type="url"
                placeholder="https://example.com/image.jpg"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                className="flex-1"
                onKeyDown={(e) => e.key === "Enter" && addImage()}
              />
              <Button type="button" size="sm" onClick={addImage}>
                Add
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <Popover open={videoOpen} onOpenChange={setVideoOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={buttonSize}
            >
              <YoutubeIcon className={iconSize} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-2" onOpenAutoFocus={(e) => e.preventDefault()}>
            <div className="flex gap-2">
              <Input
                type="url"
                placeholder="https://youtube.com/watch?v=..."
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                className="flex-1"
                onKeyDown={(e) => e.key === "Enter" && addVideo()}
              />
              <Button type="button" size="sm" onClick={addVideo}>
                Embed
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              Supports YouTube and Vimeo URLs
            </p>
          </PopoverContent>
        </Popover>

        <div className="w-px h-6 bg-border mx-1" />

        {/* Alignment */}
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign("left").run()}
          isActive={editor.isActive({ textAlign: "left" })}
          tooltip="Align left"
          buttonSize={buttonSize}

        >
          <AlignLeft className={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign("center").run()}
          isActive={editor.isActive({ textAlign: "center" })}
          tooltip="Align center"
          buttonSize={buttonSize}

        >
          <AlignCenter className={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign("right").run()}
          isActive={editor.isActive({ textAlign: "right" })}
          tooltip="Align right"
          buttonSize={buttonSize}

        >
          <AlignRight className={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign("justify").run()}
          isActive={editor.isActive({ textAlign: "justify" })}
          tooltip="Justify"
          buttonSize={buttonSize}

        >
          <AlignJustify className={iconSize} />
        </ToolbarButton>

        <div className="w-px h-6 bg-border mx-1" />

        {/* Headings */}
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          isActive={editor.isActive("heading", { level: 1 })}
          tooltip="Heading 1"
          buttonSize={buttonSize}

        >
          <Heading1 className={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          isActive={editor.isActive("heading", { level: 2 })}
          tooltip="Heading 2"
          buttonSize={buttonSize}

        >
          <Heading2 className={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          isActive={editor.isActive("heading", { level: 3 })}
          tooltip="Heading 3"
          buttonSize={buttonSize}

        >
          <Heading3 className={iconSize} />
        </ToolbarButton>

        <div className="w-px h-6 bg-border mx-1" />

        {/* Lists & blockquote */}
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          isActive={editor.isActive("bulletList")}
          tooltip="Bullet list"
          buttonSize={buttonSize}

        >
          <List className={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          isActive={editor.isActive("orderedList")}
          tooltip="Numbered list"
          buttonSize={buttonSize}

        >
          <ListOrdered className={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          isActive={editor.isActive("blockquote")}
          tooltip="Blockquote"
          buttonSize={buttonSize}

        >
          <TextQuote className={iconSize} />
        </ToolbarButton>

        <div className="w-px h-6 bg-border mx-1" />

        {/* Table */}
        <Popover>
          <PopoverTrigger asChild>
            <span>
              <ToolbarButton
                onClick={() => {}}
                tooltip="Insert table"
                buttonSize={buttonSize}
      
              >
                <TableIcon className={iconSize} />
              </ToolbarButton>
            </span>
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

        {/* History */}
        <ToolbarButton
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          tooltip="Undo (Ctrl+Z)"
          buttonSize={buttonSize}

        >
          <Undo className={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          tooltip="Redo (Ctrl+Shift+Z)"
          buttonSize={buttonSize}

        >
          <Redo className={iconSize} />
        </ToolbarButton>
      </div>

      {/* Fullscreen toggle */}
      {!isFullscreen && (
        <div>
          <ToolbarButton
            onClick={toggleModal}
            tooltip="Fullscreen"
            buttonSize={buttonSize}
  
          >
            <Maximize className={iconSize} />
          </ToolbarButton>
        </div>
      )}
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
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Handle Escape key and body scroll lock for fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsFullscreen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isFullscreen]);

  const toggleFullscreen = () => {
    setIsFullscreen((prev) => !prev);
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
        code: false,
        codeBlock: false,
        strike: false,
        horizontalRule: false,
      }),
      Heading.configure({
        levels: [1, 2, 3],
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: "text-primary underline",
        },
      }),
      ResizableImage,
      Placeholder.configure({
        placeholder,
      }),
      Underline,
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
    ],
    content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class:
          "max-w-none p-4 min-h-[200px] focus-visible:outline-none text-sm",
      },
    },
    immediatelyRender: false,
  });

  useEffect(() => {
    if (editorInstance && content !== editorInstance.getHTML() && isMounted) {
      editorInstance.commands.setContent(content);
    }
  }, [content, editorInstance, isMounted]);

  if (!isMounted) {
    return (
      <div className={cn("border rounded-md", className)}>
        <div className="border border-input rounded-t-md p-1 bg-background h-10"></div>
        <div className="max-w-none p-4 min-h-[200px] focus-visible:outline-none text-sm border-t">
          <div className="text-muted-foreground">{placeholder}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col bg-background",
        isFullscreen
          ? "fixed inset-0 z-[100]"
          : "border rounded-md",
        !isFullscreen && className,
      )}
    >
      {/* Fullscreen header */}
      {isFullscreen && (
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
          <span className="text-sm font-medium text-muted-foreground">
            Editing Content
          </span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground hidden sm:inline">
              Press <kbd className="px-1.5 py-0.5 rounded border bg-muted text-[10px] font-mono">Esc</kbd> to exit
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsFullscreen(false)}
              className="gap-1.5"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              Exit Fullscreen
            </Button>
          </div>
        </div>
      )}

      {/* Toolbar */}
      {editorInstance && (
        <MenuBar
          editor={editorInstance}
          toggleModal={toggleFullscreen}
          compact={isFullscreen ? false : compact}
          isFullscreen={isFullscreen}
        />
      )}

      {/* Editor content — always mounted, never unmounts */}
      <div
        className={cn(
          "overflow-y-auto border-t",
          isFullscreen ? "flex-1" : "",
        )}
        style={!isFullscreen ? { maxHeight: "300px" } : undefined}
      >
        <div className={isFullscreen ? "max-w-4xl mx-auto px-8 py-6" : ""}>
          <EditorContent editor={editorInstance} className="max-w-none" />
        </div>
      </div>
    </div>
  );
}
