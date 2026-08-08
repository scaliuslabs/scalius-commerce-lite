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

  const headers = `/assets/immutable/*.js
  Cache-Control: public, max-age=31536000, immutable

/assets/immutable/*.css
  Cache-Control: public, max-age=31536000, immutable
`;
  write(root, "apps/admin-v2/public/_headers", headers);
  write(root, "apps/admin-v2/public/flags/flags.css", ".flag { display: block; }\n");

  for (const route of [
    "apps/admin-v2/src/routes/admin/products/index.tsx",
    "apps/admin-v2/src/routes/admin/orders/index.tsx",
    "apps/admin-v2/src/routes/admin/customers/index.tsx",
    "apps/admin-v2/src/routes/admin/categories/index.tsx",
    "apps/admin-v2/src/routes/admin/collections/index.tsx",
    "apps/admin-v2/src/routes/admin/discounts/index.tsx",
    "apps/admin-v2/src/routes/admin/pages/index.tsx",
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
    export const INTENT_PREFETCH_MOUNT_GRACE_MS = 5_000;
    export function shouldRefetchServerTableOnMount(query) {
      if (query.state.isInvalidated || query.state.dataUpdatedAt <= 0 || query.isStale()) return "always";
      return Date.now() - query.state.dataUpdatedAt > INTENT_PREFETCH_MOUNT_GRACE_MS
        ? "always"
        : false;
    }
    export function useServerTable(qOpts) {
      return useQuery({
        ...qOpts,
        placeholderData: keepPreviousData,
        refetchOnMount: shouldRefetchServerTableOnMount,
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
    export function ProductImagesSection() {
      const field = { value: [] };
      return field.value.slice(0, 12).map((item) => <img loading="lazy" src={item.url} />);
    }
  `);

  write(root, "apps/admin-v2/src/routes/admin/products/new.tsx", `
    import { lazy } from "react";
    const OptionMatrixEditor = lazy(() => import("~/components/admin/product-form/variants/OptionMatrixEditor"));
    export default OptionMatrixEditor;
  `);
  write(root, "apps/admin-v2/src/routes/admin/products/$productId/edit.tsx", `
    import { lazy } from "react";
    import type { OptionMatrixEditorHandle } from "~/components/admin/product-form/variants/option-matrix-editor-model";
    const OptionMatrixEditor = lazy(() => import("~/components/admin/product-form/variants/OptionMatrixEditor"));
    export default OptionMatrixEditor;
  `);
  write(root, "apps/admin-v2/src/components/admin/product-form/variants/OptionMatrixEditor.tsx", `
    const pageSize = 30;
    const filteredVariants = [];
    const page = 0;
    export const visibleVariants = filteredVariants.slice(page * pageSize, (page + 1) * pageSize);
  `);

  write(root, "apps/admin-v2/src/components/admin/navigation/NavigationBuilder.tsx", `
    export const NAVIGATION_RENDER_BATCH_SIZE = 80;
    export function NavigationBuilder() {
      const outlineRows = [];
      const renderLimit = NAVIGATION_RENDER_BATCH_SIZE;
      return outlineRows.slice(0, renderLimit);
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
    import { OrderSupportRequestsCard } from "./orderview/OrderSupportRequestsCard";
    import { OrderNotificationsCard } from "./orderview/OrderNotificationsCard";
    export function OrderView() {
      return <><OrderSupportRequestsCard /><OrderNotificationsCard /></>;
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
    write(root, "apps/admin-v2/dist/client/_headers", headers);
    write(root, "apps/admin-v2/dist/client/flags/flags.css", ".flag { display: block; }\n");
    write(root, "apps/admin-v2/dist/client/assets/immutable/global-a1B2c3D4.css", `
      :root { color-scheme: light; }
    `);
    write(root, "apps/admin-v2/dist/client/assets/immutable/ProductForm-a1B2c3D4e.js", `
      import { DeferredTiptapEditor } from "./DeferredTiptapEditor-fixture.js";
      export async function loadAdditionalInfo() {
        return import("./AdditionalInfoManager-fixture.js");
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
    write(root, "apps/admin-v2/dist/client/assets/immutable/ProductForm-a1B2c3D4e.js", `
      export async function restoreObsoleteGallery() {
        return import("./DraggableImageGallery-fixture.js");
      }
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

  it("fails when useServerTable omits explicit stale-aware mount refetch", () => {
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
      "expected the bounded intent-prefetch mount policy",
    );
  });

  it("fails when useServerTable forces fresh prefetched data to refetch", () => {
    const root = createPassingFixture({ dist: false });
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

    const report = runAdminPerfCheck({ rootDir: root });

    expect(report.ok).toBe(false);
    expect(formatAdminPerfCheckReport(report).join("\n")).toContain(
      "expected the bounded intent-prefetch mount policy",
    );
  });

  it("fails when product media restores drag tooling or drops the render cap", () => {
    const root = createPassingFixture({ dist: false });
    write(root, "apps/admin-v2/src/components/admin/product-form/ProductImagesSection.tsx", `
      import { DndContext } from "@dnd-kit/core";
      import { DraggableImageGallery } from "../DraggableImageGallery";
      export function ProductImagesSection({ field }) {
        return <DndContext>{field.value.map((item) => <img src={item.url} />)}</DndContext>;
      }
    `);

    const report = runAdminPerfCheck({ rootDir: root });
    const output = formatAdminPerfCheckReport(report).join("\n");

    expect(report.ok).toBe(false);
    expect(output).toContain("product media must keep the direct, accessible reorder controls");
    expect(output).toContain("cap its initial rendered tiles at 12");
    expect(output).toContain("native lazy loading");
  });

  it("fails when navigation restores duplicate editors or drops row batching", () => {
    const root = createPassingFixture({ dist: false });
    write(root, "apps/admin-v2/src/components/admin/navigation/NavigationBuilder.tsx", `
      import { MobileNavigationTree } from "./MobileNavigationTree";
      const SortableNavigationEditor = () => null;
      export function NavigationBuilder({ outlineRows }) {
        return <><MobileNavigationTree />{outlineRows.map((row) => row)}</>;
      }
    `);

    const report = runAdminPerfCheck({ rootDir: root });
    const output = formatAdminPerfCheckReport(report).join("\n");

    expect(report.ok).toBe(false);
    expect(output).toContain("80-row render batch");
    expect(output).toContain("only the active row batch");
    expect(output).toContain("duplicate legacy desktop/mobile editors");
  });

  it("fails when OrderView restores lazy panel hydration", () => {
    const root = createPassingFixture({ dist: false });
    write(root, "apps/admin-v2/src/components/admin/OrderView.tsx", `
      import { lazy, Suspense } from "react";
      const OrderSupportRequestsCard = lazy(() => import("./orderview/OrderSupportRequestsCard"));
      const OrderNotificationsCard = lazy(() => import("./orderview/OrderNotificationsCard"));
      export function OrderView() {
        return <Suspense><OrderSupportRequestsCard /><OrderNotificationsCard /></Suspense>;
      }
    `);

    const report = runAdminPerfCheck({ rootDir: root });
    const output = formatAdminPerfCheckReport(report).join("\n");

    expect(report.ok).toBe(false);
    expect(output).toContain("render deterministically");
    expect(output).toContain("hydration-unstable lazy panel boundary");
  });

  it("rejects broad immutable header rules", () => {
    const root = createPassingFixture();
    const broadHeaders = `/*
  Cache-Control: public, max-age=31536000, immutable
`;
    write(root, "apps/admin-v2/public/_headers", broadHeaders);
    write(root, "apps/admin-v2/dist/client/_headers", broadHeaders);

    const report = runAdminPerfCheck({ rootDir: root });
    const output = formatAdminPerfCheckReport(report).join("\n");

    expect(report.ok).toBe(false);
    expect(output).toContain("long-lived browser caching is only allowed");
    expect(output).toContain("found /*");
    expect(output).toContain("expected exactly one /assets/immutable/*.js rule");
  });

  it("rejects broad long-lived caching even without the immutable directive", () => {
    const root = createPassingFixture();
    const broadHeaders = `/*
  Cache-Control: public, max-age=31536000
`;
    write(root, "apps/admin-v2/public/_headers", broadHeaders);
    write(root, "apps/admin-v2/dist/client/_headers", broadHeaders);

    const report = runAdminPerfCheck({ rootDir: root });
    const output = formatAdminPerfCheckReport(report).join("\n");

    expect(report.ok).toBe(false);
    expect(output).toContain("long-lived browser caching is only allowed");
    expect(output).toContain("found /*");
  });

  it("fails closed when an existing client build loses its ProductForm chunk", () => {
    const root = createPassingFixture();
    const productFormChunk = join(
      root,
      "apps/admin-v2/dist/client/assets/immutable/ProductForm-a1B2c3D4e.js",
    );
    rmSync(productFormChunk);

    const report = runAdminPerfCheck({ rootDir: root });
    const output = formatAdminPerfCheckReport(report).join("\n");

    expect(report.ok).toBe(false);
    expect(output).toContain("expected a ProductForm-*.js artifact");
  });

  it("rejects unhashed or misplaced generated scripts and styles", () => {
    const root = createPassingFixture();
    write(root, "apps/admin-v2/dist/client/assets/immutable/unhashed.js", "export {};\n");
    write(root, "apps/admin-v2/dist/client/assets/generated-a1B2c3D4.css", ".x {}\n");

    const report = runAdminPerfCheck({ rootDir: root });
    const output = formatAdminPerfCheckReport(report).join("\n");

    expect(report.ok).toBe(false);
    expect(output).toContain("immutable scripts/styles require a Vite content hash");
    expect(output).toContain(
      "generated scripts/styles must be emitted under assets/immutable/",
    );
  });

  it("rejects public files, maps, and HTML in the generated immutable namespace", () => {
    const root = createPassingFixture();
    write(root, "apps/admin-v2/public/assets/immutable/copied-a1B2c3D4.js", "export {};\n");
    write(root, "apps/admin-v2/dist/client/assets/immutable/index.html", "<!doctype html>\n");
    write(root, "apps/admin-v2/dist/client/assets/immutable/index-a1B2c3D4.js.map", "{}\n");

    const report = runAdminPerfCheck({ rootDir: root });
    const output = formatAdminPerfCheckReport(report).join("\n");

    expect(report.ok).toBe(false);
    expect(output).toContain("reserved for generated client assets");
    expect(output).toContain("source maps and HTML must stay outside");
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
