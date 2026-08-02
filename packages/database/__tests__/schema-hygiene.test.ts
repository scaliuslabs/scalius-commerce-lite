import { describe, expect, it } from "vitest";

import { RETIRED_PRE_CONSOLIDATION_TABLES } from "../scripts/normalize-d1-export-core";
import {
  createProviderSchemaDatabase,
  readApplicationTableNames,
} from "../scripts/sqlite-provider-schema";

describe("canonical schema hygiene", () => {
  it("keeps D1 and Turso on one clean application table set", async () => {
    const d1 = await createProviderSchemaDatabase("d1");
    const turso = await createProviderSchemaDatabase("turso");
    try {
      const d1Tables = readApplicationTableNames(d1);
      const tursoTables = readApplicationTableNames(turso);
      const retired = d1Tables.filter((table) =>
        RETIRED_PRE_CONSOLIDATION_TABLES.has(table));

      expect(d1Tables).toEqual(tursoTables);
      expect(d1Tables).toHaveLength(109);
      expect(retired).toEqual([]);
    } finally {
      d1.close();
      turso.close();
    }
  });
});
