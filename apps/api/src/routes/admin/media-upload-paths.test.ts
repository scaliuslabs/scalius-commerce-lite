import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every image a buyer can see (product and variant photos, brand logos,
 * content blocks, homepage banners, category and collection images) is a
 * `media` row, and a media row is committed only by an upload completion.
 * Those forms pick or upload through the shared dashboard media manager
 * (`mediaClient.ts`), which goes through the two routes below. So the delayed
 * `media.render_variants` job covers every upload path exactly when each
 * route that commits an upload also enqueues it.
 */
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

function sources(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "generated" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path, pattern));
    else if (pattern.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

function callers(files: string[], call: RegExp): string[] {
  return files
    .filter((file) => call.test(readFileSync(file, "utf8")))
    .map((file) => relative(repoRoot, file))
    .sort();
}

describe("media upload paths", () => {
  const serverFiles = [
    ...sources(join(repoRoot, "apps/api/src"), /\.ts$/),
    ...sources(join(repoRoot, "packages/core/src"), /\.ts$/),
  ];

  it("commits media rows only through the upload completion service", () => {
    expect(callers(serverFiles, /\.insert\(\s*media\s*\)/)).toEqual([
      "packages/core/src/modules/media/media.service.ts",
    ]);
  });

  it("enqueues the delayed render job on every route that completes an upload", () => {
    expect(callers(serverFiles, /\b(?:completeMediaUpload|importMediaFromUrl)\(/)).toEqual([
      "apps/api/src/routes/admin/media-url-import.ts",
      "apps/api/src/routes/admin/media.ts",
      "packages/core/src/modules/media/media.service.ts",
    ]);
    const routes = readFileSync(join(repoRoot, "apps/api/src/routes/admin/media.ts"), "utf8");
    for (const commit of ["await importMediaFromUrl(", "await completeMediaUpload("]) {
      const at = routes.indexOf(commit);
      expect(at).toBeGreaterThan(-1);
      const handlerEnd = routes.indexOf("\n});", at);
      expect(routes.slice(at, handlerEnd)).toContain("await enqueueMediaVariantsJob(");
    }
  });

  it("uploads dashboard images only through the media manager client", () => {
    const dashboardFiles = sources(join(repoRoot, "apps/admin-v2/src"), /\.tsx?$/);
    expect(callers(dashboardFiles, /postApiV1AdminMediaUploads(?:ByIdComplete|ImportUrl)?\b|\/media\/uploads/)).toEqual([
      "apps/admin-v2/src/components/admin/media-manager/api/mediaClient.ts",
    ]);
  });
});
