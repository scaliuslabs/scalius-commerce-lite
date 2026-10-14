import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it } from "vitest";
import { drizzleD1, drizzleRemote, relationalSchema } from "./drizzle-clients";
import * as schema from "./schema";

const binding = { prepare() {}, batch() {} } as unknown as D1Database;
const execute = async () => ({ rows: [] });
const executeBatch = async () => [];

function shape(db: { _: { tableNamesMap: unknown; schema: unknown }; query: object }) {
  return {
    tableNamesMap: db._.tableNamesMap,
    tables: Object.keys(db._.schema as object),
    query: Object.keys(db.query),
  };
}

describe("drizzle clients over one relational schema", () => {
  it("build what drizzle() builds, for D1 and for remote adapters", () => {
    const expected = drizzle(binding, { schema });
    const actual = drizzleD1(binding);
    expect(shape(actual as never)).toEqual(shape(expected as never));
    expect(actual.$client).toBe(binding);
    expect(actual.select().from(schema.products).where(eq(schema.products.id, "p_1")).toSQL())
      .toEqual(expected.select().from(schema.products).where(eq(schema.products.id, "p_1")).toSQL());
    const relational = (db: typeof expected) => db.query.agentDeviceAuthorizations.findFirst({ where: (table, { eq: equals }) => equals(table.id, "d_1") }).toSQL();
    expect(relational(actual)).toEqual(relational(expected));

    const remoteExpected = drizzleProxy(execute, executeBatch, { schema });
    const remoteActual = drizzleRemote(execute, executeBatch);
    expect(shape(remoteActual as never)).toEqual(shape(remoteExpected as never));
    expect(remoteActual.select().from(schema.products).limit(1).toSQL()).toEqual(remoteExpected.select().from(schema.products).limit(1).toSQL());
  });

  it("share only the code-derived schema: every call is a new client on its own binding", () => {
    const other = { prepare() {}, batch() {} } as unknown as D1Database;
    const first = drizzleD1(binding);
    const second = drizzleD1(other);
    expect(first).not.toBe(second);
    expect(second.$client).toBe(other);
    expect(first._.schema).toBe(second._.schema);
    expect(relationalSchema().fullSchema).toBe(schema);
  });
});
