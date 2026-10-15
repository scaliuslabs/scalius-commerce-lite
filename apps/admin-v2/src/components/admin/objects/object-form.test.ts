import { describe, expect, it } from "vitest";
import { objectTypeInputSchema } from "@scalius/shared/plugins/objects";
import type { ObjectType } from "~/lib/api-query-options/objects";
import {
  blankRow,
  createTypeBody,
  emptyTypeDraft,
  hasTypeProblems,
  moveRow,
  typeDraftOf,
  typeDraftProblems,
  typeDraftSnapshot,
  uniqueKey,
  updateTypeBody,
  withName,
  withRowName,
  type TypeDraft,
} from "./object-form";

const faq: ObjectType = {
  id: "mod_faq",
  handle: "custom.faq",
  namespace: "custom",
  type: "faq",
  name: "Questions and answers",
  description: null,
  fields: [
    { key: "question", name: "Question", type: "single_line_text", required: true, validations: {} },
    { key: "answer", name: "Answer", type: "multi_line_text", required: false, validations: {}, description: "Plain text" },
  ],
  display: "question",
  storefront: true,
  owner: "merchant", admin: "edit", handleEnabled: true, indexes: [], unique: [], events: false,
  recordCount: 3,
  revision: 4,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function filled(): TypeDraft {
  let draft = withName(emptyTypeDraft(), "Size chart");
  draft = withRowName(draft, draft.fields[0]!.rowId, "Size label");
  draft = { ...draft, fields: [...draft.fields, { ...blankRow(), name: "Chest", key: "chest", keyEdited: true, type: "list.integer", required: true, description: "In inches" }] };
  return draft;
}

describe("object type form model", () => {
  it("saves scalar indexes and preserves compound indexes and declaration policies", () => {
    const current = { ...faq, indexes: [["question", "answer"]], unique: ["question"], events: true };
    const draft = typeDraftOf(current);
    draft.fields[1]!.indexed = true;
    const body = updateTypeBody(draft, current.revision, current);
    expect(body).toMatchObject({ indexes: [["question", "answer"], "answer"], unique: ["question"], events: true, admin: "edit", handle: true });
  });

  it("derives the handle from the name until it is edited, and each field key from its name", () => {
    const draft = filled();
    expect(draft.handle).toBe("size_chart");
    expect(draft.fields[0]).toMatchObject({ name: "Size label", key: "size_label" });
    const edited = withName({ ...draft, handle: "sizes", handleEdited: true }, "Size guide");
    expect(edited.handle).toBe("sizes");
    // A key the merchant edited stays when the name changes.
    const kept = withRowName({ ...draft, fields: draft.fields.map((row, index) => (index === 0 ? { ...row, key: "label", keyEdited: true } : row)) }, draft.fields[0]!.rowId, "Size name");
    expect(kept.fields[0]!.key).toBe("label");
  });

  it("keeps keys unique across the rows", () => {
    expect(uniqueKey("Title", ["title"])).toBe("title_2");
    expect(uniqueKey("Title", ["title", "title_2"])).toBe("title_3");
    expect(uniqueKey("!!", [])).toBe("");
  });

  it("builds the create body with fields, display field and storefront access", () => {
    const draft = { ...filled(), display: "chest", storefront: true, description: " For the size page " };
    const body = createTypeBody(draft);
    expect(body).toEqual({
      type: "size_chart",
      name: "Size chart",
      description: "For the size page",
      fields: [
        { key: "size_label", name: "Size label", type: "single_line_text", required: false, validations: {} },
        { key: "chest", name: "Chest", type: "list.integer", required: true, description: "In inches", validations: {} },
      ],
      display: "chest",
      storefront: true,
      indexes: [],
      admin: "edit", handle: true,
    });
    // The API accepts exactly this.
    expect(objectTypeInputSchema.safeParse(body).success).toBe(true);
  });

  it("leaves out a display field that is no longer a field", () => {
    const body = createTypeBody({ ...filled(), display: "removed" });
    expect(body).not.toHaveProperty("display");
    expect(body.storefront).toBe(false);
  });

  it("builds the update body at the revision read, without the handle", () => {
    const draft = typeDraftOf(faq);
    expect(draft.handle).toBe("faq");
    expect(draft.fields.every((row) => row.saved && row.keyEdited)).toBe(true);
    const body = updateTypeBody({ ...draft, storefront: false }, faq.revision, faq);
    expect(body).toEqual({
      name: "Questions and answers",
      fields: [
        { key: "question", name: "Question", type: "single_line_text", required: true, validations: {} },
        { key: "answer", name: "Answer", type: "multi_line_text", required: false, validations: {}, description: "Plain text" },
      ],
      display: "question",
      storefront: false,
      expectedRevision: 4,
      indexes: [], unique: [], admin: "edit", events: false, handle: true,
    });
    expect(body).not.toHaveProperty("type");
  });

  it("tells edits from none", () => {
    const draft = typeDraftOf(faq);
    expect(typeDraftSnapshot(typeDraftOf(faq))).toBe(typeDraftSnapshot(draft));
    expect(typeDraftSnapshot({ ...draft, name: "FAQ" })).not.toBe(typeDraftSnapshot(draft));
  });

  it("finds what the API would refuse", () => {
    expect(hasTypeProblems(typeDraftProblems(filled(), true))).toBe(false);
    const empty = typeDraftProblems(emptyTypeDraft(), true);
    expect(empty.name).toBe("nameRequired");
    expect(empty.handle).toBe("handleInvalid");
    expect(Object.values(empty.rows)[0]).toEqual({ name: "fieldNameRequired", key: "fieldKeyInvalid" });
    const draft = filled();
    const twice = typeDraftProblems({ ...draft, fields: draft.fields.map((row) => ({ ...row, key: "same" })) }, false);
    expect(twice.rows[draft.fields[1]!.rowId]).toEqual({ key: "fieldKeyTaken" });
    // The handle of a saved type is not checked again.
    expect(typeDraftProblems({ ...draft, handle: "" }, false).handle).toBeUndefined();
    expect(typeDraftProblems({ ...draft, fields: [] }, false).fields).toBe("fieldsRequired");
  });

  it("moves a row by one place and stops at the ends", () => {
    const draft = filled();
    const names = (fields: typeof draft.fields) => fields.map((row) => row.name);
    expect(names(moveRow(draft.fields, 0, 1))).toEqual(["Chest", "Size label"]);
    expect(names(moveRow(draft.fields, 0, -1))).toEqual(["Size label", "Chest"]);
  });
});
