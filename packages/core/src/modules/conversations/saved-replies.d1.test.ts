import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { encodeListCursor } from "@scalius/shared/pagination";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSavedReply, getSavedReply, listSavedReplies, updateSavedReply } from "./saved-replies";

describe("conversation saved replies", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const input = { id: "saved_delivery", title: "Delivery time", body: "It arrives tomorrow.", mode: "reply" as const };

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`INSERT INTO user (id, name, email, email_verified, role) VALUES
      ('staff_1', 'Nadia', 'nadia@shop.test', 1, 'admin'),
      ('staff_2', 'Amina', 'amina@shop.test', 1, 'admin')`);
  });
  afterEach(() => sqlite.close());

  it("normalizes content and replays only the same creator's identical create", async () => {
    const first = await createSavedReply(db, "staff_1", { ...input, title: " Delivery time ", body: " It arrives tomorrow.\r\n " });
    expect(first).toMatchObject({ ...input, createdBy: "staff_1", updatedBy: "staff_1", version: 1, archivedAt: null });
    expect(typeof first.createdAt).toBe("number");
    expect(await createSavedReply(db, "staff_1", input)).toEqual(first);
    for (const changed of [{ body: "Different" }, { title: "Changed" }, { mode: "note" as const }]) {
      await expect(createSavedReply(db, "staff_1", { ...input, ...changed })).rejects.toMatchObject({ status: 409 });
    }
    await expect(createSavedReply(db, "staff_2", input)).rejects.toMatchObject({ status: 409 });
    expect((await listSavedReplies(db)).items).toEqual([first]);
  });

  it("allows one winner for concurrent versioned edits and refuses stale archive changes", async () => {
    const first = await createSavedReply(db, "staff_1", input);
    const results = await Promise.allSettled([
      updateSavedReply(db, "staff_1", first.id, { version: first.version, body: "First edit" }),
      updateSavedReply(db, "staff_2", first.id, { version: first.version, body: "Second edit" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const current = await getSavedReply(db, first.id);
    expect(current.version).toBe(2);
    await expect(updateSavedReply(db, "staff_1", first.id, { version: 1, archived: true })).rejects.toMatchObject({ status: 409 });
    expect(await getSavedReply(db, first.id)).toEqual(current);
  });

  it("archives without deletion, exposes stale choices by id, and restores with the current version", async () => {
    const first = await createSavedReply(db, "staff_1", input);
    const archived = await updateSavedReply(db, "staff_2", first.id, { version: first.version, archived: true });
    expect(archived).toMatchObject({ version: 2, updatedBy: "staff_2" });
    expect(typeof archived.archivedAt).toBe("number");
    expect((await listSavedReplies(db)).items).toEqual([]);
    expect(await getSavedReply(db, first.id)).toEqual(archived);
    // Retrying creation cannot resurrect a saved reply another teammate archived.
    expect(await createSavedReply(db, "staff_1", input)).toEqual(archived);
    const restored = await updateSavedReply(db, "staff_1", first.id, { version: archived.version, archived: false });
    expect(restored).toMatchObject({ version: 3, archivedAt: null });
    expect((await listSavedReplies(db)).items).toEqual([restored]);
  });

  it("filters mode and title literally, including Bangla terms longer than D1's pattern limit", async () => {
    const bangla = "আপনার পণ্য আগামীকাল পৌঁছে যাবে";
    await createSavedReply(db, "staff_1", input);
    const note = await createSavedReply(db, "staff_1", { id: "saved_note", title: `50%_ ${bangla}`, body: "Private follow-up", mode: "note" });
    expect((await listSavedReplies(db, { mode: "reply" })).items.map((row) => row.id)).toEqual([input.id]);
    expect((await listSavedReplies(db, { q: "DELIVERY" })).items.map((row) => row.id)).toEqual([input.id]);
    expect((await listSavedReplies(db, { q: "arrives" })).items).toEqual([]);
    expect((await listSavedReplies(db, { q: "%_" })).items).toEqual([note]);
    expect((await listSavedReplies(db, { mode: "note", q: bangla })).items).toEqual([note]);
  });

  it("walks tied timestamps in bounded pages without dropping or repeating replies", async () => {
    const insert = sqlite.prepare(`INSERT INTO conversation_saved_replies
      (id, title, body, mode, created_by, updated_by, created_at, updated_at, version)
      VALUES (?, 'Delivery', 'Tomorrow', 'reply', 'staff_1', 'staff_1', 100, 100, 1)`);
    for (let index = 0; index < 53; index++) insert.run(`saved_${String(index).padStart(3, "0")}`);
    const first = await listSavedReplies(db);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const second = await listSavedReplies(db, { cursor: first.nextCursor });
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((row) => row.id);
    expect(new Set(ids).size).toBe(53);
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it("rejects malformed input and cursors without writes, and distinguishes missing from stale replies", async () => {
    for (const changed of [{ id: "../bad" }, { id: "x".repeat(129) }, { title: " " }, { title: "x".repeat(81) }, { title: "two\nlines" }, { body: " " }, { body: "x".repeat(5001) }, { body: "bad\u0000body" }]) {
      await expect(createSavedReply(db, "staff_1", { ...input, ...changed })).rejects.toMatchObject({ status: 400 });
    }
    await expect(listSavedReplies(db, { q: "x".repeat(101) })).rejects.toMatchObject({ status: 400 });
    await expect(listSavedReplies(db, { cursor: "invalid" })).rejects.toMatchObject({ status: 400 });
    await expect(listSavedReplies(db, { cursor: encodeListCursor({ sort: "other", direction: "desc", values: [100], id: input.id }) })).rejects.toMatchObject({ status: 400 });
    await expect(getSavedReply(db, input.id)).rejects.toMatchObject({ status: 404 });
    await expect(updateSavedReply(db, "staff_1", input.id, { version: 1, body: "Hello" })).rejects.toMatchObject({ status: 404 });
    await expect(updateSavedReply(db, "staff_1", input.id, { version: 0, body: "Hello" })).rejects.toMatchObject({ status: 400 });
    await expect(updateSavedReply(db, "staff_1", input.id, { version: 1 })).rejects.toMatchObject({ status: 400 });
    expect((await listSavedReplies(db)).items).toEqual([]);
  });
});
