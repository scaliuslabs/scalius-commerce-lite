// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { cartPageDependencies, cartPageImportNames } from "./cart-page-harness";

describe("cart page script harness", () => {
  it("supplies a real value for every import of the page script", () => {
    const dependencies = cartPageDependencies();
    expect(Object.keys(dependencies).sort()).toEqual([...cartPageImportNames].sort());
    for (const value of Object.values(dependencies)) expect(value).toBeDefined();
    expect(cartPageImportNames).toContain("phoneHintCopy");
  });

  it("lets a test replace one import without losing the rest", () => {
    const stub = () => Promise.resolve();
    const dependencies = cartPageDependencies({ initCartFunctionality: stub });
    expect(dependencies.initCartFunctionality).toBe(stub);
    expect(dependencies.pagePath).toBeTypeOf("function");
  });
});
