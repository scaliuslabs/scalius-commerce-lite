import { ValidationError } from "@scalius/core/errors";
import { MEDIA_MULTIPART_PART_SIZE_BYTES } from "@scalius/shared/media-policy";

const LENGTH_ERROR = "Media part length does not match Content-Length.";

async function cancelReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    reason: string,
) {
    try {
        await reader.cancel(reason);
    } catch {
        // A failed cancellation must not hide the transport validation error.
    }
}

/**
 * Materialize exactly one policy-bounded multipart part into a known-length
 * body accepted by R2. This never buffers the complete media object.
 */
export async function readExactMediaPart(
    body: ReadableStream<Uint8Array>,
    declaredLength: number,
): Promise<ArrayBuffer> {
    if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength < 1 ||
        declaredLength > MEDIA_MULTIPART_PART_SIZE_BYTES
    ) {
        throw new ValidationError("Media part length is outside the upload policy.");
    }

    const buffer = new ArrayBuffer(declaredLength);
    const bytes = new Uint8Array(buffer);
    const reader = body.getReader();
    let offset = 0;

    while (offset < declaredLength) {
        const result = await reader.read();
        if (result.done) {
            throw new ValidationError(LENGTH_ERROR);
        }
        if (result.value.byteLength > declaredLength - offset) {
            await cancelReader(reader, LENGTH_ERROR);
            throw new ValidationError(LENGTH_ERROR);
        }
        bytes.set(result.value, offset);
        offset += result.value.byteLength;
    }

    const trailing = await reader.read();
    if (!trailing.done) {
        await cancelReader(reader, LENGTH_ERROR);
        throw new ValidationError(LENGTH_ERROR);
    }

    return buffer;
}
