import { describe, expect, it } from "vitest";

import { generateAdminBreadcrumbs } from "./adminBreadCrumb";

describe("admin breadcrumbs", () => {
  it("uses the merchant-facing incomplete checkout name", () => {
    expect(generateAdminBreadcrumbs("/admin/abandoned-checkouts")).toEqual([
      { title: "Incomplete Checkouts", href: undefined },
    ]);
  });
});
