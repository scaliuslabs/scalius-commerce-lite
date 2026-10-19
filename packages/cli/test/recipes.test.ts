import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateRecipeFiles, loadManifest, loadSource, referencedOperations } from "../scripts/generate-recipes.mjs";

// (e) Recipes are generated from the operation manifest and its workflow
// catalog: the committed files must equal a fresh generation, and a removed
// operation or route must fail the generation instead of shipping a stale step.

interface Operation {
  operationId: string;
  exposure: string;
  risk: string;
}
interface Manifest {
  operations: Operation[];
  workflowCatalog: { routes: Array<{ id: string }> };
}
interface Source {
  skills: Record<string, { routes?: string[]; recipes?: unknown[] }>;
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = loadManifest() as Manifest;
const source = loadSource() as Source;
const generate = (value: Manifest, recipes: Source = source) => generateRecipeFiles(value, recipes) as Array<{ path: string; content: string }>;
const clone = <T>(value: T): T => structuredClone(value);

describe("generated skill recipes", () => {
  it("match a fresh generation from the manifest (run pnpm --filter scalius generate:recipes)", async () => {
    for (const file of generate(manifest)) {
      expect(await readFile(join(packageRoot, file.path), "utf8"), file.path).toBe(file.content);
    }
  });

  it("reference only operations the manifest exposes to agents", () => {
    const byId = new Map(manifest.operations.map((operation) => [operation.operationId, operation]));
    for (const { id, planned } of referencedOperations(source) as Array<{ id: string; planned: boolean }>) {
      if (planned) continue;
      expect(byId.get(id)?.exposure, id).toMatch(/^(execute|continuation)$/);
    }
  });

  it("cover the 30 merchant tasks", () => {
    const recipes = Object.values(source.skills).flatMap((skill) => skill.recipes ?? []);
    expect(recipes.length).toBeGreaterThanOrEqual(30);
  });

  it("fail when a referenced operation id disappears", () => {
    const removed = clone(manifest);
    removed.operations = removed.operations.filter((operation) => operation.operationId !== "dashboard.orders.refund");
    expect(() => generate(removed)).toThrow(/dashboard\.orders\.refund, which is not in the manifest/);
  });

  it("fail when a referenced operation stops being runnable by agents", () => {
    const excluded = clone(manifest);
    excluded.operations = excluded.operations.map((operation) =>
      operation.operationId === "dashboard.payments.methods_update" ? { ...operation, exposure: "excluded" } : operation);
    expect(() => generate(excluded)).toThrow(/dashboard\.payments\.methods_update, which agents cannot run/);
  });

  it("fail when a listed workflow route disappears", () => {
    const removed = clone(manifest);
    removed.workflowCatalog.routes = removed.workflowCatalog.routes.filter((route) => route.id !== "dashboard.order-refund");
    expect(() => generate(removed)).toThrow(/workflow route dashboard\.order-refund/);
  });

  it("switch a recipe to the new operation once the API exposes it", () => {
    const giftCards = (files: Array<{ path: string; content: string }>) =>
      files.find((file) => file.path === "skills/scalius-sales/references/recipes.md")!.content.split("## Issue a 1,000 gift card")[1]!.split("\n## ")[0]!;
    // The API exposes gift card issue (financial, confirmed); a store whose API hides it falls back.
    const exposed = giftCards(generate(manifest));
    expect(exposed).toContain("write  dashboard.gift_cards.create");
    expect(exposed).not.toContain("staff-only");
    const hidden = clone(manifest);
    hidden.operations = hidden.operations.map((operation) =>
      operation.operationId === "dashboard.gift_cards.create" ? { ...operation, exposure: "excluded" } : operation);
    expect(giftCards(generate(hidden))).toContain("staff-only");
  });

  it("mark steps that need the merchant's approval from the manifest's risk", () => {
    const sales = generate(manifest).find((file) => file.path === "skills/scalius-sales/references/recipes.md")!.content;
    expect(sales).toMatch(/write {2}dashboard\.orders\.refund \[approval\]/);
    expect(sales).not.toMatch(/dashboard\.orders\.payments \[approval\]/);
  });
});
