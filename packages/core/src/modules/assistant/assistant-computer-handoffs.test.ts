import type { Database } from "@scalius/database/client";
import { assistantComputerHandoffs } from "@scalius/database/schema";
import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_COMPUTER_HANDOFF_AUDIT_RETENTION_SECONDS,
  cleanupExpiredAssistantComputerHandoffs,
  confirmAssistantComputerHandoffDispatch,
  consumeAssistantComputerHandoff,
} from "./assistant-computer-handoffs";

const NOW = new Date("2026-07-11T10:00:00.000Z");
const SESSION_ID = "as_session_1";
const INSTANCE_ID = `v1.${"a".repeat(43)}`;
const REQUEST_ID = "abcdefghijklmnopqrstuv";
const PROGRAM_DIGEST = "b".repeat(43);
const TICKET_EXPIRES_AT = NOW.getTime() + 120_000;

type HandoffRow = typeof assistantComputerHandoffs.$inferSelect;

function input(
  state: "cancelled" | "dispatched",
  overrides: Partial<Parameters<typeof consumeAssistantComputerHandoff>[1]> = {},
) {
  return {
    sessionId: SESSION_ID,
    agentInstanceId: INSTANCE_ID,
    requestId: REQUEST_ID,
    programDigest: PROGRAM_DIGEST,
    state,
    ticketExpiresAt: TICKET_EXPIRES_AT,
    now: NOW,
    ...overrides,
  };
}

function createLedgerDb() {
  const rows: HandoffRow[] = [];
  const db = {
    insert: () => ({
      values: (value: HandoffRow) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            const conflict = rows.some((row) =>
              row.agentInstanceId === value.agentInstanceId &&
              row.requestId === value.requestId);
            if (conflict) return [];
            rows.push(structuredClone(value));
            return [structuredClone(value)];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async (limit: number) => rows.slice(0, limit).map((row) => structuredClone(row)),
        }),
      }),
    }),
    update: () => ({
      set: (values: Partial<HandoffRow>) => ({
        where: () => ({
          returning: async () => {
            const row = rows[0];
            if (!row || row.dispatchConfirmedAt) return [];
            Object.assign(row, values);
            return [structuredClone(row)];
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => rows.splice(0).map((row) => ({ requestId: row.requestId })),
      }),
    }),
  } as unknown as Database;
  return { db, rows };
}

describe("assistant computer handoff ledger", () => {
  it("makes cancellation terminal and idempotent before any dispatch claim", async () => {
    const { db, rows } = createLedgerDb();
    await expect(consumeAssistantComputerHandoff(db, input("cancelled"))).resolves.toEqual({
      status: "claimed",
      state: "cancelled",
      requestId: REQUEST_ID,
    });
    await expect(consumeAssistantComputerHandoff(db, input("cancelled"))).resolves.toEqual({
      status: "replayed",
      state: "cancelled",
      requestId: REQUEST_ID,
    });
    await expect(consumeAssistantComputerHandoff(db, input("dispatched"))).resolves.toEqual({
      status: "conflict",
      state: "cancelled",
      requestId: REQUEST_ID,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: SESSION_ID,
      state: "cancelled",
      dispatchClaimHash: null,
      dispatchConfirmedAt: null,
      ticketExpiresAt: new Date(TICKET_EXPIRES_AT),
      retentionExpiresAt: new Date(
        TICKET_EXPIRES_AT +
          ASSISTANT_COMPUTER_HANDOFF_AUDIT_RETENTION_SECONDS * 1_000,
      ),
    });
  });

  it("dispatches at most once and fails closed until the winner confirms", async () => {
    const { db, rows } = createLedgerDb();
    const claimed = await consumeAssistantComputerHandoff(db, input("dispatched"));
    expect(claimed).toMatchObject({
      status: "claimed",
      state: "dispatched",
      requestId: REQUEST_ID,
      dispatchClaimToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    if (claimed.status !== "claimed" || claimed.state !== "dispatched") {
      throw new Error("Expected dispatch claim");
    }
    expect(rows[0]?.dispatchClaimHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(rows[0]?.dispatchClaimHash).not.toBe(claimed.dispatchClaimToken);

    await expect(consumeAssistantComputerHandoff(db, input("dispatched"))).resolves.toEqual({
      status: "uncertain",
      state: "dispatched",
      requestId: REQUEST_ID,
    });
    await expect(consumeAssistantComputerHandoff(db, input("cancelled"))).resolves.toEqual({
      status: "conflict",
      state: "dispatched",
      requestId: REQUEST_ID,
    });

    await expect(confirmAssistantComputerHandoffDispatch(db, {
      sessionId: SESSION_ID,
      agentInstanceId: INSTANCE_ID,
      requestId: REQUEST_ID,
      programDigest: PROGRAM_DIGEST,
      dispatchClaimToken: claimed.dispatchClaimToken,
      now: NOW,
    })).resolves.toEqual({
      status: "confirmed",
      state: "dispatched",
      requestId: REQUEST_ID,
    });
    await expect(consumeAssistantComputerHandoff(db, input("dispatched"))).resolves.toEqual({
      status: "replayed",
      state: "dispatched",
      requestId: REQUEST_ID,
    });
  });

  it("allows exactly one concurrent cancel-or-dispatch winner", async () => {
    const { db, rows } = createLedgerDb();
    const outcomes = await Promise.all([
      consumeAssistantComputerHandoff(db, input("cancelled")),
      consumeAssistantComputerHandoff(db, input("dispatched")),
    ]);
    expect(rows).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "claimed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "conflict")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "claimed")?.state)
      .toBe(rows[0]?.state);
  });

  it("rejects identity drift and invalid ticket lifetime without changing the winner", async () => {
    const { db, rows } = createLedgerDb();
    await consumeAssistantComputerHandoff(db, input("cancelled"));
    await expect(consumeAssistantComputerHandoff(db, input("cancelled", {
      programDigest: "c".repeat(43),
    }))).resolves.toEqual({
      status: "conflict",
      state: "cancelled",
      requestId: REQUEST_ID,
    });
    await expect(consumeAssistantComputerHandoff(db, input("cancelled", {
      ticketExpiresAt: NOW.getTime() + 126_000,
    }))).rejects.toBeInstanceOf(ValidationError);
    await expect(consumeAssistantComputerHandoff(db, input("cancelled", {
      state: "queued" as never,
    }))).rejects.toBeInstanceOf(ValidationError);
    expect(rows).toHaveLength(1);
  });

  it("retains a modest audit window, then exports bounded cleanup", async () => {
    const { db, rows } = createLedgerDb();
    await consumeAssistantComputerHandoff(db, input("cancelled"));
    const retentionExpiresAt = rows[0]!.retentionExpiresAt;

    // This focused fake returns its only candidate; call cleanup only at the
    // stored cutoff to exercise the bounded deletion/result contract.
    await expect(cleanupExpiredAssistantComputerHandoffs(
      db,
      retentionExpiresAt,
      { limit: 40 },
    )).resolves.toEqual({
      scanned: 1,
      deleted: 1,
      limit: 40,
      hasMore: false,
    });
    expect(rows).toHaveLength(0);
    await expect(cleanupExpiredAssistantComputerHandoffs(db, NOW, { limit: 46 }))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it("fails closed if a lost insert cannot be re-read", async () => {
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
    } as unknown as Database;
    await expect(consumeAssistantComputerHandoff(db, input("cancelled")))
      .rejects.toBeInstanceOf(ServiceUnavailableError);
  });
});
