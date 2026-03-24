// src/lib/adminBreadCrumb.ts

export interface BreadcrumbItem {
  title: string;
  href?: string;
}

/**
 * Generates breadcrumb items for admin pages, handling special cases where ID segments should be excluded
 * @param currentPath - The current URL pathname
 * @returns Array of breadcrumb items
 */
export function generateAdminBreadcrumbs(
  currentPath: string,
): BreadcrumbItem[] {
  const pathSegments = currentPath.split("/").filter(Boolean);

  // Drop the leading "admin" segment — the Breadcrumb component already
  // renders a Home icon that links to /admin, so including "Admin" as a
  // text breadcrumb would duplicate it.
  const segments = pathSegments[0] === "admin" ? pathSegments.slice(1) : pathSegments;

  // If we're on exactly /admin (dashboard), no extra breadcrumb items needed
  // — the Home icon alone is sufficient.
  if (segments.length === 0) return [];

  // Entities that use /:id/ sub-routes (view, edit, history, invoice, etc.)
  const entitiesWithIds = new Set([
    "categories",
    "collections",
    "pages",
    "widgets",
    "discounts",
    "analytics",
    "customers",
    "products",
    "orders",
  ]);

  const breadcrumbItems: BreadcrumbItem[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    // Skip ID segments (e.g. the UUID between "products" and "edit")
    if (i >= 1 && entitiesWithIds.has(segments[0]) && i === 1) {
      // segments[1] is the ID — skip it
      continue;
    }

    const href = `/admin/${segments.slice(0, i + 1).join("/")}`;
    const isLast = i === segments.length - 1;

    // Friendly title: capitalize, handle hyphenated words
    const title = segment
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    breadcrumbItems.push({
      title,
      href: isLast ? undefined : href,
    });
  }

  return breadcrumbItems;
}
