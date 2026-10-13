// PostgreSQL sidecar for 0148_queue_retirement on the upgrade path: it drops
// the queue-only indexes, gives webhook_events its retry columns, returns rows
// a queue still held to `pending` (or `failed` for payment events, which kept
// no payload), and leaves the schema equal to a fresh one. Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

const server = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function database(sql: string) {
  const name = `scalius_queue_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: server }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(server!); url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  cleanup.push(async () => { await client.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await client.connect(); await client.query(sql); return client;
}

async function catalog(client: Client) {
  const queries = [
    "SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2",
    "SELECT conrelid::regclass::text AS table_name,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2,3",
    "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2",
  ];
  const result = []; for (const query of queries) result.push((await client.query(query)).rows); return result;
}

describe.runIf(server)("0148 queue retirement on native PostgreSQL", () => {
  it("releases queue-held rows and equals a fresh schema", async () => {
    const upgraded = await database((await compileCanonicalPostgresSchema({ beforeMigration: "0148_" })).sql);
    await upgraded.query(`
      INSERT INTO event_outbox(id,topic,resource_type,resource_id,data,status,queued_at)
        VALUES ('evt_queued','order.created','order','ord_1','{}','queued',1000),
               ('evt_done','order.created','order','ord_2','{}','dispatched',NULL);
      INSERT INTO webhook_events(id,provider,event_type,status) VALUES ('stripe:payment.confirmed:1','stripe','payment.confirmed','queued');
    `);
    const migration = readFileSync(join(import.meta.dirname, "../migrations/postgres/0148_queue_retirement.sql"), "utf8");
    await upgraded.query("BEGIN");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await upgraded.query(statement);
    await upgraded.query("COMMIT");

    expect((await upgraded.query("SELECT id, status FROM event_outbox ORDER BY 1")).rows)
      .toEqual([{ id: "evt_done", status: "dispatched" }, { id: "evt_queued", status: "pending" }]);
    expect((await upgraded.query("SELECT status, attempts::integer AS attempts, payload, next_attempt_at FROM webhook_events")).rows)
      .toEqual([{ status: "failed", attempts: 0, payload: null, next_attempt_at: null }]);

    const fresh = await database((await compileCanonicalPostgresSchema()).sql);
    expect(await catalog(upgraded)).toEqual(await catalog(fresh));
  }, 180_000);
});
