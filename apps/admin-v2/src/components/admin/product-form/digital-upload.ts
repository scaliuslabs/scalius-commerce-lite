// Sends a digital file to the API in its multipart parts (Wave B design §3.5):
// every part but the last is exactly `partSize` bytes, one part at a time,
// skipping parts the server already has, then completes the upload.
import {
  getApiV1AdminDigitalAssetsByIdUploadsByUploadId,
  postApiV1AdminDigitalAssetsByIdUploads,
  postApiV1AdminDigitalAssetsByIdUploadsByUploadIdComplete,
} from "@scalius/api-client/sdk";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { apiData, type ApiResult } from "~/lib/api";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { formatNumber } from "~/i18n";

export type DigitalAssetDto = ApiResult<typeof postApiV1AdminDigitalAssetsByIdUploadsByUploadIdComplete>["asset"];
export type DigitalUploadSessionDto = NonNullable<ApiResult<typeof postApiV1AdminDigitalAssetsByIdUploads>["upload"]>;

/** Same-origin proxy path, below the runtime dashboard base path. */
const DIGITAL_API = withDashboardBasePath("/api/v1/admin/digital-assets");

/** The byte range of each part: every part but the last is exactly `partSize`. */
export function partRange(session: Pick<DigitalUploadSessionDto, "partSize" | "sizeBytes">, partNumber: number): { start: number; end: number } {
  const start = (partNumber - 1) * session.partSize;
  return { start, end: Math.min(start + session.partSize, session.sizeBytes) };
}

/** What the file declares to the API (the type falls back as the API's does). */
export function fileInput(file: File): { filename: string; mediaType: string; sizeBytes: number } {
  return { filename: file.name, mediaType: file.type || "application/octet-stream", sizeBytes: file.size };
}

// Binary parts stay on raw fetch: the SDK transport sends JSON text bodies only.
async function putPart(assetId: string, uploadId: string, partNumber: number, body: Blob, signal: AbortSignal): Promise<void> {
  const response = await fetch(
    `${DIGITAL_API}/${encodeURIComponent(assetId)}/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`,
    { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body, signal },
  );
  const payload = (await response.json().catch(() => null)) as
    | { success?: boolean; error?: { code?: string; message?: string } }
    | null;
  if (!response.ok || !payload || payload.success === false) {
    throw new AdminApiResponseError(payload?.error?.message ?? `API error: ${response.status}`, response.ok ? 502 : response.status, payload?.error?.code);
  }
}

/**
 * Sends the parts the session is missing, in order, reporting the bytes the
 * server holds after each part, then completes the upload (the file becomes
 * ready). Aborting stops between or during parts; the upload can resume.
 */
export async function sendDigitalFile({ assetId, session, file, signal, onProgress }: {
  assetId: string;
  session: DigitalUploadSessionDto;
  file: Blob;
  signal: AbortSignal;
  onProgress: (sentBytes: number) => void;
}): Promise<DigitalAssetDto> {
  const done = new Set(session.uploadedParts);
  let sent = 0;
  for (const part of done) {
    const range = partRange(session, part);
    sent += Math.max(0, range.end - range.start);
  }
  onProgress(sent);
  for (let part = 1; part <= session.partCount; part += 1) {
    if (done.has(part)) continue;
    const { start, end } = partRange(session, part);
    await putPart(assetId, session.id, part, file.slice(start, end), signal);
    sent += end - start;
    onProgress(sent);
  }
  signal.throwIfAborted();
  const { asset } = await apiData(postApiV1AdminDigitalAssetsByIdUploadsByUploadIdComplete({ path: { id: assetId, uploadId: session.id } }));
  return asset;
}

/**
 * After a failure: the same upload with the parts the server kept, or a new
 * upload when that one can't continue (finished, cancelled or swept).
 */
export async function resumeOrRestart(assetId: string, uploadId: string | null, file: File): Promise<DigitalUploadSessionDto> {
  if (uploadId) {
    const current = await apiData(getApiV1AdminDigitalAssetsByIdUploadsByUploadId({ path: { id: assetId, uploadId } })).catch(() => null);
    if (current?.upload.status === "uploading" && current.upload.sizeBytes === file.size) return current.upload;
  }
  return startDigitalUpload(assetId, file);
}

/** A new upload for a file item (its first file, or a replacement). */
export async function startDigitalUpload(assetId: string, file: File): Promise<DigitalUploadSessionDto> {
  const { upload } = await apiData(postApiV1AdminDigitalAssetsByIdUploads({ path: { id: assetId }, body: fileInput(file) }));
  if (!upload) throw new AdminApiResponseError(`API error: 502`, 502);
  return upload;
}

/** "12.5 MB" in the dashboard's number format. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${formatNumber(value, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}
