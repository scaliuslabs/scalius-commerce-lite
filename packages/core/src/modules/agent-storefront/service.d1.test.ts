import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError } from "@scalius/core/errors";
import {
  AgentStorefrontContextRevisionConflictError,
  closeAgentStorefrontContext,
  createAgentStorefrontContext,
  mutateAgentStorefrontCart,
} from "./service";

const GRANT = "agr_storefront0123456789";

async function setup() {
  let raceOnUpdate: (() => void) | undefined;
  const harness = createSqliteD1Database({
    onQuery(query) {
      if (raceOnUpdate && /^update "agent_storefront_contexts"/iu.test(query.trim())) {
        const race = raceOnUpdate;
        raceOnUpdate = undefined;
        race();
      }
    },
  });
  const now = Math.floor(Date.now() / 1000);
  harness.sqlite.exec(`
    INSERT INTO user (id, name, email) VALUES ('owner-1', 'Owner', 'owner@example.com');
    INSERT INTO agent_grants (id, kind, owner_user_id, resource, label, preset, permissions_json,
      risk_ceiling, authority_revision, status, expires_at, created_at, updated_at)
    VALUES ('${GRANT}', 'pat', 'owner-1', 'storefront', 'Buyer agent', 'full', '[]', 'read', 1, 'active',
      ${now + 86_400 * 2}, ${now - 60}, ${now - 60});
  `);
  const context = await createAgentStorefrontContext(harness.db, GRANT);
  const row = () => harness.sqlite.prepare(
    "SELECT status, revision, discount_code AS discountCode FROM agent_storefront_contexts WHERE id = ?",
  ).get(context.id);
  return { ...harness, context, row, raceNextUpdate: (race: () => void) => { raceOnUpdate = race; } };
}

describe("agent storefront context persistence", () => {
  it("guards mutations by owner, revision, and expiry", async () => {
    const { db, context, row } = await setup();

    await expect(closeAgentStorefrontContext(db, "agr_otherowner0123456789", context.id, 1))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(closeAgentStorefrontContext(db, GRANT, context.id, 2))
      .rejects.toBeInstanceOf(AgentStorefrontContextRevisionConflictError);
    expect(row()).toMatchObject({ status: "active", revision: 1 });

    const afterExpiry = new Date(Date.parse(context.expiresAt) + 1_000);
    await expect(closeAgentStorefrontContext(db, GRANT, context.id, 1, { now: afterExpiry }))
      .rejects.toBeInstanceOf(ConflictError);
    expect(row()).toMatchObject({ status: "expired", revision: 1 });
  });

  it("rejects a write whose revision changed after the read at commit time", async () => {
    const { sqlite, db, context, row, raceNextUpdate } = await setup();
    raceNextUpdate(() => {
      sqlite.prepare("UPDATE agent_storefront_contexts SET revision = 2 WHERE id = ?").run(context.id);
    });

    await expect(closeAgentStorefrontContext(db, GRANT, context.id, 1))
      .rejects.toBeInstanceOf(AgentStorefrontContextRevisionConflictError);
    expect(row()).toMatchObject({ status: "active", revision: 2 });
  });

  it("invalidates accepted discount state on every cart edit", async () => {
    const { sqlite, db, context, row } = await setup();
    sqlite.prepare("UPDATE agent_storefront_contexts SET discount_code = 'SAVE10' WHERE id = ?").run(context.id);

    await mutateAgentStorefrontCart(db, GRANT, context.id, 1, { kind: "clear" });

    expect(row()).toEqual({ status: "active", revision: 2, discountCode: null });
  });
});
