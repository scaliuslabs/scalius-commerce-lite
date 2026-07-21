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
import { MediaManager } from "~/components/admin/media-manager";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { normalizeVideoEmbed } from "@scalius/shared/video-embed";
import type { MediaFile } from "~/components/admin/media-manager";
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
  const [videoError, setVideoError] = useState<string | null>(null);
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

  const handleMediaSelect = (file: MediaFile) => {
    const optimizedUrl = getOptimizedImageUrl(file.url);
    requestAnimationFrame(() => {
      editor
        .chain()
        .focus()
        .setImage({
          src: optimizedUrl,
          alt: file.altText?.trim() || file.filename,
        })
        .run();
    });
  };

  const addVideo = () => {
    const normalized = normalizeVideoEmbed(videoUrl);
    if (!normalized) {
      setVideoError("Enter a valid YouTube or Vimeo video URL.");
      return;
    }
    setVideoUrl("");
    setVideoError(null);
    setVideoOpen(false);
    requestAnimationFrame(() => {
      editor
        .chain()
        .focus()
        .setVideoEmbed({
          src: normalized.src,
          provider: normalized.provider,
        })
        .run();
    });
  };

  const buttonSize = compact
    ? "h-11 w-11 sm:h-7 sm:w-7"
    : "h-11 w-11 sm:h-9 sm:w-9";
  const iconSize = compact ? "h-4 w-4 sm:h-3 sm:w-3" : "h-4 w-4";
  const gapSize = compact ? "gap-0.5" : "gap-1";
  const padding = compact ? "p-0.5" : "p-1";

  return (
    <div className={cn(
      "flex items-center overflow-hidden rounded-t-md border border-input bg-background",
      padding,
      gapSize,
    )}>
      <div className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain scrollbar-hide">
      <div className={cn("flex min-w-max items-center", gapSize)}>
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
                  aria-label="Insert link"
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
          <PopoverContent className="w-[calc(100vw-2rem)] max-w-80 p-2">
            <div className="flex gap-2">
              <Input
                type="url"
                aria-label="Link URL"
                placeholder="https://example.com"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                className="min-h-11 flex-1 sm:min-h-9"
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  setLink();
                }}
              />
              <Button type="button" size="sm" onClick={setLink} className="min-h-11 sm:min-h-9">
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
                  aria-label="Insert image URL"
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
          <PopoverContent className="w-[calc(100vw-2rem)] max-w-80 p-2">
            <div className="flex gap-2">
              <Input
                type="url"
                aria-label="Image URL"
                placeholder="https://example.com/image.jpg"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                className="min-h-11 flex-1 sm:min-h-9"
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addImage();
                }}
              />
              <Button type="button" size="sm" onClick={addImage} className="min-h-11 sm:min-h-9">
                Add
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <MediaManager
          capability="image"
          onSelect={handleMediaSelect}
          triggerLabel="Media Library"
          dialogClassName={isFullscreen ? "z-[10001]" : undefined}
          trigger={
            <ToolbarButton
              onClick={() => undefined}
              tooltip="Media Library"
              buttonSize={buttonSize}
            >
              <FolderOpen className={iconSize} />
            </ToolbarButton>
          }
        />

        {/* Video */}
        <Popover
          open={videoOpen}
          onOpenChange={(open) => {
            setVideoOpen(open);
            if (!open) setVideoError(null);
          }}
        >
          <Tooltip open={videoOpen ? false : undefined}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Embed video"
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
          <PopoverContent className="w-[calc(100vw-2rem)] max-w-80 p-2">
            <div className="flex gap-2">
              <Input
                type="url"
                aria-label="Video URL"
                placeholder="YouTube or Vimeo URL"
                value={videoUrl}
                onChange={(event) => {
                  setVideoUrl(event.target.value);
                  if (videoError) setVideoError(null);
                }}
                className="min-h-11 flex-1 sm:min-h-9"
                aria-invalid={Boolean(videoError)}
                aria-describedby={videoError ? "video-embed-error" : undefined}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addVideo();
                }}
              />
              <Button type="button" size="sm" onClick={addVideo} className="min-h-11 sm:min-h-9">
                Embed
              </Button>
            </div>
            {videoError ? (
              <p id="video-embed-error" role="alert" className="mt-1.5 text-xs text-destructive">
                {videoError}
              </p>
            ) : null}
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
      </div>

      {/* Fullscreen toggle */}
      {!isFullscreen ? (
        <div className="shrink-0 border-l border-border bg-background">
          <ToolbarButton
            onClick={toggleModal}
            tooltip="Fullscreen"
            buttonSize={buttonSize}
          >
            <Maximize className={iconSize} />
          </ToolbarButton>
        </div>
      ) : (
        <div className="shrink-0 border-l border-border bg-background">
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
