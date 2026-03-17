import { useState } from "react";
import type { Editor } from "@tiptap/react";
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
  Maximize,
  Minimize2,
  TextQuote,
  Video as VideoIcon,
  FolderOpen,
} from "lucide-react";
import { Button } from "../button";
import { Input } from "../input";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "../tooltip";
import { MediaManager } from "@/components/admin/media-manager";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { ToolbarButton } from "./ToolbarButton";
import { TiptapTablePopover } from "./TiptapTablePopover";

interface MenuBarProps {
  editor: Editor | null;
  toggleModal: () => void;
  compact?: boolean;
  isFullscreen?: boolean;
}

export const TiptapMenuBar = ({
  editor,
  toggleModal,
  compact = false,
  isFullscreen = false,
}: MenuBarProps) => {
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
        <TiptapTablePopover
          editor={editor}
          buttonSize={buttonSize}
          iconSize={iconSize}
          tableRows={tableRows}
          tableCols={tableCols}
          tableWithHeader={tableWithHeader}
          onTableRowsChange={setTableRows}
          onTableColsChange={setTableCols}
          onTableWithHeaderChange={setTableWithHeader}
        />

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
