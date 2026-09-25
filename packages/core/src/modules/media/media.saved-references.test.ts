import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { media } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MediaDependencyConflictError,
  generateMediaVariants,
  listMediaFiles,
  permanentlyDeleteMediaFile,
  saveMediaVariants,
  trashMediaFile,
} from "./media.service";
import { withPublicMediaUrl } from "../../integrations/storage";
import {
  getGeneralSettings,
  saveHeaderConfig,
} from "../settings/site-settings.service";

function createBucket() {
  const objects = new Set<string>();
  const deleteCalls: string[] = [];
  return {
    objects,
    deleteCalls,
    bucket: {
      head: async (key: string) => (objects.has(key) ? {} : null),
      put: async (key: string) => {
        objects.add(key);
        return {};
      },
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          deleteCalls.push(key);
          objects.delete(key);
        }
      },
    } as unknown as R2Bucket,
  };
}

const WEBP_BYTES = new TextEncoder().encode("RIFF\u0010\u0000\u0000\u0000WEBPVP8 ").buffer as ArrayBuffer;

function renditions(widths: number[]) {
  return new Map(widths.map((width) => [width, WEBP_BYTES]));
}

describe("saved media reference deletion guards", () => {
  let db: Database;
  let sqlite: DatabaseSync;

  beforeEach(() => {
    ({ db, sqlite } = createSqliteD1Database());
  });

  afterEach(() => sqlite.close());

  async function seedMedia() {
    const id = "media_saved_logo";
    const objectKey = "media/media_saved_logo.png";
    await db.insert(media).values({
      id,
      filename: "saved-logo.png",
      kind: "image",
      objectKey,
      size: 4,
      mimeType: "image/png",
      status: "ready",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { id, objectKey };
  }

  it("blocks a trashed media item still saved as the header logo without deleting its blob", async () => {
    const file = await seedMedia();
    const storage = createBucket();
    storage.objects.add(file.objectKey);
    const saved = await saveHeaderConfig(db, {
      topBar: { enabled: false, text: "" },
      logo: { src: `https://media.example/${file.objectKey}`, alt: "Logo" },
      favicon: { src: "", alt: "" },
      contact: { phone: "", email: "" },
      social: [],
    }, 0);
    const trashed = await trashMediaFile(db, file.id, 1);

    const result = await permanentlyDeleteMediaFile(db, file.id, trashed.version, storage.bucket)
      .then(() => null)
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(MediaDependencyConflictError);
    expect((result as MediaDependencyConflictError).details).toMatchObject({
      count: 1,
      references: [{ kind: "theme", id: null }],
      orderCount: 0,
    });

    expect(storage.deleteCalls).toEqual([]);
    expect(storage.objects.has(file.objectKey)).toBe(true);
    expect(sqlite.prepare("SELECT status FROM media WHERE id = ?").get(file.id)).toMatchObject({ status: "trashed" });
    expect((await getGeneralSettings(db)).revisions.header).toBe(saved.revision);
  });

  it("allows permanent deletion after replacing the saved header reference", async () => {
    const file = await seedMedia();
    const storage = createBucket();
    storage.objects.add(file.objectKey);
    const saved = await saveHeaderConfig(db, {
      logo: { src: `https://media.example/${file.objectKey}`, alt: "Logo" },
    }, 0);
    const trashed = await trashMediaFile(db, file.id, 1);
    await saveHeaderConfig(db, { logo: { src: "", alt: "" } }, saved.revision);

    await expect(
      permanentlyDeleteMediaFile(db, file.id, trashed.version, storage.bucket),
    ).resolves.toBeUndefined();
    expect(storage.deleteCalls).toEqual([file.objectKey]);
    expect(storage.objects.has(file.objectKey)).toBe(false);
    expect(sqlite.prepare("SELECT status FROM media WHERE id = ?").get(file.id)).toMatchObject({ status: "deleted" });
  });

  it("treats underscores in object keys literally during dependency preflight", async () => {
    const file = await seedMedia();
    const storage = createBucket();
    storage.objects.add(file.objectKey);
    const trashed = await trashMediaFile(db, file.id, 1);

    await saveHeaderConfig(db, {
      logo: { src: `https://media.example/media/mediaAsaved_logo.png`, alt: "Different object" },
    }, 0);

    await expect(
      permanentlyDeleteMediaFile(db, file.id, trashed.version, storage.bucket),
    ).resolves.toBeUndefined();
    expect(storage.deleteCalls).toEqual([file.objectKey]);
  });

  it("rechecks the saved reference in the atomic claim when a writer races the preflight", async () => {
    const file = await seedMedia();
    const storage = createBucket();
    storage.objects.add(file.objectKey);
    const saved = await saveHeaderConfig(db, { logo: { src: "", alt: "" } }, 0);
    const trashed = await trashMediaFile(db, file.id, 1);

    const deletion = permanentlyDeleteMediaFile(db, file.id, trashed.version, storage.bucket);
    await Promise.resolve();
    const writer = saveHeaderConfig(db, {
      logo: { src: `https://media.example/${file.objectKey}`, alt: "Raced logo" },
    }, saved.revision);
    const [deleteResult, writeResult] = await Promise.allSettled([deletion, writer]);

    expect(writeResult.status).toBe("fulfilled");
    expect(deleteResult.status).toBe("rejected");
    expect((deleteResult as PromiseRejectedResult).reason).toBeInstanceOf(MediaDependencyConflictError);
    expect(storage.deleteCalls).toEqual([]);
    expect(storage.objects.has(file.objectKey)).toBe(true);
  });

  it("rejects a writer that tries to save a reference after the delete claim", async () => {
    const file = await seedMedia();
    const saved = await saveHeaderConfig(db, { logo: { src: "", alt: "" } }, 0);
    const trashed = await trashMediaFile(db, file.id, 1);
    await db.update(media).set({
      status: "deleting",
      version: trashed.version + 1,
      trashedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(media.id, file.id));

    await expect(saveHeaderConfig(db, {
      logo: { src: `https://media.example/${file.objectKey}`, alt: "Late logo" },
    }, saved.revision)).rejects.toThrow();
    expect((await getGeneralSettings(db)).revisions.header).toBe(saved.revision);
  });
});

describe("pre-generated media renditions", () => {
  let db: Database;
  let sqlite: DatabaseSync;

  beforeEach(() => {
    ({ db, sqlite } = createSqliteD1Database());
  });

  afterEach(() => sqlite.close());

  async function seedImage() {
    const id = "media_rendition_1";
    const objectKey = "media/media_rendition_1.jpg";
    await db.insert(media).values({
      id,
      filename: "shirt.jpg",
      kind: "image",
      objectKey,
      size: 4,
      mimeType: "image/jpeg",
      status: "ready",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { id, objectKey };
  }

  it("stores the exact width ladder and publishes the largest rendition", async () => {
    const file = await seedImage();
    const storage = createBucket();
    expect((await listMediaFiles(db, { variants: "missing" })).files.map(({ id }) => id)).toEqual([file.id]);

    const saved = await withPublicMediaUrl("https://media.example", () =>
      saveMediaVariants(db, file.id, { width: 1000, height: 800, files: renditions([144, 172, 206, 247, 296, 355, 426, 511, 613, 735, 882, 960, 1000]) }, storage.bucket),
    );

    expect(saved).toMatchObject({
      url: "https://media.example/media/media_rendition_1.jpg/1000.webp",
      variantWidth: 1000,
      width: 1000,
      height: 800,
      version: 1,
    });
    expect([...storage.objects].sort()).toEqual([144, 172, 206, 247, 296, 355, 426, 511, 613, 735, 882, 960, 1000].map((width) => `${file.objectKey}/${width}.webp`).sort());
    expect((await listMediaFiles(db, { variants: "missing" })).files).toEqual([]);
  });

  it("rejects an incomplete ladder or non-WebP bytes without storing anything", async () => {
    const file = await seedImage();
    const storage = createBucket();

    await expect(saveMediaVariants(db, file.id, { width: 1000, height: 800, files: renditions([144, 172]) }, storage.bucket))
      .rejects.toThrow(/each width/);
    const jpeg = new Map(renditions([144, 172, 206, 247, 296, 355, 426, 511, 613, 735, 882, 960, 1000]));
    jpeg.set(160, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer);
    await expect(saveMediaVariants(db, file.id, { width: 1000, height: 800, files: jpeg }, storage.bucket))
      .rejects.toThrow();
    expect(storage.objects.size).toBe(0);
    expect(sqlite.prepare("SELECT variant_width FROM media WHERE id = ?").get(file.id)).toMatchObject({ variant_width: null });
  });

  it("keeps rendition URLs saved on storefront surfaces protected and deletes renditions with the original", async () => {
    const file = await seedImage();
    const storage = createBucket();
    storage.objects.add(file.objectKey);
    await saveMediaVariants(db, file.id, { width: 500, height: 500, files: renditions([144, 172, 206, 247, 296, 355, 426, 500]) }, storage.bucket);
    const saved = await saveHeaderConfig(db, {
      logo: { src: `https://media.example/${file.objectKey}/320.webp`, alt: "Logo" },
    }, 0);
    const trashed = await trashMediaFile(db, file.id, 1);

    await expect(permanentlyDeleteMediaFile(db, file.id, trashed.version, storage.bucket))
      .rejects.toBeInstanceOf(MediaDependencyConflictError);
    expect(storage.deleteCalls).toEqual([]);

    await saveHeaderConfig(db, { logo: { src: "", alt: "" } }, saved.revision);
    await permanentlyDeleteMediaFile(db, file.id, trashed.version, storage.bucket);
    expect(storage.objects.size).toBe(0);
    expect(storage.deleteCalls).toContain(`${file.objectKey}/500.webp`);
  });

  it("renders the ladder once through the Images binding for non-dashboard uploads", async () => {
    const file = await seedImage();
    const storage = createBucket();
    const transforms: number[] = [];
    const bucket = {
      ...storage.bucket,
      put: storage.bucket.put,
      get: async () => ({ arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer }),
    } as unknown as R2Bucket;
    const images = {
      info: async () => ({ format: "image/jpeg", fileSize: 3, width: 700, height: 350 }),
      input: () => ({
        transform: ({ width }: { width: number }) => {
          transforms.push(width);
          return {
            output: async () => ({ response: () => new Response(WEBP_BYTES) }),
          };
        },
      }),
    } as unknown as ImagesBinding;

    const saved = await generateMediaVariants(db, file.id, bucket, images);

    expect(transforms).toEqual([144, 172, 206, 247, 296, 355, 426, 511, 613, 700]);
    expect(saved).toMatchObject({ variantWidth: 700, width: 700, height: 350 });
    expect(storage.objects.has(`${file.objectKey}/700.webp`)).toBe(true);
  });
});
