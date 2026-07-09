import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ADMIN_SRC_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ASSISTANT_ROOT = join(ADMIN_SRC_ROOT, "components", "admin", "assistant");
const PAGE_STATE_FILES = [
  "AdminAssistantPageStateBridge.tsx",
  "page-state.ts",
] as const;
const LAYOUT_PREFERENCE_FILES = [
  "assistant-layout.ts",
  "useAdminAssistantLayout.ts",
] as const;

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      const stats = statSync(path);
      return stats.isDirectory() ? listSourceFiles(path) : [path];
    })
    .filter((path) => /\.(?:ts|tsx)$/.test(path))
    .filter((path) => !/\.test\.(?:ts|tsx)$/.test(path));
}

function readFiles(files: readonly string[]): string {
  return files
    .map((file) => readFileSync(join(ASSISTANT_ROOT, file), "utf8"))
    .join("\n");
}

function readAssistantSource(excludedFiles: readonly string[] = []): string {
  return listSourceFiles(ASSISTANT_ROOT)
    .filter((path) => !excludedFiles.some((file) => path.endsWith(`/${file}`)))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

function readPageStateSource(): string {
  return readFiles(PAGE_STATE_FILES);
}

describe("admin assistant page-state source boundary", () => {
  it("mounts the headless bridge from the admin shell with pathname-only route context", () => {
    const adminRouteSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin.tsx"),
      "utf8",
    );

    expect(adminRouteSource).toContain(
      "@/components/admin/assistant/AdminAssistantPageStateBridge",
    );
    expect(adminRouteSource).toContain("const location = useLocation()");
    expect(adminRouteSource).toContain(
      "<AdminAssistantPageStateBridge routePath={location.pathname} />",
    );
    expect(adminRouteSource).not.toContain("routePath={location.href}");
    expect(adminRouteSource).not.toContain("routePath={location.search}");
  });

  it("mounts the visible launcher after deferred header actions and before theme controls", () => {
    const adminHeaderSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "layout", "AdminHeader.tsx"),
      "utf8",
    );

    expect(adminHeaderSource).toContain(
      "@/components/admin/assistant/AdminAssistantLauncher",
    );
    expect(adminHeaderSource.indexOf("<DeferredAdminHeaderActions")).toBeLessThan(
      adminHeaderSource.indexOf("<AdminAssistantLauncher"),
    );
    expect(adminHeaderSource.indexOf("<AdminAssistantLauncher")).toBeLessThan(
      adminHeaderSource.indexOf("<DarkModeToggle"),
    );
  });

  it("keeps the bridge browser-only and away from admin API/domain authority", () => {
    const source = readPageStateSource();

    expect(source).toContain("__SCALIUS_ADMIN_ASSISTANT_PAGE_STATE__");
    expect(source).toContain("scalius:admin-assistant-page-state");
    expect(source).not.toMatch(/@scalius\/(?:core|database)/);
    expect(source).not.toMatch(/(?:~|@)\/lib\/api/);
    expect(source).not.toContain("cloudflare:workers");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("document.cookie");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("observer?.observe(scrollElement");
  });

  it("does not query arbitrary form controls or read DOM field values", () => {
    const source = readPageStateSource();

    expect(source).not.toMatch(
      /querySelector(?:All)?(?:<[^>]+>)?\(\s*["'`][^"'`]*(?:input|textarea|select|\[name=|form)/i,
    );
    const headingSelector = source.match(
      /const\s+PAGE_HEADING_SELECTOR\s*=\s*([\s\S]*?);/,
    )?.[1];
    expect(headingSelector).toBeDefined();
    expect(headingSelector).not.toMatch(
      /(?:input|textarea|select|\[name=|form)/i,
    );
    expect(source).not.toContain("FormData");
    expect(source).not.toMatch(/\.(?:value|checked|selectedOptions|files)\b/);
  });

  it("keeps the visible chat UI off direct MCP, fetch, cookies, and sensitive storage", () => {
    const source = readAssistantSource(LAYOUT_PREFERENCE_FILES);
    const layoutSource = readFiles(LAYOUT_PREFERENCE_FILES);

    expect(source).not.toContain("/api/assistant/mcp");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("document.cookie");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toMatch(/window\.(?:localStorage|sessionStorage)/);

    expect(layoutSource).toContain("scalius:admin-assistant-layout:v1");
    expect(layoutSource).toContain("window.localStorage");
    expect(layoutSource).not.toContain("sessionStorage");
    expect(layoutSource).not.toContain("document.cookie");
    expect(layoutSource).not.toContain("fetch(");
    expect(layoutSource).not.toMatch(/(?:messages|history|pageContext|credential|token)/);
  });
});
