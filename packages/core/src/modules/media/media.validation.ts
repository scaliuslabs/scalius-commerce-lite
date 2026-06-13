// src/modules/media/media.validation.ts
import { z } from "zod";

export const updateMediaSchema = z.object({
    filename: z.string().optional(),
    altText: z.string().nullable().optional(),
    folderId: z.string().nullable().optional(),
});

export const moveMediaSchema = z.object({
    fileIds: z.array(z.string()).min(1, "File IDs are required"),
    folderId: z.string().nullable().optional(),
});

export const createFolderSchema = z.object({
    name: z.string().min(1, "Folder name is required"),
    parentId: z.string().nullable().optional(),
});

export const updateFolderSchema = z.object({
    name: z.string().min(1, "Folder name is required"),
});

export type UpdateMediaInput = z.infer<typeof updateMediaSchema>;
export type MoveMediaInput = z.infer<typeof moveMediaSchema>;
export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type UpdateFolderInput = z.infer<typeof updateFolderSchema>;
