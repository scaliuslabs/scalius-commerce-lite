import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Download, ImagePlus, Loader2, Play } from "lucide-react";
import { getOptimizedImageUrl, getOriginalImageUrl } from "@scalius/shared/image-optimizer";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { MediaManager } from "../LazyMediaManager";
import type { LibraryMediaFile, MediaFile } from "../types";
import { formatDate, formatFileSize, formatFileType } from "../utils";
import { resolveSavedPoster } from "../utils/poster";

interface MediaPreviewProps {
  open: boolean;
  file: LibraryMediaFile | null;
  files: LibraryMediaFile[];
  onOpenChange: (open: boolean) => void;
  onNavigate: (direction: -1 | 1) => void;
  onUpdate: (file: LibraryMediaFile, updates: { filename?: string; altText?: string | null; caption?: string | null; posterMediaId?: string | null }) => Promise<LibraryMediaFile>;
  onSelect?: (file: MediaFile) => void;
}

export function MediaPreview({ open, file, files, onOpenChange, onNavigate, onUpdate, onSelect }: MediaPreviewProps) {
  const [filename, setFilename] = useState("");
  const [description, setDescription] = useState("");
  const [poster, setPoster] = useState<MediaFile | null>(null);
  const [posterMediaId, setPosterMediaId] = useState<string | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setFilename(file?.filename ?? "");
    setDescription(file?.kind === "video" ? (file.caption ?? "") : (file?.altText ?? ""));
    const savedPoster = resolveSavedPoster(file, files);
    setPoster(savedPoster.poster);
    setPosterMediaId(savedPoster.posterMediaId);
    setPosterUrl(savedPoster.posterUrl);
  }, [file, files]);
  if (!file) return null;
  const index = files.findIndex((item) => item.id === file.id);
  const save = async () => {
    setSaving(true);
    try {
      await onUpdate(file, {
        filename: filename.trim(),
        ...(file.kind === "video" ? { caption: description.trim() || null, posterMediaId } : { altText: description.trim() || null }),
      });
    } catch {
      // The owning hook reports the actionable CAS/API error and keeps the
      // editor open with the merchant's values intact.
    } finally { setSaving(false); }
  };
  const sourceUrl = file.kind === "image" ? getOriginalImageUrl(file.url) : file.url;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] max-h-[760px] w-[94vw] max-w-5xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-4 py-3 text-left">
          <DialogTitle className="truncate text-sm">{file.filename}</DialogTitle>
          <DialogDescription className="flex flex-wrap gap-x-3 text-xs"><span>{formatFileType(file.mimeType)}</span><span>{formatFileSize(file.size)}</span>{file.width && file.height && <span>{file.width} × {file.height}</span>}<span>{formatDate(file.createdAt)}</span></DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="relative flex min-h-64 items-center justify-center overflow-hidden bg-muted/50 p-3">
            {file.kind === "image" ? (
              <img src={getOptimizedImageUrl(file.url)} alt={file.altText || file.filename} className="max-h-full max-w-full object-contain" />
            ) : (
              <video src={file.url} poster={posterUrl ? getOptimizedImageUrl(posterUrl) : undefined} controls playsInline preload="metadata" className="max-h-full max-w-full bg-black" aria-label={file.caption || file.filename}>Your browser does not support this video.</video>
            )}
            <Button type="button" variant="secondary" size="icon" className="absolute left-3 top-1/2 h-8 w-8 -translate-y-1/2" disabled={index <= 0} onClick={() => onNavigate(-1)} aria-label="Previous asset"><ChevronLeft className="h-4 w-4" /></Button>
            <Button type="button" variant="secondary" size="icon" className="absolute right-3 top-1/2 h-8 w-8 -translate-y-1/2" disabled={index < 0 || index >= files.length - 1} onClick={() => onNavigate(1)} aria-label="Next asset"><ChevronRight className="h-4 w-4" /></Button>
          </div>
          <aside className="min-h-0 overflow-y-auto border-t p-4 md:border-l md:border-t-0">
            <div className="space-y-4">
              <div className="space-y-1.5"><Label htmlFor="media-filename" className="text-xs">File name</Label><Input id="media-filename" className="h-8 text-[13px]" maxLength={255} value={filename} onChange={(event) => setFilename(event.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor="media-description" className="text-xs">{file.kind === "image" ? "Alternative text" : "Caption"}</Label><Textarea id="media-description" rows={4} maxLength={file.kind === "image" ? 500 : 2000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={file.kind === "image" ? "Describe the image for people who cannot see it" : "Optional buyer-facing context"} className="resize-none text-[13px]" /></div>
              {file.kind === "video" && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Poster image</Label>
                  {posterUrl || posterMediaId ? <div className="flex items-center gap-2 rounded-md border p-2">{posterUrl ? <img src={getOptimizedImageUrl(posterUrl)} alt="" className="h-10 w-14 rounded object-cover" /> : <div className="flex h-10 w-14 items-center justify-center rounded bg-muted"><ImagePlus className="h-4 w-4 text-muted-foreground" /></div>}<span className="min-w-0 flex-1 truncate text-xs">{poster?.filename ?? "Saved poster image"}</span><Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setPoster(null); setPosterMediaId(null); setPosterUrl(null); }}>Remove</Button></div> : <div className="flex h-16 items-center justify-center rounded-md border border-dashed text-muted-foreground"><Play className="mr-2 h-4 w-4" /><span className="text-xs">Neutral video placeholder</span></div>}
                  <MediaManager capability="image" onSelect={(image) => { setPoster(image); setPosterMediaId(image.id); setPosterUrl(image.url); }} trigger={<Button type="button" variant="outline" size="sm" className="h-8 w-full"><ImagePlus className="mr-1.5 h-3.5 w-3.5" />{posterMediaId ? "Change poster" : "Choose poster"}</Button>} />
                </div>
              )}
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" className="h-8 flex-1" onClick={async () => { await navigator.clipboard.writeText(sourceUrl); toast.success("URL copied"); }}><Copy className="mr-1.5 h-3.5 w-3.5" />Copy URL</Button>
                <Button type="button" variant="outline" size="sm" className="h-8 flex-1" asChild><a href={sourceUrl} download={file.filename} target="_blank" rel="noreferrer"><Download className="mr-1.5 h-3.5 w-3.5" />Download</a></Button>
              </div>
            </div>
          </aside>
        </div>
        <DialogFooter className="border-t px-4 py-3 sm:justify-between">
          <span className="text-xs text-muted-foreground">Revision {file.version}</span>
          <div className="flex gap-2">{onSelect && <Button type="button" variant="outline" size="sm" onClick={() => onSelect(file)}>Use this {file.kind}</Button>}<Button type="button" size="sm" disabled={!filename.trim() || saving} onClick={() => void save()}>{saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save details</Button></div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
