import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Download, ImagePlus } from "lucide-react";
import { mediaImageUrl, mediaOriginalUrl } from "@scalius/shared/media-variants";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { VideoPlayer } from "~/components/ui/video-player";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { resourceMessages } from "~/i18n/resource";
import { MediaManager } from "../LazyMediaManager";
import type { LibraryMediaFile, MediaFile } from "../types";
import { formatDate, formatDuration, formatFileSize, formatFileType } from "../utils";
import { resolveSavedPoster } from "../utils/poster";
import { MediaUsage } from "./MediaUsage";

interface MediaPreviewProps {
  open: boolean;
  file: LibraryMediaFile | null;
  files: LibraryMediaFile[];
  onOpenChange: (open: boolean) => void;
  onNavigate: (direction: -1 | 1) => void;
  onUpdate: (file: LibraryMediaFile, updates: { filename?: string; altText?: string | null; caption?: string | null; posterMediaId?: string | null }) => Promise<LibraryMediaFile>;
  onSelect?: (file: MediaFile) => void;
}

/** File details: large preview, name, alt text or description, video cover, link and download. */
export function MediaPreview({ open, file, files, onOpenChange, onNavigate, onUpdate, onSelect }: MediaPreviewProps) {
  const t = useMessages(mediaMessages);
  const r = useMessages(resourceMessages);
  const [filename, setFilename] = useState("");
  const [description, setDescription] = useState("");
  const [poster, setPoster] = useState<MediaFile | null>(null);
  const [posterMediaId, setPosterMediaId] = useState<string | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<"close" | -1 | 1 | null>(null);
  const draftKeyRef = useRef("");

  const resetDraft = (source: LibraryMediaFile | null) => {
    setFilename(source?.filename ?? "");
    setDescription(source?.kind === "video" ? (source.caption ?? "") : (source?.altText ?? ""));
    const savedPoster = resolveSavedPoster(source, files);
    setPoster(savedPoster.poster);
    setPosterMediaId(savedPoster.posterMediaId);
    setPosterUrl(savedPoster.posterUrl);
  };

  useEffect(() => {
    const draftKey = file ? `${file.id}:${file.version}` : "";
    if (draftKeyRef.current === draftKey) return;
    draftKeyRef.current = draftKey;
    resetDraft(file);
    // Reset only when a different file or a newer saved version arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, files]);

  const isVideo = file?.kind === "video";
  const savedDescription = isVideo ? (file?.caption ?? "") : (file?.altText ?? "");
  const dirty = Boolean(file) && (filename !== file?.filename || description !== savedDescription || (isVideo && posterMediaId !== file?.posterMediaId));
  const index = file ? files.findIndex((item) => item.id === file.id) : -1;

  const requestClose = (nextOpen: boolean) => {
    if (nextOpen) onOpenChange(true);
    else if (dirty) setPendingAction("close");
    else onOpenChange(false);
  };
  const requestNavigation = (direction: -1 | 1) => {
    if (dirty) setPendingAction(direction);
    else onNavigate(direction);
  };
  const discardAndContinue = () => {
    const action = pendingAction;
    setPendingAction(null);
    resetDraft(file);
    if (action === "close") onOpenChange(false);
    else if (action) onNavigate(action);
  };
  const save = async () => {
    if (!file) return;
    setSaving(true);
    try {
      await onUpdate(file, {
        filename: filename.trim(),
        ...(isVideo ? { caption: description.trim() || null, posterMediaId } : { altText: description.trim() || null }),
      });
    } catch {
      // The owning hook shows the error and the merchant's edits stay in place.
    } finally {
      setSaving(false);
    }
  };

  const sourceUrl = file ? (file.kind === "image" ? mediaOriginalUrl(file.url) : file.url) : "";
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(sourceUrl);
      toast.success(t("linkCopied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };
  const meta = file
    ? [formatFileType(file.mimeType), formatFileSize(file.size), file.width && file.height ? `${file.width} × ${file.height}` : null, formatDuration(file.durationMs), formatDate(file.createdAt)]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <>
      <Dialog open={open && Boolean(file)} onOpenChange={requestClose}>
        <DialogContent className="flex h-[92svh] max-h-[760px] w-full flex-col gap-0 overflow-hidden p-0 sm:w-[94vw] sm:max-w-5xl">
          <div className="flex flex-col gap-1 border-b py-3 pl-4 pr-14">
            <DialogTitle className="break-all">{file?.filename}</DialogTitle>
            <DialogDescription>{meta}</DialogDescription>
          </div>
          {file ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_18rem] md:overflow-hidden">
              <div className="relative flex h-60 shrink-0 items-center justify-center bg-muted p-3 md:h-auto">
                {file.kind === "image" ? (
                  <img src={mediaImageUrl(file.url, 960)} alt={file.altText || file.filename} className="max-h-full max-w-full object-contain" />
                ) : (
                  <VideoPlayer key={file.id} src={file.url} poster={posterUrl ? mediaImageUrl(posterUrl, 960) : undefined} playsInline preload="metadata" className="max-h-full max-w-full" aria-label={file.caption || file.filename} />
                )}
                <Button type="button" variant="outline" size="icon" className="absolute left-3 top-1/2 -translate-y-1/2" disabled={index <= 0} onClick={() => requestNavigation(-1)} aria-label={t("previousFile")}>
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <Button type="button" variant="outline" size="icon" className="absolute right-3 top-1/2 -translate-y-1/2" disabled={index < 0 || index >= files.length - 1} onClick={() => requestNavigation(1)} aria-label={t("nextFile")}>
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
              <div className="flex flex-col gap-4 border-t p-4 md:overflow-y-auto md:border-l md:border-t-0">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="media-filename">{t("fileName")}</Label>
                  <Input id="media-filename" maxLength={255} value={filename} onChange={(event) => setFilename(event.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="media-description">{t(isVideo ? "videoDescription" : "altText")}</Label>
                  <Textarea id="media-description" rows={4} maxLength={isVideo ? 2000 : 500} value={description} onChange={(event) => setDescription(event.target.value)} />
                  <p className="text-body text-muted-foreground">{t(isVideo ? "videoDescriptionHelp" : "altTextHelp")}</p>
                </div>
                {isVideo ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-body font-medium">{t("coverImage")}</span>
                    {posterUrl || posterMediaId ? (
                      <div className="flex items-center gap-2 rounded-lg border p-2">
                        {posterUrl ? <img src={mediaImageUrl(posterUrl, 160)} alt="" className="h-10 w-14 rounded-md bg-muted object-contain" /> : null}
                        <span className="min-w-0 flex-1 truncate text-body">{poster?.filename ?? t("coverImage")}</span>
                        <Button type="button" variant="ghost" size="sm" onClick={() => { setPoster(null); setPosterMediaId(null); setPosterUrl(null); }}>
                          {t("remove")}
                        </Button>
                      </div>
                    ) : (
                      <p className="text-body text-muted-foreground">{t("noCoverImage")}</p>
                    )}
                    <MediaManager
                      capability="image"
                      onSelect={(image) => { setPoster(image); setPosterMediaId(image.id); setPosterUrl(image.url); }}
                      trigger={
                        <Button type="button" variant="outline">
                          <ImagePlus aria-hidden="true" />
                          {t(posterMediaId ? "changeCoverImage" : "chooseCoverImage")}
                        </Button>
                      }
                    />
                  </div>
                ) : null}
                {/* The picker keeps the merchant in their editor; "Used in" links live on the Files page. */}
                {onSelect ? null : <MediaUsage file={file} />}
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={() => void copyLink()}>
                    <Copy aria-hidden="true" />
                    {t("copyLink")}
                  </Button>
                  <Button type="button" variant="outline" asChild>
                    <a href={sourceUrl} download={file.filename} target="_blank" rel="noreferrer">
                      <Download aria-hidden="true" />
                      {t("download")}
                    </a>
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
            {dirty ? <span className="mr-auto text-body text-muted-foreground" aria-live="polite">{r("unsavedChanges")}</span> : null}
            {onSelect && file ? (
              <Button type="button" variant="outline" onClick={() => onSelect(file)}>{t(isVideo ? "useVideo" : "useImage")}</Button>
            ) : null}
            <Button type="button" loading={saving} disabled={!filename.trim() || !dirty} onClick={() => void save()}>{r("save")}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingAction !== null}
        onOpenChange={(nextOpen) => !nextOpen && setPendingAction(null)}
        title={t("discardTitle")}
        description={t("discardBody")}
        confirmLabel={t("discardConfirm")}
        cancelLabel={t("keepEditing")}
        onConfirm={discardAndContinue}
      />
    </>
  );
}
