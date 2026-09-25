// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCOUNT_PAGE_CONTAINER } from "./account-format";

const page = (path: string) => readFileSync(new URL(`../pages/${path}`, import.meta.url), "utf8");

describe("account page width", () => {
  it.each(["account.astro", "account/inbox/index.astro", "account/orders/[id].astro"])(
    "%s uses the one account container, so the Account/Inbox tabs don't shift",
    (path) => {
      expect(page(path)).toMatch(/<section class=\{ACCOUNT_PAGE_CONTAINER\}/);
    },
  );

  it("is wide enough for the account's two columns", () => {
    expect(ACCOUNT_PAGE_CONTAINER).toContain("max-w-5xl");
  });
});
