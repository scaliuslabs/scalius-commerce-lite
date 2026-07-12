import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
    fileURLToPath(new URL("./media.service.ts", import.meta.url)),
    "utf8",
);

describe("media lifecycle boundaries", () => {
    it("claims durable D1 initialization before creating the R2 multipart upload", () => {
        const functionStart = source.indexOf("export async function initiateMediaUpload");
        const claim = source.indexOf("db.insert(mediaUploadSessions)", functionStart);
        const sideEffect = source.indexOf("createMediaMultipartUpload", functionStart);
        expect(claim).toBeGreaterThan(functionStart);
        expect(sideEffect).toBeGreaterThan(claim);
        expect(source).not.toContain("export async function uploadMediaFiles");
    });

    it("requires first-part signature evidence before any R2 part write", () => {
        const functionStart = source.indexOf("export async function uploadMediaPart");
        const signature = source.indexOf("validateMediaSignature", functionStart);
        const sideEffect = source.indexOf("uploadMediaMultipartPart", functionStart);
        expect(signature).toBeGreaterThan(functionStart);
        expect(sideEffect).toBeGreaterThan(signature);
    });

    it("reconciles an R2-complete upload and keeps committed retries read-only", () => {
        const functionStart = source.indexOf("export async function completeMediaUpload");
        const committedBranch = source.indexOf('session.state === "committed"', functionStart);
        const head = source.indexOf("headMediaObject", functionStart);
        const complete = source.indexOf("completeMediaMultipartUpload", functionStart);
        expect(committedBranch).toBeGreaterThan(functionStart);
        expect(head).toBeGreaterThan(committedBranch);
        expect(complete).toBeGreaterThan(head);
        expect(source).toContain("Existing media does not match this upload session.");
    });

    it("guards folder deletion before folder or media writes", () => {
        const functionStart = source.indexOf("export async function deleteMediaFolder");
        const guard = source.indexOf("buildBatchGuard", functionStart);
        const batch = source.indexOf("safeBatch", functionStart);
        const folderWrite = source.indexOf("db.update(mediaFolders)", functionStart);
        const mediaWrite = source.indexOf("db.update(media)", functionStart);
        expect(guard).toBeGreaterThan(functionStart);
        expect(batch).toBeGreaterThan(guard);
        expect(folderWrite).toBeGreaterThan(batch);
        expect(mediaWrite).toBeGreaterThan(folderWrite);
    });

    it("blocks referenced permanent deletes before the durable deleting claim", () => {
        const functionStart = source.indexOf("export async function permanentlyDeleteMediaFile");
        const dependencyRead = source.indexOf("loadMediaDeleteDependencies", functionStart);
        const claim = source.indexOf("status: \"deleting\"", functionStart);
        const productGuard = source.indexOf("SELECT 1 FROM ${productMedia}", claim);
        const storageDelete = source.indexOf("deleteFile(current.objectKey)", functionStart);
        expect(dependencyRead).toBeGreaterThan(functionStart);
        expect(claim).toBeGreaterThan(dependencyRead);
        expect(productGuard).toBeGreaterThan(claim);
        expect(storageDelete).toBeGreaterThan(productGuard);
        expect(source).toContain("MEDIA_DEPENDENCY_CONFLICT");
        expect(source).toContain("productMediaId");
        expect(source).toContain("productImageMediaId");
    });
});
