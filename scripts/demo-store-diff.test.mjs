import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, parseDemoStoreArgs } from "./demo-store.mjs";
import { listCursor, listPaged } from "./demo-store/api-read.mjs";
import { buildDemoStoreDiff } from "./demo-store/diff.mjs";
import { writeEvidenceBundle } from "./demo-store/evidence.mjs";
import { sanitizeResumeRecord } from "./demo-store/journal.mjs";
import { demoStoreManifest } from "./demo-store/manifest.mjs";
import { runDemoStoreDiff } from "./demo-store/run-diff.mjs";
import { closeAdminSession, normalizeAdminOrigin, openAdminSession } from "./demo-store/session.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function emptySnapshot() {
  return {
    capturedAt: "2026-07-13T02:00:00.000Z",
    auth: { authenticated: true, isSuperAdmin: true },
    categories: [],
    products: [],
    productDetails: [],
    media: [],
    attributes: [],
    collections: [],
    presentation: { general: {}, theme: {}, heroes: [] },
  };
}

describe("demo-store authenticated session", () => {
  it("posts credentials only in JSON and returns only safe evidence", async () => {
    const privatePassword = "private-password-value";
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: "user_1" } }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "session=signed-value; HttpOnly; Secure" },
    }));

    const session = await openAdminSession({
      adminOrigin: "https://dashboard.example.test",
      email: "admin@example.test",
      password: privatePassword,
      fetchImpl,
      timeoutMs: 1_000,
    });

    expect(fetchImpl.mock.calls[0][0]).toBe("https://dashboard.example.test/api/auth/sign-in/email");
    const request = fetchImpl.mock.calls[0][1];
    expect(JSON.parse(request.body)).toEqual({ email: "admin@example.test", password: privatePassword, rememberMe: false });
    expect(JSON.stringify(session.evidence)).not.toContain(privatePassword);
    expect(JSON.stringify(session.evidence)).not.toContain("signed-value");
    expect(session.cookieHeader).toContain("session=signed-value");
  });

  it("normalizes safe origins and rejects credentialed URLs", () => {
    expect(normalizeAdminOrigin("https://dashboard.example.test/")).toBe("https://dashboard.example.test");
    expect(() => normalizeAdminOrigin("https://user:pass@dashboard.example.test")).toThrow("without credentials");
    expect(() => normalizeAdminOrigin("http://dashboard.example.test")).toThrow("must use HTTPS");
  });

  it("attempts sign-out without surfacing cookie material", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(closeAdminSession({
      adminOrigin: "https://dashboard.example.test",
      cookieHeader: "session=private",
      fetchImpl,
      timeoutMs: 1_000,
    })).resolves.toEqual({ status: "closed", statusCode: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cleans up a provisional session when two-factor continuation is required", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ twoFactorRedirect: true }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "session=provisional; HttpOnly; Secure" },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(openAdminSession({
      adminOrigin: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "private",
      fetchImpl,
      timeoutMs: 1_000,
    })).rejects.toThrow("two-factor verification");
    expect(fetchImpl.mock.calls[1][0]).toBe("https://dashboard.example.test/api/auth/sign-out");
  });
});

describe("demo-store bounded reads", () => {
  it("collects page and cursor pagination within explicit limits", async () => {
    const pagedClient = {
      get: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: "1" }], pagination: { total: 2, totalPages: 2 } })
        .mockResolvedValueOnce({ rows: [{ id: "2" }], pagination: { total: 2, totalPages: 2 } }),
    };
    await expect(listPaged(pagedClient, { path: "/rows", collectionKey: "rows", label: "Rows", limit: 1 }))
      .resolves.toEqual([{ id: "1" }, { id: "2" }]);

    const cursorClient = {
      get: vi.fn()
        .mockResolvedValueOnce({ files: [{ id: "1" }], pagination: { hasMore: true, nextCursor: "next-1" } })
        .mockResolvedValueOnce({ files: [{ id: "2" }], pagination: { hasMore: false, nextCursor: null } }),
    };
    await expect(listCursor(cursorClient, { path: "/media", collectionKey: "files", label: "Media", limit: 1 }))
      .resolves.toEqual([{ id: "1" }, { id: "2" }]);
  });

  it("fails on repeated cursors and page-bound overflow", async () => {
    const cursorClient = { get: vi.fn().mockResolvedValue({ files: [], pagination: { hasMore: true, nextCursor: "same" } }) };
    await expect(listCursor(cursorClient, { path: "/media", collectionKey: "files", label: "Media", maxPages: 3 }))
      .rejects.toThrow("invalid or repeated cursor");

    const pagedClient = { get: vi.fn().mockResolvedValue({ rows: [], pagination: { total: 1, totalPages: 2 } }) };
    await expect(listPaged(pagedClient, { path: "/rows", collectionKey: "rows", label: "Rows", maxPages: 1 }))
      .rejects.toThrow("exceeded the 1-page safety bound");
  });
});

describe("demo-store diff and evidence", () => {
  it("uses exact retained IDs and reports a collision as a conflict", () => {
    const snapshot = emptySnapshot();
    snapshot.products = [{ id: "prod_wrong", slug: "rider-court-trainers" }];
    const diff = buildDemoStoreDiff(demoStoreManifest, snapshot);
    const rider = diff.resources.products.find((product) => product.slug === "rider-court-trainers");
    expect(rider).toMatchObject({ action: "conflict", fields: ["retainedProductId"] });
    expect(diff.summary.products).toMatchObject({ conflict: 1, create: 49 });
  });

  it("treats a drifting unversioned Brand definition as a pre-write conflict", () => {
    const snapshot = emptySnapshot();
    snapshot.attributes = [{ id: "attr_brand", slug: "brand", name: "Maker", filterable: false }];
    const diff = buildDemoStoreDiff(demoStoreManifest, snapshot);
    expect(diff.resources.attributes[0]).toMatchObject({
      logicalKey: "attribute:brand",
      action: "conflict",
      fields: ["name", "filterable"],
    });
    expect(diff.summary.conflicts).toBe(1);
  });

  it("writes a private evidence bundle and a whitelisted resume journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-demo-evidence-"));
    temporaryDirectories.push(directory);
    const snapshot = emptySnapshot();
    const diff = buildDemoStoreDiff(demoStoreManifest, snapshot);
    const evidence = await writeEvidenceBundle({
      baseDir: directory,
      snapshot,
      diff,
      now: () => new Date("2026-07-13T02:00:00.000Z"),
      id: () => "test-run",
    });

    const run = await readFile(join(evidence.runDir, "run.json"), "utf8");
    const journal = await readFile(join(evidence.runDir, "resume.jsonl"), "utf8");
    expect(JSON.parse(run)).toMatchObject({ mode: "diff", readOnly: true, auth: { authenticated: true } });
    expect(JSON.parse(journal)).toMatchObject({ phase: "snapshot-current-state", status: "complete", count: 0 });
    expect(`${run}${journal}`).not.toMatch(/cookie|password|admin@example/i);
    expect(() => sanitizeResumeRecord({ status: "complete", timestamp: new Date().toISOString(), cookie: "private" }))
      .toThrow("field is not allowed");
  });

  it("always signs out and returns no credential or cookie fields", async () => {
    const closeSession = vi.fn().mockResolvedValue({ status: "closed", statusCode: 200 });
    const result = await runDemoStoreDiff({
      adminOrigin: "https://dashboard.example.test",
      credentials: { email: "admin@example.test", password: "private" },
      openSession: vi.fn().mockResolvedValue({ cookieHeader: "session=private", evidence: { statusCode: 200, sessionCookieCount: 1 } }),
      closeSession,
      readClientFactory: vi.fn().mockReturnValue({}),
      snapshotReader: vi.fn().mockResolvedValue(emptySnapshot()),
      diffBuilder: buildDemoStoreDiff,
      evidenceWriter: vi.fn().mockResolvedValue({ runId: "run", runDir: "/safe/run", files: {} }),
      fetchImpl: vi.fn(),
    });
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ readOnly: true, writesEnabled: false, sessionCleanup: { status: "closed" } });
    expect(JSON.stringify(result)).not.toContain("session=private");
    expect(JSON.stringify(result)).not.toContain("admin@example.test");
  });
});

describe("demo-store diff CLI", () => {
  it("rejects credentials in arguments and incomplete apply invocation", async () => {
    expect(() => parseDemoStoreArgs(["--diff", "--password", "private"])).toThrow("interactive terminal");
    expect(() => parseDemoStoreArgs(["--plan", "--diff"])).toThrow("exactly one");
    await expect(main(["--apply"], { log: vi.fn() })).rejects.toThrow("explicit --media-readiness");
  });

  it("passes prompted credentials in memory and prints only safe diff evidence", async () => {
    const privateCredentials = { email: "admin@example.test", password: "private" };
    const runDiffImpl = vi.fn().mockResolvedValue({
      diff: buildDemoStoreDiff(demoStoreManifest, emptySnapshot()),
      evidence: { runDir: "/safe/run" },
      sessionCleanup: { status: "closed" },
    });
    const lines = [];
    await expect(main(["--diff", "--admin-url", "https://dashboard.example.test"], {
      log: (line) => lines.push(line),
      credentialReader: vi.fn().mockResolvedValue(privateCredentials),
      runDiffImpl,
    })).resolves.toBe(0);

    expect(runDiffImpl).toHaveBeenCalledWith(expect.objectContaining({ credentials: privateCredentials }));
    expect(lines.join("\n")).toContain("Writes: disabled");
    expect(lines.join("\n")).not.toContain(privateCredentials.email);
    expect(lines.join("\n")).not.toContain(privateCredentials.password);
  });
});
