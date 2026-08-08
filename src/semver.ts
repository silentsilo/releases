/**
 * Version parsing and ordering for update decisions.
 *
 * Tauri app versions are semver. The endpoint must order them correctly,
 * including prereleases: an installed 0.2.0-rc.1 must be offered 0.2.0,
 * and an installed 0.2.0 must not be offered 0.2.0-rc.2.
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Anything a real build reports is far under this. The cap is here because
 * whatever passes validation is written to the analytics dataset, and the
 * pattern alone would accept a version thousands of characters long from
 * anyone who felt like sending one.
 */
const MAX_VERSION_LENGTH = 32;

export function isVersion(input: string): boolean {
  return input.length <= MAX_VERSION_LENGTH && VERSION_RE.test(input);
}

/** Strips an optional leading "v" so manifests and requests can disagree. */
export function normalize(input: string): string {
  return input.startsWith("v") ? input.slice(1) : input;
}

type Parsed = { core: [number, number, number]; pre: string[] | null };

function parse(input: string): Parsed | null {
  const m = VERSION_RE.exec(input);
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : null,
  };
}

/**
 * Returns a negative number when `a` is older than `b`, zero when equal,
 * positive when newer. Unparseable input sorts as oldest, so a manifest
 * with a broken version can never be offered as an update.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  for (let i = 0; i < 3; i++) {
    if (pa.core[i]! !== pb.core[i]!) return pa.core[i]! - pb.core[i]!;
  }

  // Same core: a release outranks any prerelease of it.
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;

  // Both prereleases: compare identifier by identifier, numbers
  // numerically, everything else as strings, shorter list first on a tie.
  const len = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i]!;
    const y = pb.pre[i]!;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (nx !== ny) {
      // Numeric identifiers sort below alphanumeric ones per semver.
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return pa.pre.length - pb.pre.length;
}
