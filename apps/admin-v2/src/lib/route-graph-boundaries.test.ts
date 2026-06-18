import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const ADMIN_SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      const stats = statSync(path);
      return stats.isDirectory() ? listSourceFiles(path) : [path];
    })
    .filter((path) => /\.(?:ts|tsx)$/.test(path));
}

function hasBroadQueryBarrelImport(source: string) {
  return /from\s+["'](?:[@~]\/lib\/api\.queries|(?:\.\.?\/)+(?:lib\/)?api\.queries)["']/.test(
    source,
  );
}

describe("admin route graph boundaries", () => {
  it("keeps route error UI out of zod-backed list helpers", () => {
    const offenders = listSourceFiles(join(ADMIN_SRC_ROOT, "routes", "admin"))
      .map((path) => ({
        path: relative(ADMIN_SRC_ROOT, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(
        ({ source }) =>
          /import\s+\{[^}]*RouteErrorComponent[^}]*\}\s+from\s+["']~\/lib\/list-helpers["'];/.test(
            source,
          ),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it("keeps runtime admin source off the broad query barrel", () => {
    const offenders = listSourceFiles(ADMIN_SRC_ROOT)
      .map((path) => ({
        path: relative(ADMIN_SRC_ROOT, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(({ source }) => hasBroadQueryBarrelImport(source))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it("keeps narrow query-option modules from depending on the broad query barrel", () => {
    const offenders = listSourceFiles(join(ADMIN_SRC_ROOT, "lib", "api-query-options"))
      .map((path) => ({
        path: relative(ADMIN_SRC_ROOT, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(({ source }) => /api\.queries/.test(source))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it("keeps customer form writes invalidating dashboard aggregates", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "CustomerForm.tsx"),
      "utf8",
    );

    expect(source).toContain("queryKeys.customers.list()");
    expect(source).toContain("queryKeys.dashboard.all");
  });

  it("keeps analytics list dates hydration-safe", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "AnalyticsList.tsx"),
      "utf8",
    );

    expect(source).toMatch(/suppressHydrationWarning[^]*formatDate\(script\.createdAt\)/);
  });

  it("keeps admin navigation from doing focus refetch stampedes", () => {
    const routerSource = readFileSync(join(ADMIN_SRC_ROOT, "router.tsx"), "utf8");
    const queryClientSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "admin-query-client.ts"),
      "utf8",
    );
    const cacheQuerySource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "api-query-options", "cache.ts"),
      "utf8",
    );
    const orderDetailSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "orders", "$orderId", "index.tsx"),
      "utf8",
    );
    const orderListSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "orders", "index.tsx"),
      "utf8",
    );
    const adminRouteSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin.tsx"),
      "utf8",
    );
    const scrollSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "admin-scroll-restoration.ts"),
      "utf8",
    );

    expect(routerSource).toContain("createAdminQueryClient()");
    expect(routerSource).toContain("defaultPreload: false");
    expect(routerSource).not.toContain('defaultPreload: "intent"');
    expect(queryClientSource).toContain("refetchOnWindowFocus: false");
    expect(queryClientSource).toContain("refetchOnReconnect: false");
    expect(cacheQuerySource.match(/refetchOnReconnect: true/g)?.length).toBe(3);
    expect(orderDetailSource.match(/refetchOnReconnect: true/g)?.length).toBe(2);
    expect(orderListSource).toContain('document.addEventListener("visibilitychange"');
    expect(orderListSource).toContain("isDocumentHidden()");
    expect(orderListSource).not.toContain("refreshIntervalRef");
    expect(routerSource).toContain("scrollToTopSelectors: [\"#admin-main-scroll\"]");
    expect(routerSource).toContain("scrollRestorationBehavior: \"instant\"");
    expect(adminRouteSource).toContain("useAdminNestedScrollRestoration();");
    expect(scrollSource).toContain('router.subscribe("onBeforeLoad"');
    expect(scrollSource).toContain('router.subscribe("onRendered"');
    expect(scrollSource).toContain('window.addEventListener("popstate"');
  });

  it("keeps deferred rich-text previews rendered without eager editor imports", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "ui", "tiptap", "DeferredTiptapEditor.tsx"),
      "utf8",
    );

    expect(source).toContain("import { RichContent } from \"../rich-content\"");
    expect(source).toContain("<RichContent content={content} variant=\"compact\" />");
    expect(source).toContain("const TiptapEditor = lazy(");
    expect(source).not.toContain("from \"./TiptapEditor\"");
    expect(source).not.toContain("toPlainTextPreview");
  });
});
