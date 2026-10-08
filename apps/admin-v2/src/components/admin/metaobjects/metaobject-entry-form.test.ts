import { describe, expect, it } from "vitest";
import type { MetaobjectDefinition, MetaobjectEntry } from "~/lib/api-query-options/metaobjects";
import {
  createEntryBody,
  entryFormOf,
  entryProblems,
  sameEntryForm,
  updateEntryBody,
} from "./metaobject-entry-form";

const definition: MetaobjectDefinition = {
  id: "mod_loc",
  handle: "custom.store_locations",
  namespace: "custom",
  type: "store_locations",
  name: "Store locations",
  description: null,
  fields: [
    { key: "title", name: "Name", type: "single_line_text", required: true },
    { key: "opens", name: "Opens", type: "date_time", required: false },
    { key: "seats", name: "Seats", type: "integer", required: false },
    { key: "open_now", name: "Open now", type: "boolean", required: false },
    { key: "phones", name: "Phones", type: "list.single_line_text", required: false },
    { key: "deposit", name: "Deposit", type: "money", required: false },
  ],
  displayField: "title",
  storefrontAccess: true,
  owner: "merchant",
  entryCount: 1,
  revision: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const entry: MetaobjectEntry = {
  id: "moe_1",
  definitionId: "mod_loc",
  handle: "gulshan",
  displayName: "Gulshan",
  status: "published",
  fields: { title: "Gulshan", seats: 12, open_now: true, phones: ["017", "018"] },
  position: 0,
  revision: 3,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const context = { decimalPlaces: 2, currencyCode: "BDT", priceIncrementMinor: 1 };

describe("entry form model", () => {
  it("shows stored values as drafts of each field's type", () => {
    const form = entryFormOf(definition, entry);
    expect(form).toMatchObject({ handle: "gulshan", status: "published" });
    expect(form.fields).toMatchObject({ title: "Gulshan", opens: "", seats: "12", open_now: "true", phones: ["017", "018"], deposit: "" });
    expect(entryFormOf(definition, null)).toMatchObject({ handle: "", status: "draft" });
  });

  it("sends typed values on create and leaves out the empty ones", () => {
    const form = entryFormOf(definition, null);
    form.fields.title = " Dhanmondi ";
    form.fields.seats = "40";
    form.fields.open_now = "false";
    form.fields.phones = ["019", "", "016"];
    form.fields.deposit = "250.5";
    form.fields.opens = "2026-11-01T10:30";
    const body = createEntryBody(definition, form);
    expect(body).toEqual({
      status: "draft",
      fields: {
        title: "Dhanmondi",
        opens: new Date("2026-11-01T10:30").toISOString(),
        seats: "40",
        open_now: false,
        phones: ["019", "016"],
        deposit: "250.5",
      },
    });
    // Text-typed numbers go to the API's codec, which reads them; the handle is sent only when typed.
    expect(createEntryBody(definition, { ...form, handle: " dhanmondi " })).toMatchObject({ handle: "dhanmondi" });
  });

  it("sends only what changed on update, a cleared field as null, at the revision read", () => {
    const base = entryFormOf(definition, entry);
    const form = { ...base, status: "draft" as const, fields: { ...base.fields, title: "Gulshan 2", seats: "", phones: ["017"] } };
    expect(updateEntryBody(definition, form, base, entry.revision)).toEqual({
      expectedRevision: 3,
      fields: { title: "Gulshan 2", seats: null, phones: ["017"] },
      status: "draft",
    });
    expect(updateEntryBody(definition, base, base, 3)).toEqual({ expectedRevision: 3 });
    expect(sameEntryForm(definition, base, entryFormOf(definition, entry))).toBe(true);
    expect(sameEntryForm(definition, form, base)).toBe(false);
  });

  it("asks for required fields only to publish, and reads each value as its type", () => {
    const draft = entryFormOf(definition, null);
    expect(entryProblems(definition, draft, context).fields).toEqual({});
    const publishing = entryProblems(definition, { ...draft, status: "published" }, context);
    expect(publishing.fields.title).toEqual({ kind: "required" });
    const bad = entryFormOf(definition, null);
    bad.fields.seats = "many";
    bad.fields.deposit = "12.345";
    const found = entryProblems(definition, bad, context);
    expect(found.fields.seats).toMatchObject({ kind: "value" });
    expect(found.fields.deposit).toMatchObject({ kind: "value" });
    expect(entryProblems(definition, { ...draft, handle: "Not valid" }, context).handle).toBe("handleInvalid");
  });
});
