import { describe, expect, it } from "vitest";

import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@scalius/core/errors";

import {
  bindAssistantAgentInstance,
  createAssistantSession,
  resolveAssistantSessionByAgentInstance,
  revokeAssistantSession,
} from "./index";
import { createAssistantSessionCredential } from "./assistant-crypto";
import { createFakeAssistantAuthorityDb } from "./assistant-test-db";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const INSTANCE_ID = `v1.${"A".repeat(43)}`;

async function createAdminSession() {
  const fake = createFakeAssistantAuthorityDb();
  const created = await createAssistantSession(fake.db, {
    surface: "admin",
    actorType: "admin",
    actorId: "admin_1",
    conversationKey: "conversation_binding_1",
    credential: createAssistantSessionCredential(),
    permissionSnapshotHash: "b".repeat(64),
    ttlSeconds: 3_600,
    now: NOW,
  });
  return { ...fake, session: created.session };
}

describe("assistant Flue agent bindings", () => {
  it("binds one opaque instance idempotently without exposing it in the session view", async () => {
    const { db, state, session } = await createAdminSession();

    const first = await bindAssistantAgentInstance(db, {
      sessionId: session.id,
      agentInstanceId: INSTANCE_ID,
      now: NOW,
    });
    const replay = await bindAssistantAgentInstance(db, {
      sessionId: session.id,
      agentInstanceId: INSTANCE_ID,
      now: NOW,
    });

    expect(first.id).toBe(session.id);
    expect(replay.id).toBe(session.id);
    expect(state.sessions[0]?.agentInstanceId).toBe(INSTANCE_ID);
    expect(first).not.toHaveProperty("agentInstanceId");
  });

  it("does not allow one authority session to be rebound", async () => {
    const { db, session } = await createAdminSession();
    await bindAssistantAgentInstance(db, {
      sessionId: session.id,
      agentInstanceId: INSTANCE_ID,
      now: NOW,
    });

    await expect(bindAssistantAgentInstance(db, {
      sessionId: session.id,
      agentInstanceId: `v1.${"B".repeat(43)}`,
      now: NOW,
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("resolves only the exact active surface binding", async () => {
    const { db, session } = await createAdminSession();
    await bindAssistantAgentInstance(db, {
      sessionId: session.id,
      agentInstanceId: INSTANCE_ID,
      now: NOW,
    });

    await expect(resolveAssistantSessionByAgentInstance(db, {
      agentInstanceId: INSTANCE_ID,
      expectedSurface: "admin",
      now: NOW,
    })).resolves.toMatchObject({ id: session.id, surface: "admin" });
    await expect(resolveAssistantSessionByAgentInstance(db, {
      agentInstanceId: INSTANCE_ID,
      expectedSurface: "storefront",
      now: NOW,
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("fails closed after revocation or expiry", async () => {
    const { db, session } = await createAdminSession();
    await bindAssistantAgentInstance(db, {
      sessionId: session.id,
      agentInstanceId: INSTANCE_ID,
      now: NOW,
    });
    await revokeAssistantSession(db, { sessionId: session.id, now: NOW });

    await expect(resolveAssistantSessionByAgentInstance(db, {
      agentInstanceId: INSTANCE_ID,
      expectedSurface: "admin",
      now: NOW,
    })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects malformed instance ids and invalid touch bounds", async () => {
    const { db, session } = await createAdminSession();
    await expect(bindAssistantAgentInstance(db, {
      sessionId: session.id,
      agentInstanceId: "bad instance id",
      now: NOW,
    })).rejects.toBeInstanceOf(ValidationError);

    await bindAssistantAgentInstance(db, {
      sessionId: session.id,
      agentInstanceId: INSTANCE_ID,
      now: NOW,
    });
    await expect(resolveAssistantSessionByAgentInstance(db, {
      agentInstanceId: INSTANCE_ID,
      expectedSurface: "admin",
      touchAfterSeconds: -1,
      now: NOW,
    })).rejects.toBeInstanceOf(ValidationError);
  });
});
