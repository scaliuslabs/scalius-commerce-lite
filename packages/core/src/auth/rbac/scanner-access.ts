// What the warehouse scanner may do, from a staff member's permissions: the
// ceiling a scanner device never exceeds, which of its modes a person can
// use, and whether the scanner is all their role is for (then it is where they
// land after signing in). Pure, so the dashboard and the API read one table.
import { PERMISSIONS } from "./permissions";

/**
 * The most a scanner device may ever do: the permissions its allowlisted
 * routes (`@scalius/shared/scanner-auth`) ask for. Product costs are not
 * among them, so a phone on the warehouse floor never shows them.
 */
export const SCANNER_PERMISSION_CEILING: ReadonlySet<string> = new Set([
  PERMISSIONS.PRODUCTS_VIEW,
  PERMISSIONS.PRODUCTS_ADJUST_STOCK,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.INVENTORY_MANAGE,
]);

/** A scanner's authority: what its staff member may do now, within the ceiling. */
export function scannerPermissions(staffPermissions: ReadonlySet<string>): Set<string> {
  return new Set([...staffPermissions].filter((permission) => SCANNER_PERMISSION_CEILING.has(permission)));
}

/** "receive" books a purchase order or transfer by scan; the others change stock per scan. */
export type ScannerMode = "quick-receive" | "quick-deduct" | "manual" | "receive";

/**
 * The scanner modes these permissions can use, in the order they are shown:
 * a stock change by scan needs to look the code up (`products.view`) and to
 * change stock (`products.adjust_stock`); receiving a document needs to list
 * open purchase orders and transfers (`inventory.view`) and to receive them
 * (`inventory.manage`), the same as their API routes.
 */
export function scannerModes(permissions: ReadonlySet<string>): ScannerMode[] {
  const modes: ScannerMode[] = [];
  if (permissions.has(PERMISSIONS.PRODUCTS_VIEW) && permissions.has(PERMISSIONS.PRODUCTS_ADJUST_STOCK)) {
    modes.push("quick-receive", "quick-deduct", "manual");
  }
  if (permissions.has(PERMISSIONS.INVENTORY_VIEW) && permissions.has(PERMISSIONS.INVENTORY_MANAGE)) {
    modes.push("receive");
  }
  return modes;
}

/** Pairing a scanner (its link, or opening it from the dashboard): the scanner-link route's own check. */
export function canOpenScanner(permissions: ReadonlySet<string>, isSuperAdmin: boolean): boolean {
  return isSuperAdmin || (permissions.has(PERMISSIONS.PRODUCTS_VIEW) && permissions.has(PERMISSIONS.PRODUCTS_ADJUST_STOCK));
}

/**
 * The scanner is all this role is for: every permission it holds is within
 * the scanner's ceiling and it can open the scanner. Such staff land on the
 * scanner after signing in instead of a dashboard page.
 */
export function isScannerOnlyRole(permissions: ReadonlySet<string>, isSuperAdmin: boolean): boolean {
  if (isSuperAdmin || permissions.size === 0) return false;
  return canOpenScanner(permissions, false) && [...permissions].every((permission) => SCANNER_PERMISSION_CEILING.has(permission));
}
