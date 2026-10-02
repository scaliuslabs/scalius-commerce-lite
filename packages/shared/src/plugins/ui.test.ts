import { describe, expect, it } from "vitest";
import {
  PLUGIN_UI_LIMITS,
  parsePluginUiActionResult,
  parsePluginUiDocument,
  pluginUiRouteActions,
  type PluginUiNode,
} from "./ui";

const doc = (root: unknown) => ({ version: 1, root });
const page = (...children: unknown[]) => doc({ type: "page", children });

function issues(value: unknown) {
  const result = parsePluginUiDocument(value);
  if (result.ok) throw new Error("expected the tree to be refused");
  return result;
}

describe("plugin UI tree", () => {
  it("accepts every node type in a page", () => {
    const tree: PluginUiNode = {
      type: "page",
      title: "Wishlist",
      description: "What buyers save",
      actions: [{ type: "button", label: "Export", action: { route: "export" } }],
      children: [
        { type: "section", title: "Today", children: [{ type: "stat", label: "Wishes", value: 12, help: "since midnight" }] },
        {
          type: "card",
          title: "Top",
          children: [
            { type: "stack", direction: "horizontal", gap: "sm", children: [{ type: "badge", text: "New", tone: "info" }] },
            { type: "columns", children: [{ type: "heading", text: "One", level: 3 }, { type: "text", text: "Two", tone: "neutral", size: "sm", emphasis: "mono" }] },
          ],
        },
        { type: "banner", tone: "warning", title: "Heads up", text: "Plain text <b>only</b>", actions: [{ type: "button", label: "Fix", to: { kind: "app-page", page: "settings" } }] },
        { type: "key-value", items: [{ label: "Plan", value: "Pro" }, { label: "Active", value: true }, { label: "Seats", value: null }] },
        {
          type: "table",
          caption: "Most wished",
          columns: [{ key: "product", label: "Product" }, { key: "count", label: "Wishes", align: "end" }, { key: "total", label: "Value" }, { key: "at", label: "Last" }, { key: "state", label: "" }],
          rows: [{
            id: "p1",
            to: { kind: "resource", resource: "product", id: "p1" },
            cells: {
              product: { text: "Panjabi", to: { kind: "resource", resource: "product", id: "p1" } },
              count: 3,
              total: { money: 250000 },
              at: { date: "2026-10-01T10:00:00Z" },
              state: { badge: "Live", tone: "success" },
            },
          }],
          pagination: { next: "c2", previous: null, total: 40 },
          empty: { title: "No wishes yet" },
        },
        { type: "empty-state", title: "Nothing here", text: "Add one", action: { type: "button", label: "Add", action: { route: "add", method: "POST" } } },
        { type: "image", src: "https://cdn.example.com/a.png", alt: "Chart", width: 400, height: 200 },
        { type: "link", text: "Docs", to: { kind: "external", href: "https://example.com/docs" } },
        { type: "divider" },
        {
          type: "form",
          action: { route: "save", method: "PUT", body: { scope: "all" } },
          submitLabel: "Save",
          confirm: { title: "Save?", destructive: false },
          children: [
            { type: "text-field", name: "title", label: "Title", required: true, maxLength: 80, error: "Too short" },
            { type: "textarea", name: "notes", label: "Notes", rows: 4 },
            { type: "number-field", name: "limit", label: "Limit", min: 1, max: 10, integer: true, value: 3 },
            { type: "select", name: "mode", label: "Mode", options: [{ value: "a", label: "A" }], value: "a" },
            { type: "checkbox", name: "on", label: "On", value: true },
            { type: "date-field", name: "from", label: "From", value: "2026-10-01" },
          ],
        },
      ],
    };
    const result = parsePluginUiDocument(doc(tree));
    expect(result).toMatchObject({ ok: true });
  });

  it("reports a newer version instead of guessing", () => {
    expect(issues({ version: 2, root: { type: "page", children: [] } }).reason).toBe("version");
  });

  it("refuses unknown nodes, HTML-ish fields and unknown properties", () => {
    expect(issues(page({ type: "script", src: "x" })).issues[0]!.path).toBe("root.children.0.type");
    expect(issues(page({ type: "text", text: "hi", html: "<b>x</b>" })).reason).toBe("invalid");
    expect(issues(page({ type: "text", text: 1 })).issues[0]!.message).toMatch(/string/);
  });

  it("allows links only to app pages, Scalius resources and https sites", () => {
    expect(issues(page({ type: "link", text: "x", to: { kind: "external", href: "javascript:alert(1)" } })).reason).toBe("invalid");
    expect(issues(page({ type: "link", text: "x", to: { kind: "external", href: "http://example.com" } })).reason).toBe("invalid");
    expect(issues(page({ type: "link", text: "x", to: { kind: "external", href: "https://user:pw@example.com" } })).reason).toBe("invalid");
    expect(issues(page({ type: "link", text: "x", to: { kind: "resource", resource: "settings", id: "1" } })).reason).toBe("invalid");
    expect(issues(page({ type: "image", src: "http://example.com/a.png", alt: "" })).reason).toBe("invalid");
  });

  it("posts only to a route name with plain path segments", () => {
    expect(issues(page({ type: "button", label: "Go", action: { route: "../../admin" } })).reason).toBe("invalid");
    expect(issues(page({ type: "button", label: "Go", action: { route: "go", subpath: "../x" } })).reason).toBe("invalid");
    expect(issues(page({ type: "button", label: "Go", action: { route: "go", method: "GET" } })).reason).toBe("invalid");
    expect(issues(page({ type: "button", label: "Go" })).reason).toBe("invalid");
    expect(issues(page({ type: "button", label: "Go", action: { route: "go" }, to: { kind: "app-page", page: "x" } })).reason).toBe("invalid");
  });

  it("keeps inputs inside forms, names unique, forms unnested and pages at the root", () => {
    expect(issues(page({ type: "text-field", name: "a", label: "A" })).issues[0]!.message).toMatch(/inside a form/);
    expect(issues(page({
      type: "form", action: { route: "s" }, submitLabel: "Save",
      children: [{ type: "checkbox", name: "a", label: "A" }, { type: "checkbox", name: "a", label: "B" }],
    })).issues[0]!.message).toMatch(/Two inputs/);
    expect(issues(page({
      type: "form", action: { route: "s" }, submitLabel: "Save",
      children: [{ type: "form", action: { route: "t" }, submitLabel: "Inner", children: [] }],
    })).issues[0]!.message).toMatch(/do not nest/);
    expect(issues(page({ type: "page", children: [] })).issues[0]!.message).toMatch(/only ever the root/);
    expect(issues(page({ type: "form", action: { route: "s" }, submitLabel: "S", children: [{ type: "select", name: "m", label: "M", options: [{ value: "a", label: "A" }], value: "b" }] })).reason).toBe("invalid");
  });

  it("bounds size, depth and table shape", () => {
    let deep: unknown = { type: "text", text: "leaf" };
    for (let level = 0; level < PLUGIN_UI_LIMITS.maxDepth + 1; level += 1) deep = { type: "stack", children: [deep] };
    expect(issues(doc(deep)).issues[0]!.message).toMatch(/nests at most/);

    const many = Array.from({ length: 100 }, () => ({ type: "stack", children: Array.from({ length: 5 }, () => ({ type: "divider" })) }));
    expect(issues(page(...many)).issues[0]!.message).toMatch(/at most 400 nodes/);

    const hugeWithKv = page(...Array.from({ length: 50 }, () => ({ type: "key-value", items: Array.from({ length: 50 }, () => ({ label: "l", value: "v".repeat(2_000) })) })));
    expect(issues(hugeWithKv).reason).toBe("too_large");

    expect(issues(page({ type: "table", columns: [{ key: "a", label: "A" }, { key: "a", label: "B" }], rows: [] })).issues[0]!.message).toMatch(/unique/);
    expect(issues(page({ type: "table", columns: [{ key: "a", label: "A" }], rows: [{ cells: { b: 1 } }] })).issues[0]!.message).toMatch(/Unknown column/);
  });

  it("lists every route action for the dashboard to check against declared routes", () => {
    const tree = page(
      { type: "button", label: "A", action: { route: "a" } },
      { type: "card", actions: [{ type: "button", label: "B", action: { route: "b", method: "DELETE" } }], children: [] },
      { type: "form", action: { route: "c" }, submitLabel: "C", children: [] },
      { type: "empty-state", title: "E", action: { type: "button", label: "D", action: { route: "d" } } },
    );
    const result = parsePluginUiDocument(tree);
    if (!result.ok) throw new Error("expected a valid tree");
    expect(pluginUiRouteActions(result.document.root).map((action) => action.route)).toEqual(["a", "b", "c", "d"]);
  });

  it("reads action results leniently: anything else is an empty result", () => {
    expect(parsePluginUiActionResult({ toast: { message: "Saved" }, refresh: true })).toEqual({ toast: { message: "Saved" }, refresh: true });
    expect(parsePluginUiActionResult({ errors: { title: "Required" } })).toEqual({ errors: { title: "Required" } });
    expect(parsePluginUiActionResult({ ok: true })).toEqual({});
    expect(parsePluginUiActionResult({ navigate: { kind: "external", href: "javascript:x" } })).toEqual({});
  });
});
