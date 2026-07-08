import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ADMIN_SRC_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ASSISTANT_ROOT = join(ADMIN_SRC_ROOT, "components", "admin", "assistant");

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

function readAssistantSource(): string {
  return listSourceFiles(ASSISTANT_ROOT)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
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

  it("keeps the bridge browser-only and away from admin API/domain authority", () => {
    const source = readAssistantSource();

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
    const source = readAssistantSource();

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
});
