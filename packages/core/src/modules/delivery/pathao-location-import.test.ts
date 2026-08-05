import { afterEach, describe, expect, it, vi } from "vitest";

import {
  preparePathaoLocationItems,
  processPathaoImportChunk,
} from "./pathao-location-import";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Pathao location import preparation", () => {
  it("normalizes buyer locations and separates provider routing artifacts", () => {
    const result = preparePathaoLocationItems([
      { name: "  Dhanmondi  ", type: "zone", parentId: "city_1", pathaoId: 1 },
      { name: "On-demand  transfer", type: "zone", parentId: "city_1", pathaoId: 2 },
      { name: "Central Road", type: "zone", parentId: "city_1", pathaoId: 3 },
      { name: "lost", type: "zone", parentId: "city_1", pathaoId: 4 },
      { name: "Section   10", type: "area", parentId: "zone_1", pathaoId: 5 },
      { name: "Invalid ID", type: "area", parentId: "zone_1", pathaoId: 0 },
    ]);

    expect(result.accepted).toMatchObject([
      { name: "Dhanmondi", pathaoId: 1 },
      { name: "Central Road", pathaoId: 3 },
      { name: "Section 10", pathaoId: 5 },
    ]);
    expect(result.rejected).toMatchObject([
      { name: "On-demand transfer", pathaoId: 2 },
      { name: "lost", pathaoId: 4 },
      { name: "Invalid ID", pathaoId: 0 },
    ]);
  });

  it("keeps one deterministic choice for duplicate provider identities", () => {
    const result = preparePathaoLocationItems([
      { name: "Mohakhali Flyover", type: "area", parentId: "zone_1", pathaoId: 16547 },
      { name: " mohakhali   flyover ", type: "area", parentId: "zone_1", pathaoId: 16487 },
      { name: "Different label", type: "area", parentId: "zone_1", pathaoId: 16487 },
      { name: "Mohakhali Flyover", type: "area", parentId: "zone_2", pathaoId: 16548 },
    ]);

    expect(result.accepted).toMatchObject([
      { name: "mohakhali flyover", parentId: "zone_1", pathaoId: 16487 },
      { name: "Mohakhali Flyover", parentId: "zone_2", pathaoId: 16548 },
    ]);
    expect(result.rejected).toHaveLength(2);
  });

  it("commits imported locations through bounded database batches", async () => {
    const selectChain = {
      from: vi.fn(() => selectChain),
      where: vi.fn(() => selectChain),
      all: vi.fn(async () => []),
    };
    const statements: object[] = [];
    const db = {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => ({
        values: vi.fn((value) => {
          const statement = { value };
          statements.push(statement);
          return statement;
        }),
      })),
      batch: vi.fn(async (batchStatements: object[]) => batchStatements.map(() => ({}))),
    };
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          data: [
            { city_id: 1, city_name: "Dhaka" },
            { city_id: 2, city_name: "Chattogram" },
            { city_id: 3, city_name: "Rajshahi" },
          ],
        },
      })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await processPathaoImportChunk(db as never, kv as never, {
      baseUrl: "https://pathao.example.test",
      clientId: "client",
      clientSecret: "secret",
      username: "merchant",
      password: "password",
    });

    expect(result).toMatchObject({
      status: "importing",
      phase: "cities",
      stats: { citiesCreated: 3, citiesUpdated: 0 },
    });
    expect(statements).toHaveLength(3);
    expect(db.batch).toHaveBeenCalledOnce();
    expect(db.batch).toHaveBeenCalledWith(statements);
    expect(kv.put).toHaveBeenCalledOnce();
  });
});
