import { describe, expect, it } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import {
  buildNavigationHierarchy,
  checksumNavigationPublication,
  normalizeNavigationMenuHandle,
  normalizeNavigationMenuItemInput,
  sparsePositionBetween,
} from "./navigation.authority";

describe("normalized navigation authority", () => {
  it("normalizes menu handles and preserves typed resource query intent", () => {
    expect(normalizeNavigationMenuHandle("  Summer & New In  ")).toBe("summer-new-in");
    expect(normalizeNavigationMenuItemInput({
      label: "Sale",
      labelMode: "resource",
      target: {
        type: "resource",
        resourceType: "collection",
        resourceId: " collection_1 ",
        query: "sort=price-asc&available=true",
      },
    })).toEqual({
      label: "Sale",
      labelMode: "resource",
      targetType: "collection",
      targetId: "collection_1",
      targetValue: null,
      targetQuery: "?sort=price-asc&available=true",
      openInNewTab: false,
      isEnabled: true,
    });
  });

  it("rejects confused target and label authorities", () => {
    expect(() => normalizeNavigationMenuItemInput({
      label: "Account",
      labelMode: "resource",
      target: { type: "internal_path", path: "/account" },
    })).toThrow(ValidationError);
    expect(() => normalizeNavigationMenuItemInput({
      label: "Bad",
      labelMode: "custom",
      target: { type: "external_url", url: "http://example.com" },
    })).toThrow("HTTPS");
    expect(() => normalizeNavigationMenuItemInput({
      label: "Bad",
      labelMode: "custom",
      target: { type: "resource", resourceType: "product", resourceId: "product_1", query: "/wrong" },
    })).toThrow("query parameters");
  });

  it("builds deterministic three-level trees and blocks cycles, orphans, and excess depth", () => {
    const tree = buildNavigationHierarchy([
      { id: "child-2", parentId: "root", position: 2048 },
      { id: "root", parentId: null, position: 1024 },
      { id: "child-1", parentId: "root", position: 1024 },
      { id: "grandchild", parentId: "child-1", position: 1024 },
    ]);
    expect(tree[0]?.children.map((node) => node.item.id)).toEqual(["child-1", "child-2"]);
    expect(tree[0]?.children[0]?.children[0]?.depth).toBe(3);

    expect(() => buildNavigationHierarchy([
      { id: "a", parentId: "b", position: 1 },
      { id: "b", parentId: "a", position: 1 },
    ])).toThrow("reachable");
    expect(() => buildNavigationHierarchy([
      { id: "child", parentId: "missing", position: 1 },
    ])).toThrow("no valid parent");
    expect(() => buildNavigationHierarchy([
      { id: "1", parentId: null, position: 1 },
      { id: "2", parentId: "1", position: 1 },
      { id: "3", parentId: "2", position: 1 },
      { id: "4", parentId: "3", position: 1 },
    ])).toThrow("at most 3 levels");
  });

  it("uses sparse midpoint positions and signals when sibling compaction is required", () => {
    expect(sparsePositionBetween(null, null)).toBe(1024);
    expect(sparsePositionBetween(1024, 2048)).toBe(1536);
    expect(sparsePositionBetween(null, 1024)).toBe(0);
    expect(sparsePositionBetween(2048, null)).toBe(3072);
    expect(sparsePositionBetween(100, 101)).toBeNull();
  });

  it("creates a stable checksum independent of database row return order", async () => {
    const base = [
      {
        id: "root",
        parentId: null,
        position: 1024,
        label: "Shop",
        labelMode: "custom" as const,
        targetType: "internal_path" as const,
        targetId: null,
        targetValue: "/shop",
        targetQuery: null,
        openInNewTab: false,
        isEnabled: true,
      },
      {
        id: "child",
        parentId: "root",
        position: 1024,
        label: "Sale",
        labelMode: "custom" as const,
        targetType: "internal_path" as const,
        targetId: null,
        targetValue: "/sale",
        targetQuery: null,
        openInNewTab: false,
        isEnabled: true,
      },
    ];
    const first = await checksumNavigationPublication(base);
    const second = await checksumNavigationPublication([...base].reverse());
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });
});
