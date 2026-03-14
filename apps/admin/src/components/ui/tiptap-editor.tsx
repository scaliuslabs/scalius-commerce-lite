import { useEffect, useState, useRef } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TextAlign } from "@tiptap/extension-text-align";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table/row";
import { TableHeader } from "@tiptap/extension-table/header";
import { TableCell } from "@tiptap/extension-table/cell";
import { Youtube } from "@tiptap/extension-youtube";
import { ResizableImage } from "./tiptap-extensions/resizable-image";
import { cn } from "@scalius/shared/utils";
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
  Video as VideoIcon,
  FolderOpen,
} from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "./tooltip";
import { Switch } from "./switch";
import { MediaManager } from "@/components/admin/media-manager";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";

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

  const handleMediaSelect = (file: { url: string; filename: string }) => {
    const optimizedUrl = getOptimizedImageUrl(file.url);
    requestAnimationFrame(() => {
      editor.chain().focus().setImage({ src: optimizedUrl, alt: file.filename }).run();
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
    <div className={cn(
      "border border-input rounded-t-md bg-background flex flex-wrap items-center",
      isFullscreen ? "justify-center" : "justify-between",
      padding,
      gapSize,
    )}>
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

        {/* Links */}
        <Popover open={linkOpen} onOpenChange={setLinkOpen}>
          <Tooltip open={linkOpen ? false : undefined}>
            <TooltipTrigger asChild>
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
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={5}>
              <p className="text-xs">Insert link</p>
            </TooltipContent>
          </Tooltip>
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

        {/* Image URL Popover */}
        <Popover open={imageOpen} onOpenChange={setImageOpen}>
          <Tooltip open={imageOpen ? false : undefined}>
            <TooltipTrigger asChild>
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
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={5}>
              <p className="text-xs">Insert Image URL</p>
            </TooltipContent>
          </Tooltip>
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

        {/* Media Manager mapped via DOM interaction to avoid breaking Radix Tooltip composition */}
        <ToolbarButton
          onClick={() => {
            const wrapper = document.getElementById("tiptap-media-manager-wrapper");
            wrapper?.querySelector("button")?.click();
          }}
          tooltip="Media Library"
          buttonSize={buttonSize}
        >
          <FolderOpen className={iconSize} />
        </ToolbarButton>

        {/* Hidden Media Manager trigger (No onClick bubble traps!) */}
        <div id="tiptap-media-manager-wrapper" className="hidden">
          <MediaManager
            onSelect={handleMediaSelect}
            triggerLabel="Hidden"
            acceptedFileTypes="image/*"
            dialogClassName={isFullscreen ? "z-[10001] !important" : undefined}
          />
        </div>

        {/* Video */}
        <Popover open={videoOpen} onOpenChange={setVideoOpen}>
          <Tooltip open={videoOpen ? false : undefined}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={buttonSize}
                >
                  <VideoIcon className={iconSize} />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={5}>
              <p className="text-xs">Embed video</p>
            </TooltipContent>
          </Tooltip>
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
                onClick={() => { }}
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
      {!isFullscreen ? (
        <div>
          <ToolbarButton
            onClick={toggleModal}
            tooltip="Fullscreen"
            buttonSize={buttonSize}
          >
            <Maximize className={iconSize} />
          </ToolbarButton>
        </div>
      ) : (
        <div>
          <ToolbarButton
            onClick={toggleModal}
            tooltip="Exit Fullscreen"
            buttonSize={buttonSize}
          >
            <Minimize2 className={iconSize} />
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
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const contentWrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Handle Escape key and body scroll lock for fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyPaddingRight = document.body.style.paddingRight;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsFullscreen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.body.classList.add("editor-fullscreen-active");

    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    document.body.classList.add("editor-fullscreen-active");

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.paddingRight = previousBodyPaddingRight;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.classList.remove("editor-fullscreen-active");
    };
  }, [isFullscreen]);

  // Break out of containing blocks via CSS overrides without unmounting
  useEffect(() => {
    if (!isFullscreen || !contentWrapperRef.current) return;

    const originalStyles = new Map<HTMLElement, string>();
    let el = contentWrapperRef.current.parentElement;

    // Traverse up to document body and strip any properties that create a containing block for fixed positioning
    while (el && el !== document.body && el !== document.documentElement) {
      const style = window.getComputedStyle(el);

      const hasContainingBlock =
        style.transform !== 'none' ||
        style.perspective !== 'none' ||
        style.filter !== 'none' ||
        (style.willChange && style.willChange !== 'auto' && style.willChange !== 'none') ||
        (style.contain && style.contain !== 'none') ||
        (style.backdropFilter && style.backdropFilter !== 'none') ||
        (style.viewTransitionName && style.viewTransitionName !== 'none');

      if (hasContainingBlock) {
        if (!originalStyles.has(el)) originalStyles.set(el, el.getAttribute('style') || '');
        el.style.setProperty('transform', 'none', 'important');
        el.style.setProperty('perspective', 'none', 'important');
        el.style.setProperty('filter', 'none', 'important');
        el.style.setProperty('will-change', 'auto', 'important');
        el.style.setProperty('contain', 'none', 'important');
        el.style.setProperty('backdrop-filter', 'none', 'important');
        el.style.setProperty('view-transition-name', 'none', 'important');
      }

      // Force z-index of all parents to ensure we sit on top of siblings like the sidebar
      const tzIndex = parseInt(style.zIndex);
      if (style.position !== 'static' || !isNaN(tzIndex) || style.isolation === 'isolate' || style.display === 'flex' || style.display === 'grid') {
        if (!originalStyles.has(el)) originalStyles.set(el, el.getAttribute('style') || '');
        el.style.setProperty('z-index', '45', 'important');
        el.style.setProperty('isolation', 'auto', 'important');
      }

      el = el.parentElement;
    }

    return () => {
      originalStyles.forEach((styleStr, element) => {
        if (styleStr === '') {
          element.removeAttribute('style');
        } else {
          element.setAttribute('style', styleStr);
        }
      });
    };
  }, [isFullscreen]);

  const editorInstance = useEditor({
    extensions: [
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
    shouldRerenderOnTransaction: true,
  });

  useEffect(() => {
    if (editorInstance && content !== editorInstance.getHTML() && isMounted) {
      editorInstance.commands.setContent(content, { emitUpdate: false });
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

  const editorContent = (
    <div
      ref={contentWrapperRef}
      className={cn(
        "flex flex-col bg-background transition-colors",
        isFullscreen
          ? "fixed inset-0 z-9999 h-dvh w-screen"
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
          toggleModal={() => {
            setIsFullscreen((prev) => {
              setTimeout(() => {
                editorInstance?.commands.focus();
              }, 50);
              return !prev;
            });
          }}
          compact={isFullscreen ? false : compact}
          isFullscreen={isFullscreen}
        />
      )}

      {/* Editor content — always mounted, never unmounts */}
      <div
        ref={editorAreaRef}
        className={cn(
          "overflow-y-auto border-t",
          isFullscreen ? "flex-1 bg-muted/30" : "",
        )}
        style={!isFullscreen ? { maxHeight: "300px" } : undefined}
        onClick={() => {
          // Click-to-focus: when user clicks the editing area background, focus the editor
          if (isFullscreen && editorInstance && !editorInstance.isFocused) {
            editorInstance.commands.focus("end");
          }
        }}
      >
        <div className={cn(
          isFullscreen
            ? "max-w-4xl mx-auto px-8 py-6 min-h-full bg-background shadow-sm border-x border-border/40"
            : ""
        )}>
          <EditorContent editor={editorInstance} className="max-w-none" />
        </div>
      </div>
      {/* CSS to ensure layout elements like sticky headers/sidebars are pushed below the fullscreen editor */}
      <style suppressHydrationWarning>{`
        body.editor-fullscreen-active header,
        body.editor-fullscreen-active aside,
        body.editor-fullscreen-active nav {
          z-index: 0 !important;
        }
      `}</style>
    </div>
  );

  return editorContent;
}
