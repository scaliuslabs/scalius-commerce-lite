import {
    abortMediaUpload,
    completeMediaUpload,
    initiateMediaUpload,
    uploadMediaPart,
} from "@scalius/core/modules/media";
import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import type { Database } from "@scalius/database/client";
import {
    MEDIA_MULTIPART_PART_SIZE_BYTES,
    MEDIA_SIGNATURE_READ_BYTES,
    getMediaPolicy,
    normalizeMediaMimeType,
    validateMediaFileMetadata,
} from "@scalius/shared/media-policy";

const MAX_REDIRECTS = 3;

function publicHttpsUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new ValidationError("Media import requires an absolute public HTTPS URL.");
    }
    const hostname = url.hostname.toLowerCase();
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (url.port && url.port !== "443") ||
        !hostname.includes(".") ||
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal") ||
        /^\[.*\]$/.test(hostname) ||
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    ) {
        throw new ValidationError("Media import requires an absolute public HTTPS URL.");
    }
    return url;
}

async function fetchPublicMedia(sourceUrl: string, fetcher: typeof fetch) {
    let url = publicHttpsUrl(sourceUrl);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        let response: Response;
        try {
            response = await fetcher(url, {
                method: "GET",
                headers: {
                    Accept: "image/jpeg,image/png,image/gif,image/webp,image/avif,video/mp4,video/webm",
                    "Accept-Encoding": "identity",
                },
                redirect: "manual",
                cache: "no-store",
            });
        } catch {
            throw new ServiceUnavailableError("The remote media source is temporarily unavailable.");
        }
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location || redirects === MAX_REDIRECTS) {
                throw new ValidationError("The remote media source has too many or invalid redirects.");
            }
            url = publicHttpsUrl(new URL(location, url).toString());
            continue;
        }
        if (!response.ok || !response.body) {
            throw new ValidationError(`Remote media returned HTTP ${response.status}.`);
        }
        return response;
    }
    throw new ValidationError("The remote media source has too many redirects.");
}

function remoteMetadata(response: Response, requestedFilename?: string) {
    const mimeType = normalizeMediaMimeType(response.headers.get("content-type")?.split(";", 1)[0]);
    if (!mimeType) throw new ValidationError("Remote media returned an unsupported Content-Type.");
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (encoding && encoding !== "identity") {
        throw new ValidationError("Remote media must not use a compressed transfer encoding.");
    }
    const rawSize = response.headers.get("content-length")?.trim() ?? "";
    const size = /^[1-9]\d*$/.test(rawSize) ? Number(rawSize) : Number.NaN;
    if (!Number.isSafeInteger(size) || size < 1) {
        throw new ValidationError("Remote media must return an exact Content-Length.");
    }
    const policy = getMediaPolicy(mimeType);
    const filename = requestedFilename?.trim() || `imported.${policy.preferredExtension}`;
    const validated = validateMediaFileMetadata({ filename, mimeType, size });
    if (!validated.ok) throw new ValidationError(validated.error);
    return validated.value;
}

async function readRemoteParts(
    body: ReadableStream<Uint8Array>,
    totalSize: number,
    consume: (partNumber: number, value: ArrayBuffer) => Promise<void>,
) {
    const reader = body.getReader();
    let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let consumed = 0;
    let partNumber = 1;
    try {
        while (consumed < totalSize) {
            const size = Math.min(MEDIA_MULTIPART_PART_SIZE_BYTES, totalSize - consumed);
            const value = new Uint8Array(size);
            let offset = 0;
            while (offset < size) {
                if (carry.byteLength === 0) {
                    const next = await reader.read();
                    if (next.done) throw new ValidationError("Remote media ended before Content-Length.");
                    carry = next.value;
                }
                const length = Math.min(carry.byteLength, size - offset);
                value.set(carry.subarray(0, length), offset);
                carry = carry.subarray(length);
                offset += length;
            }
            await consume(partNumber, value.buffer);
            consumed += size;
            partNumber += 1;
        }
        if (carry.byteLength > 0 || !(await reader.read()).done) {
            throw new ValidationError("Remote media exceeded Content-Length.");
        }
    } finally {
        try { await reader.cancel(); } catch { /* validation error remains authoritative */ }
    }
}

export async function importMediaFromUrl(input: {
    db: Database;
    bucket: R2Bucket;
    sourceUrl: string;
    filename?: string;
    folderId?: string | null;
    fetcher?: typeof fetch;
}) {
    const response = await fetchPublicMedia(input.sourceUrl, input.fetcher ?? fetch);
    const metadata = remoteMetadata(response, input.filename);
    const session = await initiateMediaUpload(input.db, {
        filename: metadata.filename,
        mimeType: metadata.mimeType,
        size: metadata.size,
        folderId: input.folderId,
    }, input.bucket);
    try {
        await readRemoteParts(response.body!, metadata.size, async (partNumber, value) => {
            await uploadMediaPart(input.db, {
                sessionId: session.id,
                partNumber,
                size: value.byteLength,
                value,
                signatureBytes: partNumber === 1
                    ? value.slice(0, Math.min(value.byteLength, MEDIA_SIGNATURE_READ_BYTES))
                    : undefined,
            }, input.bucket);
        });
        return await completeMediaUpload(input.db, session.id, input.bucket);
    } catch (error) {
        try { await abortMediaUpload(input.db, session.id, input.bucket); } catch { /* scheduled expiry is the fallback */ }
        throw error;
    }
}

export const mediaImportUrlSchema = {
    sourceUrl: "sourceUrl",
    filename: "filename",
    folderId: "folderId",
} as const;
