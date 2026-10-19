import { describe, expect, it } from "vitest";
import { compileJq } from "../src/jq.js";
import { parseSelect, selectPointers } from "../src/select.js";

const data = {
  total: 3,
  items: [
    { id: "p1", name: "Panjabi", price: 1500, tags: ["eid"], stock: { available: 2 } },
    { id: "p2", name: "Shirt", price: 800, tags: [], stock: { available: 0 } },
    { id: "p3", name: "Saree", price: 3200, tags: ["eid", "silk"], stock: { available: 9 } },
  ],
};

const run = (expression: string, input: unknown = data) => compileJq(expression)(input);

describe("built-in --jq", () => {
  it.each([
    [".total", [3]],
    [".items[0].name", ["Panjabi"]],
    [".items[].id", ["p1", "p2", "p3"]],
    [".items | length", [3]],
    [".items[] | select(.price > 1000) | .id", ["p1", "p3"]],
    ["[.items[] | .price] | add", [5500]],
    [".items | map(.stock.available) | max", [9]],
    [".items | sort_by(.price) | .[0].name", ["Shirt"]],
    [".items[] | {id, low: (.stock.available < 3)}", [{ id: "p1", low: true }, { id: "p2", low: true }, { id: "p3", low: false }]],
    [".items | map(select(.tags | contains([\"eid\"]))) | length", [2]],
    [".items[] | [.id, .price] | @csv", ["\"p1\",1500", "\"p2\",800", "\"p3\",3200"]],
    [".missing // \"none\"", ["none"]],
    ["if .total > 2 then \"many\" else \"few\" end", ["many"]],
    [".items | group_by(.tags | length) | map(length)", [[1, 1, 1]]],
    [".items[1:] | map(.id)", [["p2", "p3"]]],
    [".items[-1].id", ["p3"]],
    ["keys", [["items", "total"]]],
    [".items[0] | to_entries | map(.key) | join(\",\")", ["id,name,price,tags,stock"]],
    [".items[] | .name | ascii_downcase | test(\"^s\")", [false, true, true]],
  ])("%s", (expression, expected) => {
    expect(run(expression)).toEqual(expected);
  });

  it("rejects unsupported syntax with a usage error", () => {
    expect(() => compileJq(".items | reduce . as $x (0; .)")).toThrow(/--jq/);
    expect(() => compileJq(".items[")).toThrow(/--jq/);
  });
});

describe("--select pointers", () => {
  it("keeps the selected fields in their original shape", () => {
    expect(selectPointers(data, parseSelect("/items/*/id,/total")!)).toEqual({ total: 3, items: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] });
  });

  it("rejects a value that is not a JSON pointer", () => {
    expect(() => parseSelect("items.id")).toThrow(/JSON pointer/);
  });
});
