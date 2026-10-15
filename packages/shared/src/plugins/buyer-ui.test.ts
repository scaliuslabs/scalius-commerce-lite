import { describe, expect, it } from "vitest";
import { buyerUiOutputSchema, checkoutAttributesSchema, readCheckoutAttributes, groupCheckoutAttributes } from "./buyer-ui";
describe("buyer UI boundary", () => {
  it("accepts only declarative bounded nodes", () => {
    expect(buyerUiOutputSchema.safeParse({ ui: { type: "stack", children: [{ type: "text", text: "<script>text only</script>" }, { type: "field", attribute: "gift" }] } }).success).toBe(true);
    expect(buyerUiOutputSchema.safeParse({ ui: { type: "html", html: "<script>bad</script>" } }).success).toBe(false);
    let node: unknown = { type: "text", text: "hello" };
    for (let i = 0; i < 9; i++) node = { type: "stack", children: [node] };
    expect(buyerUiOutputSchema.safeParse({ ui: node }).success).toBe(false);
  });
  it.each(["https://outside.test", "//outside.test", "/\\outside.test", "/%2e%2e/secret", "/cart?private=1"])("refuses unsafe link %s", (path) => {
    expect(buyerUiOutputSchema.safeParse({ ui: { type: "link", text: "go", path } }).success).toBe(false);
  });
  it("limits attributes by UTF-8 bytes and reads stored attributes strictly", () => {
    expect(checkoutAttributesSchema.safeParse(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`app.name.${i}`, "অ".repeat(500)]))).success).toBe(false);
    expect(readCheckoutAttributes('{"x":12}')).toEqual({});
    expect(groupCheckoutAttributes('{"app.name.gift":"yes"}')).toEqual([{ appId: "app.name", attributes: [{ key: "gift", value: "yes" }] }]);
  });
});
