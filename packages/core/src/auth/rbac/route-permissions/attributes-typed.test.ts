import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "../permissions";
import { getRoutePermission } from "./index";

const ATTRIBUTES = "/api/v1/admin/attributes";

describe("typed attribute route permissions", () => {
  it("gates groups: reads for attribute or product viewers, writes by attribute permissions", () => {
    expect(getRoutePermission(`${ATTRIBUTES}/groups`, "GET"))
      .toEqual({ anyOf: [PERMISSIONS.ATTRIBUTES_VIEW, PERMISSIONS.PRODUCTS_VIEW] });
    expect(getRoutePermission(`${ATTRIBUTES}/groups`, "POST")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_CREATE });
    expect(getRoutePermission(`${ATTRIBUTES}/groups/order`, "PUT")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_EDIT });
    expect(getRoutePermission(`${ATTRIBUTES}/groups/atg_display01`, "PATCH")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_EDIT });
    expect(getRoutePermission(`${ATTRIBUTES}/groups/atg_display01`, "DELETE")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_DELETE });
  });

  it("gates category sets, value rows and conversion", () => {
    expect(getRoutePermission(`${ATTRIBUTES}/category-sets/cat_1`, "GET")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_VIEW });
    expect(getRoutePermission(`${ATTRIBUTES}/category-sets/cat_1`, "PUT")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_EDIT });
    expect(getRoutePermission(`${ATTRIBUTES}/attr_1/normalized-values`, "GET")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_VIEW });
    expect(getRoutePermission(`${ATTRIBUTES}/attr_1/normalized-values`, "POST")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_EDIT });
    expect(getRoutePermission(`${ATTRIBUTES}/attr_1/normalized-values/order`, "PUT")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_EDIT });
    expect(getRoutePermission(`${ATTRIBUTES}/attr_1/normalized-values/atv_1`, "PATCH")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_EDIT });
    expect(getRoutePermission(`${ATTRIBUTES}/attr_1/normalized-values/atv_1`, "DELETE")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_EDIT });
    expect(getRoutePermission(`${ATTRIBUTES}/attr_1/convert-type`, "POST")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_EDIT });
  });

  it("leaves the existing attribute routes and unmapped methods as they were", () => {
    expect(getRoutePermission(`${ATTRIBUTES}/attr_1/values`, "DELETE")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_EDIT });
    expect(getRoutePermission(`${ATTRIBUTES}/attr_1/permanent`, "DELETE")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_DELETE });
    expect(getRoutePermission(`${ATTRIBUTES}/attr_1/restore`, "POST")).toEqual({ permission: PERMISSIONS.ATTRIBUTES_EDIT });
    expect(getRoutePermission(`${ATTRIBUTES}/category-sets/cat_1`, "POST")).toBeNull();
  });
});
