// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { hashKey, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";
import { appSurfacesQueryOptions, type AppAdminSurfaces } from "~/lib/api-query-options/apps";
import { queryKeys } from "~/lib/query-keys";
import {
  APP_LIST_COLUMNS_MAX,
  appColumnSpec,
  appFilterColumnKey,
  appFilterValue,
  appListColumnsOf,
  effectiveAppFilter,
  useAppListColumns,
  type AppListColumn,
  type AppListColumns,
} from "./list-columns";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const permission = vi.hoisted(() => ({ canView: true }));
vi.mock("~/contexts/PermissionContext", () => ({ usePermissions: () => ({ hasPermission: () => permission.canView }) }));
// The lists are not under test: the API client is never called.
vi.mock("@scalius/api-client/sdk", () => ({ getApiV1AdminAppsSurfaces: vi.fn() }));
// A read that never answers: the apps stay unknown.
vi.mock("~/lib/api", () => ({ apiData: () => new Promise(() => undefined) }));

type Column = AppAdminSurfaces["listColumns"][number];
const column = (id: string, resource: Column["resource"], extra: Partial<Column> = {}): Column => ({
  key: `scalius.loyalty/${id}`,
  id,
  resource,
  title: `Title ${id}`,
  type: "text",
  filterable: false,
  ...extra,
});

function app(id: string, name: string, listColumns: Column[], translations?: AppAdminSurfaces["translations"]): AppAdminSurfaces {
  return {
    id,
    name,
    pages: [],
    cards: [],
    actions: [],
    widgets: [],
    listColumns,
    routes: [],
    providers: [],
    translations,
  } as AppAdminSurfaces;
}

const LOYALTY = app("scalius.loyalty", "Loyalty", [
  column("tier", "customer", { filterable: true }),
  column("points", "customer", { type: "number" }),
  column("badge", "order", { type: "boolean", filterable: true }),
], { bn: { listColumns: { tier: "স্তর" } } });

describe("apps' list columns", () => {
  it("takes one resource's columns across the apps, in app order, with the app's name", () => {
    const other = app("acme.crm", "CRM", [{ ...column("owner", "customer"), key: "acme.crm/owner" }]);
    const columns = appListColumnsOf([LOYALTY, other], "customer");
    expect(columns.map((entry) => [entry.key, entry.appName])).toEqual([
      ["scalius.loyalty/tier", "Loyalty"],
      ["scalius.loyalty/points", "Loyalty"],
      ["acme.crm/owner", "CRM"],
    ]);
    expect(appListColumnsOf([LOYALTY], "product")).toEqual([]);
  });

  it("splits a filter into its column and value, keeping colons in the value", () => {
    expect(appFilterColumnKey("scalius.loyalty/tier:gold")).toBe("scalius.loyalty/tier");
    expect(appFilterValue("scalius.loyalty/tier:gold")).toBe("gold");
    expect(appFilterValue("scalius.loyalty/note:a:b")).toBe("a:b");
    expect(appFilterValue(undefined)).toBe("");
  });

  it("keeps the URL's filter until the apps are known, then only when its column can still filter", () => {
    const columns = appListColumnsOf([LOYALTY], "customer");
    expect(effectiveAppFilter("scalius.loyalty/tier:gold", [], false)).toBe("scalius.loyalty/tier:gold");
    expect(effectiveAppFilter("scalius.loyalty/tier:gold", columns, true)).toBe("scalius.loyalty/tier:gold");
    // A column that cannot filter, or one from an app that is gone, would make the API refuse the list.
    expect(effectiveAppFilter("scalius.loyalty/points:5", columns, true)).toBeUndefined();
    expect(effectiveAppFilter("gone.app/x:1", columns, true)).toBeUndefined();
    expect(effectiveAppFilter(undefined, columns, true)).toBeUndefined();
  });

  it("reads a cell from the values the list returned for its row", () => {
    const [tier] = appListColumnsOf([LOYALTY], "customer") as [AppListColumn];
    const spec = appColumnSpec<{ id: string; appValues?: Record<string, string | number | boolean | null> }>(tier);
    expect(spec).toMatchObject({ id: "app.scalius.loyalty/tier", label: "Title tier", kind: "text" });
    expect(spec.value({ id: "c1", appValues: { "scalius.loyalty/tier": "gold" } })).toBe("gold");
    expect(spec.value({ id: "c2" })).toBeUndefined();
  });

  it("leaves a list's request key unchanged when it asks for nothing", () => {
    // Undefined parameters hash like absent ones: a store without app columns shares every cached list.
    expect(hashKey(queryKeys.orders.list({ page: 1, limit: 10, appColumns: undefined, appFilter: undefined })))
      .toBe(hashKey(queryKeys.orders.list({ page: 1, limit: 10 })));
  });
});

describe("useAppListColumns", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let latest: AppListColumns<{ id: string }> | null;

  function Probe({ resource, filter }: { resource: "customer" | "order"; filter?: string }) {
    latest = useAppListColumns<{ id: string }>(resource, filter);
    return null;
  }
  /** `columns`: wait for the code that draws the columns, which loads on demand. */
  const renderProbe = async (children: ReactNode, { columns = false } = {}) => {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
    });
    for (let attempt = 0; columns && !latest?.extra.length && attempt < 100; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  };

  beforeEach(() => {
    permission.canView = true;
    latest = null;
    setLocale("en");
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setLocale("en");
  });

  it("asks for nothing and adds nothing when no app has a column here", async () => {
    queryClient.setQueryData(appSurfacesQueryOptions().queryKey, [app("acme.empty", "Empty", [])]);
    await renderProbe(<Probe resource="customer" />);
    expect(latest).toMatchObject({ columnsParam: undefined, filterParam: undefined, filterable: [], extra: [] });
  });

  it("asks for nothing while the apps are still loading", async () => {
    await renderProbe(<Probe resource="order" filter="scalius.loyalty/badge:true" />);
    // The route already read the list with the URL's filter; it stands until the apps answer.
    expect(latest).toMatchObject({ columnsParam: undefined, filterParam: "scalius.loyalty/badge:true", extra: [], filterable: [] });
  });

  it("asks for nothing without permission to view apps", async () => {
    permission.canView = false;
    queryClient.setQueryData(appSurfacesQueryOptions().queryKey, [LOYALTY]);
    await renderProbe(<Probe resource="customer" filter="scalius.loyalty/tier:gold" />);
    expect(latest).toMatchObject({ columnsParam: undefined, filterParam: undefined, extra: [] });
  });

  it("asks for this list's columns in app order and draws one column each", async () => {
    queryClient.setQueryData(appSurfacesQueryOptions().queryKey, [LOYALTY]);
    await renderProbe(<Probe resource="customer" />, { columns: true });
    expect(latest?.columnsParam).toBe("scalius.loyalty/tier,scalius.loyalty/points");
    expect(latest?.extra.map((entry) => entry.id)).toEqual(["app.scalius.loyalty/tier", "app.scalius.loyalty/points"]);
    expect(latest?.filterable.map((entry) => entry.key)).toEqual(["scalius.loyalty/tier"]);
    // Another resource's column stays off this list.
    await renderProbe(<Probe resource="order" />, { columns: true });
    expect(latest?.columnsParam).toBe("scalius.loyalty/badge");
  });

  it("titles the columns in the dashboard's language", async () => {
    setLocale("bn");
    queryClient.setQueryData(appSurfacesQueryOptions().queryKey, [LOYALTY]);
    await renderProbe(<Probe resource="customer" />, { columns: true });
    expect(latest?.extra.map((entry) => (entry.meta as { label: string }).label)).toEqual(["স্তর", "Title points"]);
  });

  it(`asks for at most ${APP_LIST_COLUMNS_MAX} columns`, async () => {
    const many = app("acme.many", "Many", Array.from({ length: 8 }, (_, index) => ({ ...column(`c${index}`, "customer"), key: `acme.many/c${index}` })));
    queryClient.setQueryData(appSurfacesQueryOptions().queryKey, [many]);
    await renderProbe(<Probe resource="customer" />, { columns: true });
    expect(latest?.columnsParam?.split(",")).toHaveLength(APP_LIST_COLUMNS_MAX);
    expect(latest?.extra).toHaveLength(APP_LIST_COLUMNS_MAX);
  });

  it("sends the URL's filter only while its column can filter", async () => {
    queryClient.setQueryData(appSurfacesQueryOptions().queryKey, [LOYALTY]);
    await renderProbe(<Probe resource="customer" filter="scalius.loyalty/tier:gold" />);
    expect(latest?.filterParam).toBe("scalius.loyalty/tier:gold");
    await renderProbe(<Probe resource="customer" filter="scalius.loyalty/points:5" />);
    expect(latest?.filterParam).toBeUndefined();
  });
});
