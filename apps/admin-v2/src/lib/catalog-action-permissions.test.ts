import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { getCatalogActionPermissions } from "./catalog-action-permissions";

function resolveCatalogActions(permissions: string[]) {
  const permissionSet = new Set(permissions);
  return getCatalogActionPermissions((permission) =>
    permissionSet.has(permission),
  );
}

describe("catalog action permissions", () => {
  it("fails closed when a catalog viewer has no mutation permissions", () => {
    const actions = resolveCatalogActions([
      PERMISSIONS.PRODUCTS_VIEW,
      PERMISSIONS.CATEGORIES_VIEW,
      PERMISSIONS.ATTRIBUTES_VIEW,
      PERMISSIONS.COLLECTIONS_VIEW,
    ]);

    expect(actions).toEqual({
      products: {
        canCreate: false,
        canEdit: false,
        canDelete: false,
        canRestore: false,
        canPermanentDelete: false,
        canBulkDelete: false,
      },
      categories: {
        canCreate: false,
        canEdit: false,
        canDelete: false,
        canRestore: false,
        canPermanentDelete: false,
        canBulkDelete: false,
      },
      attributes: {
        canCreate: false,
        canEdit: false,
        canDelete: false,
        canRestore: false,
        canPermanentDelete: false,
        canBulkDelete: false,
      },
      collections: {
        canCreate: false,
        canEdit: false,
        canDelete: false,
        canRestore: false,
        canPermanentDelete: false,
        canBulkDelete: false,
        canToggleStatus: false,
        canReorder: false,
      },
      inventory: { canAdjustStock: false, canAcknowledgeAlerts: false },
    });
  });

  it("keeps product actions granular and ties stock adjustment to product edit", () => {
    expect(
      resolveCatalogActions([PERMISSIONS.PRODUCTS_EDIT]),
    ).toMatchObject({
      products: {
        canCreate: false,
        canEdit: true,
        canDelete: false,
        canRestore: false,
        canPermanentDelete: false,
        canBulkDelete: false,
      },
      inventory: { canAdjustStock: true, canAcknowledgeAlerts: true },
    });

    expect(
      resolveCatalogActions([PERMISSIONS.PRODUCTS_BULK_OPERATIONS]).products,
    ).toMatchObject({
      canDelete: false,
      canPermanentDelete: false,
      canBulkDelete: true,
    });
  });

  it("maps category actions to the API's dedicated permissions", () => {
    expect(
      resolveCatalogActions([
        PERMISSIONS.CATEGORIES_CREATE,
        PERMISSIONS.CATEGORIES_EDIT,
        PERMISSIONS.CATEGORIES_RESTORE,
        PERMISSIONS.CATEGORIES_PERMANENT_DELETE,
      ]).categories,
    ).toEqual({
      canCreate: true,
      canEdit: true,
      canDelete: false,
      canRestore: true,
      canPermanentDelete: true,
      canBulkDelete: false,
    });

    expect(
      resolveCatalogActions([PERMISSIONS.CATEGORIES_DELETE]).categories,
    ).toMatchObject({
      canDelete: true,
      canPermanentDelete: false,
      canBulkDelete: true,
    });
  });

  it("mirrors attribute restore and permanent-delete backend authority", () => {
    expect(
      resolveCatalogActions([PERMISSIONS.ATTRIBUTES_EDIT]).attributes,
    ).toMatchObject({
      canEdit: true,
      canRestore: true,
      canDelete: false,
      canPermanentDelete: false,
      canBulkDelete: false,
    });

    expect(
      resolveCatalogActions([PERMISSIONS.ATTRIBUTES_DELETE]).attributes,
    ).toMatchObject({
      canEdit: false,
      canRestore: false,
      canDelete: true,
      canPermanentDelete: true,
      canBulkDelete: true,
    });
  });

  it("uses collection edit for row status/reorder and delete for permanent deletion", () => {
    expect(
      resolveCatalogActions([PERMISSIONS.COLLECTIONS_EDIT]).collections,
    ).toMatchObject({
      canEdit: true,
      canToggleStatus: true,
      canReorder: true,
      canDelete: false,
      canPermanentDelete: false,
    });

    expect(
      resolveCatalogActions([PERMISSIONS.COLLECTIONS_DELETE]).collections,
    ).toMatchObject({
      canEdit: false,
      canDelete: true,
      canPermanentDelete: true,
      canBulkDelete: true,
      canToggleStatus: false,
      canReorder: false,
    });
  });
});
