import { useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, ExternalLink, ImageOff, ImagePlus, Loader2 } from "lucide-react";
import { mediaImageUrl, mediaOriginalUrl } from "@scalius/shared/media-variants";
import { cn } from "@scalius/shared/utils";
import { toast } from "~/lib/toast";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
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
import { Field } from "~/components/ui/field";

interface MediaPreviewProps {
  open: boolean;
  file: LibraryMediaFile | null;
  files: LibraryMediaFile[];
  onOpenChange: (open: boolean) => void;
  onNavigate: (direction: -1 | 1) => void;
  onUpdate: (file: LibraryMediaFile, updates: { filename?: string; altText?: string | null; caption?: string | null; posterMediaId?: string | null }) => Promise<LibraryMediaFile>;
  onSelect?: (file: MediaFile) => void;
}

/** File details: bounded preview, metadata, video cover and original access. */
export function MediaPreview({ open, file, files, onOpenChange, onNavigate, onUpdate, onSelect }: MediaPreviewProps) {
  const t = useMessages(mediaMessages);
  const r = useMessages(resourceMessages);
  const [filename, setFilename] = useState("");
  const [description, setDescription] = useState("");
  const [poster, setPoster] = useState<MediaFile | null>(null);
  const [posterMediaId, setPosterMediaId] = useState<string | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<"close" | "select" | -1 | 1 | null>(null);
  const draftKeyRef = useRef("");
  const savingRef = useRef(false);

  const resetDraft = (source: LibraryMediaFile | null) => {
    setFilename(source?.filename ?? "");
    setDescription(source?.kind === "video" ? (source.caption ?? "") : (source?.altText ?? ""));
    const savedPoster = resolveSavedPoster(source, files);
    setPoster(savedPoster.poster);
    setPosterMediaId(savedPoster.posterMediaId);
    setPosterUrl(savedPoster.posterUrl);
  };

  useLayoutEffect(() => {
    const draftKey = file ? `${file.id}:${file.version}` : "";
    if (draftKeyRef.current === draftKey) return;
    draftKeyRef.current = draftKey;
    resetDraft(file);
    setPendingAction(null);
    // Reset only when a different file or a newer saved version arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, files]);

  const isVideo = file?.kind === "video";
  const normalizedFilename = filename.trim();
  const normalizedDescription = description.trim() || null;
  const savedDescription = (isVideo ? file?.caption : file?.altText)?.trim() || null;
  const dirty = Boolean(file) && (normalizedFilename !== file?.filename.trim() || normalizedDescription !== savedDescription || (isVideo && posterMediaId !== (file?.posterMediaId ?? null)));
  const index = file ? files.findIndex((item) => item.id === file.id) : -1;

  const requestClose = (nextOpen: boolean) => {
    if (savingRef.current) return;
    if (nextOpen) onOpenChange(true);
    else if (dirty) setPendingAction("close");
    else onOpenChange(false);
  };
  const requestNavigation = (direction: -1 | 1) => {
    if (savingRef.current) return;
    if (dirty) setPendingAction(direction);
    else onNavigate(direction);
  };
  const requestSelection = () => {
    if (savingRef.current || !file) return;
    if (dirty) setPendingAction("select");
    else onSelect?.(file);
  };
  const discardAndContinue = () => {
    if (savingRef.current) return;
    const action = pendingAction;
    setPendingAction(null);
    resetDraft(file);
    if (action === "close") onOpenChange(false);
    else if (action === "select") { if (file) onSelect?.(file); }
    else if (action) onNavigate(action);
  };
  const save = async () => {
    if (!file || savingRef.current || !normalizedFilename || !dirty) return;
    savingRef.current = true;
    setSaving(true);
    const savingKey = draftKeyRef.current;
    try {
      const updated = await onUpdate(file, {
        filename: normalizedFilename,
        ...(isVideo ? { caption: normalizedDescription, posterMediaId } : { altText: normalizedDescription }),
      });
      if (draftKeyRef.current === savingKey) resetDraft(updated);
    } catch {
      // The owning hook shows the error and the merchant's edits stay in place.
    } finally {
      savingRef.current = false;
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
        <DialogContent aria-busy={saving || undefined} className="flex h-[92svh] max-h-[760px] w-full flex-col gap-0 overflow-hidden p-0 sm:w-[94vw] sm:max-w-5xl">
          <div className="flex shrink-0 flex-col gap-1 border-b py-3 ps-4 pe-14">
            <DialogTitle className="line-clamp-2 break-words text-heading-sm">{file?.filename}</DialogTitle>
            <DialogDescription className="break-words">{meta}</DialogDescription>
          </div>
          {file ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_18rem] md:grid-rows-[minmax(0,1fr)] md:overflow-hidden">
              <div className="relative h-[min(14rem,38svh)] min-h-0 min-w-0 shrink-0 bg-muted md:h-auto">
                <div className="absolute inset-3 flex items-center justify-center">
                  <PreviewAsset key={`${file.id}:${file.url}`} file={file} posterUrl={posterUrl} />
                </div>
                <Button type="button" variant="outline" size="icon" className="absolute inset-s-3 top-1/2 -translate-y-1/2" disabled={saving || index <= 0} onClick={() => requestNavigation(-1)} aria-label={t("previousFile")}>
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <Button type="button" variant="outline" size="icon" className="absolute inset-e-3 top-1/2 -translate-y-1/2" disabled={saving || index < 0 || index >= files.length - 1} onClick={() => requestNavigation(1)} aria-label={t("nextFile")}>
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
              <div className="flex min-h-0 min-w-0 shrink-0 flex-col gap-4 border-t p-4 md:overflow-y-auto md:border-s md:border-t-0">
                <Field id="media-filename" label={t("fileName")}>
                  <Input id="media-filename" maxLength={255} disabled={saving} value={filename} onChange={(event) => setFilename(event.target.value)} />
                </Field>
                <Field id="media-description" label={t(isVideo ? "videoDescription" : "altText")} help={t(isVideo ? "videoDescriptionHelp" : "altTextHelp")}>
                  <Textarea id="media-description" rows={4} maxLength={isVideo ? 2000 : 500} disabled={saving} value={description} onChange={(event) => setDescription(event.target.value)} />
                </Field>
                {isVideo ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-body font-medium">{t("coverImage")}</span>
                    {posterUrl || posterMediaId ? (
                      <div className="flex items-center gap-2 rounded-lg border p-2">
                        {posterUrl ? <img src={mediaImageUrl(posterUrl, 160)} alt="" className="h-10 w-14 rounded-md bg-muted object-contain" /> : null}
                        <span className="min-w-0 flex-1 truncate text-body">{poster?.filename ?? t("coverImage")}</span>
                        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => { setPoster(null); setPosterMediaId(null); setPosterUrl(null); }}>
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
                        <Button type="button" variant="outline" disabled={saving}>
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
                    <a href={sourceUrl} target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden="true" />
                      {t("openOriginal")}
                    </a>
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
            {dirty ? <span className="me-auto text-body text-muted-foreground" aria-live="polite">{r("unsavedChanges")}</span> : null}
            {onSelect && file ? (
              <Button type="button" variant="outline" disabled={saving} onClick={requestSelection}>{t(isVideo ? "useVideo" : "useImage")}</Button>
            ) : null}
            <Button type="button" loading={saving} aria-label={r("save")} disabled={!normalizedFilename || !dirty} onClick={() => void save()}>{r("save")}</Button>
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

/** Keyed per file so a new selection never retains the previous bitmap or error. */
function PreviewAsset({ file, posterUrl }: { file: LibraryMediaFile; posterUrl: string | null }) {
  const t = useMessages(mediaMessages);
  const r = useMessages(resourceMessages);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const original = file.kind === "image" ? mediaOriginalUrl(file.url) : file.url;
  if (status === "error") {
    return (
      <div className="flex flex-col items-center gap-2 text-center" role="status">
        <ImageOff className="size-6 text-muted-foreground" aria-hidden="true" />
        <p className="text-body text-muted-foreground">{t("previewUnavailable")}</p>
        <Button type="button" variant="outline" asChild><a href={original} target="_blank" rel="noreferrer">{t("openOriginal")}</a></Button>
      </div>
    );
  }
  return (
    <>
      {status === "loading" ? <div className="absolute inset-0 flex items-center justify-center gap-2 text-body text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" aria-hidden="true" />{r("loading")}</div> : null}
      {file.kind === "image" ? (
        <img src={mediaImageUrl(file.url, 960)} alt={file.altText || file.filename} className={cn("max-h-full max-w-full object-contain", status !== "ready" && "invisible")} onLoad={() => setStatus("ready")} onError={() => setStatus("error")} />
      ) : (
        <VideoPlayer src={file.url} poster={posterUrl ? mediaImageUrl(posterUrl, 960) : undefined} playsInline preload="metadata" className={cn("max-h-full max-w-full", status !== "ready" && "invisible")} aria-label={file.caption || file.filename} onLoadedMetadata={() => setStatus("ready")} onError={() => setStatus("error")} />
      )}
    </>
  );
}
