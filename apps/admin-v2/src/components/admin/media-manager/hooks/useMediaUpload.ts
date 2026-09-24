import { useCallback, useEffect, useRef, useState } from "react";
import {
  MEDIA_MAX_FILES_PER_UPLOAD,
  MEDIA_MULTIPART_PART_SIZE_BYTES,
  MEDIA_SIGNATURE_READ_BYTES,
  getMediaPolicy,
  normalizeMediaMimeType,
  validateMediaFileMetadata,
  validateMediaSignature,
} from "@scalius/shared/media-policy";
import { toast } from "sonner";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { mediaText as t } from "~/i18n/media";
import { MediaApiClient, type MediaUploadSession } from "../api";
import type { LibraryMediaFile, MediaCapability, UploadError, UploadQueueItem } from "../types";
import { readIntrinsicMediaMetadata } from "../utils/intrinsic-metadata";
import { canEncodeMediaVariants, encodeMediaVariants } from "../utils/media-variants";

const MAX_CONCURRENT_FILES = 2;
/** A finished row stays long enough to read "Uploaded", then leaves the panel. */
export const DONE_ROW_MS = 2500;
const IN_FLIGHT = new Set<UploadQueueItem["status"]>(["queued", "uploading", "processing"]);
/** Server session states a retry continues instead of starting over. */
const RESUMABLE = new Set<MediaUploadSession["state"]>(["initiated", "uploading", "completing", "committed"]);

interface UseMediaUploadOptions {
  capability: MediaCapability;
  folderId?: string | null;
  onUploadComplete?: (files: LibraryMediaFile[]) => void;
}

function queueId(): string {
  return `upload_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function byId(items: UploadQueueItem[], id: string): UploadQueueItem | undefined {
  return items.find((item) => item.id === id);
}

function notSupported(capability: MediaCapability): UploadError {
  return capability === "image" ? "notImage" : capability === "video" ? "notVideo" : "notMedia";
}

/** Checks type, size and the file's real content before anything is sent. */
async function checkFile(file: File, capability: MediaCapability): Promise<UploadError | null> {
  const metadata = validateMediaFileMetadata({ filename: file.name, mimeType: file.type, size: file.size });
  if (!metadata.ok) {
    const mimeType = normalizeMediaMimeType(file.type);
    const policy = mimeType ? getMediaPolicy(mimeType) : null;
    if (policy && file.size > policy.maxBytes) return policy.kind === "video" ? "videoTooLarge" : "imageTooLarge";
    return notSupported(capability);
  }
  if (capability !== "both" && metadata.value.kind !== capability) return notSupported(capability);
  const head = await file.slice(0, MEDIA_SIGNATURE_READ_BYTES).arrayBuffer();
  return validateMediaSignature(head, metadata.value.mimeType).ok ? null : notSupported(capability);
}

/** Server rejections become the same plain reasons as the client checks; never raw server text. */
function serverError(error: unknown, item: UploadQueueItem, capability: MediaCapability, rejectsContent: boolean): UploadError {
  if (!(error instanceof AdminApiResponseError)) return "failed";
  if (error.status === 413) return item.kind === "video" ? "videoTooLarge" : "imageTooLarge";
  if (rejectsContent && [400, 415, 422].includes(error.status)) return notSupported(capability);
  return "failed";
}

export function useMediaUpload({ capability, folderId, onUploadComplete }: UseMediaUploadOptions) {
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const queueRef = useRef<UploadQueueItem[]>([]);
  const activeCountRef = useRef(0);
  const controllersRef = useRef(new Map<string, AbortController>());
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const aliveRef = useRef(false);
  const onCompleteRef = useRef(onUploadComplete);
  onCompleteRef.current = onUploadComplete;
  const pumpRef = useRef<() => void>(() => undefined);

  // Set in the effect body (not at declaration) so StrictMode's replayed
  // mount turns it back on; a stale `false` here froze every row at "Waiting".
  useEffect(() => {
    aliveRef.current = true;
    const controllers = controllersRef.current;
    const timers = timersRef.current;
    return () => {
      aliveRef.current = false;
      controllers.forEach((controller) => controller.abort());
      timers.forEach(clearTimeout);
    };
  }, []);

  const inFlight = queue.some((item) => IN_FLIGHT.has(item.status));
  useEffect(() => {
    if (!inFlight) return;
    // A browser File can't be recovered after this document closes.
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [inFlight]);

  const commit = useCallback((next: UploadQueueItem[]) => {
    queueRef.current = next;
    if (aliveRef.current) setQueue(next);
  }, []);
  const mutate = useCallback((id: string, update: Partial<UploadQueueItem>) => {
    commit(queueRef.current.map((item) => item.id === id ? { ...item, ...update } : item));
  }, [commit]);
  const remove = useCallback((id: string) => {
    commit(queueRef.current.filter((item) => item.id !== id));
  }, [commit]);

  const runItem = useCallback(async (id: string) => {
    const item = byId(queueRef.current, id);
    if (!item?.kind) return;
    const file = item.file;
    const intrinsicMetadata = readIntrinsicMediaMetadata(file, item.kind);
    // Renditions encode while the parts upload; null falls back to the server.
    const encodedVariants = canEncodeMediaVariants(file.type) ? encodeMediaVariants(file) : Promise.resolve(null);
    const stillWanted = () => aliveRef.current && byId(queueRef.current, id) !== undefined;
    let rejectsContent = true;
    try {
      // Retry continues the server session where it stopped.
      let session: MediaUploadSession | null = item.sessionId
        ? await MediaApiClient.getUpload(item.sessionId).catch(() => null)
        : null;
      if (!session || !RESUMABLE.has(session.state)) {
        session = await MediaApiClient.initiateUpload({
          filename: file.name,
          mimeType: file.type,
          size: file.size,
          folderId: folderId ?? null,
        });
      }
      if (!stillWanted()) {
        // Removed while the session was being created: clean it up server-side.
        void MediaApiClient.abortUpload(session.id).catch(() => undefined);
        return;
      }
      mutate(id, { sessionId: session.id });

      const uploaded = new Set(session.uploadedParts?.map((part) => part.partNumber) ?? []);
      const uploadedBytes = () => [...uploaded].reduce((total, number) =>
        total + Math.min(MEDIA_MULTIPART_PART_SIZE_BYTES, file.size - (number - 1) * MEDIA_MULTIPART_PART_SIZE_BYTES), 0);
      mutate(id, { progress: Math.round((uploadedBytes() / file.size) * 95) });
      for (let partNumber = 1; partNumber <= session.expectedParts; partNumber += 1) {
        if (!stillWanted()) return;
        if (uploaded.has(partNumber)) continue;
        rejectsContent = partNumber === 1;
        const start = (partNumber - 1) * MEDIA_MULTIPART_PART_SIZE_BYTES;
        const controller = new AbortController();
        controllersRef.current.set(id, controller);
        await MediaApiClient.uploadPart(session.id, partNumber, file.slice(start, start + MEDIA_MULTIPART_PART_SIZE_BYTES), controller.signal);
        controllersRef.current.delete(id);
        uploaded.add(partNumber);
        mutate(id, { progress: Math.round((uploadedBytes() / file.size) * 95) });
      }
      rejectsContent = false;

      if (!stillWanted()) return;
      mutate(id, { status: "processing", progress: 100 });
      const variants = await encodedVariants;
      let result = await MediaApiClient.completeUpload(session.id, variants ? "client" : "server");
      let warning: UploadQueueItem["warning"] = null;
      if (variants) {
        try {
          result = await MediaApiClient.saveVariants(result.id, variants);
        } catch {
          warning = "variantsNotSaved";
        }
      } else {
        const metadata = await intrinsicMetadata;
        if (metadata && !(result.width && result.height)) {
          try {
            result = await MediaApiClient.updateFile(result, metadata);
          } catch {
            warning = "metadataNotSaved";
          }
        }
      }
      if (!aliveRef.current) return;
      onCompleteRef.current?.([result]);
      if (!byId(queueRef.current, id)) return;
      mutate(id, { status: "done", result, warning });
      // Rows with a warning stay until the merchant dismisses them.
      if (!warning) {
        const timer = setTimeout(() => {
          timersRef.current.delete(timer);
          remove(id);
        }, DONE_ROW_MS);
        timersRef.current.add(timer);
      }
    } catch (error) {
      controllersRef.current.delete(id);
      if (!stillWanted() || (error instanceof DOMException && error.name === "AbortError")) return;
      mutate(id, { status: "failed", error: serverError(error, item, capability, rejectsContent) });
    }
  }, [capability, folderId, mutate, remove]);

  const pump = useCallback(() => {
    while (activeCountRef.current < MAX_CONCURRENT_FILES) {
      const next = queueRef.current.find((item) => item.status === "queued");
      if (!next) break;
      activeCountRef.current += 1;
      mutate(next.id, { status: "uploading" });
      void runItem(next.id).finally(() => {
        activeCountRef.current -= 1;
        pumpRef.current();
      });
    }
  }, [mutate, runItem]);
  pumpRef.current = pump;

  const uploadFiles = useCallback(async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    const incoming = Array.from(files);
    if (incoming.length > MEDIA_MAX_FILES_PER_UPLOAD) {
      toast.error(t("tooManyFiles", { count: MEDIA_MAX_FILES_PER_UPLOAD }));
      return;
    }
    const items = await Promise.all(incoming.map(async (file): Promise<UploadQueueItem> => {
      const error = await checkFile(file, capability);
      return {
        id: queueId(),
        file,
        kind: error ? null : file.type.startsWith("video/") ? "video" : "image",
        status: error ? "failed" : "queued",
        progress: 0,
        sessionId: null,
        error,
        warning: null,
        result: null,
      };
    }));
    commit([...queueRef.current, ...items]);
    pumpRef.current();
  }, [capability, commit]);

  const retry = useCallback((id: string) => {
    if (byId(queueRef.current, id)?.error !== "failed") return;
    mutate(id, { status: "queued", error: null });
    pumpRef.current();
  }, [mutate]);

  /** Removes a row; an upload still in flight is stopped and its server session dropped. */
  const dismiss = useCallback((id: string) => {
    const item = byId(queueRef.current, id);
    if (!item) return;
    remove(id);
    controllersRef.current.get(id)?.abort();
    if (item.sessionId && item.status !== "done") void MediaApiClient.abortUpload(item.sessionId).catch(() => undefined);
  }, [remove]);

  return { queue, isUploading: inFlight, uploadFiles, retry, dismiss };
}
