/** Update notice (FR-APP-16): Folio only tells the user that a newer release exists; it never installs one. */

/** The repository whose latest release is looked up. The shell holds the matching URL; both are fixed. */
export const RELEASES_REPO = 'dbuffoni/Folio';
const RELEASE_PAGE = `https://github.com/${RELEASES_REPO}/releases/`;

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers after the dash; empty for a final release. */
  pre: string[];
}

/** Parses `1.2.3`, `v1.2.3` and `1.2.3-rc.1` (build metadata after `+` is ignored); null for anything else. */
export function parseSemver(text: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!m) return null;
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ? m[4].split('.') : [] };
}

/** Negative when a < b, zero when equal, positive when a > b (semver precedence, pre-releases sort first). */
export function compareSemver(a: Semver, b: Semver): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && +x !== +y) return +x - +y;
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export interface ReleaseInfo {
  /** Version without a leading `v`. */
  version: string;
  /** Page of the release on GitHub, opened in the browser; never fetched by Folio. */
  url: string;
}

/**
 * Reads the answer of GitHub's "latest release" call. Drafts, pre-releases, versions that are not newer than
 * `current`, unreadable answers and links that do not lead to the project's releases give `null`.
 */
export function newerRelease(body: string, current: string): ReleaseInfo | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  if (typeof r.tag_name !== 'string') return null;
  const latest = parseSemver(r.tag_name);
  const now = parseSemver(current);
  if (!latest || !now || latest.pre.length || compareSemver(latest, now) <= 0) return null;
  const version = `${latest.major}.${latest.minor}.${latest.patch}`;
  const html = typeof r.html_url === 'string' ? r.html_url : '';
  return { version, url: html.startsWith(RELEASE_PAGE) ? html : `${RELEASE_PAGE}tag/v${version}` };
}
