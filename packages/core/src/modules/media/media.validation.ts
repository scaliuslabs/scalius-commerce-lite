import { MEDIA_KINDS } from "@scalius/shared/media-policy";
import { z } from "zod";

const resourceId = z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9_-]+$/u);
const folderId = resourceId.nullable().optional();

export const initiateMediaUploadSchema = z.object({
    filename: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(100),
    size: z.number().int().positive(),
    folderId,
});

export const updateMediaSchema = z.object({
    expectedVersion: z.number().int().min(1),
    filename: z.string().trim().min(1).max(255).optional(),
    altText: z.string().trim().max(500).nullable().optional(),
    caption: z.string().trim().max(2_000).nullable().optional(),
    width: z.number().int().positive().nullable().optional(),
    height: z.number().int().positive().nullable().optional(),
    durationMs: z.number().int().positive().nullable().optional(),
    posterMediaId: resourceId.nullable().optional(),
    folderId,
}).superRefine((value, context) => {
    const hasWidth = Object.prototype.hasOwnProperty.call(value, "width");
    const hasHeight = Object.prototype.hasOwnProperty.call(value, "height");
    if (hasWidth !== hasHeight || (hasWidth && ((value.width === null) !== (value.height === null)))) {
        context.addIssue({
            code: "custom",
            message: "Width and height must both be set or both be empty",
            path: ["width"],
        });
    }
});

export const mediaVersionCommandSchema = z.object({
    expectedVersion: z.number().int().min(1),
});

export const moveMediaSchema = z.object({
    items: z.array(z.object({
        id: resourceId,
        expectedVersion: z.number().int().min(1),
    })).min(1, "Media items are required").max(90),
    folderId,
}).refine((value) => new Set(value.items.map((item) => item.id)).size === value.items.length, {
    message: "Media IDs must be unique",
    path: ["items"],
});

export const createFolderSchema = z.object({
    name: z.string().trim().min(1, "Folder name is required").max(100),
});

export const updateFolderSchema = z.object({
    name: z.string().trim().min(1, "Folder name is required").max(100),
    expectedVersion: z.number().int().min(1),
});

export const mediaKindSchema = z.enum(MEDIA_KINDS);

export type InitiateMediaUploadInput = z.infer<typeof initiateMediaUploadSchema>;
export type UpdateMediaInput = z.infer<typeof updateMediaSchema>;
export type MoveMediaInput = z.infer<typeof moveMediaSchema>;
export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type UpdateFolderInput = z.infer<typeof updateFolderSchema>;
