import { describe, expect, it } from "vitest";

import { generateAdminBreadcrumbs } from "./adminBreadCrumb";

describe("admin breadcrumbs", () => {
  it("uses the merchant-facing incomplete checkout name", () => {
    expect(generateAdminBreadcrumbs("/admin/abandoned-checkouts")).toEqual([
      { title: "Incomplete Checkouts", href: undefined },
    ]);
  });

  it("uses the merchant-facing fraud checks name", () => {
    expect(generateAdminBreadcrumbs("/admin/settings/fraud-checker")).toEqual([
      { title: "Settings", href: "/admin/settings" },
      { title: "Fraud checks", href: undefined },
    ]);
  });

  it("keeps internal article IDs out of edit breadcrumbs", () => {
    expect(
      generateAdminBreadcrumbs("/admin/articles/article_internal-id/edit"),
    ).toEqual([
      { title: "Articles", href: "/admin/articles" },
      { title: "Edit", href: undefined },
    ]);
  });
});
