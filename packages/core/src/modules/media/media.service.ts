// src/modules/media/media.service.ts
import { media, mediaFolders } from "@scalius/database/schema";
import { deleteFile, uploadFile } from "../../integrations/storage";
import { desc, isNull, sql, like, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";

const MAX_FILE_SIZE_MB = 20; // Increased to 20MB for robustness
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 50; // Increased to 50 for robust bulk uploads
const BATCH_SIZE = 5;

export const MediaService = {
    async listFiles(dbOp: any, page: number, limit: number, searchQuery: string, folderId?: string) {
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

        const whereClause = sql.join(conditions, sql` AND `);
        const [{ count }] = await dbOp.select({ count: sql<number>`count(*)` }).from(media).where(whereClause);

        const files = await dbOp
            .select()
            .from(media)
            .where(whereClause)
            .orderBy(desc(media.createdAt))
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
    },

    async uploadFiles(dbOp: any, files: File[], folderId: string | null) {
        if (!files.length) {
            const error = new Error("No files provided");
            (error as any).statusCode = 400;
            throw error;
        }

        if (files.length > MAX_FILES_PER_UPLOAD) {
            const error = new Error(`Too many files. Maximum ${MAX_FILES_PER_UPLOAD} files allowed per upload. You tried to upload ${files.length} files.`);
            (error as any).statusCode = 400;
            throw error;
        }

        const uploadedFiles = [];
        const errors: Array<{ filename: string; error: string; index: number }> = [];
        const now = new Date();

        for (let batchStart = 0; batchStart < files.length; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, files.length);
            const batch = files.slice(batchStart, batchEnd);

            for (let i = 0; i < batch.length; i++) {
                const file = batch[i];
                const fileIndex = batchStart + i;

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

                    const [mediaFile] = await dbOp.insert(media).values({
                        id: "media_" + nanoid(),
                        filename: uploadResult.filename,
                        url: uploadResult.url,
                        size: uploadResult.size,
                        mimeType: uploadResult.mimeType,
                        folderId: folderId || null,
                        createdAt: now,
                        updatedAt: now,
                    }).returning();

                    uploadedFiles.push({
                        id: mediaFile.id,
                        url: mediaFile.url,
                        filename: mediaFile.filename,
                        size: mediaFile.size,
                        mimeType: mediaFile.mimeType,
                        createdAt: now,
                    });
                } catch (fileError: any) {
                    let errorMessage = fileError.message || "Upload failed for unknown reason";
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

        const response: any = {
            files: uploadedFiles,
            summary: errors.length === 0
                ? `Successfully uploaded ${uploadedFiles.length} file(s)`
                : `${uploadedFiles.length} file(s) uploaded successfully, ${errors.length} file(s) failed`,
        };

        if (errors.length > 0) {
            response.warnings = errors.map((e: any) => ({ filename: e.filename, error: e.error }));
            response.details = errors.map((e: any) => ({ filename: e.filename, error: e.error })); // Maintain for UI

            if (uploadedFiles.length === 0) {
                response.status = 400;
                response.error = "All files failed to upload";
            } else {
                response.status = 207; // Partial success
            }
        } else {
            response.status = 201;
        }

        if (response.status === 400) {
            // Throw it instead of returning so normal Hono error catch maps it properly, but format it as UI expects under data.error and data.details
            throw Object.assign(new Error("All files failed to upload"), {
                statusCode: 400,
                details: response.details,
                summary: response.summary
            });
        }

        return response;
    },

    async updateFile(dbOp: any, id: string, data: any) {
        const [file] = await dbOp.select().from(media).where(eq(media.id, id));
        if (!file) {
            const error = new Error("File not found");
            (error as any).statusCode = 404;
            throw error;
        }

        const updates: any = { updatedAt: new Date() };
        if (data.filename !== undefined) updates.filename = data.filename;
        if (data.folderId !== undefined) updates.folderId = data.folderId || null;

        const [updatedFile] = await dbOp.update(media).set(updates).where(eq(media.id, id)).returning();
        return updatedFile;
    },

    async deleteFile(dbOp: any, id: string) {
        const [file] = await dbOp.select().from(media).where(eq(media.id, id));
        if (!file) {
            const error = new Error("File not found");
            (error as any).statusCode = 404;
            throw error;
        }
        const key = file.url.split("/").pop()!;
        await deleteFile(key);
        await dbOp.delete(media).where(eq(media.id, id));
    },

    async moveFiles(dbOp: any, fileIds: string[], folderId: string | null) {
        await dbOp.update(media).set({ folderId: folderId || null, updatedAt: new Date() }).where(inArray(media.id, fileIds));
    },

    async listFolders(dbOp: any) {
        return await dbOp.select().from(mediaFolders).where(isNull(mediaFolders.deletedAt)).orderBy(desc(mediaFolders.createdAt));
    },

    async createFolder(dbOp: any, name: string, parentId?: string | null) {
        const now = new Date();
        const [folder] = await dbOp.insert(mediaFolders).values({
            id: "folder_" + nanoid(),
            name,
            parentId: parentId || null,
            createdAt: now,
            updatedAt: now,
        }).returning();
        return folder;
    },

    async deleteFolder(dbOp: any, id: string) {
        await dbOp.update(media).set({ folderId: null, updatedAt: new Date() }).where(eq(media.folderId, id));
        await dbOp.update(mediaFolders).set({ deletedAt: new Date() }).where(eq(mediaFolders.id, id));
    }
};
