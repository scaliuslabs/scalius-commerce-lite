import { describe, expect, it, vi } from "vitest";
import { MEDIA_MULTIPART_PART_SIZE_BYTES } from "@scalius/shared/media-policy";
import { readExactMediaPart } from "./media-upload-body";

function bodyFrom(chunks: number[][], cancel = vi.fn()) {
    const pending = chunks.map((chunk) => Uint8Array.from(chunk));
    return {
        body: new ReadableStream<Uint8Array>({
            pull(controller) {
                const chunk = pending.shift();
                if (chunk) controller.enqueue(chunk);
                else controller.close();
            },
            cancel,
        }),
        cancel,
    };
}

describe("media multipart request bodies", () => {
    it("combines chunked input into one exact known-length ArrayBuffer", async () => {
        const { body } = bodyFrom([[0, 1], [2], [3, 4]]);

        const value = await readExactMediaPart(body, 5);

        expect(value).toBeInstanceOf(ArrayBuffer);
        expect(value.byteLength).toBe(5);
        expect([...new Uint8Array(value)]).toEqual([0, 1, 2, 3, 4]);
    });

    it("rejects a body shorter than Content-Length before storage", async () => {
        const { body } = bodyFrom([[0, 1, 2]]);
        await expect(readExactMediaPart(body, 4)).rejects.toThrow(
            "Media part length does not match Content-Length.",
        );
    });

    it("rejects and cancels a body longer than Content-Length", async () => {
        const { body, cancel } = bodyFrom([[0, 1], [2, 3]]);
        await expect(readExactMediaPart(body, 3)).rejects.toThrow(
            "Media part length does not match Content-Length.",
        );
        expect(cancel).toHaveBeenCalledOnce();
    });

    it("refuses allocations larger than one multipart part", async () => {
        const { body } = bodyFrom([[0]]);
        await expect(
            readExactMediaPart(body, MEDIA_MULTIPART_PART_SIZE_BYTES + 1),
        ).rejects.toThrow("outside the upload policy");
    });
});
