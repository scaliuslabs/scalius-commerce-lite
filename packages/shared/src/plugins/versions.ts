// The one version comparison: semantic version precedence (semver.org, item
// 11), for app releases (which release a registry lists as newest, whether an
// installed app has an update) and platform releases (`minPlatformVersion`).

/** A version's precedence parts: major, minor, patch and its pre-release identifiers (build metadata dropped). */
function parts(value: string): { core: [number, number, number]; pre: string[] } {
  const [version = ""] = value.split("+", 1);
  const dash = version.indexOf("-");
  const [major = 0, minor = 0, patch = 0] = (dash < 0 ? version : version.slice(0, dash)).split(".").map((part) => Number(part) || 0);
  return { core: [major, minor, patch], pre: dash < 0 ? [] : version.slice(dash + 1).split(".") };
}

const NUMERIC = /^\d+$/;

/** One pre-release identifier against another: numbers numerically and below words, words in ASCII order. */
function compareIdentifier(left: string, right: string): -1 | 0 | 1 {
  if (left === right) return 0;
  const leftNumeric = NUMERIC.test(left);
  const rightNumeric = NUMERIC.test(right);
  if (leftNumeric && rightNumeric) {
    // By length first, so a number past 2^53 still compares exactly (semver forbids leading zeros).
    const a = left.replace(/^0+(?=\d)/, "");
    const b = right.replace(/^0+(?=\d)/, "");
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : 1;
}

/**
 * -1, 0 or 1 as `left` precedes, equals or follows `right`: major, minor and
 * patch numerically; a release above its own pre-releases; pre-release
 * identifiers field by field (`beta.8` < `beta.10`, `rc.2` < `rc.10`), a
 * numeric one below a word, a shorter set below a longer one it starts; build
 * metadata (`+...`) ignored.
 */
export function comparePluginVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index]! < b.core[index]! ? -1 : 1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index += 1) {
    const order = compareIdentifier(a.pre[index]!, b.pre[index]!);
    if (order !== 0) return order;
  }
  return a.pre.length === b.pre.length ? 0 : a.pre.length < b.pre.length ? -1 : 1;
}
