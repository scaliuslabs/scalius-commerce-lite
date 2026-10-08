// Fixtures for the `pnpm plugin` tests: a throwaway plugin package written
// by the scaffold, in a folder under node_modules/.cache (ignored by git)
// whose node_modules is linked to a workspace plugin's, so the SDK resolves.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { root } from "./plugin-build.mjs";
import { scaffoldFiles } from "./plugin-scaffold.mjs";

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#0a7"/></svg>\n';

/** A scaffolded plugin package; `withIcon` adds a listing icon, `version` replaces 0.1.0. */
export function makeTempPlugin({ id = "acme.tally", withIcon = false, version = "0.1.0" } = {}) {
  const cache = join(root, "node_modules/.cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "plugin-test-"));
  const files = scaffoldFiles(id, id.split(".")[1]);
  for (const [file, contents] of Object.entries(files)) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  symlinkSync(join(root, "plugins/bkash/node_modules"), join(dir, "node_modules"));
  if (withIcon) {
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets/icon.svg"), ICON);
  }
  editSource(dir, (source) => {
    let next = source.replace('version: "0.1.0",', `version: ${JSON.stringify(version)},`);
    if (withIcon) next = next.replace("  categories:", '  icon: "assets/icon.svg",\n  categories:');
    return next;
  });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Rewrites src/index.ts of a temp plugin. */
export function editSource(dir, change) {
  const path = join(dir, "src/index.ts");
  writeFileSync(path, change(readFileSync(path, "utf8")));
}
