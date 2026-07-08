import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatAdminPerfCheckReport,
  runAdminPerfCheck,
} from "./admin-perf-check.mjs";

const tmpRoots = [];

function createRoot() {
  const root = mkdtempSync(join(tmpdir(), "scalius-admin-perf-"));
  tmpRoots.push(root);
  return root;
}

function write(root, relativePath, content) {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function createPassingFixture({ dist = true } = {}) {
  const root = createRoot();

  for (const route of [
    "apps/admin-v2/src/routes/admin/products/index.tsx",
    "apps/admin-v2/src/routes/admin/orders/index.tsx",
    "apps/admin-v2/src/routes/admin/customers/index.tsx",
    "apps/admin-v2/src/routes/admin/categories/index.tsx",
    "apps/admin-v2/src/routes/admin/collections/index.tsx",
    "apps/admin-v2/src/routes/admin/discounts/index.tsx",
    "apps/admin-v2/src/routes/admin/pages/index.tsx",
    "apps/admin-v2/src/routes/admin/widgets/index.tsx",
  ]) {
    write(root, route, `
      import { warmRouteQuery } from "~/lib/route-query-warming";
      export async function loader() {
        await warmRouteQuery(queryClient, listQueryOptions());
      }
    `);
  }

  write(root, "apps/admin-v2/src/lib/api-query-options/orders.ts", `
    export const ordersQueryOptions = () => ({ queryKey: ["orders"] });
  `);

  write(root, "apps/admin-v2/src/components/admin/data-table/useServerTable.ts", `
    import { keepPreviousData, useQuery } from "@tanstack/react-query";
    export function useServerTable(qOpts) {
      return useQuery({
        ...qOpts,
        placeholderData: keepPreviousData,
        refetchOnMount: "always",
      });
    }
  `);

  write(root, "apps/admin-v2/src/components/admin/data-table/DataTable.tsx", `
    import { lazy, Suspense } from "react";
    const SortableDataTableContent = lazy(() => import("./SortableDataTableContent"));
    export function DataTable({ sortable }) {
      return sortable ? <Suspense><SortableDataTableContent /></Suspense> : null;
    }
  `);

  write(root, "apps/admin-v2/src/components/admin/data-table/SortableDataTableContent.tsx", `
    import { DndContext } from "@dnd-kit/core";
    import { SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
    export function SortableDataTableContent() {
      useSortable({ id: "row" });
      return <DndContext><SortableContext items={[]} /></DndContext>;
    }
  `);

  write(root, "apps/admin-v2/src/components/admin/ProductForm.tsx", `
    import { TitleDescriptionSection } from "./product-form/TitleDescriptionSection";
    export function ProductForm() {
      return <TitleDescriptionSection />;
    }
  `);

  write(root, "apps/admin-v2/src/components/admin/product-form/TitleDescriptionSection.tsx", `
    import { lazy, Suspense } from "react";
    import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor";
    const AdditionalInfoManager = lazy(() => import("./AdditionalInfoManager"));
    export function TitleDescriptionSection() {
      return <><DeferredTiptapEditor /><Suspense><AdditionalInfoManager /></Suspense></>;
    }
  `);

  write(root, "apps/admin-v2/src/components/admin/product-form/ProductImagesSection.tsx", `
    import { lazy, Suspense } from "react";
    const DraggableImageGallery = lazy(() => import("../DraggableImageGallery"));
    export function ProductImagesSection() {
      return <Suspense><DraggableImageGallery /></Suspense>;
    }
  `);

  write(root, "apps/admin-v2/src/components/admin/product-form/variants/VariantManager.tsx", `
    import { lazy, Suspense } from "react";
    const VariantSortModal = lazy(() => import("./VariantSortModal"));
    export function VariantManager() {
      return <Suspense><VariantSortModal /></Suspense>;
    }
  `);

  write(root, "apps/admin-v2/src/components/admin/product-form/variants/VariantActionsToolbar.tsx", `
    import { lazy, Suspense } from "react";
    const BulkVariantGenerator = lazy(() => import("./bulk-generator"));
    const VariantImportExport = lazy(() => import("./VariantImportExport"));
    export function VariantActionsToolbar() {
      async function handleExport() {
        await import("./utils/csvHelpers");
      }
      return <Suspense><BulkVariantGenerator /><VariantImportExport /></Suspense>;
    }
  `);

  write(root, "apps/admin-v2/src/components/admin/navigation/NavigationBuilder.tsx", `
    import { lazy, Suspense } from "react";
    const SortableNavigationEditor = lazy(() => import("./SortableNavigationEditor"));
    export function NavigationBuilder() {
      return <Suspense><SortableNavigationEditor /></Suspense>;
    }
  `);

  write(root, "apps/admin-v2/src/components/admin/settings/GeneralSettingsPage.tsx", `
    import { lazy, Suspense } from "react";
    import type { HeaderConfig } from "../header-builder/types";
    import type { FooterConfig } from "../footer-builder/types";
    const HeaderBuilder = lazy(() => import("../header-builder"));
    const FooterBuilder = lazy(() => import("../footer-builder"));
    export default function GeneralSettingsPage() {
      return <Suspense><HeaderBuilder /><FooterBuilder /></Suspense>;
    }
  `);

  write(root, "apps/admin-v2/src/components/admin/OrderView.tsx", `
    import { lazy, Suspense } from "react";
    const LazyOrderSupportRequestsCard = lazy(() => import("./orderview/OrderSupportRequestsCard"));
    const LazyOrderNotificationsCard = lazy(() => import("./orderview/OrderNotificationsCard"));
    export function OrderView() {
      return <Suspense><LazyOrderSupportRequestsCard /><LazyOrderNotificationsCard /></Suspense>;
    }
  `);

  if (dist) {
    write(root, "apps/admin-v2/dist/server/.vite/manifest.json", JSON.stringify({
      "src/routes/admin/index.tsx?tsr-split=component": {
        file: "assets/admin.js",
        imports: ["assets/dashboard.js"],
      },
      "src/routes/admin/settings/index.tsx?tsr-split=component": {
        file: "assets/settings.js",
        imports: ["assets/settings-safe.js"],
      },
    }));
    write(root, "apps/admin-v2/dist/client/assets/ProductForm-fixture.js", `
      import { DeferredTiptapEditor } from "./DeferredTiptapEditor-fixture.js";
      export async function loadGallery() {
        return import("./DraggableImageGallery-fixture.js");
      }
    `);
  }

  return root;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("admin-perf-check", () => {
  it("passes a representative source and dist fixture", () => {
    const root = createPassingFixture();

    const report = runAdminPerfCheck({ rootDir: root });

    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.results.map((result) => result.status)).not.toContain("SKIP");
    expect(formatAdminPerfCheckReport(report)).toContain(
      "PASS dist: ProductForm client chunk - 1 chunk(s)",
    );
  });

  it("fails with grouped source and dist errors", () => {
    const root = createPassingFixture();
    write(root, "apps/admin-v2/src/lib/api.queries.ts", "export {};\n");
    write(root, "apps/admin-v2/src/components/admin/data-table/DataTable.tsx", `
      import { DndContext } from "@dnd-kit/core";
      export function DataTable() {
        return <DndContext />;
      }
    `);
    write(root, "apps/admin-v2/dist/client/assets/ProductForm-fixture.js", `
      import { DraggableImageGallery } from "./DraggableImageGallery-fixture.js";
      export { DraggableImageGallery };
    `);

    const report = runAdminPerfCheck({ rootDir: root });
    const lines = formatAdminPerfCheckReport(report);

    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.group)).toEqual(
      expect.arrayContaining(["source", "dist"]),
    );
    expect(lines).toContain("FAIL admin performance confidence gate");
    expect(lines).toContain("FAIL source");
    expect(lines).toContain("FAIL dist");
    expect(lines.join("\n")).toContain("api.queries.ts exists");
    expect(lines.join("\n")).toContain("DraggableImageGallery-fixture.js");
  });

  it("fails when useServerTable omits explicit mount refetch", () => {
    const root = createPassingFixture({ dist: false });
    write(root, "apps/admin-v2/src/components/admin/data-table/useServerTable.ts", `
      import { keepPreviousData, useQuery } from "@tanstack/react-query";
      export function useServerTable(qOpts) {
        return useQuery({ ...qOpts, placeholderData: keepPreviousData });
      }
    `);

    const report = runAdminPerfCheck({ rootDir: root });

    expect(report.ok).toBe(false);
    expect(formatAdminPerfCheckReport(report).join("\n")).toContain(
      'expected refetchOnMount: "always"',
    );
  });

  it("passes and reports dist as skipped when build artifacts are absent", () => {
    const root = createPassingFixture({ dist: false });

    const report = runAdminPerfCheck({ rootDir: root });

    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "SKIP",
          label: "dist: admin build artifacts",
        }),
      ]),
    );
  });
});
