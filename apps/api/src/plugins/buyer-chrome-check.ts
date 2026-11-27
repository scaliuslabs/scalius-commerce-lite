// The store's mark on each installed release's buyer-page sheet
// (`buyer-chrome.css`, @scalius/shared/plugins/buyer-chrome-mark): which
// checker version allows its bytes (`BUYER_CHROME_CSS_VERSION`), or why that
// checker refuses them. The file route serves the sheet only under a mark of
// this version (storefront-files.ts), so the storefront draws a theme's
// header and footer on a buyer's page only from a sheet this checker wrote
// byte for byte.
//
// - Install and update (`storeRelease`): the upload ran this checker on the
//   app's `styles.css` and the shipped sheet matched it, so the release is
//   marked with no parse of its own.
// - After a deploy (`recheckBuyerChromeAfterDeploy`, a stage of the version's
//   post-deploy settle, scheduled/catalog-projections.ts): every installed
//   release that asks for buyer pages, active and approved or not yet, marked
//   by an older checker, or never marked, is read again and must be this
//   checker's writing of itself (`recheckedBuyerChromeSheet`). So an app
//   activated or approved after the version settled draws at once. That parse costs
//   about 30 ms of CPU for the largest sheet an app may ship, so one run checks
//   one release and the version stays unsettled until none is left; until then
//   the release's buyer pages draw the store's own header and footer. A
//   settled version costs a later tick nothing here. A check is counted before it starts, so one a run
//   could not finish (stopped at a CPU limit) is tried at most
//   `BUYER_CHROME_CHECK_TRIES` times, then refused. A refusal is marked (not
//   checked again under this checker) and written once to the app's log,
//   which the app's page and the theme editor show the merchant.
// A buyer's request never parses a sheet: it reads a file the mark allows.

import type { Database } from "@scalius/database/client";
import { listPluginInstallations, writePluginLogs, type PluginInstallation } from "@scalius/core/modules/plugins";
import { getSystemKvMany, putSystemKv } from "@scalius/core/utils/system-kv";
import { BUYER_CHROME_CSS_VERSION, recheckedBuyerChromeSheet } from "@scalius/shared/plugins/buyer-chrome-css";
import { buyerChromeMarkCurrent, buyerChromeMarkKey, buyerChromeMarkTries, readBuyerChromeMark, type BuyerChromeMark } from "@scalius/shared/plugins/buyer-chrome-mark";
import { sha256Hex } from "@scalius/shared/plugins/registry";
import { STOREFRONT_BUYER_CHROME_FILE } from "@scalius/shared/plugins/storefront-protocol";
import { STOREFRONT_INCIDENT_SOURCE } from "@scalius/shared/plugins/storefront-incidents";
import { readPluginStorefrontFile } from "./storefront-files";

/** Releases one maintenance run parses (each about 30 ms of CPU at the largest sheet). */
export const BUYER_CHROME_CHECKS_PER_RUN = 1;

/** Checks begun on one release that no run finished, before it is refused. */
export const BUYER_CHROME_CHECK_TRIES = 3;

export async function markBuyerChromeSheet(db: Database, pluginId: string, release: string, mark: BuyerChromeMark): Promise<void> {
  await putSystemKv(db, buyerChromeMarkKey(pluginId, release), JSON.stringify(mark));
}

/**
 * An installed release whose header or footer asks to draw on the buyer's own pages: its sheet needs a mark,
 * whatever the app's status or grant now. Those change without a deploy (an app activated, or approved for
 * buyer pages, after the version settled) and the release's bytes do not, so a release is checked once per
 * checker and draws from the moment it becomes eligible.
 */
function asksForBuyerPages(installation: PluginInstallation): boolean {
  const storefront = installation.declaredManifest.storefront;
  return installation.source !== "bundled" && storefront.stylesheet
    && storefront.skins.some((skin) => skin.buyerPages === true && (skin.target === "header" || skin.target === "footer"));
}

/** The app log line a refused sheet writes: what the merchant's buyers see instead, and what fixes it. */
function refusedLine(installation: PluginInstallation, problem: string) {
  const skin = installation.declaredManifest.storefront.skins.find((entry) => entry.buyerPages === true && (entry.target === "header" || entry.target === "footer"));
  return {
    level: "error" as const,
    source: `${STOREFRONT_INCIDENT_SOURCE}skin:${skin?.id ?? "buyer-pages"}`.slice(0, 80),
    message: `Your store couldn't show this app's header and footer on your buyers' account, receipt and order pages: this version of the store does not accept its stylesheet there (${problem}). Those pages show the store's own header and footer until the app ships a release that passes.`.slice(0, 500),
    fields: { kind: "skin", reason: "refused", release: installation.bundleSha256.slice(0, 12), checker: BUYER_CHROME_CSS_VERSION },
  };
}

export interface BuyerChromeRecheck {
  /** Releases this run parsed. */
  checked: number;
  /** Of those, the ones this checker refused. */
  refused: number;
  /** Releases still to check under this checker (a later run's). */
  remaining: number;
}

/**
 * Checks again, with this checker, the sheets of releases no mark of its
 * version covers, at most `budget` parses; each gets this checker's mark.
 */
export async function recheckBuyerChromeSheets(
  db: Database,
  installations: readonly PluginInstallation[],
  read: (pluginId: string, release: string) => Promise<{ bytes: Uint8Array } | null>,
  budget = BUYER_CHROME_CHECKS_PER_RUN,
): Promise<BuyerChromeRecheck> {
  const wanted = installations.filter(asksForBuyerPages);
  const marks = new Map<string, string>();
  for (let at = 0; at < wanted.length; at += 90) {
    for (const [key, value] of await getSystemKvMany(db, wanted.slice(at, at + 90).map((installation) => buyerChromeMarkKey(installation.pluginId, installation.bundleSha256)))) marks.set(key, value);
  }
  const result: BuyerChromeRecheck = { checked: 0, refused: 0, remaining: 0 };
  for (const installation of wanted) {
    const key = buyerChromeMarkKey(installation.pluginId, installation.bundleSha256);
    const mark = readBuyerChromeMark(marks.get(key));
    if (buyerChromeMarkCurrent(mark)) continue;
    if (result.checked >= budget) {
      result.remaining += 1;
      continue;
    }
    result.checked += 1;
    const tries = buyerChromeMarkTries(mark) + 1;
    let checked: { ok: true } | { ok: false; problem: string };
    let file: { bytes: Uint8Array } | null = null;
    if (tries > BUYER_CHROME_CHECK_TRIES) {
      checked = { ok: false, problem: `the store could not finish checking the stylesheet in ${BUYER_CHROME_CHECK_TRIES} runs` };
    } else {
      // Counted first: a run stopped inside the parse leaves the count, never an allowed mark.
      await markBuyerChromeSheet(db, installation.pluginId, installation.bundleSha256, { checker: BUYER_CHROME_CSS_VERSION, tries });
      file = await read(installation.pluginId, installation.bundleSha256);
      checked = file ? recheckedBuyerChromeSheet(file.bytes) : { ok: false, problem: "the release ships no store reading of its stylesheet" };
    }
    if (checked.ok) {
      await markBuyerChromeSheet(db, installation.pluginId, installation.bundleSha256, { checker: BUYER_CHROME_CSS_VERSION, sha256: await sha256Hex(file!.bytes) });
      continue;
    }
    result.refused += 1;
    await markBuyerChromeSheet(db, installation.pluginId, installation.bundleSha256, { checker: BUYER_CHROME_CSS_VERSION, problem: checked.problem });
    await writePluginLogs(db, installation.pluginId, [refusedLine(installation, checked.problem)]);
  }
  return result;
}

/**
 * The post-deploy stage: every installed release's buyer-page sheet checked by
 * this checker, one parse a run. The caller keeps the version unsettled while
 * `remaining` is above zero (a deploy ships its checker, so the version
 * names the checker too).
 */
export async function recheckBuyerChromeAfterDeploy(env: Env, db: Database): Promise<BuyerChromeRecheck> {
  return recheckBuyerChromeSheets(db, await listPluginInstallations(db), (pluginId, release) =>
    readPluginStorefrontFile(env, db, pluginId, release, STOREFRONT_BUYER_CHROME_FILE, { unmarked: true }));
}
