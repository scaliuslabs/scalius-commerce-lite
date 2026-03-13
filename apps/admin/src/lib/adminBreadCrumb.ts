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

  const breadcrumbItems = pathSegments
    .map((segment: string, index: number): BreadcrumbItem | null => {
      // Special handling for customer history page
      if (
        pathSegments[0] === "admin" &&
        pathSegments[1] === "customers" &&
        pathSegments[3] === "history"
      ) {
        if (index === 0) return { title: "Admin", href: "/admin" };
        if (index === 1)
          return { title: "Customers", href: "/admin/customers" };
        if (index === 3) return { title: "History" };
        return null;
      }

      // Special handling for admin pages with IDs - exclude the ID segment
      const adminPagesWithIds = [
        "categories",
        "collections",
        "pages",
        "widgets",
        "discounts",
        "analytics",
        "customers",
        "products",
        "orders",
      ];

      if (
        pathSegments[0] === "admin" &&
        adminPagesWithIds.includes(pathSegments[1]) &&
        pathSegments[2] && // has an ID
        index === 2 // this is the ID segment
      ) {
        return null; // Exclude ID segment completely from breadcrumb
      }

      // Generate normal breadcrumb item
      const href = `/${pathSegments.slice(0, index + 1).join("/")}`;
      return {
        title: segment.charAt(0).toUpperCase() + segment.slice(1),
        href: index === pathSegments.length - 1 ? undefined : href,
      };
    })
    .filter(
      (item: BreadcrumbItem | null): item is BreadcrumbItem => item !== null,
    );

  return breadcrumbItems;
}
