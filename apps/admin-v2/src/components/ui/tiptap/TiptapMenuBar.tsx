import { useId, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
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
  TextQuote,
  Video as VideoIcon,
  FolderOpen,
} from "lucide-react";
import { Button } from "../button";
import { Input } from "../input";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "../tooltip";
import { MediaManager } from "~/components/admin/media-manager";
import { normalizeVideoEmbed } from "@scalius/shared/video-embed";
import type { MediaFile } from "~/components/admin/media-manager";
import { ToolbarButton } from "./ToolbarButton";
import { TiptapTablePopover } from "./TiptapTablePopover";
import { Label } from "../label";
import {
  insertRichTextImage,
  insertRichTextVideo,
} from "./tiptap-insertions";
import {
  normalizeRichTextImageUrl,
  normalizeRichTextLinkUrl,
} from "./tiptap-url";
import {
  canToggleRichTextBlockquote,
  canToggleRichTextList,
  toggleRichTextBlockquote,
  toggleRichTextBulletList,
  toggleRichTextOrderedList,
} from "./tiptap-formatting";

interface MenuBarProps {
  editor: Editor | null;
  toggleModal: () => void;
  compact?: boolean;
  isFullscreen?: boolean;
  ariaLabel?: string;
}

export const TiptapMenuBar = ({
  editor,
  toggleModal,
  compact = false,
  isFullscreen = false,
  ariaLabel = "Rich text formatting",
}: MenuBarProps) => {
  const fieldId = useId();
  const linkUrlId = `${fieldId}-link-url`;
  const linkErrorId = `${fieldId}-link-error`;
  const imageUrlId = `${fieldId}-image-url`;
  const imageAltId = `${fieldId}-image-alt`;
  const imageErrorId = `${fieldId}-image-error`;
  const videoErrorId = `${fieldId}-video-error`;
  const [linkUrl, setLinkUrl] = useState<string>("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string>("");
  const [imageAlt, setImageAlt] = useState<string>("");
  const [imageError, setImageError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [tableRows, setTableRows] = useState<string>("3");
  const [tableCols, setTableCols] = useState<string>("3");
  const [tableWithHeader, setTableWithHeader] = useState<boolean>(true);

  const toolbarState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      bold: currentEditor?.isActive("bold") ?? false,
      italic: currentEditor?.isActive("italic") ?? false,
      underline: currentEditor?.isActive("underline") ?? false,
      link: currentEditor?.isActive("link") ?? false,
      hasSelection: currentEditor ? !currentEditor.state.selection.empty : false,
      alignLeft: currentEditor?.isActive({ textAlign: "left" }) ?? false,
      alignCenter: currentEditor?.isActive({ textAlign: "center" }) ?? false,
      alignRight: currentEditor?.isActive({ textAlign: "right" }) ?? false,
      justify: currentEditor?.isActive({ textAlign: "justify" }) ?? false,
      heading1: currentEditor?.isActive("heading", { level: 1 }) ?? false,
      heading2: currentEditor?.isActive("heading", { level: 2 }) ?? false,
      heading3: currentEditor?.isActive("heading", { level: 3 }) ?? false,
      bulletList: currentEditor?.isActive("bulletList") ?? false,
      orderedList: currentEditor?.isActive("orderedList") ?? false,
      blockquote: currentEditor?.isActive("blockquote") ?? false,
      canToggleList: currentEditor ? canToggleRichTextList(currentEditor) : false,
      canToggleBlockquote: currentEditor
        ? canToggleRichTextBlockquote(currentEditor)
        : false,
      canUndo: currentEditor?.can().undo() ?? false,
      canRedo: currentEditor?.can().redo() ?? false,
    }),
  });

  if (!editor || !toolbarState) {
    return null;
  }

  const setLink = () => {
    const normalized = normalizeRichTextLinkUrl(linkUrl);
    if (!normalized) {
      setLinkError("Enter a complete web, email, phone, page, or anchor link.");
      return;
    }

    setLinkOpen(false);
    requestAnimationFrame(() => {
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: normalized })
        .run();
    });
  };

  const removeLink = () => {
    setLinkOpen(false);
    requestAnimationFrame(() => {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    });
  };

  const addImage = () => {
    const url = normalizeRichTextImageUrl(imageUrl);
    if (!url) {
      setImageError("Enter a secure image URL beginning with https://.");
      return;
    }

    setImageUrl("");
    setImageAlt("");
    setImageError(null);
    setImageOpen(false);
    insertRichTextImage(editor, {
      src: url,
      alt: imageAlt.trim(),
    });
    requestAnimationFrame(() => {
      editor.commands.focus(undefined, { scrollIntoView: false });
    });
  };

  const handleMediaSelect = (file: MediaFile) => {
    insertRichTextImage(editor, {
      src: file.url,
      alt: file.altText?.trim() || file.filename,
    });
    requestAnimationFrame(() => {
      editor.commands.focus(undefined, { scrollIntoView: false });
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
    insertRichTextVideo(editor, {
      src: normalized.src,
      provider: normalized.provider,
    });
    requestAnimationFrame(() => {
      editor.commands.focus(undefined, { scrollIntoView: false });
    });
  };

  const hasLinkSelection = toolbarState.link;
  const canOpenLink = toolbarState.hasSelection || hasLinkSelection;

  const iconButtonSize = compact ? "icon-sm" : "icon";

  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      className="flex items-center gap-0.5 overflow-hidden bg-card p-1"
    >
      <div
        className={cn(
          "min-w-0 overflow-x-auto overscroll-x-contain scrollbar-hide",
          isFullscreen ? "mx-auto w-fit max-w-full" : "flex-1",
        )}
      >
        <div className="flex min-w-max items-center gap-0.5">
        {/* Text formatting */}
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          isActive={toolbarState.bold}
          tooltip="Bold (Ctrl+B)"
          compact={compact}
        >
          <Bold />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          isActive={toolbarState.italic}
          tooltip="Italic (Ctrl+I)"
          compact={compact}
        >
          <Italic />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          isActive={toolbarState.underline}
          tooltip="Underline (Ctrl+U)"
          compact={compact}
        >
          <UnderlineIcon />
        </ToolbarButton>

        <div className="mx-1 h-6 w-px bg-border" />

        {/* Links */}
        <Popover
          open={linkOpen}
          onOpenChange={(open) => {
            setLinkOpen(open);
            setLinkError(null);
            if (open) {
              setLinkUrl(editor.getAttributes("link").href || "");
            }
          }}
        >
          <Tooltip open={linkOpen ? false : undefined}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size={iconButtonSize}
                  aria-pressed={toolbarState.link || undefined}
                  aria-label={
                    canOpenLink
                      ? hasLinkSelection
                        ? "Edit link"
                        : "Add link"
                      : "Select text to add a link"
                  }
                  disabled={!canOpenLink}
                >
                  <LinkIcon />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>
                {canOpenLink
                  ? hasLinkSelection
                    ? "Edit link"
                    : "Add link"
                  : "Select text to add a link"}
              </p>
            </TooltipContent>
          </Tooltip>
          <PopoverContent className="z-[10001] w-[calc(100vw-2rem)] max-w-sm space-y-2 p-3">
            <Label htmlFor={linkUrlId}>
              Link
            </Label>
            <div className="flex gap-2">
              <Input
                id={linkUrlId}
                type="url"
                aria-label="Link URL"
                placeholder="https://example.com"
                value={linkUrl}
                onChange={(e) => {
                  setLinkUrl(e.target.value);
                  if (linkError) setLinkError(null);
                }}
                className="flex-1"
                aria-invalid={Boolean(linkError)}
                aria-describedby={linkError ? linkErrorId : undefined}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  setLink();
                }}
              />
              <Button type="button" onClick={setLink}>
                Apply
              </Button>
            </div>
            {linkError ? (
              <p id={linkErrorId} role="alert" className="text-body text-destructive">
                {linkError}
              </p>
            ) : null}
            {hasLinkSelection ? (
              <Button type="button" variant="ghost" onClick={removeLink} className="w-full">
                Remove link
              </Button>
            ) : null}
          </PopoverContent>
        </Popover>

        {/* Image URL Popover */}
        <Popover
          open={imageOpen}
          onOpenChange={(open) => {
            setImageOpen(open);
            if (!open) setImageError(null);
          }}
        >
          <Tooltip open={imageOpen ? false : undefined}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size={iconButtonSize}
                  aria-label="Insert image URL"
                >
                  <ImageIcon />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Insert image URL</p>
            </TooltipContent>
          </Tooltip>
          <PopoverContent className="z-[10001] w-[calc(100vw-2rem)] max-w-sm space-y-3 p-3">
            <div className="space-y-1.5">
              <Label htmlFor={imageUrlId}>
                Image URL
              </Label>
              <Input
                id={imageUrlId}
                type="url"
                aria-label="Image URL"
                placeholder="https://example.com/image.jpg"
                value={imageUrl}
                onChange={(e) => {
                  setImageUrl(e.target.value);
                  if (imageError) setImageError(null);
                }}
                aria-invalid={Boolean(imageError)}
                aria-describedby={imageError ? imageErrorId : undefined}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addImage();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={imageAltId}>
                Alternative text
              </Label>
              <Input
                id={imageAltId}
                value={imageAlt}
                maxLength={512}
                onChange={(event) => setImageAlt(event.target.value)}
                placeholder="Describe the image"
              />
              <p className="text-body text-muted-foreground">
                Leave empty only when the image is decorative.
              </p>
            </div>
            {imageError ? (
              <p id={imageErrorId} role="alert" className="text-body text-destructive">
                {imageError}
              </p>
            ) : null}
            <Button type="button" onClick={addImage} className="w-full">
              Insert image
            </Button>
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
              compact={compact}
            >
              <FolderOpen />
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
                  size={iconButtonSize}
                  aria-label="Embed video"
                >
                  <VideoIcon />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Embed video</p>
            </TooltipContent>
          </Tooltip>
          <PopoverContent className="z-[10001] w-[calc(100vw-2rem)] max-w-sm p-3">
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
                className="flex-1"
                aria-invalid={Boolean(videoError)}
                aria-describedby={videoError ? videoErrorId : undefined}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addVideo();
                }}
              />
              <Button type="button" onClick={addVideo}>
                Embed
              </Button>
            </div>
            {videoError ? (
              <p id={videoErrorId} role="alert" className="mt-1.5 text-body text-destructive">
                {videoError}
              </p>
            ) : null}
          </PopoverContent>
        </Popover>

        <div className="mx-1 h-6 w-px bg-border" />

        {/* Alignment */}
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign("left").run()}
          isActive={toolbarState.alignLeft}
          tooltip="Align left"
          compact={compact}
        >
          <AlignLeft />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign("center").run()}
          isActive={toolbarState.alignCenter}
          tooltip="Align center"
          compact={compact}
        >
          <AlignCenter />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign("right").run()}
          isActive={toolbarState.alignRight}
          tooltip="Align right"
          compact={compact}
        >
          <AlignRight />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign("justify").run()}
          isActive={toolbarState.justify}
          tooltip="Justify"
          compact={compact}
        >
          <AlignJustify />
        </ToolbarButton>

        <div className="mx-1 h-6 w-px bg-border" />

        {/* Headings */}
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          isActive={toolbarState.heading1}
          tooltip="Heading 1"
          compact={compact}
        >
          <Heading1 />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          isActive={toolbarState.heading2}
          tooltip="Heading 2"
          compact={compact}
        >
          <Heading2 />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          isActive={toolbarState.heading3}
          tooltip="Heading 3"
          compact={compact}
        >
          <Heading3 />
        </ToolbarButton>

        <div className="mx-1 h-6 w-px bg-border" />

        {/* Lists & blockquote */}
        <ToolbarButton
          onClick={() => toggleRichTextBulletList(editor)}
          isActive={toolbarState.bulletList}
          disabled={!toolbarState.canToggleList}
          tooltip="Bullet list"
          compact={compact}
        >
          <List />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => toggleRichTextOrderedList(editor)}
          isActive={toolbarState.orderedList}
          disabled={!toolbarState.canToggleList}
          tooltip="Numbered list"
          compact={compact}
        >
          <ListOrdered />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => toggleRichTextBlockquote(editor)}
          isActive={toolbarState.blockquote}
          disabled={!toolbarState.canToggleBlockquote}
          tooltip="Blockquote"
          compact={compact}
        >
          <TextQuote />
        </ToolbarButton>

        <div className="mx-1 h-6 w-px bg-border" />

        {/* Table */}
        <TiptapTablePopover
          editor={editor}
          compact={compact}
          tableRows={tableRows}
          tableCols={tableCols}
          tableWithHeader={tableWithHeader}
          onTableRowsChange={setTableRows}
          onTableColsChange={setTableCols}
          onTableWithHeaderChange={setTableWithHeader}
          isFullscreen={isFullscreen}
        />

        <div className="mx-1 h-6 w-px bg-border" />

        {/* History */}
        <ToolbarButton
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!toolbarState.canUndo}
          tooltip="Undo (Ctrl+Z)"
          compact={compact}
        >
          <Undo />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!toolbarState.canRedo}
          tooltip="Redo (Ctrl+Shift+Z)"
          compact={compact}
        >
          <Redo />
        </ToolbarButton>
        </div>
      </div>

      {/* Fullscreen toggle */}
      {!isFullscreen ? (
        <div className="shrink-0 border-l pl-1">
          <ToolbarButton
            onClick={toggleModal}
            tooltip="Fullscreen"
            compact={compact}
          >
            <Maximize />
          </ToolbarButton>
        </div>
      ) : null}
    </div>
  );
};
