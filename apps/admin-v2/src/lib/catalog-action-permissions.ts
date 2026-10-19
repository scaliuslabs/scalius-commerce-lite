import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import type { PermissionName } from "@scalius/core/auth/rbac/types";

type HasPermission = (permission: PermissionName | string) => boolean;

/**
 * Catalog mutation capabilities mirrored from the API route permission map.
 *
 * Inventory intentionally shares product permissions because sellable and
 * stock identities are product variants. Attributes and collections do not
 * currently expose separate permanent-delete permissions, so those actions
 * use their API's existing delete permission. Attribute restore uses edit,
 * matching the backend route.
 */
export interface CatalogActionPermissions {
  products: {
    canCreate: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canRestore: boolean;
    canPermanentDelete: boolean;
    canBulkDelete: boolean;
  };
  categories: {
    canCreate: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canRestore: boolean;
    canPermanentDelete: boolean;
    canBulkDelete: boolean;
  };
  attributes: {
    canCreate: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canRestore: boolean;
    canPermanentDelete: boolean;
    canBulkDelete: boolean;
  };
  collections: {
    canCreate: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canRestore: boolean;
    canPermanentDelete: boolean;
    canBulkDelete: boolean;
    canToggleStatus: boolean;
    canReorder: boolean;
  };
  inventory: {
    /** On-hand quantities: adjustments, counts, imports and the quantities a product save sets. */
    canAdjustStock: boolean;
    /** Low-stock alert levels (product data). */
    canSetAlertLevels: boolean;
    canAcknowledgeAlerts: boolean;
    /** "View product costs": cost per item, margins, inventory value, purchase-order money. */
    canViewCosts: boolean;
    /** Changing a cost per item (products.edit) needs to see costs too. */
    canEditCosts: boolean;
    /** Suppliers, purchase orders and transfers: create, edit, receive, ship, cancel. */
    canManageOperations: boolean;
    /** Drafting or editing a purchase order sets unit costs. */
    canDraftPurchaseOrders: boolean;
    /** Add, edit, archive locations: inventory operations or store settings. */
    canManageLocations: boolean;
  };
}

export function getCatalogActionPermissions(
  hasPermission: HasPermission,
): CatalogActionPermissions {
  const canEditProducts = hasPermission(PERMISSIONS.PRODUCTS_EDIT);
  const canDeleteCategories = hasPermission(PERMISSIONS.CATEGORIES_DELETE);
  const canEditAttributes = hasPermission(PERMISSIONS.ATTRIBUTES_EDIT);
  const canDeleteAttributes = hasPermission(PERMISSIONS.ATTRIBUTES_DELETE);
  const canEditCollections = hasPermission(PERMISSIONS.COLLECTIONS_EDIT);
  const canDeleteCollections = hasPermission(PERMISSIONS.COLLECTIONS_DELETE);
  const canViewCosts = hasPermission(PERMISSIONS.PRODUCTS_VIEW_COSTS);
  const canManageOperations = hasPermission(PERMISSIONS.INVENTORY_MANAGE);

  return {
    products: {
      canCreate: hasPermission(PERMISSIONS.PRODUCTS_CREATE),
      canEdit: canEditProducts,
      canDelete: hasPermission(PERMISSIONS.PRODUCTS_DELETE),
      canRestore: hasPermission(PERMISSIONS.PRODUCTS_RESTORE),
      canPermanentDelete: hasPermission(
        PERMISSIONS.PRODUCTS_PERMANENT_DELETE,
      ),
      canBulkDelete: hasPermission(PERMISSIONS.PRODUCTS_BULK_OPERATIONS),
    },
    categories: {
      canCreate: hasPermission(PERMISSIONS.CATEGORIES_CREATE),
      canEdit: hasPermission(PERMISSIONS.CATEGORIES_EDIT),
      canDelete: canDeleteCategories,
      canRestore: hasPermission(PERMISSIONS.CATEGORIES_RESTORE),
      canPermanentDelete: hasPermission(
        PERMISSIONS.CATEGORIES_PERMANENT_DELETE,
      ),
      canBulkDelete: canDeleteCategories,
    },
    attributes: {
      canCreate: hasPermission(PERMISSIONS.ATTRIBUTES_CREATE),
      canEdit: canEditAttributes,
      canDelete: canDeleteAttributes,
      canRestore: canEditAttributes,
      canPermanentDelete: canDeleteAttributes,
      canBulkDelete: canDeleteAttributes,
    },
    collections: {
      canCreate: hasPermission(PERMISSIONS.COLLECTIONS_CREATE),
      canEdit: canEditCollections,
      canDelete: canDeleteCollections,
      canRestore: hasPermission(PERMISSIONS.COLLECTIONS_RESTORE),
      canPermanentDelete: canDeleteCollections,
      canBulkDelete: canDeleteCollections,
      // The current row switch and reorder calls use the generic update and
      // reorder endpoints, both guarded by collections.edit.
      canToggleStatus: canEditCollections,
      canReorder: canEditCollections,
    },
    inventory: {
      canAdjustStock: hasPermission(PERMISSIONS.PRODUCTS_ADJUST_STOCK),
      canSetAlertLevels: canEditProducts,
      canAcknowledgeAlerts: canEditProducts,
      canViewCosts,
      canEditCosts: canEditProducts && canViewCosts,
      canManageOperations,
      canDraftPurchaseOrders: canManageOperations && canViewCosts,
      canManageLocations: canManageOperations || hasPermission(PERMISSIONS.SETTINGS_GENERAL_EDIT),
    },
  };
}
