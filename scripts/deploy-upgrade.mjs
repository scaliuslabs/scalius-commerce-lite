// The guarded upgrade of a D1 store, run by scripts/deploy.mjs:
//
//   1. Pre-flight, before anything changes: read the running API's /meta, the
//      database's two migration ledgers (`d1_migrations`, written by Wrangler,
//      and `scalius_schema_migrations`, written by each migration) and whether
//      the store is frozen; refuse when the database or the running code has a
//      history this tree does not (a newer release deployed, two branches each
//      adding a migration, a deployed migration edited, a file half applied).
//   2. When migrations are pending on a store with data: freeze writes
//      (`DATABASE_MIGRATION_FREEZE` on the API Worker), watch the API refuse
//      requests for a minute while old invocations drain, take a D1 Time
//      Travel bookmark, and write the receipt (bookmark, time, database,
//      migration range, the API Worker version that served before).
//   3. Migrate, deploy the API Worker, verify it, then release the freeze and
//      watch the API serve again.
//
// Frozen means observed: only the API answering 503 database_migration_in_progress
// counts, never a receipt. A failure releases the freeze while the code and
// the schema still match (both old). Once the schema changed it keeps the
// store frozen: the old code must not write to a schema it was not built for,
// and a frozen store has taken no write since the bookmark, so a restore
// loses nothing. Every outcome's words say what is true and the next step.
//
// How Wrangler changes a Worker here (wrangler 4.161, read from its source):
// `secret put` and `secret delete` send the secret change to the Worker's
// secrets endpoint, which makes a new version from the latest one and deploys
// it (error 10215 when the latest version is not the deployed one). Secrets
// belong to each version, so `wrangler rollback <version>` deploys that
// version with its own secrets (after confirming the changed ones, code
// 10220): rolling back to the version from before the freeze is itself the
// release, and a `secret delete` after it would act on the latest version,
// which no longer serves.
//
// Every side effect is an injected function: deploy.mjs passes Wrangler and
// fetch, the tests pass fakes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parseRewriteDeclarations } from "../packages/database/scripts/migration-writes.mjs";

export const FREEZE_SECRET = "DATABASE_MIGRATION_FREEZE";
export const RECEIPT_CONTRACT = "scalius-deploy-receipt/v1";
/** Where receipts are written by default: outside every checkout, so removing a worktree keeps them. */
export const RECEIPT_DIRECTORY = "~/.scalius/deploy-receipts";
/** The first migration that records itself in `scalius_schema_migrations`. */
const FIRST_RELEASE_LEDGER_VERSION = 50;
const FREEZE_RESPONSE_CODE = "database_migration_in_progress";
/** What `/api/v1/meta` named as the release before it reported the platform's (v2.0.0-beta.8 and older). */
export const PRE_RELEASE_REPORTING_VERSION = "1.0.0";

// Matched with identifier quotes removed: files write it with and without backticks.
const LEDGER_INSERT = /INSERT\s+INTO\s+scalius_schema_migrations\s*\(\s*version\s*,\s*name\s*,\s*source_sha256\s*\)\s*VALUES\s*\(\s*(\d+)\s*,\s*'([^']+)'\s*,\s*'([a-f0-9]{64})'\s*\)/i;

export const REMOTE_TABLES_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('d1_migrations', 'scalius_schema_migrations') ORDER BY name";
export const REMOTE_APPLIED_SQL = "SELECT name FROM d1_migrations ORDER BY id";
export const REMOTE_LEDGER_SQL = "SELECT version, name, source_sha256 AS sourceSha256 FROM scalius_schema_migrations ORDER BY version";

/** This tree's migrations, in order, with the digest each records and the rewrites it declares. */
export function readTreeMigrations(directory) {
  return readdirSync(directory)
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(directory, file), "utf8");
      return {
        file,
        version: Number(file.slice(0, 4)),
        name: file.slice(0, -4),
        sourceSha256: LEDGER_INSERT.exec(sql.replace(/[`"]/g, ""))?.[3] ?? null,
        rewrites: parseRewriteDeclarations(sql),
      };
    });
}

/** The rows of one `wrangler d1 execute --json --command` answer. */
export function parseD1ExecuteRows(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Wrangler did not return JSON for the D1 ledger read.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0]?.results)) {
    throw new Error("Wrangler returned an unexpected D1 result for the ledger read.");
  }
  return parsed[0].results;
}

/** Both ledgers of the remote database, read-only. `query(sql)` answers rows. */
export async function readRemoteLedgers(query) {
  const tables = new Set((await query(REMOTE_TABLES_SQL)).map((row) => String(row.name)));
  const applied = tables.has("d1_migrations")
    ? (await query(REMOTE_APPLIED_SQL)).map((row) => String(row.name))
    : [];
  const ledger = tables.has("scalius_schema_migrations")
    ? (await query(REMOTE_LEDGER_SQL)).map((row) => ({
        version: Number(row.version),
        name: String(row.name),
        sourceSha256: String(row.sourceSha256),
      }))
    : [];
  return { applied, ledger };
}

async function getJson(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: controller.signal,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  } finally {
    clearTimeout(timeout);
  }
}

/** The running API's compatibility document (`GET /api/v1/meta`), or null when it cannot be read. */
export async function readMeta(apiUrl, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  try {
    const { status, payload } = await getJson(new URL("/api/v1/meta", apiUrl).toString(), { fetchImpl, timeoutMs });
    if (status !== 200 || payload?.success !== true || typeof payload.data !== "object") return null;
    return payload.data;
  } catch {
    return null;
  }
}

/**
 * Whether the store's API answers ordinary requests with the freeze refusal:
 * true or false from an answer, null when nothing answered. A probe path
 * (/health, /readyz, /meta) stays open during a freeze, so this reads
 * `/api/v1/platform`, a public read.
 */
export async function readFreezeState(apiUrl, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  try {
    const { status, payload } = await getJson(new URL("/api/v1/platform", apiUrl).toString(), { fetchImpl, timeoutMs });
    return status === 503 && payload?.code === FREEZE_RESPONSE_CODE;
  } catch {
    return null;
  }
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split(".") : [] };
}

/** Semantic-version order of two releases: -1, 0 or 1; null when either is not a version. */
export function compareReleaseVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function listNames(names, limit = 5) {
  return names.length > limit ? `${names.slice(0, limit).join(", ")} and ${names.length - limit} more` : names.join(", ");
}

const refuse = (code, message) => ({ ok: false, code, message });

/**
 * The pre-flight decision. `remote` is null when the database was not read (a
 * dry run); `meta` is null when the API was not read. `frozen` is what the
 * freeze probe observed: true, false, or null when the API could not be asked.
 * `previous` is the newest receipt for the database; `resumeFrozen` is the
 * operator's `--resume-frozen`, for a failed deploy's freeze whose receipt is
 * on another machine. `freezes` is false for `--migrate-only`, which never
 * freezes and so needs no API to watch.
 */
export function decideUpgrade({ tree, remote = null, meta = null, frozen = null, previous = null, resumeFrozen = false, treeRelease = null, freezes = true }) {
  const latest = tree.at(-1);
  if (!latest) return refuse("no_migrations", "This tree has no migrations to compare with the database.");

  if (meta) {
    const provider = meta.database?.provider ?? null;
    if (provider && provider !== "d1") {
      return refuse("provider_mismatch", `The running API reports a ${provider} database, but this deploy migrates D1. `
        + `Deploy with --database-provider ${provider} (its schema is upgraded by upgrade:schema), or check that apps/api/wrangler.jsonc names this store's database.`);
    }
    const expected = meta.database?.schema?.expected;
    if (expected && Number.isInteger(expected.version)) {
      if (expected.version > latest.version) {
        return refuse("tree_older_than_deployed", `The API serving this store was built for schema ${expected.name}; this tree ends at ${latest.name}. `
          + "Deploying it would put older code on the store. Update this checkout to the deployed release or a later one, then deploy again.");
      }
      const mine = tree.find((migration) => migration.version === expected.version);
      if (mine && mine.name !== expected.name) {
        return refuse("diverged", `The API serving this store expects ${expected.name}, but migration ${String(expected.version).padStart(4, "0")} in this tree is ${mine.name}: `
          + "the deployed code and this tree have different histories. Rebase this branch onto the deployed release so its migrations come after the deployed ones, then deploy.");
      }
    }
    // Builds before 2.0.0-rc.1 reported apps/api's package version ("1.0.0")
    // as their release: that says nothing about which release runs, so it is
    // not compared (the schema check above still is).
    if (meta.platform?.version !== PRE_RELEASE_REPORTING_VERSION && compareReleaseVersions(meta.platform?.version, treeRelease) === 1) {
      return refuse("tree_older_than_deployed", `The API serving this store is release ${meta.platform.version}; this tree is ${treeRelease}. `
        + "Update this checkout to the deployed release or a later one, then deploy again.");
    }
  }

  // Frozen is what the API answers, never what a receipt says: a receipt stays
  // "held" after an operator released by hand, or a kill between its save and
  // the Wrangler call.
  const receiptHolds = receiptHoldsFreeze(previous);
  if (frozen === true && !receiptHolds && !resumeFrozen) {
    return refuse("frozen_by_someone_else", "The store is frozen (its API answers database_migration_in_progress) and no deploy receipt here says a deploy froze it: "
      + "a database cutover or another operator may hold the freeze. Finish that work first. If a failed deploy on another machine left it, "
      + `copy that machine's receipt into ${RECEIPT_DIRECTORY}/<database>/ or pass --resume-frozen, then deploy again.`);
  }
  if (frozen === null && receiptHolds) {
    return refuse("freeze_unobservable", `The last deploy receipt (${previous.startedAt}) says that deploy left the store frozen, but the API could not be asked whether it still is. `
      + "Pass --api-url with the store's API origin, reachable from here, and deploy again; nothing was changed.");
  }

  if (!remote) {
    return { ok: true, remoteRead: false, latest: latest.name, pending: null, freeze: false, recoveryPoint: false, resume: false, firstInstall: false, notes: [] };
  }

  const known = new Set(tree.map((migration) => migration.file));
  const foreign = remote.applied.filter((name) => !known.has(name)).map((name) => name.replace(/\.sql$/, ""));
  if (foreign.length > 0) {
    return refuse("database_ahead_of_tree", `The database has applied ${foreign.length} migration(s) this tree does not have (${listNames(foreign)}): `
      + "a newer release or another branch upgraded it. Update this checkout to that release and deploy again; never deploy an older tree over a newer database.");
  }
  for (let index = 0; index < remote.applied.length; index += 1) {
    if (remote.applied[index] !== tree[index].file) {
      return refuse("diverged", `The database's migration history diverges from this tree at row ${index + 1}: it applied ${remote.applied[index]} where this tree has ${tree[index].file}. `
        + `Two branches each added a migration. Rebase this branch and renumber its migrations after ${remote.applied.at(-1)}, then deploy.`);
    }
  }
  const byVersion = new Map(tree.map((migration) => [migration.version, migration]));
  for (const row of remote.ledger) {
    const mine = byVersion.get(row.version);
    if (!mine || mine.name !== row.name) {
      return refuse("database_ahead_of_tree", `The database's schema ledger records ${row.name}, which this tree does not have. `
        + "Update this checkout to the release that applied it, then deploy again.");
    }
    if (mine.sourceSha256 !== row.sourceSha256) {
      return refuse("migration_edited", `Migration ${row.name} in this tree is not the one the database applied (its source digest differs). `
        + "Deployed migrations are immutable: restore the file from the release that deployed it and put the change in a new migration.");
    }
  }
  const ledgerVersions = new Set(remote.ledger.map((row) => row.version));
  const appliedVersions = remote.applied.map((name) => Number(name.slice(0, 4))).filter((version) => version >= FIRST_RELEASE_LEDGER_VERSION);
  const halfApplied = [
    ...appliedVersions.filter((version) => !ledgerVersions.has(version)),
    ...[...ledgerVersions].filter((version) => !appliedVersions.includes(version)),
  ];
  if (halfApplied.length > 0) {
    const names = halfApplied.map((version) => byVersion.get(version)?.name ?? String(version));
    // A restore is advised only for the bookmark of the deploy that did this, and only while the store stayed frozen since.
    const cause = previous?.outcome === "failed-frozen" && frozen === true && receiptHolds && previous.recoveryPoint?.bookmark ? previous : null;
    const advice = cause
      ? `The deploy of ${cause.startedAt} stopped there and the store has stayed frozen since, so restoring its recovery point loses no write: `
        + `pnpm --dir apps/api exec wrangler d1 time-travel restore ${cause.database} --bookmark=${cause.recoveryPoint.bookmark}, then deploy again.`
      : "Investigate first: compare d1_migrations, scalius_schema_migrations and the file's statements. Do not restore a bookmark blindly: a restore loses every write since it was taken.";
    return refuse("half_applied", `The database's two migration ledgers disagree about ${listNames(names)}: a migration may have applied in part. Do not migrate on top of it. ${advice}`);
  }

  const pending = tree.slice(remote.applied.length);
  const firstInstall = remote.applied.length === 0;
  const resume = frozen === true;
  if (freezes && pending.length > 0 && !firstInstall && !resume && frozen === null) {
    return refuse("freeze_unobservable", `${pending.length} migration(s) are pending on a store with data. The deploy freezes the store first and must watch the freeze take effect before the bookmark, `
      + "but the API could not be asked. Pass --api-url with the store's API origin, reachable from here, and deploy again; nothing was changed.");
  }
  const notes = [];
  if (receiptHolds && frozen === false) {
    notes.push(`The last receipt (${previous.startedAt}) says its freeze was held, but the API serves: that freeze was released outside the deploy. This deploy treats the store as live.`);
  }
  return {
    ok: true,
    remoteRead: true,
    latest: latest.name,
    from: remote.applied.at(-1)?.replace(/\.sql$/, "") ?? null,
    appliedCount: remote.applied.length,
    pending,
    firstInstall,
    resume,
    // A resumed freeze: did the deploy that left it change the schema? Unknown counts as yes (the side that keeps it frozen).
    resumeSchemaChanged: resume ? previous?.schemaChanged !== false : false,
    previous: resume ? previous : null,
    // A store with data is frozen around its migrations; a resumed freeze is finished and released.
    freeze: resume || (pending.length > 0 && !firstInstall),
    recoveryPoint: pending.length > 0 && !firstInstall,
    notes,
  };
}

/** What a pre-flight decision means, for the deploy log. */
export function describeUpgradeDecision(decision) {
  if (!decision.ok) return [`✗ Upgrade pre-flight refused (${decision.code}): ${decision.message}`];
  if (!decision.remoteRead) {
    return [
      `ℹ Upgrade pre-flight: this tree ends at ${decision.latest}. The remote was not read (dry run).`,
      "  A real deploy reads the API's /api/v1/meta and both D1 migration ledgers first, refuses a diverged or newer database,",
      `  and, when migrations are pending on a store with data, freezes writes, records a Time Travel bookmark in ${RECEIPT_DIRECTORY}/, migrates, deploys, verifies and releases.`,
    ];
  }
  const lines = [];
  if (decision.pending.length === 0) {
    lines.push(`✓ Upgrade pre-flight: the database is at ${decision.from}, current with this tree; no migration to apply.`);
  } else {
    const range = `${decision.pending[0].name} to ${decision.pending.at(-1).name}`;
    lines.push(decision.firstInstall
      ? `✓ Upgrade pre-flight: a new database; ${decision.pending.length} migration(s) to apply (${range}), no freeze needed.`
      : `✓ Upgrade pre-flight: the database is at ${decision.from}; ${decision.pending.length} migration(s) to apply (${range}).`);
    for (const migration of decision.pending) {
      for (const { table, basis } of migration.rewrites ?? []) lines.push(`  ${migration.name} rewrites ${table}: ${basis}`);
    }
  }
  for (const note of decision.notes ?? []) lines.push(`  ${note}`);
  if (decision.resume) lines.push("  The store is still frozen by an earlier deploy: this one finishes it and releases the freeze.");
  else if (decision.freeze) lines.push("  Writes are frozen from before the bookmark until the new API is verified (planned downtime; probes stay up).");
  return lines;
}

/**
 * A new receipt for one guarded upgrade. A run that finishes an earlier one's
 * freeze (`resumes`) carries that run's recovery point and API version: the
 * point before any of its files applied.
 */
export function createReceipt({ database, worker, decision, startedAt, apiVersionBefore = null, resumes = null }) {
  return {
    contract: RECEIPT_CONTRACT,
    database,
    worker,
    startedAt,
    ...(resumes ? { resumes: resumes.startedAt } : {}),
    apiVersionBefore: resumes?.apiVersionBefore ?? apiVersionBefore,
    migrations: {
      from: decision.from ?? null,
      to: decision.pending?.at(-1)?.name ?? decision.from ?? null,
      pending: (decision.pending ?? []).map((migration) => migration.name),
      rewrites: (decision.pending ?? []).flatMap((migration) => (migration.rewrites ?? []).map((rewrite) => ({ migration: migration.name, ...rewrite }))),
    },
    recoveryPoint: resumes?.recoveryPoint ?? null,
    freeze: { held: decision.resume === true, setByThisDeploy: false, released: false },
    schemaChanged: decision.resume === true ? decision.resumeSchemaChanged !== false : false,
    outcome: "in-progress",
    steps: [],
  };
}

const WRANGLER = "pnpm --dir apps/api exec wrangler";

/** The one command that releases a freeze while the version holding it serves. */
export function releaseCommand({ wranglerPrefix = WRANGLER, workerConfigFlag = "" } = {}) {
  return `${wranglerPrefix} secret delete ${FREEZE_SECRET}${workerConfigFlag}`;
}

/**
 * The way back to a receipt's recovery point, in the order that loses
 * nothing: restore the database while the store is still frozen, then roll
 * the API Worker back to the version that served before the freeze. That
 * version has no freeze secret, so the rollback also releases the store; no
 * `secret delete` follows it (it would edit the latest version, which no
 * longer serves). Without the version id, the step says how to find it: in
 * `wrangler deployments list` the deployment just before this deploy is the
 * freeze (`secret put`: the old code with the freeze), and the one before
 * that is the version to roll back to.
 */
export function rollbackCommands(receipt, { wranglerPrefix = WRANGLER, d1ConfigFlag = "", workerConfigFlag = "" } = {}) {
  const commands = [];
  if (receipt.recoveryPoint?.bookmark) {
    commands.push(`${wranglerPrefix} d1 time-travel restore ${receipt.database} --bookmark=${receipt.recoveryPoint.bookmark}${d1ConfigFlag}`);
  }
  commands.push(receipt.apiVersionBefore
    ? `${wranglerPrefix} rollback ${receipt.apiVersionBefore} --message "Back to before the ${receipt.startedAt} upgrade"${workerConfigFlag}`
    : `# The version from before the freeze is not recorded: run ${wranglerPrefix} deployments list${workerConfigFlag}, skip the freeze deployment (created by secret put just before this deploy), and run ${wranglerPrefix} rollback <the version before it>${workerConfigFlag}`);
  return commands;
}

/** Where receipts live: `SCALIUS_DEPLOY_RECEIPTS`, else ~/.scalius/deploy-receipts (outside every checkout). */
export function receiptsDirectory(env = process.env, home = homedir()) {
  const configured = String(env.SCALIUS_DEPLOY_RECEIPTS ?? "").trim();
  return configured ? resolve(configured) : join(home, ".scalius", "deploy-receipts");
}

export function receiptPath(directory, receipt) {
  const stamp = receipt.startedAt.replace(/[:.]/g, "-");
  return join(directory, receipt.database, `${stamp}.json`);
}

export function writeReceipt(directory, receipt) {
  const path = receiptPath(directory, receipt);
  mkdirSync(join(directory, receipt.database), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
}

/** The newest receipt in `directory` for the database, or null. */
export function latestReceipt(directory, database) {
  let files;
  try {
    files = readdirSync(join(directory, database)).filter((file) => file.endsWith(".json")).sort();
  } catch {
    return null;
  }
  for (const file of files.reverse()) {
    try {
      const receipt = JSON.parse(readFileSync(join(directory, database, file), "utf8"));
      if (receipt?.contract === RECEIPT_CONTRACT) return receipt;
    } catch {
      continue;
    }
  }
  return null;
}

/** Whether a receipt says its deploy left the store frozen (evidence of who froze it, never of whether it still is). */
export function receiptHoldsFreeze(receipt) {
  return Boolean(receipt && receipt.freeze?.held === true && receipt.freeze?.released !== true);
}

/**
 * Wait until the API is seen refusing ordinary requests continuously for
 * `holdMs` (default 60 s): repeated answers, not one location's first. An
 * invocation that started before the freeze keeps its old environment, so the
 * hold is what lets requests and their after-response work finish. Throws when
 * no refusal is seen within `firstWithinMs` or the hold never completes within
 * `totalMs`.
 */
export async function awaitObservedFreeze({ probe, sleep, now, firstWithinMs = 90_000, holdMs = 60_000, totalMs = 240_000, intervalMs = 3_000, log = () => {} }) {
  const started = now();
  let since = null;
  let observations = 0;
  for (;;) {
    const state = await probe();
    const at = now();
    if (state === true) {
      if (since === null) {
        since = at;
        log("✓ The API refuses ordinary requests; holding while old invocations drain.");
      }
      observations += 1;
      if (at - since >= holdMs && observations >= 3) return { observations, heldMs: at - since };
    } else {
      since = null;
      observations = 0;
      if (at - started >= firstWithinMs && state !== true) {
        throw new Error(`The API did not start refusing requests within ${Math.round(firstWithinMs / 1000)}s of the freeze being set.`);
      }
    }
    if (at - started >= totalMs) throw new Error(`The API's refusals did not hold for ${Math.round(holdMs / 1000)}s within ${Math.round(totalMs / 1000)}s.`);
    await sleep(intervalMs);
  }
}

/** Wait until the API serves ordinary requests again; throws when it still refuses after `withinMs`. */
export async function awaitObservedRelease({ probe, sleep, now, withinMs = 60_000, intervalMs = 3_000 }) {
  const started = now();
  for (;;) {
    if (await probe() === false) return;
    if (now() - started >= withinMs) throw new Error(`The API still answered database_migration_in_progress ${Math.round(withinMs / 1000)}s after the release.`);
    await sleep(intervalMs);
  }
}

export class GuardedUpgradeError extends Error {
  constructor(message, { outcome, step, receipt }) {
    super(message);
    this.name = "GuardedUpgradeError";
    this.outcome = outcome;
    this.step = step;
    this.receipt = receipt;
  }
}

const errorText = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Freeze, recovery point, migrate, deploy the API, verify, release.
 *
 * steps: {
 *   setFreeze(), awaitFreeze() (throws unless the freeze is observed holding),
 *   freezeState() -> true | false | null (what the API answers now),
 *   bookmark() -> { bookmark, takenAt }, migrate(), appliedCount() -> number,
 *   deployApi(), verifyApi(), releaseFreeze() (throws unless the release is observed),
 *   saveReceipt(receipt), now() -> ISO string,
 * }
 * `migrateOnly` (`--migrate-only`): no freeze, no deploy, no verification.
 * `commands`: { rollback(receipt) -> string[], release() -> string }.
 *
 * Outcomes written to the receipt (and on the thrown error):
 *   deployed                 new code verified on the new schema; any freeze released and seen released
 *   migrated                 --migrate-only applied its migrations (the running code serves them)
 *   deployed-frozen          new code verified, but the store still refuses writes (a release that did not take, or a freeze the new version inherited)
 *   failed-unchanged         nothing changed: old code on the old schema serves as before
 *   failed-unchanged-frozen  nothing changed, but the freeze this run set did not release: the store refuses writes
 *   failed-freeze-unknown    the freeze call failed and the API could not be asked whether it took
 *   failed-frozen            the schema changed (or may have) and the store stays frozen; no write since the bookmark
 *   failed-deploy            a code-only deploy's upload failed: Wrangler normally leaves the previous version serving
 *   failed-unverified        a code-only deploy's new code serves but did not verify
 *   failed-migrate-partial   --migrate-only applied some files, not all: the running code serves a schema part way
 *   failed-first-install     a new database stopped part way; nothing served from it
 */
export async function runGuardedUpgrade({ decision, receipt, steps, log = console.log, migrateOnly = false, commands = {} }) {
  const rollback = commands.rollback ?? ((next) => rollbackCommands(next));
  const release = commands.release ?? (() => releaseCommand());
  const pending = decision.pending ?? [];
  // Observed by the pre-flight (a resume), or once this run's freeze is set.
  let frozen = decision.resume === true;
  let schemaChanged = decision.resume === true && decision.resumeSchemaChanged !== false;

  const record = async (step, ok, detail) => {
    receipt.steps.push({ step, at: steps.now(), ok, ...(detail ? { detail } : {}) });
    receipt.schemaChanged = schemaChanged;
    await steps.saveReceipt(receipt);
  };
  const finish = async (outcome) => {
    receipt.outcome = outcome;
    receipt.schemaChanged = schemaChanged;
    receipt.finishedAt = steps.now();
    await steps.saveReceipt(receipt);
  };
  const stop = async (step, outcome, message) => {
    await finish(outcome);
    throw new GuardedUpgradeError(message, { outcome, step, receipt });
  };
  const rollbackText = () => rollback(receipt).map((command) => `  ${command}`).join("\n");

  const fail = async (step, error) => {
    await record(step, false, errorText(error));
    const cause = `${step} failed: ${errorText(error)}`;
    if (frozen && !schemaChanged) {
      try {
        await steps.releaseFreeze();
        frozen = false;
        receipt.freeze.released = true;
        await record("release-freeze", true);
        return stop(step, "failed-unchanged", `${cause}\nNo migration was applied and the freeze is released: the store serves its old code on its old schema, as before. Fix the cause and deploy again.`);
      } catch (releaseError) {
        await record("release-freeze", false, errorText(releaseError));
        return stop(step, "failed-unchanged-frozen", `${cause}\nNo migration was applied, but the freeze this deploy set did not release (${errorText(releaseError)}): the store refuses writes. Release it:\n  ${release()}`);
      }
    }
    if (frozen) {
      return stop(step, "failed-frozen", [
        cause,
        "The schema changed but the new code is not verified, so the store stays frozen: the old code must not write to the new schema, and nothing has been written since the bookmark.",
        "Either fix the cause and deploy again (the pre-flight sees this freeze, finds the receipt and finishes the upgrade),",
        "or roll back, losing nothing (the rollback also releases the store):",
        rollbackText(),
      ].join("\n"));
    }
    if (decision.firstInstall && schemaChanged) {
      return stop(step, "failed-first-install", `${cause}\nThe new database is part way migrated and nothing serves from it yet. Fix the cause and deploy again: Wrangler continues from the last applied file.`);
    }
    if (migrateOnly && schemaChanged) {
      return stop(step, "failed-migrate-partial", `${cause}\nSome migrations applied and some did not; the running API now serves a schema it was not built for. `
        + `Finish with pnpm run deploy (it freezes the store and ships the matching code), or restore the bookmark taken before (it loses every write since):\n${rollbackText()}`);
    }
    if (step === "verify-api") {
      return stop(step, "failed-unverified", `${cause}\nThe new code is serving but did not verify. Investigate (pnpm ops:check), or roll it back:\n${rollbackText()}`);
    }
    if (step === "deploy-api") {
      return stop(step, "failed-deploy", `${cause}\nThe API upload failed; Wrangler normally leaves the previous version serving. Confirm with pnpm --dir apps/api exec wrangler deployments list, then deploy again.`);
    }
    return stop(step, "failed-unchanged", `${cause}\nNothing was changed. Fix the cause and deploy again.`);
  };

  await steps.saveReceipt(receipt);

  if (decision.freeze && !decision.resume && !migrateOnly) {
    receipt.freeze.setByThisDeploy = true;
    try {
      await steps.setFreeze();
    } catch (error) {
      // Did the freeze take anyway (a lost answer)? Only what the API answers says.
      let state = null;
      try {
        state = await steps.freezeState();
      } catch {
        state = null;
      }
      if (state === true) {
        frozen = true;
        receipt.freeze.held = true;
        await fail("set-freeze", error);
      }
      receipt.freeze.setByThisDeploy = false;
      await record("set-freeze", false, errorText(error));
      if (state === false) return stop("set-freeze", "failed-unchanged", `set-freeze failed: ${errorText(error)}\nThe freeze was not applied and nothing changed: the store serves as before. Fix the cause and deploy again.`);
      return stop("set-freeze", "failed-freeze-unknown", `set-freeze failed: ${errorText(error)}\nThe API could not be asked whether the freeze took. If ${"/api/v1/platform"} answers 503 database_migration_in_progress, release it:\n  ${release()}`);
    }
    // Wrangler set it: from here the freeze is this run's to release.
    frozen = true;
    receipt.freeze.held = true;
    await record("set-freeze", true);
    try {
      await steps.awaitFreeze();
      await record("freeze-effective", true);
    } catch (error) {
      await fail("freeze-effective", error);
    }
  }

  // A resumed upgrade keeps the bookmark its first run took, before any file applied.
  if (decision.recoveryPoint && !receipt.recoveryPoint) {
    try {
      const point = await steps.bookmark();
      receipt.recoveryPoint = { bookmark: point.bookmark, takenAt: point.takenAt, database: receipt.database };
      await record("recovery-point", true, point.bookmark);
      log(`✓ Recovery point: D1 bookmark ${point.bookmark} at ${point.takenAt}.`);
      log(`  Restore (destructive; while still frozen it loses no write): ${rollback(receipt)[0]}`);
    } catch (error) {
      await fail("recovery-point", error);
    }
  }

  if (pending.length > 0) {
    const before = decision.appliedCount ?? 0;
    try {
      await steps.migrate();
      schemaChanged = true;
      await record("migrate", true, `${pending[0].name}..${pending.at(-1).name}`);
    } catch (error) {
      // Did any file apply? Ask the database; when it cannot answer, assume it did (the safe side).
      let applied = null;
      try {
        applied = await steps.appliedCount();
      } catch {
        applied = null;
      }
      schemaChanged = applied === null || applied !== before;
      await fail("migrate", error);
    }
  }

  if (migrateOnly) {
    await finish("migrated");
    return receipt;
  }

  try {
    await steps.deployApi();
    await record("deploy-api", true);
  } catch (error) {
    await fail("deploy-api", error);
  }

  try {
    await steps.verifyApi();
    await record("verify-api", true);
  } catch (error) {
    await fail("verify-api", error);
  }

  if (frozen) {
    try {
      await steps.releaseFreeze();
      frozen = false;
      receipt.freeze.released = true;
      await record("release-freeze", true);
    } catch (error) {
      await record("release-freeze", false, errorText(error));
      return stop("release-freeze", "deployed-frozen", `The new API is deployed and verified, but the release did not take (${errorText(error)}): the store refuses writes. Release it:\n  ${release()}\nthen check pnpm ops:check.`);
    }
  } else {
    // A rollback leaves the freeze on the Worker's latest version; a later deploy inherits that version's secrets.
    let state = null;
    try {
      state = await steps.freezeState();
    } catch {
      state = null;
    }
    if (state === true) {
      await record("inherited-freeze", false, "the new version answers database_migration_in_progress");
      return stop("verify-api", "deployed-frozen", `The new API is deployed and verified, but it refuses writes: it inherited ${FREEZE_SECRET} from the Worker's latest version (a rollback leaves the freeze there). `
        + `This deploy set no freeze; if no cutover holds one, release it:\n  ${release()}`);
    }
  }
  await finish("deployed");
  return receipt;
}
