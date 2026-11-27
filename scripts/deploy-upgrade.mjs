// The guarded upgrade of a D1 store, run by scripts/deploy.mjs:
//
//   1. Pre-flight, before anything changes: read the running API's /meta, the
//      database's two migration ledgers (`d1_migrations`, written by Wrangler,
//      and `scalius_schema_migrations`, written by each migration) and whether
//      the store is frozen; refuse when the database or the running code has a
//      history this tree does not (a newer release deployed, two branches each
//      adding a migration, a deployed migration edited, a file half applied).
//   2. When migrations are pending on a store with data: freeze writes
//      (`DATABASE_MIGRATION_FREEZE` on the API Worker), take a D1 Time Travel
//      bookmark once in-flight writes have drained, and write the receipt
//      (bookmark, time, database, migration range, the API version before).
//   3. Migrate, deploy the API Worker, verify it, then release the freeze.
//
// A failure releases the freeze whenever the code and the schema are still a
// matched pair (both old): the store is exactly as before. Once the schema has
// changed it keeps the store frozen, because releasing would let the old code
// write to a schema it was not built for, and because a frozen store has
// taken no write since the bookmark, so restoring it loses nothing. The
// receipt and the message name both ways out: deploy again (fix forward), or
// restore the bookmark, roll the API Worker back and release (roll back).
//
// Every side effect is an injected function: deploy.mjs passes Wrangler and
// fetch, the tests pass fakes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseRewriteDeclarations } from "../packages/database/scripts/migration-writes.mjs";

export const FREEZE_SECRET = "DATABASE_MIGRATION_FREEZE";
export const RECEIPT_CONTRACT = "scalius-deploy-receipt/v1";
/** Where receipts are written, relative to the repository root (git-ignored). */
export const RECEIPT_DIRECTORY = "deploy-receipts";
/** The first migration that records itself in `scalius_schema_migrations`. */
const FIRST_RELEASE_LEDGER_VERSION = 50;
const FREEZE_RESPONSE_CODE = "database_migration_in_progress";

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
 * dry run); `meta` is null when the API was not read. `frozen` is the freeze
 * probe's answer; `resumable` says a receipt here (or the operator's
 * `--resume-frozen`) shows that a deploy, not a cutover, holds that freeze.
 */
export function decideUpgrade({ tree, remote = null, meta = null, frozen = null, resumable = false, treeRelease = null }) {
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
    if (compareReleaseVersions(meta.platform?.version, treeRelease) === 1) {
      return refuse("tree_older_than_deployed", `The API serving this store is release ${meta.platform.version}; this tree is ${treeRelease}. `
        + "Update this checkout to the deployed release or a later one, then deploy again.");
    }
  }

  if (frozen === true && !resumable) {
    return refuse("frozen_by_someone_else", "The store is frozen (its API answers database_migration_in_progress) and no deploy receipt here says a deploy froze it: "
      + "a database cutover or another operator may hold the freeze. Finish that work first. If a failed deploy from another machine left it, "
      + "copy that machine's receipt into deploy-receipts/ or pass --resume-frozen, then deploy again.");
  }

  if (!remote) {
    return { ok: true, remoteRead: false, latest: latest.name, pending: null, freeze: false, recoveryPoint: false, resume: false, firstInstall: false };
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
    return refuse("half_applied", `The database's two migration ledgers disagree about ${listNames(names)}: a migration may have applied in part. `
      + `Do not migrate on top of it. Restore the recovery point in the last deploy receipt (${RECEIPT_DIRECTORY}/), then deploy again.`);
  }

  const pending = tree.slice(remote.applied.length);
  const firstInstall = remote.applied.length === 0;
  const resume = frozen === true;
  return {
    ok: true,
    remoteRead: true,
    latest: latest.name,
    from: remote.applied.at(-1)?.replace(/\.sql$/, "") ?? null,
    appliedCount: remote.applied.length,
    pending,
    firstInstall,
    resume,
    // A store with data is frozen around its migrations; a resumed freeze is finished and released.
    freeze: resume || (pending.length > 0 && !firstInstall),
    recoveryPoint: pending.length > 0 && !firstInstall,
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
    outcome: "in-progress",
    steps: [],
  };
}

/**
 * The commands that take a receipt's store back to its recovery point, in
 * this order: restore the database while the store is still frozen (no write
 * is lost), roll the API Worker back to the version before the deploy, then
 * release the freeze (if the rollback already dropped it, Wrangler answers
 * that the secret does not exist: nothing is left to release).
 */
export function rollbackCommands(receipt, { wranglerPrefix = "pnpm --dir apps/api exec wrangler", d1ConfigFlag = "", workerConfigFlag = "" } = {}) {
  const commands = [];
  if (receipt.recoveryPoint?.bookmark) {
    commands.push(`${wranglerPrefix} d1 time-travel restore ${receipt.database} --bookmark=${receipt.recoveryPoint.bookmark}${d1ConfigFlag}`);
  }
  if (receipt.apiVersionBefore) commands.push(`${wranglerPrefix} rollback ${receipt.apiVersionBefore}${workerConfigFlag}`);
  commands.push(`${wranglerPrefix} secret delete ${FREEZE_SECRET}${workerConfigFlag}`);
  return commands;
}

/** Where receipts live: `SCALIUS_DEPLOY_RECEIPTS`, else `deploy-receipts/` in the repository. */
export function receiptsDirectory(root, env = process.env) {
  const configured = String(env.SCALIUS_DEPLOY_RECEIPTS ?? "").trim();
  return configured ? resolve(configured) : join(root, RECEIPT_DIRECTORY);
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

/** Whether a receipt shows a deploy that left the store frozen. */
export function receiptHoldsFreeze(receipt) {
  return Boolean(receipt && receipt.freeze?.held === true && receipt.freeze?.released !== true);
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
 *   setFreeze(), awaitFreeze(), bookmark() -> { bookmark, takenAt },
 *   migrate(), appliedCount() -> number, deployApi(), verifyApi(),
 *   releaseFreeze(), saveReceipt(receipt), now() -> ISO string,
 * }
 *
 * Outcomes written to the receipt (and on the thrown error):
 *   deployed          new code on the new schema, freeze released (or never set)
 *   failed-unchanged  the schema is as before and the freeze released: old code serves as before
 *   failed-frozen     the schema changed (or may have) and the store stays frozen; no write since the bookmark
 *   deployed-frozen   new code verified on the new schema, but releasing the freeze failed
 *   failed-first-install  a new database stopped part way; nothing was serving from it
 */
export async function runGuardedUpgrade({ decision, receipt, steps, log = console.log, rollbackHint = rollbackCommands }) {
  const pending = decision.pending ?? [];
  let frozen = decision.resume === true;
  // A resumed freeze was left by a deploy whose schema had already changed.
  let schemaChanged = decision.resume === true;

  const record = async (step, ok, detail) => {
    receipt.steps.push({ step, at: steps.now(), ok, ...(detail ? { detail } : {}) });
    await steps.saveReceipt(receipt);
  };
  const finish = async (outcome) => {
    receipt.outcome = outcome;
    receipt.finishedAt = steps.now();
    await steps.saveReceipt(receipt);
  };

  const fail = async (step, error) => {
    await record(step, false, errorText(error));
    let outcome;
    let advice;
    if (frozen && !schemaChanged) {
      try {
        await steps.releaseFreeze();
        frozen = false;
        receipt.freeze.released = true;
        await record("release-freeze", true);
        outcome = "failed-unchanged";
        advice = "No migration was applied and the freeze is released: the store serves its old code on its old schema, as before. Fix the cause and deploy again.";
      } catch (releaseError) {
        await record("release-freeze", false, errorText(releaseError));
        outcome = "failed-frozen";
        advice = `No migration was applied, but releasing the freeze failed: the store refuses writes. Release it: ${rollbackHint(receipt).at(-1)}`;
      }
    } else if (frozen) {
      outcome = "failed-frozen";
      advice = [
        "The schema changed but the new code is not verified, so the store stays frozen: the old code must not write to the new schema, and nothing has been written since the bookmark.",
        "Either fix the cause and deploy again (the pre-flight finds this freeze and finishes the upgrade),",
        "or roll back, losing nothing:",
        ...rollbackHint(receipt).map((command) => `  ${command}`),
      ].join("\n");
    } else if (decision.firstInstall && schemaChanged) {
      outcome = "failed-first-install";
      advice = "The new database is part way migrated and nothing serves from it yet. Fix the cause and deploy again: Wrangler continues from the last applied file.";
    } else {
      outcome = "failed-unchanged";
      advice = "Nothing was changed by this step. Fix the cause and deploy again.";
    }
    await finish(outcome);
    throw new GuardedUpgradeError(`${step} failed: ${errorText(error)}\n${advice}`, { outcome, step, receipt });
  };

  if (decision.freeze && !decision.resume) {
    // Counted as frozen before the call, and on disk before it: a lost answer
    // to a successful freeze, or a deploy killed mid-call, must still be released.
    frozen = true;
    receipt.freeze.held = true;
    receipt.freeze.setByThisDeploy = true;
  }
  await steps.saveReceipt(receipt);

  if (decision.freeze && !decision.resume) {
    try {
      await steps.setFreeze();
      await record("set-freeze", true);
      await steps.awaitFreeze();
      await record("freeze-effective", true);
    } catch (error) {
      await fail("set-freeze", error);
    }
  }

  // A resumed upgrade keeps the bookmark its first run took, before any file applied.
  if (decision.recoveryPoint && !receipt.recoveryPoint) {
    try {
      const point = await steps.bookmark();
      receipt.recoveryPoint = { bookmark: point.bookmark, takenAt: point.takenAt, database: receipt.database };
      await record("recovery-point", true, point.bookmark);
      log(`✓ Recovery point: D1 bookmark ${point.bookmark} at ${point.takenAt}.`);
      log(`  Restore (destructive; while still frozen it loses no write): ${rollbackHint(receipt)[0]}`);
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
      await finish("deployed-frozen");
      throw new GuardedUpgradeError(
        `The new API is deployed and verified, but releasing the freeze failed: the store refuses writes. Release it: ${rollbackHint(receipt).at(-1)}`,
        { outcome: "deployed-frozen", step: "release-freeze", receipt },
      );
    }
  }
  await finish("deployed");
  return receipt;
}
