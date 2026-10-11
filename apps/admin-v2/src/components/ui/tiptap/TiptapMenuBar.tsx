import { useId, useRef, useState } from "react";
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
  Pilcrow,
  ChevronDown,
  MoreHorizontal,
  Plus,
  Table as TableIcon,
  Undo,
  Redo,
  Maximize,
  TextQuote,
  Video as VideoIcon,
  FolderOpen,
} from "lucide-react";
import { Button } from "../button";
import { Input } from "../input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "../tooltip";
import { MediaManager } from "~/components/admin/media-manager";
import { normalizeVideoEmbed } from "@scalius/shared/video-embed";
import type { MediaFile } from "~/components/admin/media-manager";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "../dropdown-menu";
import { TOOLBAR_ROW, TOOLBAR_WIDE, TOOLBAR_NARROW } from "./tiptap-toolbar-layout";
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
import { useMessages } from "~/i18n";
import { richTextMessages } from "~/i18n/rich-text";

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
  isFullscreen = false,
  ariaLabel,
}: MenuBarProps) => {
  const t = useMessages(richTextMessages);
  const fieldId = useId();
  const linkUrlId = `${fieldId}-link-url`;
  const linkErrorId = `${fieldId}-link-error`;
  const imageUrlId = `${fieldId}-image-url`;
  const imageAltId = `${fieldId}-image-alt`;
  const imageErrorId = `${fieldId}-image-error`;
  const videoErrorId = `${fieldId}-video-error`;
  const insertAnchor = useRef<HTMLButtonElement | null>(null);
  const insertTrigger = useRef<HTMLButtonElement | null>(null);
  const moreTrigger = useRef<HTMLButtonElement | null>(null);
  const pendingMenuAction = useRef<(() => void) | null>(null);
  const inserted = useRef(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string>("");
  const [linkError, setLinkError] = useState(false);
  const [imageUrl, setImageUrl] = useState<string>("");
  const [imageAlt, setImageAlt] = useState<string>("");
  const [imageError, setImageError] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoError, setVideoError] = useState(false);
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
      table: currentEditor?.isActive("table") ?? false,
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
      setLinkError(true);
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
      setImageError(true);
      return;
    }

    setImageUrl("");
    setImageAlt("");
    setImageError(false);
    inserted.current = true;
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
    inserted.current = true;
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
      setVideoError(true);
      return;
    }
    setVideoUrl("");
    setVideoError(false);
    inserted.current = true;
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
  const linkLabel = t(canOpenLink ? (hasLinkSelection ? "editLink" : "addLink") : "selectTextForLink");

  // Let Radix release the menu's focus scope before focusing the editor or
  // opening a persistent sibling panel. Cancelling a menu uses Radix's default.
  const finishMenu = (event: Event) => {
    const action = pendingMenuAction.current;
    pendingMenuAction.current = null;
    if (!action) return;
    event.preventDefault();
    requestAnimationFrame(action);
  };
  const runFromMenu = (action: () => void) => { pendingMenuAction.current = action; };
  const restoreInsertFocus = (event: Event) => {
    event.preventDefault();
    if (inserted.current) editor.commands.focus(undefined, { scrollIntoView: false });
    else insertAnchor.current?.focus();
    inserted.current = false;
  };
  const heading = toolbarState.heading1 ? "1" : toolbarState.heading2 ? "2" : toolbarState.heading3 ? "3" : "paragraph";
  const styleLabel = heading === "paragraph" ? t("paragraph") : t("heading", { level: Number(heading) });
  const alignment = toolbarState.alignCenter ? "center" : toolbarState.alignRight ? "right" : toolbarState.justify ? "justify" : "left";
  const insertItems = () => (
    <>
      <DropdownMenuItem onSelect={() => runFromMenu(() => setImageOpen(true))}><ImageIcon />{t("insertImageUrl")}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => runFromMenu(() => setMediaOpen(true))}><FolderOpen />{t("mediaLibrary")}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => runFromMenu(() => setVideoOpen(true))}><VideoIcon />{t("embedVideo")}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => runFromMenu(() => setTableOpen(true))}><TableIcon />{t(toolbarState.table ? "editTable" : "insertTable")}</DropdownMenuItem>
    </>
  );

  return (
    <div className={cn("@container min-w-0 shrink-0 bg-card", isFullscreen && "mx-auto w-full max-w-2xl sm:px-4")}>
      <div role="toolbar" aria-label={ariaLabel ?? t("toolbar")} className={TOOLBAR_ROW}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-11 w-14 shrink-0 sm:h-8 sm:w-12 pointer-coarse:h-11 pointer-coarse:w-14 @[38rem]:w-26 pointer-coarse:@[38rem]:w-14" aria-label={`${t("textStyle")}: ${styleLabel}`}>
              <Pilcrow className="text-muted-foreground @[38rem]:hidden pointer-coarse:@[38rem]:block" />
              <span className="hidden min-w-0 flex-1 truncate ps-2 text-muted-foreground text-start @[38rem]:inline pointer-coarse:@[38rem]:hidden">{styleLabel}</span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="z-[10001]" onCloseAutoFocus={finishMenu}>
            <DropdownMenuRadioGroup value={heading} onValueChange={(value) => runFromMenu(() => {
              if (value === "paragraph") editor.chain().focus().setParagraph().run();
              else editor.chain().focus().toggleHeading({ level: Number(value) as 1 | 2 | 3 }).run();
            })}>
              <DropdownMenuRadioItem value="paragraph">{t("paragraph")}</DropdownMenuRadioItem>
              {([1, 2, 3] as const).map((level) => <DropdownMenuRadioItem key={level} value={String(level)}>{t("heading", { level })}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
            <DropdownMenuCheckboxItem checked={toolbarState.blockquote} disabled={!toolbarState.canToggleBlockquote} onSelect={() => runFromMenu(() => { toggleRichTextBlockquote(editor); })}>
              <TextQuote />{t("blockquote")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("alignment")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={alignment} onValueChange={(value) => runFromMenu(() => { editor.chain().focus().setTextAlign(value).run(); })}>
              <DropdownMenuRadioItem value="left"><AlignLeft />{t("alignLeft")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="center"><AlignCenter />{t("alignCenter")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="right"><AlignRight />{t("alignRight")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="justify"><AlignJustify />{t("justify")}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
        <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} isActive={toolbarState.bold} tooltip={t("bold")}><Bold /></ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} isActive={toolbarState.italic} tooltip={t("italic")}><Italic /></ToolbarButton>
        <div className={TOOLBAR_WIDE}>
          <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} isActive={toolbarState.underline} tooltip={t("underline")}><UnderlineIcon /></ToolbarButton>
        </div>
        {/* Links */}
        <Popover
          open={linkOpen}
          onOpenChange={(open) => {
            setLinkOpen(open);
            setLinkError(false);
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
                  size="icon"
                  className="h-11 w-11 shrink-0 sm:h-8 sm:w-8 pointer-coarse:h-11 pointer-coarse:w-11"
                  onPointerDown={(event) => event.preventDefault()}
                  aria-pressed={toolbarState.link || undefined}
                  aria-label={linkLabel}
                  disabled={!canOpenLink}
                >
                  <LinkIcon className={toolbarState.link ? "text-foreground" : "text-muted-foreground"} />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{linkLabel}</p>
            </TooltipContent>
          </Tooltip>
          <PopoverContent className="z-[10001] w-[calc(100vw-2rem)] max-w-sm space-y-2 p-3">
            <Label htmlFor={linkUrlId}>{t("link")}</Label>
            <div className="flex gap-2">
              <Input
                id={linkUrlId}
                type="url"
                aria-label={t("linkUrl")}
                placeholder="https://example.com"
                value={linkUrl}
                onChange={(e) => {
                  setLinkUrl(e.target.value);
                  if (linkError) setLinkError(false);
                }}
                className="flex-1"
                aria-invalid={linkError}
                aria-describedby={linkError ? linkErrorId : undefined}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  setLink();
                }}
              />
              <Button type="button" onClick={setLink}>
                {t("apply")}
              </Button>
            </div>
            {linkError ? (
              <p id={linkErrorId} role="alert" className="text-body text-destructive">
                {t("linkInvalid")}
              </p>
            ) : null}
            {hasLinkSelection ? (
              <Button type="button" variant="ghost" onClick={removeLink} className="w-full">
                {t("removeLink")}
              </Button>
            ) : null}
          </PopoverContent>
        </Popover>


        <div className={cn(TOOLBAR_WIDE, "items-center gap-0.5")}>
          <ToolbarButton onClick={() => toggleRichTextBulletList(editor)} isActive={toolbarState.bulletList} disabled={!toolbarState.canToggleList} tooltip={t("bulletList")}><List /></ToolbarButton>
          <ToolbarButton onClick={() => toggleRichTextOrderedList(editor)} isActive={toolbarState.orderedList} disabled={!toolbarState.canToggleList} tooltip={t("numberedList")}><ListOrdered /></ToolbarButton>
          <DropdownMenu onOpenChange={(open) => { if (open) { insertAnchor.current = insertTrigger.current; inserted.current = false; } }}>
            <DropdownMenuTrigger asChild>
              <Button ref={insertTrigger} type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0 sm:h-8 sm:w-20 pointer-coarse:h-11 pointer-coarse:w-11" aria-label={t("insert")}>
                <Plus className="hidden text-muted-foreground pointer-coarse:block" />
                <span className="text-body text-muted-foreground pointer-coarse:hidden">{t("insert")}</span>
                <ChevronDown className="text-muted-foreground pointer-coarse:hidden" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="z-[10001]" onCloseAutoFocus={finishMenu}>{insertItems()}</DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className={TOOLBAR_NARROW}>
          <DropdownMenu onOpenChange={(open) => { if (open) { insertAnchor.current = moreTrigger.current; inserted.current = false; } }}>
            <DropdownMenuTrigger asChild>
              <Button ref={moreTrigger} type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0 sm:h-8 sm:w-8 pointer-coarse:h-11 pointer-coarse:w-11" aria-label={t("moreFormatting")}><MoreHorizontal className="text-muted-foreground" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="z-[10001]" onCloseAutoFocus={finishMenu}>
              <DropdownMenuCheckboxItem checked={toolbarState.underline} onSelect={() => runFromMenu(() => { editor.chain().focus().toggleUnderline().run(); })}><UnderlineIcon />{t("underline")}</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={toolbarState.bulletList} disabled={!toolbarState.canToggleList} onSelect={() => runFromMenu(() => { toggleRichTextBulletList(editor); })}><List />{t("bulletList")}</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={toolbarState.orderedList} disabled={!toolbarState.canToggleList} onSelect={() => runFromMenu(() => { toggleRichTextOrderedList(editor); })}><ListOrdered />{t("numberedList")}</DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              {insertItems()}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!toolbarState.canUndo} onSelect={() => runFromMenu(() => { editor.chain().focus().undo().run(); })}><Undo />{t("undo")}</DropdownMenuItem>
              <DropdownMenuItem disabled={!toolbarState.canRedo} onSelect={() => runFromMenu(() => { editor.chain().focus().redo().run(); })}><Redo />{t("redo")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className={cn(TOOLBAR_WIDE, "ms-auto items-center gap-0.5")}>
          <ToolbarButton onClick={() => editor.chain().focus().undo().run()} disabled={!toolbarState.canUndo} tooltip={t("undo")}><Undo /></ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().redo().run()} disabled={!toolbarState.canRedo} tooltip={t("redo")}><Redo /></ToolbarButton>
        </div>
        {!isFullscreen && <div className="ms-auto shrink-0" data-rich-text-fullscreen-toggle>
          <ToolbarButton onClick={toggleModal} tooltip={t("fullscreen")}><Maximize /></ToolbarButton>
        </div>}
      </div>
        {/* Image URL Popover */}
        <Popover
          open={imageOpen}
          onOpenChange={(open) => {
            setImageOpen(open);
            if (!open) setImageError(false);
          }}
        >
          <PopoverAnchor virtualRef={insertAnchor} />
          <PopoverContent aria-label={t("insertImageUrl")} onCloseAutoFocus={restoreInsertFocus} className="z-[10001] w-[calc(100vw-2rem)] max-w-sm space-y-3 p-3">
            <div className="space-y-1.5">
              <Label htmlFor={imageUrlId}>{t("imageUrl")}</Label>
              <Input
                id={imageUrlId}
                type="url"
                aria-label={t("imageUrl")}
                placeholder="https://example.com/image.jpg"
                value={imageUrl}
                onChange={(e) => {
                  setImageUrl(e.target.value);
                  if (imageError) setImageError(false);
                }}
                aria-invalid={imageError}
                aria-describedby={imageError ? imageErrorId : undefined}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addImage();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={imageAltId}>{t("altText")}</Label>
              <Input
                id={imageAltId}
                value={imageAlt}
                maxLength={512}
                onChange={(event) => setImageAlt(event.target.value)}
                placeholder={t("altPlaceholder")}
              />
              <p className="text-body">
                {t("altHelp")}
              </p>
            </div>
            {imageError ? (
              <p id={imageErrorId} role="alert" className="text-body text-destructive">
                {t("imageUrlInvalid")}
              </p>
            ) : null}
            <Button type="button" onClick={addImage} className="w-full">
              {t("insertImage")}
            </Button>
          </PopoverContent>
        </Popover>

        {/* Video */}
        <Popover
          open={videoOpen}
          onOpenChange={(open) => {
            setVideoOpen(open);
            if (!open) setVideoError(false);
          }}
        >
          <PopoverAnchor virtualRef={insertAnchor} />
          <PopoverContent aria-label={t("embedVideo")} onCloseAutoFocus={restoreInsertFocus} className="z-[10001] w-[calc(100vw-2rem)] max-w-sm p-3">
            <div className="flex gap-2">
              <Input
                type="url"
                aria-label={t("videoUrl")}
                placeholder={t("videoPlaceholder")}
                value={videoUrl}
                onChange={(event) => {
                  setVideoUrl(event.target.value);
                  if (videoError) setVideoError(false);
                }}
                className="flex-1"
                aria-invalid={videoError}
                aria-describedby={videoError ? videoErrorId : undefined}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addVideo();
                }}
              />
              <Button type="button" onClick={addVideo}>
                {t("embed")}
              </Button>
            </div>
            {videoError ? (
              <p id={videoErrorId} role="alert" className="mt-1.5 text-body text-destructive">
                {t("videoInvalid")}
              </p>
            ) : null}
          </PopoverContent>
        </Popover>


      <MediaManager capability="image" open={mediaOpen} onOpenChange={setMediaOpen} onCloseAutoFocus={restoreInsertFocus} onSelect={handleMediaSelect} dialogClassName={isFullscreen ? "z-[10001]" : undefined} />
      <TiptapTablePopover editor={editor} open={tableOpen} onOpenChange={setTableOpen} anchorRef={insertAnchor} onCloseAutoFocus={restoreInsertFocus} tableRows={tableRows} tableCols={tableCols} tableWithHeader={tableWithHeader} onTableRowsChange={setTableRows} onTableColsChange={setTableCols} onTableWithHeaderChange={setTableWithHeader} isFullscreen={isFullscreen} />
    </div>
  );
};
