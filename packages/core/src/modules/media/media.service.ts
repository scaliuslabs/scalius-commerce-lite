// src/modules/media/media.service.ts
import { media, mediaFolders } from "@scalius/database/schema";
import { deleteFile, uploadFile, extractKeyFromUrl } from "../../integrations/storage";
import { desc, asc, isNull, sql, like, eq, inArray, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ValidationError } from "@scalius/core/errors";

const MAX_FILE_SIZE_MB = 10; // Aligned with R2 storage.ts limit
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 50; // Increased to 50 for robust bulk uploads
const BATCH_SIZE = 5;

type SortField = "createdAt" | "size" | "filename";
type SortOrder = "asc" | "desc";

export async function listMediaFiles(
    dbOp: Database,
    page: number,
    limit: number,
    searchQuery: string,
    folderId?: string,
    sortBy: SortField = "createdAt",
    sortOrder: SortOrder = "desc",
    mimeTypeFilter?: string,
) {
    const offset = (page - 1) * limit;
    const conditions = [isNull(media.deletedAt)];

    if (searchQuery) conditions.push(like(media.filename, `%${searchQuery}%`));

    if (folderId !== undefined && folderId !== "all") {
        if (folderId === "" || folderId === "root" || folderId === "null") {
            conditions.push(isNull(media.folderId));
        } else {
            conditions.push(eq(media.folderId, folderId));
        }
    }

    if (mimeTypeFilter) {
        conditions.push(like(media.mimeType, `${mimeTypeFilter}%`));
    }

    const whereClause = sql.join(conditions, sql` AND `);
    const countArr = await dbOp.select({ count: sql<number>`count(*)` }).from(media).where(whereClause);
    const count = countArr[0]?.count ?? 0;

    // Build order by clause
    const sortColumn = sortBy === "size" ? media.size : sortBy === "filename" ? media.filename : media.createdAt;
    const orderFn = sortOrder === "asc" ? asc : desc;

    const files = await dbOp
        .select()
        .from(media)
        .where(whereClause)
        .orderBy(orderFn(sortColumn))
        .limit(limit)
        .offset(offset);

    return {
        files,
        pagination: {
            total: count,
            page,
            limit,
            totalPages: Math.ceil(count / limit),
        },
    };
}

export async function uploadMediaFiles(
    dbOp: Database,
    files: File[],
    folderId: string | null,
    metadata?: Array<{ altText?: string; width?: number; height?: number }>,
) {
    if (!files.length) {
        throw new ValidationError("No files provided");
    }

    if (files.length > MAX_FILES_PER_UPLOAD) {
        throw new ValidationError("Too many files");
    }

    const uploadedFiles = [];
    const errors: Array<{ filename: string; error: string; index: number }> = [];

    for (let batchStart = 0; batchStart < files.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, files.length);
        const batch = files.slice(batchStart, batchEnd);

        for (let i = 0; i < batch.length; i++) {
            const file = batch[i];
            const fileIndex = batchStart + i;
            if (!file) continue;

            try {
                if (!file.name || file.name.trim() === "") {
                    errors.push({ filename: file.name || `File ${fileIndex + 1}`, error: "Invalid file name", index: fileIndex });
                    continue;
                }
                if (file.size === 0) {
                    errors.push({ filename: file.name, error: "File is empty (0 bytes)", index: fileIndex });
                    continue;
                }
                if (file.size > MAX_FILE_SIZE_BYTES) {
                    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
                    errors.push({ filename: file.name, error: `File size (${fileSizeMB}MB) exceeds maximum allowed size (${MAX_FILE_SIZE_MB}MB)`, index: fileIndex });
                    continue;
                }

                const uploadResult = await uploadFile(file);
                const fileMeta = metadata?.[fileIndex];

                const mediaFileArr = await dbOp.insert(media).values({
                    id: "media_" + nanoid(),
                    filename: uploadResult.filename,
                    url: uploadResult.url,
                    size: uploadResult.size,
                    mimeType: uploadResult.mimeType,
                    altText: fileMeta?.altText || null,
                    width: fileMeta?.width || null,
                    height: fileMeta?.height || null,
                    folderId: folderId || null,
                    createdAt: sql`(unixepoch())`,
                    updatedAt: sql`(unixepoch())`,
                }).returning();

                const mediaFile = mediaFileArr[0];
                if (mediaFile) {
                    uploadedFiles.push({
                        id: mediaFile.id,
                        url: mediaFile.url,
                        filename: mediaFile.filename,
                        size: mediaFile.size,
                        mimeType: mediaFile.mimeType,
                        altText: mediaFile.altText,
                        width: mediaFile.width,
                        height: mediaFile.height,
                        createdAt: mediaFile.createdAt,
                    });
                }
            } catch (fileError: unknown) {
                let errorMessage = fileError instanceof Error ? fileError.message : "Upload failed for unknown reason";
                if (errorMessage.includes("Deserialization error")) {
                    errorMessage = "File processing error - the file may be corrupted or in an unsupported format";
                }
                errors.push({ filename: file.name, error: errorMessage, index: fileIndex });
            }
        }
        if (batchEnd < files.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    if (uploadedFiles.length === 0 && errors.length > 0) {
        throw new ValidationError("All files failed to upload", {
            details: errors.map((e) => ({ filename: e.filename, error: e.error })),
            summary: `0 file(s) uploaded successfully, ${errors.length} file(s) failed`,
        });
    }

    const response: {
        files: typeof uploadedFiles;
        summary: string;
        warnings?: Array<{ filename: string; error: string }>;
        partialSuccess?: boolean;
    } = {
        files: uploadedFiles,
        summary: errors.length === 0
            ? `Successfully uploaded ${uploadedFiles.length} file(s)`
            : `${uploadedFiles.length} file(s) uploaded successfully, ${errors.length} file(s) failed`,
    };

    if (errors.length > 0) {
        response.warnings = errors.map((e) => ({ filename: e.filename, error: e.error }));
        response.partialSuccess = true;
    }

    return response;
}

export async function updateMediaFile(
    dbOp: Database,
    id: string,
    data: { filename?: string; altText?: string; folderId?: string | null },
) {
    const [file] = await dbOp
        .select()
        .from(media)
        .where(and(eq(media.id, id), isNull(media.deletedAt)));
    if (!file) {
        throw new NotFoundError("File not found");
    }

    const updates: Record<string, unknown> = { updatedAt: sql`(unixepoch())` };
    if (data.filename !== undefined) updates.filename = data.filename;
    if (data.altText !== undefined) updates.altText = data.altText;
    if (data.folderId !== undefined) updates.folderId = data.folderId || null;

    const [updatedFile] = await dbOp.update(media).set(updates).where(eq(media.id, id)).returning();
    return updatedFile;
}

export async function deleteMediaFile(dbOp: Database, id: string) {
    const [file] = await dbOp.select().from(media).where(eq(media.id, id));
    if (!file) {
        throw new NotFoundError("File not found");
    }
    const key = extractKeyFromUrl(file.url) || file.url.split("/").pop()!;
    // Delete DB record first (atomic concern), then R2 (orphan is acceptable, broken ref is not)
    await dbOp.delete(media).where(eq(media.id, id));
    await deleteFile(key);
}

/**
 * Move files to a target folder. Only moves active (non-deleted) files.
 * Returns the count of files actually moved for verification.
 */
export async function moveMediaFiles(
    dbOp: Database,
    fileIds: string[],
    folderId: string | null,
): Promise<{ movedCount: number }> {
    if (fileIds.length === 0) return { movedCount: 0 };

    // Only move active (non-deleted) files
    const result = await dbOp
        .update(media)
        .set({ folderId: folderId || null, updatedAt: sql`(unixepoch())` })
        .where(and(inArray(media.id, fileIds), isNull(media.deletedAt)))
        .returning({ id: media.id });

    return { movedCount: result.length };
}

export async function listMediaFolders(dbOp: Database) {
    return await dbOp.select().from(mediaFolders).where(isNull(mediaFolders.deletedAt)).orderBy(desc(mediaFolders.createdAt)).limit(200);
}

export async function createMediaFolder(dbOp: Database, name: string, parentId?: string | null) {
    const [folder] = await dbOp.insert(mediaFolders).values({
        id: "folder_" + nanoid(),
        name,
        parentId: parentId || null,
        createdAt: sql`(unixepoch())`,
        updatedAt: sql`(unixepoch())`,
    }).returning();
    return folder;
}

export async function updateMediaFolder(dbOp: Database, id: string, name: string) {
    const [folder] = await dbOp
        .update(mediaFolders)
        .set({ name, updatedAt: sql`(unixepoch())` })
        .where(and(eq(mediaFolders.id, id), isNull(mediaFolders.deletedAt)))
        .returning();

    if (!folder) {
        throw new NotFoundError("Folder not found");
    }

    return folder;
}

export async function deleteMediaFolder(dbOp: Database, id: string) {
    await dbOp.update(media).set({ folderId: null, updatedAt: sql`(unixepoch())` }).where(eq(media.folderId, id));
    await dbOp.update(mediaFolders).set({ deletedAt: sql`(unixepoch())` }).where(eq(mediaFolders.id, id));
}
