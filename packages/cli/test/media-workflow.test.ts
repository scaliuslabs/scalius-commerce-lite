import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.js";
import { uploadMediaFiles } from "../src/media.js";
import type { OpenApiDocument } from "../src/types.js";
import { createTestRuntime, executableSpec, validToken } from "./helpers.js";

function mediaSpec(): OpenApiDocument {
  const document = executableSpec() as OpenApiDocument;
  document.paths!["/api/v1/admin/media/uploads/{id}"] = {
    delete: {
      operationId: "dashboard.media.upload_abort",
      parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
      "x-scalius-agent": {
        surface: "dashboard", exposure: "execute", principals: ["admin"], risk: "write",
        openWorld: false, idempotency: "none", batch: "sequential", transport: "json", maxRequestBytes: 1024 * 1024,
      },
    },
  };
  const part = document.paths!["/api/v1/admin/media/uploads/{id}/parts/{partNumber}"]!.put as Record<string, unknown>;
  const metadata = part["x-scalius-agent"] as Record<string, unknown>;
  metadata.idempotency = "none";
  return document;
}

async function profile(directory: string, fetch: typeof globalThis.fetch) {
  const runtime = createTestRuntime({ directory, fetch });
  const store = new ConfigStore(runtime);
  await store.putProfile("default", "https://api.example.com");
  await store.putCredential("default", { token: validToken(), createdAt: "2026-08-13T00:00:00.000Z" });
  return { runtime, profile: await store.resolveProfile() };
}

describe("guided media upload", () => {
  it("validates and completes a JPEG through one contract load", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-media-test-"));
    const path = join(directory, "hero.jpg");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    await writeFile(path, jpeg);
    const requests: Array<{ path: string; method: string; body?: Uint8Array }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/openapi.json")) return Response.json(mediaSpec());
      const body = init?.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : undefined;
      requests.push({ path: url.pathname, method: init?.method ?? "GET", body });
      if (url.pathname.endsWith("/media/uploads")) return Response.json({ success: true, data: { session: { id: "upload_12345678", expectedParts: 1, partSize: 5 * 1024 * 1024 } } }, { status: 201 });
      if (url.pathname.includes("/parts/1")) return Response.json({ success: true, data: { partNumber: 1, size: jpeg.length } });
      if (url.pathname.endsWith("/complete")) return Response.json({ success: true, data: { file: { id: "media_12345678", mimeType: "image/jpeg", size: jpeg.length } } });
      return new Response(null, { status: 404 });
    });
    const context = await profile(directory, fetch as typeof globalThis.fetch);
    await expect(uploadMediaFiles(context.runtime, context.profile, [path])).resolves.toMatchObject({
      count: 1,
      uploaded: [{ mediaId: "media_12345678", mimeType: "image/jpeg", size: jpeg.length }],
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(requests.map(({ path: requestPath }) => requestPath)).toEqual([
      "/api/v1/admin/media/uploads",
      "/api/v1/admin/media/uploads/upload_12345678/parts/1",
      "/api/v1/admin/media/uploads/upload_12345678/complete",
    ]);
    expect(Buffer.from(requests[1]?.body ?? [])).toEqual(jpeg);
  });

  it("rejects unsupported and mislabeled files before initiating", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-media-test-"));
    const unsupported = join(directory, "camera.heic");
    const mislabeled = join(directory, "image.png");
    await writeFile(unsupported, Buffer.from("not-heic"));
    await writeFile(mislabeled, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const fetch = vi.fn(async () => Response.json(mediaSpec()));
    const context = await profile(directory, fetch as typeof globalThis.fetch);
    await expect(uploadMediaFiles(context.runtime, context.profile, [unsupported])).rejects.toMatchObject({ errorCode: "unsupported_media" });
    await expect(uploadMediaFiles(context.runtime, context.profile, [mislabeled])).rejects.toMatchObject({ errorCode: "media_extension_mismatch" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts the durable session when a part upload fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-media-test-"));
    const path = join(directory, "hero.jpg");
    await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]));
    const visited: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/openapi.json")) return Response.json(mediaSpec());
      visited.push(url.pathname);
      if (url.pathname.endsWith("/media/uploads")) return Response.json({ success: true, data: { session: { id: "upload_12345678", expectedParts: 1, partSize: 5 * 1024 * 1024 } } }, { status: 201 });
      if (url.pathname.includes("/parts/1")) return Response.json({ success: false, error: { code: "upload_failed", message: "failed" } }, { status: 500 });
      if (url.pathname.endsWith("/upload_12345678")) return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    });
    const context = await profile(directory, fetch as typeof globalThis.fetch);
    await expect(uploadMediaFiles(context.runtime, context.profile, [path])).rejects.toMatchObject({ errorCode: "upload_failed" });
    expect(visited.at(-1)).toBe("/api/v1/admin/media/uploads/upload_12345678");
  });
});
