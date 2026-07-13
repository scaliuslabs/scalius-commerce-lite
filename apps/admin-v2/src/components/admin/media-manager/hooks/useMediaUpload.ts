import { useCallback, useEffect, useRef, useState } from "react";
import {
  MEDIA_MAX_FILES_PER_UPLOAD,
  MEDIA_MULTIPART_PART_SIZE_BYTES,
  validateMediaFileMetadata,
} from "@scalius/shared/media-policy";
import { toast } from "sonner";
import { MediaApiClient } from "../api";
import type { LibraryMediaFile, MediaCapability, UploadQueueItem } from "../types";
import { readIntrinsicMediaMetadata } from "../utils/intrinsic-metadata";

const MAX_CONCURRENT_FILES = 2;
const UNFINISHED_UPLOAD_STATUSES = new Set<UploadQueueItem["status"]>([
  "queued",
  "initiating",
  "uploading",
  "paused",
  "completing",
  "failed",
]);

interface UseMediaUploadOptions {
  capability: MediaCapability;
  folderId?: string | null;
  onUploadComplete?: (files: LibraryMediaFile[]) => void;
}

function queueId(): string {
  return `upload_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function useMediaUpload({ capability, folderId, onUploadComplete }: UseMediaUploadOptions) {
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const queueRef = useRef<UploadQueueItem[]>([]);
  const activeCountRef = useRef(0);
  const controllersRef = useRef(new Map<string, AbortController>());
  const mountedRef = useRef(true);
  const pumpRef = useRef<() => void>(() => undefined);

  useEffect(() => () => {
    mountedRef.current = false;
    controllersRef.current.forEach((controller) => controller.abort());
  }, []);

  useEffect(() => {
    if (!queue.some((item) => UNFINISHED_UPLOAD_STATUSES.has(item.status))) return;

    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      // The server-side multipart session is durable, but a browser File cannot
      // be recovered after this document closes. Keep the merchant from
      // accidentally discarding the only client-side handle needed to resume.
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [queue]);

  const mutate = useCallback((id: string, update: Partial<UploadQueueItem>) => {
    queueRef.current = queueRef.current.map((item) => item.id === id ? { ...item, ...update } : item);
    if (mountedRef.current) setQueue(queueRef.current);
  }, []);

  const runItem = useCallback(async (id: string) => {
    let item = queueRef.current.find((candidate) => candidate.id === id);
    if (!item || item.status !== "initiating") return;
    const intrinsicMetadata = readIntrinsicMediaMetadata(item.file, item.kind);
    let sessionId = item.sessionId;
    let failedPart: number | null = null;
    try {
      let session;
      if (sessionId) {
        session = await MediaApiClient.getUpload(sessionId);
      } else {
        session = await MediaApiClient.initiateUpload({
          filename: item.file.name,
          mimeType: item.file.type,
          size: item.file.size,
          folderId: folderId ?? null,
        });
        sessionId = session.id;
      }

      const uploadedParts = new Set(session.uploadedParts?.map((part) => part.partNumber) ?? []);
      item = queueRef.current.find((candidate) => candidate.id === id);
      if (!item) return;
      if (item.status === "cancelled") {
        // Cancellation can race session initiation, which is not abortable in the
        // browser. Once the server returns the new session ID, clean it up rather
        // than reviving the local queue item or leaking multipart state.
        try {
          await MediaApiClient.abortUpload(session.id);
        } catch {
          mutate(id, {
            status: "paused",
            sessionId: session.id,
            error: "Server cancellation was not confirmed. Choose cancel again.",
          });
        }
        return;
      }
      mutate(id, {
        sessionId,
        expectedParts: session.expectedParts,
        uploadedParts: [...uploadedParts].sort((a, b) => a - b),
        status: item.status === "paused" ? "paused" : "uploading",
        error: null,
        warning: null,
        failedPart: null,
      });
      if (item.status === "paused") return;

      for (let partNumber = 1; partNumber <= session.expectedParts; partNumber += 1) {
        item = queueRef.current.find((candidate) => candidate.id === id);
        if (!item || item.status === "paused" || item.status === "cancelled") return;
        if (uploadedParts.has(partNumber)) continue;
        failedPart = partNumber;
        const start = (partNumber - 1) * MEDIA_MULTIPART_PART_SIZE_BYTES;
        const end = Math.min(start + MEDIA_MULTIPART_PART_SIZE_BYTES, item.file.size);
        const controller = new AbortController();
        controllersRef.current.set(id, controller);
        await MediaApiClient.uploadPart(session.id, partNumber, item.file.slice(start, end), controller.signal);
        controllersRef.current.delete(id);
        uploadedParts.add(partNumber);
        const completedBytes = [...uploadedParts].reduce((total, number) => {
          const partStart = (number - 1) * MEDIA_MULTIPART_PART_SIZE_BYTES;
          return total + Math.min(MEDIA_MULTIPART_PART_SIZE_BYTES, item!.file.size - partStart);
        }, 0);
        mutate(id, {
          uploadedParts: [...uploadedParts].sort((a, b) => a - b),
          progress: Math.min(95, Math.round((completedBytes / item.file.size) * 95)),
          failedPart: null,
        });
      }

      item = queueRef.current.find((candidate) => candidate.id === id);
      if (!item || item.status === "paused" || item.status === "cancelled") return;
      mutate(id, { status: "completing", progress: 97 });
      let file = await MediaApiClient.completeUpload(session.id);
      const metadata = await intrinsicMetadata;
      let warning: string | null = null;
      if (metadata) {
        try {
          file = await MediaApiClient.updateFile(file, metadata);
        } catch {
          warning = "Uploaded, but dimensions or duration could not be saved. The asset is still usable.";
        }
      }
      mutate(id, { status: "complete", progress: 100, result: file, warning });
      onUploadComplete?.([file]);
    } catch (error) {
      controllersRef.current.delete(id);
      const current = queueRef.current.find((candidate) => candidate.id === id);
      if (!current || current.status === "cancelled") return;
      if (error instanceof DOMException && error.name === "AbortError") {
        if (current.status !== "paused") mutate(id, { status: "paused" });
        return;
      }
      mutate(id, {
        status: "failed",
        failedPart,
        error: error instanceof Error ? error.message : "Upload failed. Retry to continue from the last saved part.",
      });
    }
  }, [folderId, mutate, onUploadComplete]);

  const pump = useCallback(() => {
    while (activeCountRef.current < MAX_CONCURRENT_FILES) {
      const next = queueRef.current.find((item) => item.status === "queued");
      if (!next) break;
      activeCountRef.current += 1;
      mutate(next.id, { status: "initiating" });
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
      toast.error("Too many files", { description: `Choose up to ${MEDIA_MAX_FILES_PER_UPLOAD} files at once.` });
      return;
    }

    const accepted: UploadQueueItem[] = [];
    const rejected: string[] = [];
    for (const file of incoming) {
      const validation = validateMediaFileMetadata({ filename: file.name, mimeType: file.type, size: file.size });
      if (!validation.ok) {
        rejected.push(`${file.name}: ${validation.error}`);
        continue;
      }
      if (capability !== "both" && validation.value.kind !== capability) {
        rejected.push(`${file.name}: this picker accepts ${capability}s only`);
        continue;
      }
      accepted.push({
        id: queueId(),
        file,
        kind: validation.value.kind,
        status: "queued",
        progress: 0,
        uploadedParts: [],
        expectedParts: Math.ceil(file.size / MEDIA_MULTIPART_PART_SIZE_BYTES),
        sessionId: null,
        failedPart: null,
        error: null,
        warning: null,
        result: null,
      });
    }
    if (rejected.length) {
      toast.error(`${rejected.length} file${rejected.length === 1 ? "" : "s"} not added`, {
        description: rejected.slice(0, 3).join("\n"),
      });
    }
    if (!accepted.length) return;
    queueRef.current = [...queueRef.current.filter((item) => !["complete", "cancelled"].includes(item.status)), ...accepted];
    setQueue(queueRef.current);
    pumpRef.current();
  }, [capability]);

  const pause = useCallback((id: string) => {
    const item = queueRef.current.find((candidate) => candidate.id === id);
    if (!item || !["initiating", "uploading"].includes(item.status)) return;
    mutate(id, { status: "paused" });
    controllersRef.current.get(id)?.abort();
  }, [mutate]);

  const resume = useCallback((id: string) => {
    const item = queueRef.current.find((candidate) => candidate.id === id);
    if (!item || !["paused", "failed"].includes(item.status)) return;
    mutate(id, { status: "queued", error: null, failedPart: null });
    pumpRef.current();
  }, [mutate]);

  const cancel = useCallback((id: string) => {
    const item = queueRef.current.find((candidate) => candidate.id === id);
    if (!item || ["complete", "cancelled"].includes(item.status)) return;
    mutate(id, { status: "cancelled", error: null });
    controllersRef.current.get(id)?.abort();
    if (item.sessionId) void MediaApiClient.abortUpload(item.sessionId).catch(() => {
      mutate(id, { status: "paused", error: "Server cancellation was not confirmed. Choose cancel again." });
    });
  }, [mutate]);

  const clearFinished = useCallback(() => {
    queueRef.current = queueRef.current.filter((item) => !["complete", "cancelled"].includes(item.status));
    setQueue(queueRef.current);
  }, []);

  return {
    queue,
    isUploading: queue.some((item) => ["queued", "initiating", "uploading", "completing"].includes(item.status)),
    uploadFiles,
    pause,
    resume,
    cancel,
    clearFinished,
  };
}
