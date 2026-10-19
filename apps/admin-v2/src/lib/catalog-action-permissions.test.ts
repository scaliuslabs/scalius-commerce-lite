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
      inventory: {
        canAdjustStock: false,
        canSetAlertLevels: false,
        canAcknowledgeAlerts: false,
        canViewCosts: false,
        canEditCosts: false,
        canManageOperations: false,
        canDraftPurchaseOrders: false,
        canManageLocations: false,
      },
    });
  });

  it("keeps costs and inventory operations behind their own permissions", () => {
    // Editing products keeps alert levels; stock needs "Adjust stock"; neither shows costs nor runs purchasing.
    expect(resolveCatalogActions([PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT]).inventory).toMatchObject({
      canAdjustStock: false,
      canSetAlertLevels: true,
      canViewCosts: false,
      canEditCosts: false,
      canManageOperations: false,
      canDraftPurchaseOrders: false,
      canManageLocations: false,
    });
    expect(resolveCatalogActions([PERMISSIONS.PRODUCTS_EDIT, PERMISSIONS.PRODUCTS_VIEW_COSTS]).inventory)
      .toMatchObject({ canViewCosts: true, canEditCosts: true });
    // Receiving and transfers without costs; drafting a purchase order sets them.
    expect(resolveCatalogActions([PERMISSIONS.INVENTORY_MANAGE]).inventory)
      .toMatchObject({ canManageOperations: true, canDraftPurchaseOrders: false, canManageLocations: true });
    expect(resolveCatalogActions([PERMISSIONS.INVENTORY_MANAGE, PERMISSIONS.PRODUCTS_VIEW_COSTS]).inventory)
      .toMatchObject({ canDraftPurchaseOrders: true });
    expect(resolveCatalogActions([PERMISSIONS.SETTINGS_GENERAL_EDIT]).inventory)
      .toMatchObject({ canManageLocations: true, canManageOperations: false });
  });

  it("keeps product actions granular and ties stock adjustment to its own permission", () => {
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
      inventory: { canAdjustStock: false, canSetAlertLevels: true, canAcknowledgeAlerts: true, canViewCosts: false },
    });
    expect(resolveCatalogActions([PERMISSIONS.PRODUCTS_ADJUST_STOCK]).inventory)
      .toMatchObject({ canAdjustStock: true, canSetAlertLevels: false });

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
