import { safeBatch, type Database } from "@scalius/database/client";
import {
  aiImageGenerationPreviews,
  media,
  mediaFolders,
} from "@scalius/database/schema";
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from "@scalius/core/errors";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  deleteFile,
  extractKeyFromUrl,
  uploadFile,
} from "../../integrations/storage";

const GENERATED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const GENERATED_IMAGE_PREVIEW_TTL_MS = 15 * 60 * 1_000;
const GENERATED_IMAGE_RATE_WINDOW_MS = 60 * 1_000;
const GENERATED_IMAGE_RATE_LIMIT = 5;
const GENERATED_IMAGE_TOKEN_LIMIT = 1_000_000_000;
const GENERATED_IMAGE_CLAIM_LEASE_MS = 2 * 60 * 1_000;

const GENERATED_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export type GeneratedImageUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type GeneratedImageCost = {
  status: "reported" | "not_reported";
  usdMicros?: number;
};

export type GeneratedImagePreviewAuthority = {
  id: string;
  provider: string;
  model: string;
  promptHash: string;
  usage: GeneratedImageUsage;
  cost: GeneratedImageCost;
  expiresAt: Date;
};

function normalizedTokenCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(GENERATED_IMAGE_TOKEN_LIMIT, Math.round(value));
}

function normalizedUsage(usage: GeneratedImageUsage): GeneratedImageUsage {
  return {
    inputTokens: normalizedTokenCount(usage.inputTokens),
    outputTokens: normalizedTokenCount(usage.outputTokens),
    totalTokens: normalizedTokenCount(usage.totalTokens),
  };
}

function assertGeneratedRaster(mediaType: string, size: number): void {
  if (!GENERATED_IMAGE_EXTENSIONS[mediaType]) {
    throw new ValidationError(
      "Generated images must be PNG, JPEG, or WebP raster files.",
    );
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > GENERATED_IMAGE_MAX_BYTES) {
    throw new ValidationError("Generated image size is invalid or exceeds 10 MB.");
  }
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256Digest(
  value: ArrayBuffer | Uint8Array | string,
): Promise<ArrayBuffer> {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  const ownedBytes = bytes.slice().buffer as ArrayBuffer;
  return crypto.subtle.digest("SHA-256", ownedBytes);
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  return hex(await sha256Digest(value));
}

async function cleanupExpiredGeneratedImagePreviews(
  db: Database,
  now: Date,
): Promise<void> {
  await db
    .delete(aiImageGenerationPreviews)
    .where(lte(aiImageGenerationPreviews.expiresAt, now));
}

async function enforceGeneratedImageRateLimit(
  db: Database,
  userId: string,
  now: Date,
): Promise<void> {
  const windowStart = new Date(now.getTime() - GENERATED_IMAGE_RATE_WINDOW_MS);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(aiImageGenerationPreviews)
    .where(
      and(
        eq(aiImageGenerationPreviews.userId, userId),
        gt(aiImageGenerationPreviews.createdAt, windowStart),
      ),
    );

  if ((row?.count ?? 0) >= GENERATED_IMAGE_RATE_LIMIT) {
    throw new RateLimitError(
      "Too many image-generation requests. Please wait a minute and try again.",
      60,
    );
  }
}

export async function enforceGeneratedImageGenerationLimit(
  db: Database,
  userId: string,
  now = new Date(),
): Promise<void> {
  await cleanupExpiredGeneratedImagePreviews(db, now);
  await enforceGeneratedImageRateLimit(db, userId, now);
}

export async function recordGeneratedImagePreview(
  db: Database,
  input: {
    userId: string;
    provider: string;
    model: string;
    prompt: string;
    bytes: Uint8Array;
    mediaType: string;
    usage: GeneratedImageUsage;
    now?: Date;
  },
): Promise<GeneratedImagePreviewAuthority> {
  const now = input.now ?? new Date();
  const userId = input.userId.trim();
  const provider = input.provider.trim();
  const model = input.model.trim();
  const prompt = input.prompt.trim();

  if (!userId || userId.length > 255) {
    throw new ValidationError("Admin identity is invalid.");
  }
  if (!provider || provider.length > 64 || !model || model.length > 200) {
    throw new ValidationError("Generated image provider metadata is invalid.");
  }
  if (!prompt || prompt.length > 4_000) {
    throw new ValidationError("Image prompt must contain 1-4000 characters.");
  }
  assertGeneratedRaster(input.mediaType, input.bytes.byteLength);

  const [imageHash, promptHash] = await Promise.all([
    sha256Hex(input.bytes),
    sha256Hex(prompt),
  ]);
  const usage = normalizedUsage(input.usage);
  const expiresAt = new Date(now.getTime() + GENERATED_IMAGE_PREVIEW_TTL_MS);
  const id = `aig_${nanoid()}`;

  await db.insert(aiImageGenerationPreviews).values({
    id,
    userId,
    imageSha256: imageHash,
    promptSha256: promptHash,
    provider,
    model,
    mimeType: input.mediaType,
    size: input.bytes.byteLength,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    costUsdMicros: null,
    costStatus: "not_reported",
    createdAt: now,
    expiresAt,
  });

  return {
    id,
    provider,
    model,
    promptHash,
    usage,
    cost: { status: "not_reported" },
    expiresAt,
  };
}

async function releaseGeneratedImageClaim(
  db: Database,
  generationId: string,
  userId: string,
  claimToken: string,
): Promise<void> {
  await db
    .update(aiImageGenerationPreviews)
    .set({ claimedAt: null })
    .where(
      and(
        eq(aiImageGenerationPreviews.id, generationId),
        eq(aiImageGenerationPreviews.userId, userId),
        eq(aiImageGenerationPreviews.claimToken, claimToken),
        isNull(aiImageGenerationPreviews.consumedAt),
      ),
    );
}

export async function saveGeneratedImagePreview(
  db: Database,
  input: {
    generationId: string;
    userId: string;
    file: File;
    altText?: string | null;
    folderId?: string | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const generationId = input.generationId.trim();
  const userId = input.userId.trim();
  const altText = input.altText?.trim() || null;
  const folderId = input.folderId?.trim() || null;

  if (!/^aig_[A-Za-z0-9_-]{10,100}$/.test(generationId)) {
    throw new ValidationError("Generated image preview ID is invalid.");
  }
  if (!userId || userId.length > 255) {
    throw new ValidationError("Admin identity is invalid.");
  }
  if (altText && altText.length > 500) {
    throw new ValidationError("Image alt text must be 500 characters or fewer.");
  }
  if (folderId && folderId.length > 255) {
    throw new ValidationError("Media folder ID is invalid.");
  }
  assertGeneratedRaster(input.file.type, input.file.size);

  const [preview] = await db
    .select()
    .from(aiImageGenerationPreviews)
    .where(
      and(
        eq(aiImageGenerationPreviews.id, generationId),
        eq(aiImageGenerationPreviews.userId, userId),
      ),
    );

  if (!preview) {
    throw new NotFoundError(
      "Generated image preview expired. Generate a new image before saving.",
    );
  }

  if (preview.consumedAt) {
    const [existing] = await db
      .select()
      .from(media)
      .where(eq(media.generationId, generationId));
    if (existing) return existing;
    throw new ServiceUnavailableError(
      "The generated image save is incomplete. Generate a new image before retrying.",
    );
  }

  if (preview.expiresAt <= now) {
    throw new NotFoundError(
      "Generated image preview expired. Generate a new image before saving.",
    );
  }
  if (preview.mimeType !== input.file.type || preview.size !== input.file.size) {
    throw new ValidationError("Generated image preview bytes do not match.");
  }

  const fileBytes = await input.file.arrayBuffer();
  const imageHash = await sha256Hex(fileBytes);
  if (imageHash !== preview.imageSha256) {
    throw new ValidationError("Generated image preview bytes do not match.");
  }

  if (folderId) {
    const [folder] = await db
      .select({ id: mediaFolders.id })
      .from(mediaFolders)
      .where(
        and(eq(mediaFolders.id, folderId), isNull(mediaFolders.deletedAt)),
      );
    if (!folder) throw new NotFoundError("Media folder not found.");
  }

  const staleClaimBefore = new Date(now.getTime() - GENERATED_IMAGE_CLAIM_LEASE_MS);
  const claimToken = `aic_${nanoid()}`;
  const [claim] = await db
    .update(aiImageGenerationPreviews)
    .set({ claimedAt: now, claimToken })
    .where(
      and(
        eq(aiImageGenerationPreviews.id, generationId),
        eq(aiImageGenerationPreviews.userId, userId),
        eq(aiImageGenerationPreviews.imageSha256, imageHash),
        gt(aiImageGenerationPreviews.expiresAt, now),
        or(
          isNull(aiImageGenerationPreviews.claimedAt),
          lte(aiImageGenerationPreviews.claimedAt, staleClaimBefore),
        ),
        isNull(aiImageGenerationPreviews.consumedAt),
      ),
    )
    .returning({
      id: aiImageGenerationPreviews.id,
      claimToken: aiImageGenerationPreviews.claimToken,
    });

  if (!claim || claim.claimToken !== claimToken) {
    throw new ConflictError(
      "This generated image preview is already being saved or was consumed.",
    );
  }

  const extension = GENERATED_IMAGE_EXTENSIONS[preview.mimeType];
  const generatedFile = new File(
    [fileBytes],
    `generated-${generationId}.${extension}`,
    { type: preview.mimeType },
  );
  let uploadedKey: string | null = null;
  const mediaId = `media_${nanoid()}`;

  try {
    const imageDigest = await sha256Digest(fileBytes);
    const upload = await uploadFile(generatedFile, undefined, undefined, {
      // Workers R2 accepts the raw SHA-256 digest ArrayBuffer. This avoids
      // checksum string encoding ambiguity while R2 verifies the write.
      sha256: imageDigest,
      customMetadata: {
        source: "ai_generated",
        generationId,
        provider: preview.provider,
        model: preview.model,
        promptSha256: preview.promptSha256,
        costStatus: preview.costStatus,
      },
    });
    uploadedKey = upload.key;

    // Refresh this exact claim after the bounded (<=30s) R2 write. A stale
    // request that resumes after another request reclaimed the lease cannot
    // insert or consume anything, and can delete only its own unique R2 key.
    const commitAt = input.now ?? new Date();
    const [ownedClaim] = await db
      .update(aiImageGenerationPreviews)
      .set({ claimedAt: commitAt })
      .where(
        and(
          eq(aiImageGenerationPreviews.id, generationId),
          eq(aiImageGenerationPreviews.userId, userId),
          eq(aiImageGenerationPreviews.claimToken, claimToken),
          gt(aiImageGenerationPreviews.expiresAt, commitAt),
          isNull(aiImageGenerationPreviews.consumedAt),
        ),
      )
      .returning({ id: aiImageGenerationPreviews.id });
    if (!ownedClaim) {
      throw new ConflictError(
        "This generated image preview was reclaimed by another save request.",
      );
    }

    const [insertedRows, consumedRows] = await safeBatch(db, [
      db
        .insert(media)
        .values({
          id: mediaId,
          filename: upload.filename,
          url: upload.url,
          size: upload.size,
          mimeType: upload.mimeType,
          altText,
          folderId,
          sourceType: "ai_generated",
          generationId,
          generationProvider: preview.provider,
          generationModel: preview.model,
          generationPromptHash: preview.promptSha256,
          generationInputTokens: preview.inputTokens,
          generationOutputTokens: preview.outputTokens,
          generationTotalTokens: preview.totalTokens,
          generationCostUsdMicros: preview.costUsdMicros,
          generationCostStatus: preview.costStatus,
          generatedAt: preview.createdAt,
          createdAt: commitAt,
          updatedAt: commitAt,
        })
        .returning(),
      db
        .update(aiImageGenerationPreviews)
        .set({ consumedAt: commitAt })
        .where(
          and(
            eq(aiImageGenerationPreviews.id, generationId),
            eq(aiImageGenerationPreviews.userId, userId),
            eq(aiImageGenerationPreviews.claimToken, claimToken),
            isNull(aiImageGenerationPreviews.consumedAt),
          ),
        )
        .returning({ id: aiImageGenerationPreviews.id }),
    ]);

    const saved = insertedRows?.[0];
    if (saved && consumedRows?.length === 1) return saved;

    // A zero-row guarded transition is not a D1 error, so explicitly
    // compensate before touching R2. This path should be unreachable after a
    // successful claim but keeps the save fail-closed under stale/corrupt state.
    await safeBatch(db, [
      db.delete(media).where(eq(media.id, mediaId)),
      db
        .update(aiImageGenerationPreviews)
        .set({ claimedAt: null, claimToken: null, consumedAt: null })
        .where(
          and(
            eq(aiImageGenerationPreviews.id, generationId),
            eq(aiImageGenerationPreviews.userId, userId),
            eq(aiImageGenerationPreviews.claimToken, claimToken),
          ),
        ),
    ]);
    throw new ServiceUnavailableError(
      "Generated image save could not be committed.",
    );
  } catch (error) {
    if (!uploadedKey) {
      await releaseGeneratedImageClaim(db, generationId, userId, claimToken);
      throw error;
    }

    // A D1 batch can commit and still lose its response. Reconcile the unique
    // generation ID before deleting R2; D1 is authoritative and strongly
    // consistent. If the read itself is unavailable, retain both object and
    // claim so a later idempotent retry can resolve the ambiguous outcome.
    try {
      const [committed] = await db
        .select()
        .from(media)
        .where(eq(media.generationId, generationId));
      if (committed) {
        const committedKey = extractKeyFromUrl(committed.url);
        if (committedKey && committedKey !== uploadedKey) {
          try {
            await deleteFile(uploadedKey);
          } catch {
            // The authoritative media row points elsewhere; this key is only
            // an orphan and can be cleaned later if the best-effort delete fails.
          }
        }
        return committed;
      }
    } catch {
      throw error;
    }

    try {
      await deleteFile(uploadedKey);
    } catch {
      // The media row was not committed; an orphan is safer than a broken row.
    }
    await releaseGeneratedImageClaim(db, generationId, userId, claimToken);
    throw error;
  }
}
