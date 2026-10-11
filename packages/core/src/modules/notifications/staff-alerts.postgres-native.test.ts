import { Client } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { connectNativePostgres, createPostgresDatabase } from "@scalius/database/postgres-adapter";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { ConflictError } from "@scalius/core/errors";
import { clearStaffAlerts, markAllStaffAlertsRead, readStaffAlerts, readStaffAlertSummary, recordStaffAlert, undoStaffAlertsClear } from "./staff-alerts";
import { seedStaffAlerts, seedStaffAlertEvent } from "./testing/staff-alerts";

afterAll(closeNativePostgres);
describe.runIf(nativePostgresUrl())("staff bell on native PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("keeps exact scope/cursor/count and clear/undo behavior on the provider compiler", async () => {
    const pg = await createNativePostgres({ label: "staff_bell" });
    await seedStaffAlerts(pg.db);
    for (const [id, conversation] of [["bell_order_event",false],["bell_message",true]] as const) {
      await seedStaffAlertEvent(pg.db,id,conversation); await recordStaffAlert(pg.db,id,true);
    }
    const page = await readStaffAlerts(pg.db,"bell_a",{ limit:1 });
    expect(page.items[0]).toMatchObject({ seq:2,scope:"conversations",kind:"conversation_message",orderNumber:"1234",read:false });
    expect(page).toMatchObject({ head:2,unreadCount:2,nextBefore:2 });
    expect((await readStaffAlerts(pg.db,"bell_a",{ beforeSeq:2 })).items.map((row) => row.seq)).toEqual([1]);
    const clear = await clearStaffAlerts(pg.db,"bell_a",{ operationId:"native_clear_1",through:2,scopes:page.scopes.map(({scope,revision})=>({scope,revision})) });
    expect((await readStaffAlerts(pg.db,"bell_a")).items).toEqual([]);
    await undoStaffAlertsClear(pg.db,"bell_a",clear.undo!);
    expect((await readStaffAlertSummary(pg.db,"bell_a")).unreadCount).toBe(2);
  });

  it("uses the scope range for a sparse authorized cursor after stripping the SQLite hint", async () => {
    const pg = await createNativePostgres({ label: "bell_sparse_cursor" });
    await seedStaffAlerts(pg.db);
    await pg.client.query(`INSERT INTO staff_alerts(id,scope,kind,subject_id,occurred_at,fanout_complete)
      SELECT 'sparse_'||i,CASE WHEN i=1 THEN 'orders' ELSE 'conversations' END,
        CASE WHEN i=1 THEN 'order_created' ELSE 'conversation_message' END,'bell_order',1000,1
      FROM generate_series(1,10000) i;
      INSERT INTO staff_alert_inbox(user_id,seq,alert_id,scope)
      SELECT 'bell_b',substring(id FROM 8)::bigint,id,scope FROM staff_alerts;
      INSERT INTO staff_alert_state(user_id,scope,last_seq) VALUES('bell_b','*',10000);
      ANALYZE staff_alert_inbox;`);
    let captured: { text: string; params: readonly unknown[] } | undefined;
    const db = createPostgresDatabase(pg.url, { connect: (url) => {
      const connection = connectNativePostgres(url);
      return {
        query(text, params) { captured = { text, params }; return connection.query(text, params); },
        transaction: (queries, options) => connection.transaction(queries, options),
      };
    } });
    const page = await readStaffAlerts(db, "bell_b", { beforeSeq: 10000 });
    expect(page.items.map((item) => item.seq)).toEqual([1]);
    expect(page).toMatchObject({ unreadCount: 1, nextBefore: null });
    expect(captured!.text).not.toContain("INDEXED BY");
    const result = await pg.client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${captured!.text}`, [...captured!.params]);
    type Plan = { "Relation Name"?: string; "Index Name"?: string; "Index Cond"?: string; Plans?: Plan[] };
    const plans: Plan[] = [];
    const collect = (plan: Plan) => { plans.push(plan); plan.Plans?.forEach(collect); };
    collect(result.rows[0]["QUERY PLAN"][0].Plan as Plan);
    const cursorPlans = plans.filter((plan) => plan["Index Name"] === "staff_alert_inbox_scope_seq_idx");
    expect(cursorPlans).toHaveLength(2);
    for (const plan of cursorPlans) expect(plan["Index Cond"]).toMatch(/user_id.*scope.*seq >.*seq </);
  });

  it("returns one coherent feed/count/frontier snapshot while appends and clears race", async () => {
    const pg = await createNativePostgres({ label: "bell_read_snapshot" });
    await seedStaffAlerts(pg.db);
    for (let i = 0; i < 6; i++) await seedStaffAlertEvent(pg.db, `bell_snapshot_${i}`, i % 2 === 1);
    const write = async () => {
      for (let i = 0; i < 6; i++) {
        await recordStaffAlert(pg.db, `bell_snapshot_${i}`, true);
        if (i === 2) {
          const shown = await readStaffAlertSummary(pg.db, "bell_a");
          await clearStaffAlerts(pg.db, "bell_a", { operationId: "snapshot_clear", through: shown.head,
            scopes: shown.scopes.map(({ scope, revision }) => ({ scope, revision })) });
        }
      }
    };
    const read = async () => {
      for (let i = 0; i < 12; i++) {
        const page = await readStaffAlerts(pg.db, "bell_a");
        expect(page.nextBefore).toBeNull();
        expect(page.unreadCount).toBe(page.items.filter((item) => !item.read).length);
        for (const item of page.items) {
          const scope = page.scopes.find((state) => state.scope === item.scope)!;
          expect(item.seq).toBeLessThanOrEqual(page.head);
          expect(item.seq).toBeGreaterThan(scope.clearedThrough);
          expect(item.read).toBe(item.seq <= scope.readThrough);
        }
      }
    };
    await Promise.all([write(), read()]);
  });

  it.each([false,true])("retries the whole allocation after an overlapping sentinel write (existing=%s)", async (existing) => {
    const pg = await createNativePostgres({ label:`bell_allocate_${existing}` });
    await seedStaffAlerts(pg.db);
    if (existing) { await seedStaffAlertEvent(pg.db,"bell_first"); await recordStaffAlert(pg.db,"bell_first",true); }
    await seedStaffAlertEvent(pg.db,"bell_racing");
    let retries=0;
    const db=createPostgresDatabase(pg.url,{ connect:connectNativePostgres,onSerializationRetry:()=>{retries++;},sleep:async()=>{} });
    const left=new Client({connectionString:pg.url}); await left.connect();
    let pending:Promise<unknown>|undefined;
    try {
      await left.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const pid=Number((await left.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      if (existing) await left.query("UPDATE staff_alert_state SET last_seq=last_seq WHERE user_id='bell_a' AND scope='*'");
      else await left.query("INSERT INTO staff_alert_state(user_id,scope) VALUES('bell_a','*')");
      pending=recordStaffAlert(db,"bell_racing",true);
      const settled=pending.then(()=>({ok:true as const}),(error:unknown)=>({ok:false as const,error}));
      let blocked=false;
      const deadline=performance.now()+5000;
      while(performance.now()<deadline) {
        const result=await pg.client.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",[pid]);
        if(Number(result.rows[0].n)>0){blocked=true;break;}
        await new Promise((resolve)=>setTimeout(resolve,10));
      }
      await left.query("COMMIT");
      const result=await settled;if(!result.ok)throw result.error;
      expect(blocked).toBe(true);expect(retries).toBeGreaterThan(0);
      const page=await readStaffAlerts(db,"bell_a");
      expect(page.items.map((item)=>item.seq)).toEqual(existing?[2,1]:[1]);
      const snapshot=JSON.stringify(page);
      await Promise.all([recordStaffAlert(db,"bell_racing",true),recordStaffAlert(pg.db,"bell_racing",true)]);
      expect(JSON.stringify(await readStaffAlerts(db,"bell_a"))).toBe(snapshot);
    } finally {await left.query("ROLLBACK").catch(()=>undefined);await left.end();await pending?.catch(()=>undefined);}
  });

  it("rolls back both scope clears after a concurrent read changes one revision", async () => {
    const pg=await createNativePostgres({label:"bell_clear_race"}); await seedStaffAlerts(pg.db);
    await seedStaffAlertEvent(pg.db,"bell_one");await recordStaffAlert(pg.db,"bell_one",true);
    await seedStaffAlertEvent(pg.db,"bell_two",true);await recordStaffAlert(pg.db,"bell_two",true);
    await markAllStaffAlertsRead(pg.db,"bell_a",{through:0,scopes:["orders","conversations"]});
    const shown=await readStaffAlertSummary(pg.db,"bell_a");
    let retries=0;
    const db=createPostgresDatabase(pg.url,{connect:connectNativePostgres,onSerializationRetry:()=>{retries++;},sleep:async()=>{}});
    const left=new Client({connectionString:pg.url});await left.connect();
    let pending:Promise<unknown>|undefined;
    try {
      await left.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const pid=Number((await left.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await left.query("UPDATE staff_alert_state SET revision=revision+1 WHERE user_id='bell_a' AND scope='orders'");
      await left.query("UPDATE staff_alert_inbox SET read_at=1001 WHERE user_id='bell_a' AND seq=1");
      pending=clearStaffAlerts(db,"bell_a",{operationId:"native_stale_clear",through:shown.head,scopes:shown.scopes.map(({scope,revision})=>({scope,revision}))});
      const settled=pending.then(()=>null,(error:unknown)=>error);
      let blocked=false;const deadline=performance.now()+5000;
      while(performance.now()<deadline){
        const result=await pg.client.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",[pid]);
        if(Number(result.rows[0].n)>0){blocked=true;break;}
        await new Promise((resolve)=>setTimeout(resolve,10));
      }
      await left.query("COMMIT");
      expect(await settled).toBeInstanceOf(ConflictError);expect(blocked).toBe(true);expect(retries).toBeGreaterThan(0);
      expect((await pg.db.all<{scope:string;cleared_through:number}>(sql`SELECT scope,cleared_through FROM staff_alert_state WHERE user_id='bell_a' AND scope<>'*' ORDER BY scope`)))
        .toEqual([{scope:"conversations",cleared_through:0},{scope:"orders",cleared_through:0}]);
      expect((await readStaffAlerts(db,"bell_a")).items).toHaveLength(2);
    }finally{await left.query("ROLLBACK").catch(()=>undefined);await left.end();await pending?.catch(()=>undefined);}
  });
});
