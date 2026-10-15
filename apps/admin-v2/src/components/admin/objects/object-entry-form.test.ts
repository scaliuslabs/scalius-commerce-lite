import { describe, expect, it } from "vitest";
import type { ObjectType, ObjectRecord } from "~/lib/api-query-options/objects";
import {
  createEntryBody,
  entryFormOf,
  entryProblems,
  sameEntryForm,
  updateEntryBody,
} from "./object-entry-form";

const definition: ObjectType = {
  id: "mod_loc",
  handle: "custom.store_locations",
  namespace: "custom",
  type: "store_locations",
  name: "Store locations",
  description: null,
  fields: [
    { key: "title", name: "Name", type: "single_line_text", required: true, validations: {} },
    { key: "opens", name: "Opens", type: "date_time", required: false, validations: {} },
    { key: "seats", name: "Seats", type: "integer", required: false, validations: {} },
    { key: "open_now", name: "Open now", type: "boolean", required: false, validations: {} },
    { key: "phones", name: "Phones", type: "list.single_line_text", required: false, validations: {} },
    { key: "deposit", name: "Deposit", type: "money", required: false, validations: {} },
  ],
  display: "title",
  storefront: true,
  owner: "merchant", admin: "edit", handleEnabled: true, indexes: [], unique: [], events: false,
  recordCount: 1,
  revision: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const entry: ObjectRecord = {
  id: "moe_1",
  typeId: "mod_loc",
  handle: "gulshan",
  displayName: "Gulshan",
  status: "published",
  data: { title: "Gulshan", seats: 12, open_now: true, phones: ["017", "018"] },
  position: 0,
  revision: 3,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const context = { decimalPlaces: 2, currencyCode: "BDT", priceIncrementMinor: 1 };

describe("entry form model", () => {
  it("requires fields for active private records and omits disabled handles", () => {
    const privateType = { ...definition, storefront: false, handleEnabled: false };
    const form = entryFormOf(privateType, null);
    expect(form.status).toBe("active");
    expect(entryProblems(privateType, form, context).fields.title).toEqual({ kind: "required" });
    expect(createEntryBody(privateType, { ...form, handle: "ignored" })).not.toHaveProperty("handle");
  });
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
      expectedRevision: null,
      data: {
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

  it("replaces the complete data at the revision read and omits cleared values", () => {
    const base = entryFormOf(definition, entry);
    const form = { ...base, status: "draft" as const, fields: { ...base.fields, title: "Gulshan 2", seats: "", phones: ["017"] } };
    expect(updateEntryBody(definition, form, base, entry.revision)).toEqual({
      expectedRevision: 3,
      data: { title: "Gulshan 2", open_now: true, phones: ["017"] },
      handle: "gulshan",
      status: "draft",
    });
    expect(updateEntryBody(definition, base, base, 3)).toEqual({ ...createEntryBody(definition, base), expectedRevision: 3 });
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
