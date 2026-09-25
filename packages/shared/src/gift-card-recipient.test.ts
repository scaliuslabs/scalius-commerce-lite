import { describe, expect, it } from "vitest";
import { withGiftCardRecipientFields } from "./gift-card-recipient";
import { resolveLineProperties, type CustomizationSchema } from "./line-properties";

describe("gift-card recipient inputs", () => {
  it("adds the optional recipient inputs after the product's own, within the field limit", () => {
    const own: CustomizationSchema = {
      version: 1,
      fields: Array.from({ length: 10 }, (_, index) => ({
        key: `note_${index}`, type: "text" as const, label: `Note ${index}`, required: false, help: null, maxLength: 20, priceMinor: 0,
      })),
    };
    const schema = withGiftCardRecipientFields(own);
    expect(schema.fields).toHaveLength(10);
    expect(schema.fields.slice(-4).map((field) => field.key))
      .toEqual(["_gc_recipient_name", "_gc_recipient_email", "_gc_recipient_phone", "_gc_message"]);
    expect(withGiftCardRecipientFields(null).fields.every((field) => !field.required)).toBe(true);
  });

  it("lets a buyer leave them empty or fill them, like any buyer input", () => {
    const schema = withGiftCardRecipientFields(null);
    expect(resolveLineProperties(schema, [])).toMatchObject({ ok: true, properties: [] });
    const filled = resolveLineProperties(schema, [
      { key: "_gc_recipient_name", value: "Sadia" },
      { key: "_gc_recipient_email", value: "sadia@example.test" },
      { key: "_gc_message", value: "Eid Mubarak" },
    ]);
    expect(filled.ok && filled.properties.map((property) => property.key))
      .toEqual(["_gc_recipient_name", "_gc_recipient_email", "_gc_message"]);
  });
});
