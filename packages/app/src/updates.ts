import { newerRelease, type ReleaseInfo } from '@folio/core';
import type { UpdateFeed } from '@folio/ports';

/** One request to the project's release feed. Returns the newer final release, or null when there is none. Throws when the feed cannot be read. */
export async function checkUpdates(feed: UpdateFeed, currentVersion: string): Promise<ReleaseInfo | null> {
  return newerRelease(await feed.latestRelease(), currentVersion);
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** True when no check ran in the last 24 hours (or the stored time is unreadable). */
export function checkIsDue(lastCheckAt: string, now: Date): boolean {
  const last = Date.parse(lastCheckAt);
  return Number.isNaN(last) || now.getTime() - last >= DAY_MS || last > now.getTime();
}
