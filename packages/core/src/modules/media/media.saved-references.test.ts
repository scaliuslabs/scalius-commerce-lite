import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "@scalius/database/client";
import { media } from "@scalius/database/schema";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MediaDependencyConflictError,
  permanentlyDeleteMediaFile,
  trashMediaFile,
} from "./media.service";
import {
  getGeneralSettings,
  saveHeaderConfig,
} from "../settings/site-settings.service";

function createDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDirectory = resolve(
    fileURLToPath(new URL("../../../../database/migrations", import.meta.url)),
  );
  for (const name of readdirSync(migrationDirectory).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
    sqlite.exec(readFileSync(resolve(migrationDirectory, name), "utf8"));
  }

  const execute = (query: string, params: unknown[], method: string) => {
    const statement = sqlite.prepare(query);
    statement.setReturnArrays(true);
    const sqlParams = params as SQLInputValue[];
    if (method === "get") {
      return {
        rows: statement.get(...sqlParams) as unknown as unknown[],
      };
    }
    if (method === "run") {
      statement.run(...sqlParams);
      return { rows: [] as unknown[][] };
    }
    return { rows: statement.all(...sqlParams) as unknown as unknown[][] };
  };
  const db = drizzle(
    async (query, params, method) => execute(query, params, method),
    async (queries) => {
      sqlite.exec("BEGIN");
      try {
        const results = queries.map((query) => execute(query.sql, query.params, query.method));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  ) as unknown as Database;
  return { db, sqlite };
}

function createBucket() {
  const objects = new Set<string>();
  const deleteCalls: string[] = [];
  return {
    objects,
    deleteCalls,
    bucket: {
      head: async (key: string) => (objects.has(key) ? {} : null),
      delete: async (key: string) => {
        deleteCalls.push(key);
        objects.delete(key);
      },
    } as unknown as R2Bucket,
  };
}

describe("saved media reference deletion guards", () => {
  let db: Database;
  let sqlite: DatabaseSync;

  beforeEach(() => {
    ({ db, sqlite } = createDatabase());
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
      savedReferences: {
        samples: [{ surface: "site_header" }],
      },
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
