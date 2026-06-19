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
      expect(source).toContain('navigate({ to: "/admin" })');
      expect(source).not.toContain('window.location.href = "/admin"');
    }
    expect(authClientSource).not.toContain("window.location.href");
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
    expect(appSidebarSource).toContain(
      "~/lib/api-query-options/storefront-url",
    );
    expect(appSidebarSource).not.toContain(
      "~/lib/api-query-options/settings",
    );
    expect(settingsQueryOptionsSource).not.toContain("getStorefrontUrl");
    expect(routerSource).toContain("scrollToTopSelectors: [\"#admin-main-scroll\"]");
    expect(routerSource).toContain("scrollRestorationBehavior: \"instant\"");
    expect(adminRouteSource).toContain("useAdminNestedScrollRestoration();");
    expect(adminRouteContextSource).toContain("ADMIN_ROUTE_CONTEXT_FRESH_MS");
    expect(adminRouteContextSource).toContain("ADMIN_ROUTE_CONTEXT_STALE_MS");
    expect(adminRouteContextSource).toContain("refreshAdminRouteContextInBackground");
    expect(scrollSource).toContain('router.subscribe("onBeforeLoad"');
    expect(scrollSource).toContain('router.subscribe("onRendered"');
    expect(scrollSource).toContain('window.addEventListener("popstate"');
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
    expect(loaderSource).not.toContain(
      "await queryClient.ensureQueryData(dashboardSummaryQueryOptions())",
    );
    expect(loaderSource).not.toContain("await warmRouteQuery");
    expect(source).toContain("isSummaryInitialLoading");
    expect(source).toContain("DashboardSummaryLoading");
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
      join(ADMIN_SRC_ROOT, "routes", "admin", "inventory.tsx"),
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

  it("keeps new-order creation from blocking on product detail fanout", () => {
    const source = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "admin", "orders", "new.tsx"),
      "utf8",
    );
    const loaderSource = source.slice(
      source.indexOf("loader: async"),
      source.indexOf("head: ()"),
    );

    expect(loaderSource).toContain("productsQueryOptions({ page: 1, limit: 100 })");
    expect(source).not.toContain("productQueryOptions(");
    expect(loaderSource).not.toContain("Promise.all(");
    expect(loaderSource).not.toContain("for (let");
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
