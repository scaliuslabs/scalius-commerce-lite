import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative } from "node:path";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { ADMIN_PERMISSIONS } from "./admin-permissions";
import { NAV_PERMISSIONS } from "../components/admin/layout/AdminNav";

const ADMIN_SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      const stats = statSync(path);
      return stats.isDirectory() ? listSourceFiles(path) : [path];
    })
    .filter((path) => /\.(?:ts|tsx)$/.test(path));
}

function resolveSourceModule(fromPath: string, specifier: string) {
  let basePath: string | null = null;

  if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    basePath = join(ADMIN_SRC_ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    basePath = join(dirname(fromPath), specifier);
  }

  if (!basePath) return null;

  const candidates = extname(basePath)
    ? [basePath]
    : [
        ...SOURCE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
        ...SOURCE_EXTENSIONS.map((extension) =>
          join(basePath, `index${extension}`),
        ),
      ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function extractStaticSourceImports(source: string) {
  const specifiers: string[] = [];
  const importPattern =
    /\bimport\s+(?!type\b)(?:[^'";]*?\s+from\s*)?["']([^"']+)["']/g;
  const exportPattern =
    /\bexport\s+(?!type\b)(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g;

  for (const pattern of [importPattern, exportPattern]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

function findStaticImportPathToTarget(entryPath: string, targetPath: string) {
  const queue: Array<{ path: string; chain: string[] }> = [
    { path: entryPath, chain: [relative(ADMIN_SRC_ROOT, entryPath)] },
  ];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (seen.has(current.path)) continue;
    seen.add(current.path);

    if (current.path === targetPath) return current.chain;

    const source = readFileSync(current.path, "utf8");
    for (const specifier of extractStaticSourceImports(source)) {
      const resolved = resolveSourceModule(current.path, specifier);
      if (!resolved || seen.has(resolved)) continue;
      queue.push({
        path: resolved,
        chain: [...current.chain, relative(ADMIN_SRC_ROOT, resolved)],
      });
    }
  }

  return null;
}

function hasBroadQueryBarrelImport(source: string) {
  return /from\s+["'](?:[@~]\/lib\/api\.queries|(?:\.\.?\/)+(?:lib\/)?api\.queries)["']/.test(
    source,
  );
}

function extractOpeningFormTags(source: string): string[] {
  const text = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const tags: string[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf("<form", searchFrom);
    if (start < 0) break;

    let braceDepth = 0;
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;

    for (let i = start + "<form".length; i < text.length; i += 1) {
      const char = text[i];

      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }

      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") {
        braceDepth += 1;
        continue;
      }
      if (char === "}" && braceDepth > 0) {
        braceDepth -= 1;
        continue;
      }
      if (char === ">" && braceDepth === 0) {
        tags.push(text.slice(start, i + 1));
        searchFrom = i + 1;
        break;
      }
      if (i === text.length - 1) {
        searchFrom = text.length;
      }
    }
  }

  return tags;
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

  it("keeps route search validators out of the Zod runtime", () => {
    const routeOffenders = listSourceFiles(join(ADMIN_SRC_ROOT, "routes"))
      .map((path) => ({
        path: relative(ADMIN_SRC_ROOT, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(({ source }) => /from\s+["']zod["']/.test(source))
      .map(({ path }) => path);
    const listHelperSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "list-helpers.tsx"),
      "utf8",
    );

    expect(routeOffenders).toEqual([]);
    expect(listHelperSource).not.toMatch(/from\s+["']zod["']/);
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

  it("keeps admin routes off the broad data-table barrel", () => {
    const offenders = listSourceFiles(join(ADMIN_SRC_ROOT, "routes", "admin"))
      .map((path) => ({
        path: relative(ADMIN_SRC_ROOT, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(({ source }) =>
        /from\s+["'](?:[@~]\/components\/admin\/data-table)["']/.test(source),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it("keeps notification settings UI off the backend notifications barrel", () => {
    const notificationSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "settings",
        "NotificationChannelsBuilder.tsx",
      ),
      "utf8",
    );
    const offenders = [
      ...listSourceFiles(join(ADMIN_SRC_ROOT, "components")),
      ...listSourceFiles(join(ADMIN_SRC_ROOT, "routes")),
    ]
      .map((path) => ({
        path: relative(ADMIN_SRC_ROOT, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(({ source }) =>
        /(?:from\s+|import\()\s*["']@scalius\/core\/modules\/notifications["']/.test(source),
      )
      .map(({ path }) => path);

    expect(notificationSource).toContain(
      "@scalius/core/modules/notifications/notification-types",
    );
    expect(offenders).toEqual([]);
  });

  it("keeps customer notification channels limited to implemented delivery paths", () => {
    const notificationSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "settings",
        "NotificationChannelsBuilder.tsx",
      ),
      "utf8",
    );
    const customerChannelBlock = notificationSource.slice(
      notificationSource.indexOf("const CHANNELS"),
      notificationSource.indexOf("const ADMIN_STATUSES"),
    );
    const adminChannelBlock = notificationSource.slice(
      notificationSource.indexOf("const ADMIN_CHANNELS"),
      notificationSource.indexOf("const DEFAULT_WHATSAPP_TEMPLATE"),
    );

    expect(customerChannelBlock).toContain('key: "email"');
    expect(customerChannelBlock).toContain('key: "sms"');
    expect(customerChannelBlock).toContain('key: "whatsapp"');
    expect(customerChannelBlock).not.toContain('key: "push"');
    expect(adminChannelBlock).toContain('key: "push"');
    expect(notificationSource).toContain("SMS notifications are locked until an active SMS provider is ready.");
    expect(notificationSource).toContain("smsProviderConfigured");
    expect(notificationSource).toContain("buildCustomerChannelConfig");
    expect(notificationSource).toContain("sanitizeCustomerChannelConfig");
    expect(notificationSource).toContain('channelCanBeEnabled(ch.key, readiness)');
    expect(notificationSource).toContain('if (channel === "email") return readiness.email;');
    expect(notificationSource).toContain('if (channel === "sms") return readiness.sms;');
    expect(notificationSource).toContain('if (channel === "whatsapp") return readiness.whatsapp;');
    expect(notificationSource).toContain("Admin push notifications are locked until Firebase service account credentials are ready.");
    expect(notificationSource).toContain("pushConfigured");
    expect(notificationSource).toContain('ch.key === "push" && !isPushConfigured');
    expect(notificationSource).toContain("setChannels(effectiveChannels)");
    expect(notificationSource).toContain("const statusChannels = effectiveChannels[status.key];");
    expect(notificationSource).not.toContain("!whatsappConfigured");
    expect(notificationSource).not.toContain("pushConfigured && enabledChannels.includes");
  });

  it("keeps the deferred rich-text editor client render flicker-free", () => {
    const tiptapSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "ui", "tiptap", "TiptapEditor.tsx"),
      "utf8",
    );
    const deferredSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "ui", "tiptap", "DeferredTiptapEditor.tsx"),
      "utf8",
    );

    expect(tiptapSource).toContain("immediatelyRender: false,");
    expect(tiptapSource).toContain('editorInstance.commands.focus("end", { scrollIntoView: false })');
    expect(deferredSource).toContain("loadAndMountEditor(false);");
    expect(deferredSource).toContain("onPointerDown={() => loadAndMountEditor(true)}");
    expect(deferredSource).toContain("setShouldMountEditor(true)");
    expect(deferredSource).not.toContain("void loadTiptapEditorModule();");
    expect(deferredSource).not.toContain("requestIdleCallback");
    expect(deferredSource).not.toContain("IntersectionObserver");
    expect(deferredSource).toContain("min-h-[237px]");
    expect(deferredSource).toContain("h-[200px]");
  });

  it("keeps admin route guards off the full Better Auth runtime", () => {
    const authFunctionsSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "auth.fns.ts"),
      "utf8",
    );
    const directSessionSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "admin-session.server.ts"),
      "utf8",
    );
    const rbacServerSource = readFileSync(
      join(ADMIN_SRC_ROOT, "middleware", "rbac.server.ts"),
      "utf8",
    );

    expect(authFunctionsSource).toContain("./admin-session.server");
    expect(authFunctionsSource).not.toContain("~/lib/auth.server");
    expect(authFunctionsSource).not.toContain("getAuthSession");
    expect(directSessionSource).not.toMatch(/from\s+["']better-auth/);
    expect(directSessionSource).not.toMatch(/from\s+["']@better-auth/);
    expect(directSessionSource).not.toContain("@scalius/database");
    expect(directSessionSource).not.toContain("@scalius/core/auth");
    expect(rbacServerSource).not.toMatch(/import\s+[^;]*from\s+["']@scalius\/database\/client["']/);
    expect(rbacServerSource).not.toMatch(/import\s+[^;]*from\s+["']@scalius\/core\/auth\/rbac/);
    expect(rbacServerSource.indexOf("knownIsSuperAdmin === true")).toBeLessThan(
      rbacServerSource.indexOf('import("cloudflare:workers")'),
    );
  });

  it("keeps scanner-token routing off the broad core auth barrel", () => {
    const scannerTokenRouteSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "api", "scanner-token.tsx"),
      "utf8",
    );

    expect(scannerTokenRouteSource).toContain(
      "@scalius/core/auth/scanner-token-claims",
    );
    expect(scannerTokenRouteSource).not.toMatch(
      /from\s+["']@scalius\/core\/auth["']/,
    );
  });

  it("keeps admin shell auth/toast actions behind lazy client boundaries", () => {
    const adminRouteSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin.tsx"),
      "utf8",
    );
    const adminHeaderSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "layout", "AdminHeader.tsx"),
      "utf8",
    );
    const userMenuSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "auth", "UserMenu.tsx"),
      "utf8",
    );
    const deferredToasterSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "ui", "deferred-toaster.tsx"),
      "utf8",
    );
    const sidebarSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "ui", "sidebar.tsx"),
      "utf8",
    );
    const sidebarMobileSheetSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "ui", "sidebar-mobile-sheet.tsx"),
      "utf8",
    );

    expect(adminRouteSource).toContain("@/components/ui/deferred-toaster");
    expect(adminRouteSource).not.toContain("@/components/ui/sonner");
    expect(adminHeaderSource).toContain('import("@/components/auth/UserMenu")');
    expect(adminHeaderSource).toContain("function DeferredUserMenu");
    expect(adminHeaderSource).not.toMatch(
      /import\s+\{\s*UserMenu\s*\}\s+from/,
    );
    expect(adminHeaderSource).not.toContain("@/components/ui/dropdown-menu");
    expect(adminHeaderSource).not.toContain("@/components/ui/avatar");
    expect(userMenuSource).not.toMatch(/import\s+\{\s*authClient\s*\}/);
    expect(userMenuSource).toContain('await import("@/lib/auth-client")');
    expect(deferredToasterSource).toContain("lazy(() =>");
    expect(deferredToasterSource).toContain('import("./sonner")');
    expect(sidebarSource).toContain('import("./sidebar-mobile-sheet")');
    expect(sidebarSource).not.toContain("@/components/ui/sheet");
    expect(sidebarMobileSheetSource).toContain("@/components/ui/sheet");
  });

  it("keeps cmdk command UI out of the admin shell and hot list route graph", () => {
    const commandSourcePath = join(
      ADMIN_SRC_ROOT,
      "components",
      "ui",
      "command.tsx",
    );
    const commandSource = readFileSync(commandSourcePath, "utf8");
    const hotEntryPaths = [
      "routes/admin.tsx",
      "routes/admin/index.tsx",
      "routes/admin/abandoned-checkouts.tsx",
      "routes/admin/analytics/index.tsx",
      "routes/admin/attributes.tsx",
      "routes/admin/categories/index.tsx",
      "routes/admin/collections/index.tsx",
      "routes/admin/collections/trash.tsx",
      "routes/admin/customers/index.tsx",
      "routes/admin/discounts/index.tsx",
      "routes/admin/inventory/index.tsx",
      "routes/admin/orders/index.tsx",
      "routes/admin/pages/index.tsx",
      "routes/admin/pages/trash.tsx",
      "routes/admin/products/index.tsx",
    ];

    const eagerCommandPaths = hotEntryPaths
      .map((entry) =>
        findStaticImportPathToTarget(join(ADMIN_SRC_ROOT, entry), commandSourcePath),
      )
      .filter((path): path is string[] => path !== null);

    expect(commandSource).toContain('from "cmdk"');
    expect(eagerCommandPaths).toEqual([]);
  });

  it("refreshes SEO live-proof and feed diagnostics after SEO settings save", () => {
    const seoSettingsSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "SeoSettingsBuilder.tsx"),
      "utf8",
    );
    const settingsFormSource = readFileSync(
      join(ADMIN_SRC_ROOT, "hooks", "use-settings-form.ts"),
      "utf8",
    );

    expect(settingsFormSource).toContain("invalidateQueryKeys?:");
    expect(seoSettingsSource).toContain("invalidateQueryKeys:");
    expect(seoSettingsSource).toContain("queryKeys.settings.seoDiscoveryLiveProbe()");
    expect(seoSettingsSource).toContain("queryKeys.settings.seoFeedDiagnostics()");
  });

  it("keeps admin shell nav data local while page access uses core RBAC source", () => {
    const adminNavSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "layout", "AdminNav.ts"),
      "utf8",
    );
    const adminAccessSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "admin-access.ts"),
      "utf8",
    );
    const adminPermissionsSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "admin-permissions.ts"),
      "utf8",
    );
    const corePermissionValues = new Set(Object.values(PERMISSIONS));
    const localPermissionValues = new Set(Object.values(ADMIN_PERMISSIONS));
    const adminAccessRbacImports = [
      ...adminAccessSource.matchAll(/@scalius\/core\/auth\/rbac\/([^"']+)/g),
    ].map((match) => match[1]);

    expect(adminNavSource).not.toContain("@scalius/core/auth/rbac/permissions");
    expect(adminAccessRbacImports).toEqual(["page-permissions"]);
    expect(adminAccessSource).not.toContain("PAGE_PERMISSION_MAP");
    expect(adminAccessSource).not.toContain("DYNAMIC_PAGE_PERMISSIONS");
    expect(adminAccessSource).not.toContain("DEFAULT_ADMIN_PAGE_CANDIDATES");
    expect(adminPermissionsSource).not.toContain("@scalius/core/auth/rbac");
    expect(Object.values(ADMIN_PERMISSIONS).length).toBeGreaterThan(0);
    expect(
      Object.values(ADMIN_PERMISSIONS).every((permission) =>
        corePermissionValues.has(permission),
      ),
    ).toBe(true);
    expect(Object.values(NAV_PERMISSIONS).length).toBeGreaterThan(0);
    expect(
      Object.values(NAV_PERMISSIONS).every((permission) =>
        localPermissionValues.has(permission),
      ),
    ).toBe(true);
  });

  it("keeps the global cache invalidation action behind cache manage permission", () => {
    const adminHeaderSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "layout", "AdminHeader.tsx"),
      "utf8",
    );
    const cacheNukeButtonSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "CacheNukeButton.tsx"),
      "utf8",
    );

    expect(ADMIN_PERMISSIONS.SETTINGS_CACHE_MANAGE).toBe(
      PERMISSIONS.SETTINGS_CACHE_MANAGE,
    );
    expect(adminHeaderSource).toContain("useHasPermission");
    expect(adminHeaderSource).toContain("ADMIN_PERMISSIONS.SETTINGS_CACHE_MANAGE");
    expect(adminHeaderSource).toContain("canManageCache ? (");
    expect(cacheNukeButtonSource).toContain(
      "Invalidate API cache and purge storefront edge cache",
    );
    expect(cacheNukeButtonSource).not.toContain("Clear all cache");
  });

  it("keeps customer form writes invalidating dashboard aggregates", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "CustomerForm.tsx"),
      "utf8",
    );

    expect(source).toContain("queryKeys.customers.list()");
    expect(source).toContain("queryKeys.dashboard.all");
  });

  it("keeps the dashboard chart off Recharts and the shared chart wrapper", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "DashboardChart.tsx"),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["']recharts["']/);
    expect(source).not.toContain("@/components/ui/chart");
    expect(
      existsSync(join(ADMIN_SRC_ROOT, "components", "ui", "chart.tsx")),
    ).toBe(false);
  });

  it("keeps analytics list dates hydration-safe", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "AnalyticsList.tsx"),
      "utf8",
    );

    expect(source).toMatch(/suppressHydrationWarning[^]*formatDate\(script\.updatedAt\)/);
  });

  it("keeps analytics list mutations gated by exact RBAC permissions", () => {
    const listSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "AnalyticsList.tsx"),
      "utf8",
    );
    const indexSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "analytics", "index.tsx"),
      "utf8",
    );
    const permissionsSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "admin-permissions.ts"),
      "utf8",
    );

    expect(permissionsSource).toContain('ANALYTICS_TOGGLE: "analytics.toggle"');
    expect(listSource).toContain("usePermissions");
    expect(indexSource).toContain("ADMIN_PERMISSIONS.ANALYTICS_CREATE");
    expect(listSource).toContain("ADMIN_PERMISSIONS.ANALYTICS_EDIT");
    expect(listSource).toContain("ADMIN_PERMISSIONS.ANALYTICS_TOGGLE");
    expect(indexSource).toContain("canCreate ? (");
    expect(listSource).toContain("canToggle");
    expect(listSource).toContain("canEdit");
    expect(listSource).toContain("aria-label={`Edit ${script.name}`}");
    expect(listSource).toContain("aria-label={`Move ${script.name} to trash`}");
  });

  it("keeps create forms draft-first and lifecycle controls permission-gated", () => {
    const analyticsForm = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "AnalyticsForm.tsx"),
      "utf8",
    );
    const pageForm = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "PageForm.tsx"),
      "utf8",
    );
    const discountForm = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "discount",
        "DiscountCodeBuilder.tsx",
      ),
      "utf8",
    );
    const discountModel = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "discount",
        "discount-editor-model.ts",
      ),
      "utf8",
    );
    const permissionsSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "admin-permissions.ts"),
      "utf8",
    );

    expect(analyticsForm).toContain("isActive: false");
    expect(analyticsForm).toContain("PERMISSIONS.ANALYTICS_TOGGLE");
    expect(analyticsForm).toContain("disabled={!canToggle}");
    expect(pageForm).toContain('publicationMode: "draft"');
    expect(pageForm).toContain("PERMISSIONS.PAGES_PUBLISH");
    expect(pageForm).toContain("disabled={!canPublish}");
    expect(discountModel).toContain("isActive: Boolean(defaults.isActive)");
    expect(discountForm).toContain("disabled={!canToggleStatus}");
    expect(permissionsSource).toContain(
      'DISCOUNTS_TOGGLE_STATUS: "discounts.toggle_status"',
    );
  });

  it("keeps the hot login route off the generic Better Auth UI chunk", () => {
    const loginRouteSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "auth", "login.tsx"),
      "utf8",
    );
    const resetPasswordRouteSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "auth", "reset-password.tsx"),
      "utf8",
    );
    const globalCssSource = readFileSync(
      join(ADMIN_SRC_ROOT, "styles", "global.css"),
      "utf8",
    );
    const authClientSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "auth-client.ts"),
      "utf8",
    );

    expect(loginRouteSource).toContain("LoginForm");
    expect(loginRouteSource).not.toContain("AuthCard");
    expect(loginRouteSource).not.toContain("@daveyplate/better-auth-ui");
    expect(resetPasswordRouteSource).toContain("ResetPasswordForm");
    expect(resetPasswordRouteSource).not.toContain("AuthCard");
    expect(resetPasswordRouteSource).not.toContain("@daveyplate/better-auth-ui");
    expect(globalCssSource).not.toContain("@daveyplate/better-auth-ui");
    expect(authClientSource).not.toContain("adminClient");
  });

  it("keeps first-time 2FA setup off eager Better Auth and QR runtimes", () => {
    const setup2faRouteSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "auth", "setup-2fa.tsx"),
      "utf8",
    );
    const twoFactorSetupSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "auth", "TwoFactorSetup.tsx"),
      "utf8",
    );

    expect(setup2faRouteSource).toContain("TwoFactorSetup");
    expect(setup2faRouteSource).not.toContain("auth-client");
    expect(setup2faRouteSource).not.toContain("qrcode");
    expect(twoFactorSetupSource).toContain('await import("@/lib/auth-client")');
    expect(twoFactorSetupSource).not.toMatch(
      /from\s+["'](?:@|~)\/lib\/auth-client["']/,
    );
    expect(twoFactorSetupSource).not.toMatch(/from\s+["']qrcode["']/);
  });

  it("keeps admin QR generators behind token/TOTP interaction boundaries", () => {
    const accountTwoFactorSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "account-settings",
        "TwoFactorSetup.tsx",
      ),
      "utf8",
    );
    const scannerTokenSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "settings",
        "ScannerTokenGenerator.tsx",
      ),
      "utf8",
    );

    for (const source of [accountTwoFactorSource, scannerTokenSource]) {
      expect(source).toContain('import("qrcode")');
      expect(source).toContain("toDataURL");
      expect(source).not.toMatch(/from\s+["']qrcode["']/);
    }
    expect(accountTwoFactorSource).toContain("if (!totpUri)");
    expect(scannerTokenSource).toContain("if (!token)");
  });

  it("keeps post-auth success navigation inside the hydrated router", () => {
    const loginFormSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "auth", "LoginForm.tsx"),
      "utf8",
    );
    const twoFactorFormSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "auth", "TwoFactorForm.tsx"),
      "utf8",
    );
    const setupFormSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "auth", "SetupForm.tsx"),
      "utf8",
    );
    const twoFactorSetupSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "auth", "TwoFactorSetup.tsx"),
      "utf8",
    );
    const authClientSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "auth-client.ts"),
      "utf8",
    );

    for (const source of [
      loginFormSource,
      twoFactorFormSource,
      setupFormSource,
      twoFactorSetupSource,
    ]) {
      expect(source).toContain("useNavigate");
      expect(source).toContain('to: "/admin"');
      expect(source).not.toContain('window.location.href = "/admin"');
    }
    expect(loginFormSource).not.toContain("callbackURL");
    expect(loginFormSource).toContain('navigate({ to: "/admin", replace: true })');
    expect(loginFormSource).toContain(
      'navigate({ to: "/auth/two-factor", replace: true })',
    );
    expect(authClientSource).not.toContain("window.location.href");
    expect(setupFormSource).toContain("storePendingTwoFactorMethods");
    expect(setupFormSource).toContain('navigate({ to: "/auth/two-factor" })');
  });

  it("keeps admin auth credentials out of the URL before hydration", () => {
    const hydratedHookSource = readFileSync(
      join(ADMIN_SRC_ROOT, "hooks", "use-hydrated.ts"),
      "utf8",
    );
    const loginFormSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "auth", "LoginForm.tsx"),
      "utf8",
    );
    const resetPasswordFormSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "auth", "ResetPasswordForm.tsx"),
      "utf8",
    );
    const formSources = [
      {
        path: join(ADMIN_SRC_ROOT, "components", "auth", "LoginForm.tsx"),
        action: 'action="/auth/login"',
      },
      {
        path: join(ADMIN_SRC_ROOT, "routes", "auth", "forgot-password.tsx"),
        action: 'action="/auth/forgot-password"',
      },
      {
        path: join(ADMIN_SRC_ROOT, "components", "auth", "ResetPasswordForm.tsx"),
        action: 'action="/auth/reset-password"',
      },
      {
        path: join(ADMIN_SRC_ROOT, "components", "auth", "TwoFactorForm.tsx"),
        action: 'action="/auth/two-factor"',
      },
      {
        path: join(ADMIN_SRC_ROOT, "components", "auth", "SetupForm.tsx"),
        action: 'action="/auth/setup"',
      },
      {
        path: join(ADMIN_SRC_ROOT, "components", "auth", "TwoFactorSetup.tsx"),
        action: 'action="/auth/setup-2fa"',
      },
      {
        path: join(
          ADMIN_SRC_ROOT,
          "components",
          "admin",
          "account-settings",
          "ChangePasswordForm.tsx",
        ),
        action: 'action="/admin/settings/account"',
      },
      {
        path: join(
          ADMIN_SRC_ROOT,
          "components",
          "admin",
          "account-settings",
          "AdminUsersManager.tsx",
        ),
        action: 'action="/admin/settings/account"',
      },
    ];

    expect(hydratedHookSource).toContain("const [isHydrated, setIsHydrated] = useState(false)");
    expect(hydratedHookSource).toContain("setIsHydrated(true)");
    expect(loginFormSource).toContain('method="post"');
    expect(loginFormSource).toContain('action="/auth/login"');
    expect(loginFormSource).toContain("useHydrated()");
    expect(loginFormSource).toContain("disabled={!isHydrated || isLoading}");
    expect(resetPasswordFormSource).not.toContain('name="password"');
    expect(resetPasswordFormSource).not.toContain('name="confirm-password"');

    for (const { path, action } of formSources) {
      const source = readFileSync(path, "utf8");
      const formTags = extractOpeningFormTags(source);
      const noValidateCount = source.match(/noValidate/g)?.length ?? 0;

      expect(formTags.length).toBeGreaterThan(0);
      expect(noValidateCount).toBe(formTags.length);
      for (const formTag of formTags) {
        expect(formTag).toContain('method="post"');
        expect(formTag).toContain(action);
      }
      expect(source).toContain("useHydrated()");
      expect(source).toContain("!isHydrated ||");
    }
  });

  it("keeps team invites off temporary-password UX", () => {
    const adminUsersSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "account-settings",
        "AdminUsersManager.tsx",
      ),
      "utf8",
    );

    expect(adminUsersSource).toContain("one-use setup link");
    expect(adminUsersSource).toContain("must configure a password and 2FA");
    expect(adminUsersSource).not.toContain("temporary password");
    expect(adminUsersSource).not.toContain("Temporary Password");
  });

  it("keeps admin app forms from relying on implicit browser submit methods", () => {
    const offenders = listSourceFiles(ADMIN_SRC_ROOT)
      .filter((path) => !/\.test\./.test(path))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return extractOpeningFormTags(source)
          .filter((formTag) => !/\bmethod\s*=/.test(formTag))
          .map((formTag) => `${relative(ADMIN_SRC_ROOT, path)}: ${formTag.replace(/\s+/g, " ")}`);
      });

    expect(offenders).toEqual([]);
  });

  it("keeps sensitive admin mutation forms out of native GET submissions", () => {
    const mutationForms = [
      join(ADMIN_SRC_ROOT, "components", "admin", "FraudCheckerSettings.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "OrderForm.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "ProductForm.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "ShipmentForm.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "checkout-languages", "LanguageFormDialog.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "collection-form", "CollectionFormContainer.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "delivery-locations", "LocationFormDialog.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "meta-conversions", "MetaConversionsSettingsForm.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "orderview", "ManualFulfillmentDialog.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "scanner", "BarcodeScanner.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "settings", "PaymentGatewaysManager.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "settings", "PolarSettingsForm.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "shared", "FormContainer.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "shipping-methods", "MethodFormDialog.tsx"),
    ];

    for (const path of mutationForms) {
      const source = readFileSync(path, "utf8");
      const formTags = extractOpeningFormTags(source);

      expect(formTags.length).toBeGreaterThan(0);
      for (const formTag of formTags) {
        expect(formTag).toContain('method="post"');
        expect(formTag).toContain("noValidate");
      }
    }
  });

  it("keeps payment gateway visibility saves locked behind loaded settings", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "settings", "PaymentGatewaysManager.tsx"),
      "utf8",
    );

    expect(source).toContain("const [methodsLoadError, setMethodsLoadError]");
    expect(source).toContain("if (!methods) {");
    expect(source).toContain("Reload payment status before saving buyer payment methods.");
    expect(source).toContain("Payment settings could not be loaded");
    expect(source).toContain("Checkout visibility is locked until the saved payment-method settings load successfully.");
    expect(source).toContain("setMethods(null)");
  });

  it("keeps checkout flow saves locked behind payment readiness", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "settings", "CheckoutFlowSettings.tsx"),
      "utf8",
    );

    expect(source).toContain("isFetching: paymentMethodsFetching");
    expect(source).toContain("const paymentMethodsUnavailable = !paymentMethods && paymentMethodsError");
    expect(source).toContain("Payment method readiness could not be checked. Reload payment settings before saving checkout flow changes.");
    expect(source).toContain("Checkout-flow saves are locked until Payment Gateways loads successfully.");
    expect(source).toContain("Retry payment check");
    expect(source).toContain("disabled={saving || saveBlocked}");
  });

  it("keeps new-discount type selection off the decorative animation runtime", () => {
    const selectorSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "discount",
        "DiscountTypeSelector.tsx",
      ),
      "utf8",
    );
    const newRouteSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "discounts", "new.tsx"),
      "utf8",
    );
    const combinedSource = `${selectorSource}\n${newRouteSource}`;
    const forbiddenMarkers = [
      ["motion", "react"].join("/"),
      ["while", "Hover"].join(""),
      ["while", "Tap"].join(""),
    ];

    expect(newRouteSource).toContain("<DiscountTypeSelector onSelect={setSelectedType} />");
    expect(newRouteSource).toContain("const DiscountCodeBuilder = lazy(");
    for (const marker of forbiddenMarkers) {
      expect(combinedSource).not.toContain(marker);
    }
  });

  it("keeps admin discount form values out of native GET submissions", () => {
    const discountForms = [
      join(ADMIN_SRC_ROOT, "components", "admin", "discount", "DiscountCodeBuilder.tsx"),
    ];

    for (const path of discountForms) {
      const source = readFileSync(path, "utf8");
      const formTags = extractOpeningFormTags(source);
      const noValidateCount = source.match(/noValidate/g)?.length ?? 0;

      expect(source).toMatch(/name="(?:code|discountValue|isActive)"/);
      expect(formTags.length).toBeGreaterThan(0);
      expect(noValidateCount).toBe(formTags.length);
      for (const formTag of formTags) {
        expect(formTag).toContain('method="post"');
        expect(formTag).toContain('action="/admin/discounts"');
      }
    }
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
    const adminHeaderSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "layout", "AdminHeader.tsx"),
      "utf8",
    );
    const appSidebarSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "layout", "AppSidebar.tsx"),
      "utf8",
    );
    const storefrontFooterLinkSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "layout",
        "StorefrontFooterLink.tsx",
      ),
      "utf8",
    );
    const settingsQueryOptionsSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "api-query-options", "settings.ts"),
      "utf8",
    );
    const adminRouteSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin.tsx"),
      "utf8",
    );
    const adminScrollSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "admin-scroll-restoration.ts"),
      "utf8",
    );
    const adminRouteContextSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "admin-route-context.ts"),
      "utf8",
    );

    expect(routerSource).toContain("createAdminQueryClient()");
    expect(routerSource).toContain("defaultPreload: false");
    expect(routerSource).not.toContain('defaultPreload: "intent"');
    expect(queryClientSource).toContain("refetchOnWindowFocus: false");
    expect(queryClientSource).toContain("refetchOnReconnect: false");
    expect(queryClientSource).toContain("retry: ADMIN_QUERY_RETRY");
    expect(queryClientSource).toContain("ADMIN_QUERY_RETRY = false");
    expect(cacheQuerySource.match(/refetchOnReconnect: true/g)?.length).toBe(4);
    expect(orderDetailSource).toContain("refetchInterval: 30_000");
    expect(orderDetailSource).not.toContain("refetchOnWindowFocus: true");
    expect(orderDetailSource).not.toContain("refetchOnReconnect: true");
    expect(orderListSource).toContain('document.addEventListener("visibilitychange"');
    expect(orderListSource).toContain("isDocumentHidden()");
    expect(orderListSource).toContain("activeOrderListRefreshRef");
    expect(orderListSource).toContain("orderListRefreshInFlightRef");
    expect(orderListSource).toContain("ORDER_AUTO_REFRESH_DEBOUNCE_MS");
    expect(orderListSource).not.toContain("refreshIntervalRef");
    expect(adminHeaderSource).toContain("requestIdleCallback");
    expect(adminHeaderSource).toContain("lazy(()");
    expect(adminHeaderSource).not.toMatch(
      /import\s+\{\s*CacheNukeButton\s*\}\s+from/,
    );
    expect(adminHeaderSource).not.toMatch(
      /import\s+\{\s*NotificationDropdown\s*\}\s+from/,
    );
    expect(appSidebarSource).toContain('import("./StorefrontFooterLink")');
    expect(appSidebarSource).not.toContain(
      "~/lib/api-query-options/storefront-url",
    );
    expect(storefrontFooterLinkSource).toContain(
      "~/lib/api-query-options/storefront-url",
    );
    expect(appSidebarSource).not.toContain(
      "~/lib/api-query-options/settings",
    );
    expect(settingsQueryOptionsSource).not.toContain("getStorefrontUrl");
    expect(routerSource).toContain("scrollRestoration: true");
    expect(routerSource).toContain("scrollToTopSelectors: [\"#admin-main-scroll\"]");
    expect(routerSource).toContain("scrollRestorationBehavior: \"instant\"");
    expect(adminRouteSource).toContain('data-scroll-restoration-id="admin-main-scroll"');
    expect(adminRouteSource).toContain("useAdminNestedScrollRestoration()");
    expect(adminScrollSource).toContain('window.addEventListener("popstate"');
    expect(adminScrollSource).toContain("schedulePopRestore(event.toLocation.href)");
    expect(adminScrollSource).not.toContain("scrollElement.scrollTop = 0");
    expect(adminRouteContextSource).toContain("ADMIN_ROUTE_CONTEXT_FRESH_MS");
    expect(adminRouteContextSource).toContain("ADMIN_ROUTE_CONTEXT_STALE_MS");
    expect(adminRouteContextSource).toContain("refreshAdminRouteContextInBackground");
  });

  it("keeps product list route first paint independent from secondary stats", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "products", "index.tsx"),
      "utf8",
    );
    const loaderSource = source.slice(
      source.indexOf("loader: async"),
      source.indexOf("head: ({ match })"),
    );

    expect(loaderSource).toContain(
      "await warmRouteQuery(queryClient, productsQueryOptions(mapParams(deps)))",
    );
    expect(loaderSource).toContain('typeof window !== "undefined"');
    expect(loaderSource).toContain(
      "void queryClient.prefetchQuery(categoryFormOptionsQueryOptions())",
    );
    expect(loaderSource).toContain(
      "void queryClient.prefetchQuery(productStatsQueryOptions())",
    );
    expect(loaderSource).not.toContain(
      "queryClient.ensureQueryData(categoryFormOptionsQueryOptions())",
    );
    expect(loaderSource).not.toContain(
      "queryClient.ensureQueryData(productStatsQueryOptions())",
    );
  });

  it("keeps list delete confirmations behind lazy interaction boundaries", () => {
    const cases = [
      {
        route: "products",
        component: "ProductDeleteDialog",
        file: "-ProductDeleteDialog.tsx",
        openMarker: "isProductDeleteDialogOpen &&",
      },
      {
        route: "categories",
        component: "CategoryDeleteDialog",
        file: "-CategoryDeleteDialog.tsx",
        openMarker: "isCategoryDeleteDialogOpen &&",
      },
      {
        route: "customers",
        component: "CustomerDeleteDialog",
        file: "-CustomerDeleteDialog.tsx",
        openMarker: "isCustomerDeleteDialogOpen &&",
      },
      {
        route: "pages",
        component: "PageDeleteDialog",
        file: "-PageDeleteDialog.tsx",
        openMarker: "isPageDeleteDialogOpen &&",
      },
    ];

    for (const { route, component, file, openMarker } of cases) {
      const routeSource = readFileSync(
        join(ADMIN_SRC_ROOT, "routes", "admin", route, "index.tsx"),
        "utf8",
      );
      const dialogSource = readFileSync(
        join(ADMIN_SRC_ROOT, "routes", "admin", route, file),
        "utf8",
      );

      expect(routeSource).toContain(`const ${component} = lazy(()`);
      expect(routeSource).toContain(`import("./${file.replace(/\.tsx$/, "")}")`);
      expect(routeSource).toContain(openMarker);
      expect(routeSource).not.toContain("~/components/ui/alert-dialog");
      expect(routeSource).not.toContain("AlertDialogContent");
      expect(dialogSource).toContain("~/components/ui/alert-dialog");
      expect(dialogSource).toContain(component);
    }
  });

  it("keeps dashboard route entry from blocking on summary data", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "index.tsx"),
      "utf8",
    );
    const currencyHookSource = readFileSync(
      join(ADMIN_SRC_ROOT, "hooks", "use-currency.ts"),
      "utf8",
    );
    const currencyQueryOptionsSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "api-query-options", "currency.ts"),
      "utf8",
    );
    const dashboardHomeQueryOptionsSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "api-query-options", "dashboard-home.ts"),
      "utf8",
    );
    const dashboardStatsSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "DashboardStats.tsx"),
      "utf8",
    );
    const loaderSource = source.slice(
      source.indexOf("loader: async"),
      source.indexOf("head: ()"),
    );

    expect(source).toContain('from "~/lib/api-query-options/dashboard-home"');
    expect(source).not.toContain('from "~/lib/api-query-options/dashboard"');
    expect(source).not.toMatch(
      /import\s+\{\s*DashboardStats\s*\}\s+from\s+["']~\/components\/admin\/DashboardStats["']/,
    );
    expect(source).not.toMatch(
      /import\s+\{\s*RecentOrders\s*\}\s+from\s+["']~\/components\/admin\/RecentOrders["']/,
    );
    expect(source).not.toMatch(
      /import\s+\{\s*WelcomeBanner\s*\}\s+from\s+["']~\/components\/admin\/WelcomeBanner["']/,
    );
    expect(source).toContain("const DashboardStats = lazy(()");
    expect(source).toContain("const RecentOrders = lazy(()");
    expect(source).toContain("const WelcomeBanner = lazy(()");
    expect(source).toContain("fallback={<WelcomeBannerLoading />}");
    expect(loaderSource).toContain('typeof window === "undefined"');
    expect(loaderSource).toContain(
      "void queryClient.prefetchQuery(dashboardSummaryQueryOptions())",
    );
    expect(loaderSource).not.toContain("dashboardActivityQueryOptions()");
    expect(loaderSource).not.toContain(
      "await queryClient.ensureQueryData(dashboardSummaryQueryOptions())",
    );
    expect(loaderSource).not.toContain("await warmRouteQuery");
    expect(source).toContain("isSummaryInitialLoading");
    expect(source).toContain("DashboardSummaryLoading");
    expect(source).toContain("useDashboardActivityEnabled");
    expect(source).toContain("enabled: shouldFetchActivity");
    expect(source).toContain("requestIdleCallback");
    expect(dashboardStatsSource).not.toContain("requestIdleCallback");
    expect(dashboardStatsSource).not.toContain("setShouldLoadChart");
    expect(currencyHookSource).toContain(
      "~/lib/api-query-options/currency",
    );
    expect(currencyHookSource).not.toContain(
      "~/lib/api-query-options/settings",
    );
    expect(currencyQueryOptionsSource).toContain(
      "../api-functions/currency",
    );
    expect(currencyQueryOptionsSource).not.toContain("getPaymentMethods");
    expect(currencyQueryOptionsSource).not.toContain("getMetaConversionsLogs");
    expect(currencyQueryOptionsSource).not.toContain("getAuthSettings");
    expect(dashboardHomeQueryOptionsSource).toContain(
      "../api-functions/dashboard-home",
    );
    expect(dashboardHomeQueryOptionsSource).not.toContain("getDashboardData");
  });

  it("keeps secondary admin tool routes from blocking first paint on data reads", () => {
    const cacheSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "settings", "cache.tsx"),
      "utf8",
    );
    const inventorySource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "inventory", "index.tsx"),
      "utf8",
    );

    for (const source of [cacheSource, inventorySource]) {
      const loaderSource = source.slice(
        source.indexOf("loader:"),
        source.indexOf("head:"),
      );
      expect(loaderSource).toContain('typeof window === "undefined"');
      expect(loaderSource).toContain("void queryClient.prefetchQuery(");
      expect(loaderSource).not.toContain("await queryClient.ensureQueryData(");
      expect(loaderSource).not.toContain("await Promise.all(");
    }
  });

  it("keeps self-loading settings routes out of route-entry data awaits", () => {
    const selfLoadingSettingsRoutes = [
      ["notifications.tsx", "FirebaseSettingsForm"],
      ["theme.tsx", "ThemeSettingsPage"],
      ["hero-sliders.tsx", "HeroSliderManager"],
    ] as const;

    for (const [filename, marker] of selfLoadingSettingsRoutes) {
      const source = readFileSync(
        join(ADMIN_SRC_ROOT, "routes", "admin", "settings", filename),
        "utf8",
      );

      expect(source).toContain(marker);
      expect(source).not.toContain("ensureQueryData(");
      expect(source).not.toContain("prefetchQuery(");
    }
  });

  it("keeps hero-slider drag-and-drop behind an explicit lazy boundary", () => {
    const containerSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "hero-slider",
        "HeroSliderContainer.tsx",
      ),
      "utf8",
    );
    const sliderTabSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "hero-slider",
        "SliderTab.tsx",
      ),
      "utf8",
    );
    const sortableEditorSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "hero-slider",
        "SortableSlidesEditor.tsx",
      ),
      "utf8",
    );
    const lazyMediaManagerSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "media-manager",
        "LazyMediaManager.tsx",
      ),
      "utf8",
    );
    const mediaManagerBarrelSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "media-manager",
        "index.ts",
      ),
      "utf8",
    );

    expect(containerSource).toContain('import("./SliderTab")');
    expect(containerSource).not.toMatch(/import\s+\{\s*SliderTab\s*\}/);
    expect(sliderTabSource).toContain('import("./SortableSlidesEditor")');
    expect(sliderTabSource).not.toContain("@dnd-kit/");
    expect(sliderTabSource).not.toContain("createPortal");
    expect(sliderTabSource).not.toMatch(/from\s+["']\.\/SortableSlide["']/);
    expect(sliderTabSource).not.toMatch(/from\s+["']\.\/SlideOverlay["']/);
    expect(sliderTabSource).not.toContain("./MediaManager");
    expect(sliderTabSource).not.toContain("~/components/ui/dialog");
    expect(sliderTabSource).not.toContain("~/components/ui/alert-dialog");
    expect(sortableEditorSource).toContain("@dnd-kit/core");
    expect(sortableEditorSource).toContain("@dnd-kit/sortable");
    expect(sortableEditorSource).toContain("createPortal");
    expect(sortableEditorSource).toContain("./SortableSlide");
    expect(sortableEditorSource).toContain("./SlideOverlay");
    expect(lazyMediaManagerSource).toContain('import("./MediaManager")');
    expect(mediaManagerBarrelSource).toContain("./LazyMediaManager");
    expect(mediaManagerBarrelSource).not.toContain("./MediaManagerPage");
  });

  it("keeps abandoned checkouts route entry independent from its self-loading list", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "abandoned-checkouts.tsx"),
      "utf8",
    );

    expect(source).toContain("AbandonedCheckoutsManager");
    expect(source).not.toContain("abandonedCheckoutsQueryOptions");
    expect(source).not.toContain("ensureQueryData(");
    expect(source).not.toContain("prefetchQuery(");
  });

  it("keeps new-order creation independent from catalog size", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "orders", "new.tsx"),
      "utf8",
    );
    const loaderSource = source.slice(
      source.indexOf("loader: async"),
      source.indexOf("head: ()"),
    );

    expect(loaderSource).not.toContain("productsQueryOptions(");
    expect(loaderSource).toContain("buildNewOrderFormRouteData()");
    expect(loaderSource).toContain("deliveryLocationsQueryOptions");
    expect(source).not.toContain("productQueryOptions(");
    expect(loaderSource).not.toContain("Promise.all(");
    expect(loaderSource).not.toContain("for (let");
  });

  it("keeps product edit first paint from eagerly importing variant management", () => {
    const source = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "routes",
        "admin",
        "products",
        "$productId",
        "edit.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("const OptionMatrixEditor = lazy(");
    expect(source).toContain(
      'import("~/components/admin/product-form/variants/OptionMatrixEditor")',
    );
    expect(source).toContain('<LoadingFallback height="h-48" />');
    expect(source).not.toMatch(
      /import\s+\{\s*OptionMatrixEditor\s*\}\s+from\s+["']~\/components\/admin\/product-form\/variants/,
    );
  });

  it("keeps the primary product description on the deferred editor boundary", () => {
    const source = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "product-form",
        "TitleDescriptionSection.tsx",
      ),
      "utf8",
    );

    expect(source).toContain(
      'import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor"',
    );
    expect(source).toContain("<DeferredTiptapEditor");
    expect(source).toContain('placeholder="Describe your product..."');
    expect(source).not.toContain('from "@/components/ui/tiptap/TiptapEditor"');
    expect(source).not.toContain("<TiptapEditor");
    expect(source).not.toContain('import("@/components/ui/tiptap/TiptapEditor")');
    expect(source).not.toContain('fallback={<LoadingFallback height="h-[237px]" />}');
    expect(source).not.toContain("<RichContent");
    expect(source).not.toContain("../rich-content");
    expect(source).not.toContain("TiptapToolbarSkeleton");
  });

  it("keeps edit forms from blocking on secondary label hydration", () => {
    const discountSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "routes",
        "admin",
        "discounts",
        "$discountId",
        "edit.tsx",
      ),
      "utf8",
    );
    const collectionSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "routes",
        "admin",
        "collections",
        "$collectionId",
        "edit.tsx",
      ),
      "utf8",
    );
    const discountLoaderSource = discountSource.slice(
      discountSource.indexOf("loader: async"),
      discountSource.indexOf("head: ({ match })"),
    );
    const collectionLoaderSource = collectionSource.slice(
      collectionSource.indexOf("loader: async"),
      collectionSource.indexOf("head: ()"),
    );

    expect(discountLoaderSource).not.toContain(
      "ensureQueryData(productsByIdsQueryOptions",
    );
    expect(discountLoaderSource).not.toContain(
      "ensureQueryData(collectionsByIdsQueryOptions",
    );
    expect(collectionLoaderSource).not.toContain(
      "ensureQueryData(productsByIdsQueryOptions",
    );
    expect(discountSource).not.toContain(
      "useSuspenseQuery(productsByIdsQueryOptions",
    );
    expect(discountSource).not.toContain(
      "useSuspenseQuery(collectionsByIdsQueryOptions",
    );
    expect(collectionSource).not.toContain(
      "useSuspenseQuery(productsByIdsQueryOptions",
    );
    expect(discountSource).toContain("Discount product label prefetch skipped");
    expect(discountSource).toContain("Discount collection label prefetch skipped");
    expect(collectionSource).toContain("Collection product label prefetch skipped");
  });

  it("keeps deferred rich-text editing lazy without a manual edit gate", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "ui", "tiptap", "DeferredTiptapEditor.tsx"),
      "utf8",
    );

    expect(source).toContain("import { RichContent } from \"../rich-content\"");
    expect(source).toContain("import { TiptapToolbarSkeleton } from \"./TiptapToolbarSkeleton\"");
    expect(source).toContain("<RichContent content={content} variant=\"compact\" />");
    expect(source).toContain("<TiptapToolbarSkeleton compact={compact} />");
    expect(source).toContain("const TiptapEditor = lazy(");
    expect(source).toContain("loadTiptapEditorModule");
    expect(source).toContain("loadAndMountEditor(false);");
    expect(source).toContain("setShouldMountEditor(true)");
    expect(source).toContain("function getDeferredEditorViewportClass");
    expect(source).toContain("compact ? \"h-[200px]\" : \"h-[300px]\"");
    expect(source).toContain("mountRequestedRef");
    expect(source).not.toContain("IntersectionObserver");
    expect(source).not.toContain("requestIdleCallback");
    expect(source).not.toContain("from \"./TiptapEditor\"");
    expect(source).not.toContain("toPlainTextPreview");
    expect(source).not.toContain("PencilLine");
    expect(source).not.toContain("editLabel");
    expect(source).not.toContain("setIsEditing");

    const editorSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "ui", "tiptap", "TiptapEditor.tsx"),
      "utf8",
    );
    expect(editorSource).toContain("const editorViewportHeight = compact ? \"200px\" : \"300px\"");
    expect(editorSource).toContain("style={!isFullscreen ? { minHeight: editorViewportHeight, maxHeight: editorViewportHeight } : undefined}");
    expect(editorSource).toContain("import { TiptapToolbarSkeleton } from \"./TiptapToolbarSkeleton\"");
    expect(editorSource).toContain("<TiptapToolbarSkeleton");
    expect(editorSource).toContain("import { sanitizeHtml } from \"@scalius/shared/html-sanitize\"");
    expect(editorSource).toContain("sanitizeHtml(content)");
    expect(editorSource).toContain('className="ProseMirror max-w-none p-4 min-h-[200px] text-sm"');
    expect(editorSource).not.toContain("<RichContent");
    expect(editorSource).not.toContain("from \"../rich-content\"");
    expect(editorSource).not.toContain("setIsMounted");
    expect(editorSource).not.toContain("if (!isMounted)");

    const skeletonSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "ui", "tiptap", "TiptapToolbarSkeleton.tsx"),
      "utf8",
    );
    expect(skeletonSource).toContain("TOOLBAR_GROUPS");
    expect(skeletonSource).toContain("lucide-react");
    expect(skeletonSource).toContain("Maximize");
    expect(skeletonSource).not.toContain("primaryWidth");
    expect(skeletonSource).not.toContain("secondaryWidth");
    expect(skeletonSource).not.toContain("animate-pulse");

    const toolbarButtonSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "ui", "tiptap", "ToolbarButton.tsx"),
      "utf8",
    );
    const menuBarSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "ui", "tiptap", "TiptapMenuBar.tsx"),
      "utf8",
    );
    expect(toolbarButtonSource).toContain("aria-label={tooltip}");
    expect(menuBarSource).toContain('aria-label="Insert link"');
    expect(menuBarSource).toContain('aria-label="Insert image URL"');
    expect(menuBarSource).toContain('aria-label="Embed video"');
    expect(menuBarSource).toContain('triggerLabel="Media Library"');
    expect(menuBarSource).toContain("trigger={");
    expect(menuBarSource).toContain('tooltip="Media Library"');
    expect(menuBarSource).not.toContain("document.getElementById");
    expect(menuBarSource).not.toContain("tiptap-media-manager-wrapper");
    expect(menuBarSource).not.toContain('querySelector("button")?.click()');
  });

  it("keeps order payment history failures local to the payment card", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "orderview", "PaymentCard.tsx"),
      "utf8",
    );

    expect(source).toContain("orderPaymentsQueryOptions(order.id)");
    expect(source).toContain("useQuery({");
    expect(source).not.toContain("useSuspenseQuery");
    expect(source).toContain("Payment history unavailable");
    expect(source).toContain("refetchPayments");
    expect(source).toContain("Retry before reviewing");
    expect(source).toContain("paymentWebhookIssues");
    expect(source).toContain("Payment webhook needs review");
    expect(source).toContain("Check the gateway dashboard before changing payment-sensitive order state.");
    expect(source).toContain("paymentSessionAttempts");
    expect(source).toContain("Payment session attempts");
    expect(source).toContain("Preparing checkout");
    expect(source).toContain("Hosted session created");
    expect(source).toContain("Processing lease expired");
    expect(source).toContain("refetchInterval: (query)");
    expect(source).toContain("Internal ref:");
    expect(source).toContain("Provider refund:");
    expect(source).toContain("Refund row:");
  });

  it("normalizes stale hosted-payment archives in incomplete-order UI", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "AbandonedCheckoutsManager.tsx"),
      "utf8",
    );
    const routeSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "abandoned-checkouts.tsx"),
      "utf8",
    );

    expect(source).toContain("parseAbandonedCheckoutDisplay");
    expect(source).toContain("useOrderActionPermissions");
    expect(source).toContain("orderActions.canDeleteOrders");
    expect(source).toContain("orderActions.canBulkDeleteOrders");
    expect(source).toContain("Archived hosted-payment order");
    expect(source).toContain("This was a stale online checkout order");
    expect(source).toContain("View order");
    expect(source).toContain("Delete recovery record");
    expect(source).toContain("The original order record remains in Orders.");
    expect(source).not.toContain("const parseCheckoutData =");

    expect(routeSource).toContain("archived hosted-payment recovery records");
  });

  it("keeps order detail SSR formatting deterministic", () => {
    const orderViewSources = [
      ...listSourceFiles(join(ADMIN_SRC_ROOT, "components", "admin", "orderview")),
      join(ADMIN_SRC_ROOT, "components", "admin", "ShipmentStatusIndicator.tsx"),
      join(ADMIN_SRC_ROOT, "routes", "admin", "orders", "$orderId", "index.tsx"),
    ].map((file) => [relative(ADMIN_SRC_ROOT, file), readFileSync(file, "utf8")] as const);

    for (const [file, source] of orderViewSources) {
      expect(source, file).not.toMatch(/\.toLocale(?:String|DateString|TimeString)\(/);
      expect(source, file).not.toContain("new Date().toISOString()");
      expect(source, file).not.toContain("suppressHydrationWarning");
    }

    const formatterSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "admin-time.ts"),
      "utf8",
    );
    expect(formatterSource).toContain('export const ADMIN_TIME_ZONE = "Asia/Dhaka"');
    expect(formatterSource).toContain('new Intl.DateTimeFormat("en-US"');
  });

  it("keeps order detail optional panels hydration-gated", () => {
    const routeSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "orders", "$orderId", "index.tsx"),
      "utf8",
    );
    const paymentSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "orderview", "PaymentCard.tsx"),
      "utf8",
    );
    const notificationsSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "orderview", "OrderNotificationsCard.tsx"),
      "utf8",
    );
    const notificationDisplaySource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "order-notification-display.ts"),
      "utf8",
    );

    expect(routeSource).toContain("const isHydrated = useHydrated()");
    expect(routeSource).toContain("enabled: isHydrated");
    expect(routeSource).toContain("const hydratedShipments = isHydrated ? shipments : []");
    expect(routeSource).toContain("isHydrated && Array.isArray(providers)");
    expect(paymentSource).toContain("const isHydrated = useHydrated()");
    expect(paymentSource).toContain("enabled: isHydrated");
    expect(paymentSource).toContain("enabled: isHydrated && isCOD");
    expect(paymentSource).toContain("(!isHydrated || paymentsLoading)");
    expect(notificationsSource).toContain("const isHydrated = useHydrated()");
    expect(notificationsSource).toContain("enabled: isHydrated");
    expect(notificationsSource).toContain("!isHydrated || isLoading");
    expect(notificationsSource).toContain("buildReceiptDisplayGroups");
    expect(notificationDisplaySource).toContain("Stopped after");
    expect(notificationDisplaySource).toContain("Delivery settled");
    expect(notificationsSource).toContain("recorded attempt");
  });

  it("keeps order detail low-priority panels behind lazy boundaries", () => {
    const orderViewPath = join(ADMIN_SRC_ROOT, "components", "admin", "OrderView.tsx");
    const orderViewSource = readFileSync(orderViewPath, "utf8");
    const supportPath = join(
      ADMIN_SRC_ROOT,
      "components",
      "admin",
      "orderview",
      "OrderSupportRequestsCard.tsx",
    );
    const notificationsPath = join(
      ADMIN_SRC_ROOT,
      "components",
      "admin",
      "orderview",
      "OrderNotificationsCard.tsx",
    );
    const paymentPath = join(
      ADMIN_SRC_ROOT,
      "components",
      "admin",
      "orderview",
      "PaymentCard.tsx",
    );
    const shipmentPath = join(
      ADMIN_SRC_ROOT,
      "components",
      "admin",
      "orderview",
      "ShipmentCard.tsx",
    );

    expect(orderViewSource).toContain("const LazyOrderSupportRequestsCard = lazy(");
    expect(orderViewSource).toContain('import("./orderview/OrderSupportRequestsCard")');
    expect(orderViewSource).toContain("(order.supportRequests?.length ?? 0) > 0");
    expect(orderViewSource).toContain("const LazyOrderNotificationsCard = lazy(");
    expect(orderViewSource).toContain('import("./orderview/OrderNotificationsCard")');
    expect(orderViewSource).toContain('import { PaymentCard } from "./orderview/PaymentCard"');
    expect(orderViewSource).toContain('import { ShipmentCard } from "./orderview/ShipmentCard"');
    expect(orderViewSource).not.toContain(
      'import { OrderSupportRequestsCard } from "./orderview/OrderSupportRequestsCard"',
    );
    expect(orderViewSource).not.toContain(
      'import { OrderNotificationsCard } from "./orderview/OrderNotificationsCard"',
    );
    expect(findStaticImportPathToTarget(orderViewPath, supportPath)).toBeNull();
    expect(findStaticImportPathToTarget(orderViewPath, notificationsPath)).toBeNull();
    expect(findStaticImportPathToTarget(orderViewPath, paymentPath)).not.toBeNull();
    expect(findStaticImportPathToTarget(orderViewPath, shipmentPath)).not.toBeNull();
  });

  it("keeps order-detail refund recovery context as the payment-card fallback", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "orders", "$orderId", "index.tsx"),
      "utf8",
    );

    expect(source).toContain("refundAttempts: order.refundAttempts");
    expect(source).toContain("activeRefundOperation: order.activeRefundOperation");
  });
});
