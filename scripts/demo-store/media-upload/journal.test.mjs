import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { appendUploadJournal, readUploadJournal } from "./journal.mjs";

const directories = [];
const fingerprint = "a".repeat(64);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function journalFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scalius-upload-journal-"));
  directories.push(directory);
  return path.join(directory, "upload.jsonl");
}

function opaqueId(prefix, seed) {
  return `${prefix}_${`${seed}${"x".repeat(21)}`.slice(0, 21)}`;
}

function baseRecord(overrides = {}) {
  return {
    logicalKey: "product-test:primary",
    action: "upload",
    status: "session",
    sessionId: opaqueId("mup", "session"),
    mediaId: opaqueId("media", "asset"),
    timestamp: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("demo-store Media upload journal", () => {
  it("accepts canonical opaque IDs when their random suffix contains an innocent sensitive-looking substring", async () => {
    const journalPath = await journalFixture();
    const sessionId = opaqueId("mup", "otp-cookie-proof");
    const mediaId = opaqueId("media", "bearer-secret-otp");

    await appendUploadJournal(journalPath, baseRecord({ sessionId, mediaId }), fingerprint);
    const state = await readUploadJournal(journalPath, fingerprint);

    expect(state.get("product-test:primary")).toMatchObject({ sessionId, mediaId, status: "session" });
    expect(await readFile(journalPath, "utf8")).toContain(sessionId);
  });

  it("rejects credential-like or non-canonical logical keys", async () => {
    const journalPath = await journalFixture();
    for (const logicalKey of [
      "product:password-proof",
      "product:valid\nsecret",
      "Product:Primary",
      "product::primary",
    ]) {
      await expect(appendUploadJournal(journalPath, baseRecord({ logicalKey }), fingerprint)).rejects.toThrow(/logical key/iu);
    }
  });

  it("accepts long canonical segmented keys without regex backtracking", async () => {
    const journalPath = await journalFixture();
    const logicalKey = `0:${"00:".repeat(60)}0`;

    await appendUploadJournal(journalPath, baseRecord({ logicalKey }), fingerprint);

    expect((await readUploadJournal(journalPath, fingerprint)).has(logicalKey)).toBe(true);
  });

  it("rejects IDs that are not exact Media or upload-session opaque identities", async () => {
    const journalPath = await journalFixture();
    for (const invalid of [
      { sessionId: "session_1" },
      { sessionId: "mup_short" },
      { sessionId: `mup_${"x".repeat(20)}@` },
      { mediaId: "Bearer credential" },
      { mediaId: "media_password" },
      { mediaId: `media_${"x".repeat(22)}` },
    ]) {
      await expect(appendUploadJournal(journalPath, baseRecord(invalid), fingerprint)).rejects.toThrow(/Id is invalid/iu);
    }
  });

  it("fails closed on unknown fields, mismatched actions, non-canonical timestamps, fingerprints, and part numbers", async () => {
    const journalPath = await journalFixture();
    await expect(appendUploadJournal(journalPath, baseRecord({ cookie: "value" }), fingerprint)).rejects.toThrow(/field is not allowed/iu);
    await expect(appendUploadJournal(journalPath, baseRecord({ action: "reuse" }), fingerprint)).rejects.toThrow(/action does not match/iu);
    await expect(appendUploadJournal(journalPath, baseRecord({ timestamp: "2026-07-14" }), fingerprint)).rejects.toThrow(/incomplete/iu);
    await expect(appendUploadJournal(journalPath, baseRecord(), "short")).rejects.toThrow(/fingerprint/iu);
    await expect(appendUploadJournal(journalPath, baseRecord({ status: "part", partNumber: 0 }), fingerprint)).rejects.toThrow(/part number/iu);
    await expect(appendUploadJournal(journalPath, baseRecord({ status: "part", partNumber: 21 }), fingerprint)).rejects.toThrow(/part number/iu);
  });

  it("rejects newline-delimited or invalid persisted journal data while rebuilding state", async () => {
    const journalPath = await journalFixture();
    const invalidRecord = {
      schemaVersion: 1,
      runFingerprint: fingerprint,
      ...baseRecord({ logicalKey: "product:primary\nsecret" }),
    };
    await writeFile(journalPath, `${JSON.stringify(invalidRecord)}\n`);
    await expect(readUploadJournal(journalPath, fingerprint)).rejects.toThrow(/logical key/iu);
  });
});
