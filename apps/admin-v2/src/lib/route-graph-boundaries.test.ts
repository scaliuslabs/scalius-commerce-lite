import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative } from "node:path";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { ADMIN_PERMISSIONS } from "./admin-permissions";

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
      .filter(({ source }) =>
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
    const offenders = listSourceFiles(
      join(ADMIN_SRC_ROOT, "lib", "api-query-options"),
    )
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
    const offenders = [
      ...listSourceFiles(join(ADMIN_SRC_ROOT, "components")),
      ...listSourceFiles(join(ADMIN_SRC_ROOT, "routes")),
    ]
      .map((path) => ({
        path: relative(ADMIN_SRC_ROOT, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(({ source }) =>
        /(?:from\s+|import\()\s*["']@scalius\/core\/modules\/notifications["']/.test(
          source,
        ),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it("keeps the deferred rich-text editor client render flicker-free", () => {
    const tiptapSource = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "ui", "tiptap", "TiptapEditor.tsx"),
      "utf8",
    );
    const deferredSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "ui",
        "tiptap",
        "DeferredTiptapEditor.tsx",
      ),
      "utf8",
    );

    expect(tiptapSource).toContain("immediatelyRender: false,");
    expect(tiptapSource).toContain(
      'editorInstance.commands.focus("end", { scrollIntoView: false })',
    );
    expect(deferredSource).toContain("loadAndMountEditor(false);");
    expect(deferredSource).toContain(
      "onPointerDown={() => loadAndMountEditor(true)}",
    );
    expect(deferredSource).toContain("setShouldMountEditor(true)");
    expect(deferredSource).not.toContain("void loadTiptapEditorModule();");
    expect(deferredSource).not.toContain("requestIdleCallback");
    expect(deferredSource).not.toContain("IntersectionObserver");
    expect(deferredSource).toContain("min-h-[237px]");
    expect(deferredSource).toContain("h-[200px]");
  });

  it("keeps admin shell auth/toast actions behind lazy client boundaries", () => {
    const adminRouteSource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin.tsx"),
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

    expect(adminRouteSource).toContain("@/components/ui/deferred-toaster");
    expect(adminRouteSource).not.toContain("@/components/ui/sonner");
    expect(userMenuSource).not.toMatch(/import\s+\{\s*authClient\s*\}/);
    expect(userMenuSource).toContain('await import("@/lib/auth-client")');
    expect(deferredToasterSource).toContain("lazy(() =>");
    expect(deferredToasterSource).toContain('import("./sonner")');
    expect(sidebarSource).toContain('import("./sidebar-mobile-sheet")');
    expect(sidebarSource).not.toContain("@/components/ui/sheet");
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
      "routes/admin/articles/index.tsx",
      "routes/admin/attributes.tsx",
      "routes/admin/categories/index.tsx",
      "routes/admin/collections/index.tsx",
      "routes/admin/customers/index.tsx",
      "routes/admin/discounts/index.tsx",
      "routes/admin/inventory/index.tsx",
      "routes/admin/orders/_list.tsx",
      "routes/admin/orders/_list/index.tsx",
      "routes/admin/orders/_list/abandoned.tsx",
      "routes/admin/pages/index.tsx",
      "routes/admin/products/index.tsx",
    ];

    const eagerCommandPaths = hotEntryPaths
      .map((entry) =>
        findStaticImportPathToTarget(
          join(ADMIN_SRC_ROOT, entry),
          commandSourcePath,
        ),
      )
      .filter((path): path is string[] => path !== null);

    expect(commandSource).toContain('from "cmdk"');
    expect(eagerCommandPaths).toEqual([]);
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
  });

  it("keeps customer form writes invalidating dashboard aggregates", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "admin", "CustomerForm.tsx"),
      "utf8",
    );

    expect(source).toContain("queryKeys.customers.all");
    expect(source).toContain("queryKeys.dashboard.all");
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
    expect(resetPasswordRouteSource).not.toContain(
      "@daveyplate/better-auth-ui",
    );
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
        "AppsSettings.tsx",
      ),
      "utf8",
    );

    for (const source of [accountTwoFactorSource, scannerTokenSource]) {
      expect(source).toContain('import("qrcode")');
      expect(source).toContain("toDataURL");
      expect(source).not.toMatch(/from\s+["']qrcode["']/);
    }
    expect(accountTwoFactorSource).toContain("if (!totpUri)");
    expect(scannerTokenSource).toContain("if (!link)");
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
    expect(loginFormSource).toContain(
      'navigate({ to: "/admin", replace: true })',
    );
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
        path: join(
          ADMIN_SRC_ROOT,
          "components",
          "auth",
          "ResetPasswordForm.tsx",
        ),
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
        action: 'action="/admin/account"',
      },
    ];

    expect(hydratedHookSource).toContain(
      "const [isHydrated, setIsHydrated] = useState(false)",
    );
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

  it("keeps admin app forms from relying on implicit browser submit methods", () => {
    const offenders = listSourceFiles(ADMIN_SRC_ROOT)
      .filter((path) => !/\.test\./.test(path))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return extractOpeningFormTags(source)
          .filter((formTag) => !/\bmethod\s*=/.test(formTag))
          .map(
            (formTag) =>
              `${relative(ADMIN_SRC_ROOT, path)}: ${formTag.replace(/\s+/g, " ")}`,
          );
      });

    expect(offenders).toEqual([]);
  });

  it("keeps sensitive admin mutation forms out of native GET submissions", () => {
    const mutationForms = [
      join(ADMIN_SRC_ROOT, "components", "admin", "OrderForm.tsx"),
      join(ADMIN_SRC_ROOT, "components", "admin", "ProductForm.tsx"),
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "collection-form",
        "CollectionFormContainer.tsx",
      ),
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "orderview",
        "ManualFulfillmentDialog.tsx",
      ),
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "scanner",
        "BarcodeScanner.tsx",
      ),
      join(
        ADMIN_SRC_ROOT,
        "components",
        "admin",
        "shared",
        "FormContainer.tsx",
      ),
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

  it("keeps admin navigation from doing focus refetch stampedes", () => {
    const routerSource = readFileSync(
      join(ADMIN_SRC_ROOT, "router.tsx"),
      "utf8",
    );
    const queryClientSource = readFileSync(
      join(ADMIN_SRC_ROOT, "lib", "admin-query-client.ts"),
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
    expect(settingsQueryOptionsSource).not.toContain("getStorefrontUrl");
    expect(routerSource).toContain("scrollRestoration: true");
    expect(routerSource).toContain(
      'scrollToTopSelectors: ["#admin-main-scroll"]',
    );
    expect(routerSource).toContain('scrollRestorationBehavior: "instant"');
    expect(adminRouteSource).toContain(
      'data-scroll-restoration-id="admin-main-scroll"',
    );
    expect(adminRouteSource).not.toContain("[overflow-anchor:none]");
    expect(adminRouteSource).not.toContain("useAdminNestedScrollRestoration");
    expect(adminRouteContextSource).toContain("ADMIN_ROUTE_CONTEXT_FRESH_MS");
    expect(adminRouteContextSource).toContain("ADMIN_ROUTE_CONTEXT_STALE_MS");
    expect(adminRouteContextSource).toContain(
      "refreshAdminRouteContextInBackground",
    );
  });

  it("keeps secondary admin tool routes from blocking first paint on data reads", () => {
    const inventorySource = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "inventory", "index.tsx"),
      "utf8",
    );

    for (const source of [inventorySource]) {
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

  it("keeps edit forms from blocking on secondary label hydration", () => {
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
    const collectionLoaderSource = collectionSource.slice(
      collectionSource.indexOf("loader: async"),
      collectionSource.indexOf("head: ()"),
    );

    expect(collectionLoaderSource).not.toContain(
      "ensureQueryData(productsByIdsQueryOptions",
    );
    expect(collectionSource).not.toContain(
      "useSuspenseQuery(productsByIdsQueryOptions",
    );
    expect(collectionSource).toContain(
      "Collection product label prefetch skipped",
    );
  });

  it("keeps deferred rich-text editing lazy without a manual edit gate", () => {
    const source = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "ui",
        "tiptap",
        "DeferredTiptapEditor.tsx",
      ),
      "utf8",
    );

    expect(source).toContain('import { RichContent } from "../rich-content"');
    expect(source).toContain(
      'import { TiptapToolbarSkeleton } from "./TiptapToolbarSkeleton"',
    );
    expect(source).toContain(
      '<RichContent content={content} variant="compact" />',
    );
    expect(source).toContain("<TiptapToolbarSkeleton compact={compact} />");
    expect(source).toContain("const TiptapEditor = lazy(");
    expect(source).toContain("loadTiptapEditorModule");
    expect(source).toContain("loadAndMountEditor(false);");
    expect(source).toContain("setShouldMountEditor(true)");
    expect(source).toContain("function getDeferredEditorViewportClass");
    expect(source).toContain('compact ? "h-[200px]" : "h-[300px]"');
    expect(source).toContain("mountRequestedRef");
    expect(source).not.toContain("IntersectionObserver");
    expect(source).not.toContain("requestIdleCallback");
    expect(source).not.toContain('from "./TiptapEditor"');
    expect(source).not.toContain("toPlainTextPreview");
    expect(source).not.toContain("PencilLine");
    expect(source).not.toContain("editLabel");
    expect(source).not.toContain("setIsEditing");


    const skeletonSource = readFileSync(
      join(
        ADMIN_SRC_ROOT,
        "components",
        "ui",
        "tiptap",
        "TiptapToolbarSkeleton.tsx",
      ),
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
    expect(menuBarSource).toContain('aria-label={');
    expect(menuBarSource).toContain('"Select text to add a link"');
    expect(menuBarSource).toContain('"Edit link"');
    expect(menuBarSource).toContain('aria-label="Insert image URL"');
    expect(menuBarSource).toContain('aria-label="Embed video"');
    expect(menuBarSource).toContain('triggerLabel="Media Library"');
    expect(menuBarSource).toContain("trigger={");
    expect(menuBarSource).toContain('tooltip="Media Library"');
    expect(menuBarSource).not.toContain("document.getElementById");
    expect(menuBarSource).not.toContain("tiptap-media-manager-wrapper");
    expect(menuBarSource).not.toContain('querySelector("button")?.click()');
  });

});
