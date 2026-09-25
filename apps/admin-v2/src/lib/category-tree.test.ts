import { describe, expect, it } from "vitest";
import { categoriesInTreeOrder, categoryPathLabel, indexCategories, parentChoices } from "./category-tree";

const tree = [
  { id: "a", name: "Men", parentId: null, depth: 0 },
  { id: "b", name: "Shirts", parentId: "a", depth: 1 },
  { id: "c", name: "Formal", parentId: "b", depth: 2 },
  { id: "d", name: "Slim", parentId: "c", depth: 3 },
  { id: "e", name: "Kids", parentId: null, depth: 0 },
];

describe("category tree", () => {
  it("names the stored path from the top level down", () => {
    expect(categoryPathLabel("c", indexCategories(tree))).toBe("Men › Shirts › Formal");
  });

  it("lists parents before their children", () => {
    expect(categoriesInTreeOrder(tree).map((category) => category.id)).toEqual(["e", "a", "b", "c", "d"]);
  });

  it("never offers the category's own subtree or a fifth level", () => {
    // "b" has two levels below it: it may only go under a top-level category.
    expect(parentChoices("b", tree).map((category) => category.id)).toEqual(["e", "a"]);
    // A new category may go anywhere but under the deepest level.
    expect(parentChoices(undefined, tree).map((category) => category.id)).toEqual(["e", "a", "b", "c"]);
  });
});
