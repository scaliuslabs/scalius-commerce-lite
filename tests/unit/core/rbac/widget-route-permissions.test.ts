import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "../../../../packages/core/src/auth/rbac/permissions";
import { getRoutePermission } from "../../../../packages/core/src/auth/rbac/route-permissions";

describe("widget route permissions", () => {
  it("protects status toggles with the dedicated toggle permission", () => {
    expect(
      getRoutePermission("/api/v1/admin/widgets/widget_123/toggle-status", "PATCH"),
    ).toEqual({ permission: PERMISSIONS.WIDGETS_TOGGLE_STATUS });
  });

  it("protects manual history snapshots with widget edit permission", () => {
    expect(
      getRoutePermission("/api/v1/admin/widgets/widget_123/history", "POST"),
    ).toEqual({ permission: PERMISSIONS.WIDGETS_EDIT });
  });
});
