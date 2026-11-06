import { describe, expect, it } from 'vitest';
import { FakeUpdateFeed } from '@folio/testkit';
import { DAY_MS, checkIsDue } from './updates.ts';
import { createTestApp } from './testing.ts';

// The test app reports version 0.1.0-test: 0.0.9 is not newer than it, 0.2.0 is.
describe('update notice', () => {
  it('makes no request at all while the setting is off, however often the app starts @FR-APP-16', async () => {
    const feed = new FakeUpdateFeed().release('v9.9.9');
    const t = await createTestApp({ updates: feed });
    await t.app.autoUpdateCheck;
    expect(t.app.settings.updates.check).toBe(false);
    expect(feed.calls).toBe(0);
    expect(t.app.update).toBeNull();
  });

  it('checks at start when on, shows the banner, and does so at most once a day @FR-APP-16', async () => {
    const feed = new FakeUpdateFeed().release('v0.2.0');
    const t = await createTestApp({ updates: feed });
    await t.app.setSetting('updates', { ...t.app.settings.updates, check: true });
    await t.app.start();
    await t.app.autoUpdateCheck;
    expect(feed.calls).toBe(1);
    expect(t.app.update).toMatchObject({ version: '0.2.0' });
    await t.app.start();
    await t.app.autoUpdateCheck;
    expect(feed.calls).toBe(1); // still the same day
    t.clock.advance(DAY_MS + 1000);
    await t.app.start();
    await t.app.autoUpdateCheck;
    expect(feed.calls).toBe(2);
    expect(checkIsDue('', new Date())).toBe(true);
    expect(checkIsDue('garbage', new Date())).toBe(true);
  });

  it('ignores drafts, pre-releases and releases that are not newer @FR-APP-16', async () => {
    const feed = new FakeUpdateFeed();
    const t = await createTestApp({ updates: feed });
    for (const body of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.0.9' }]) {
      feed.release('v0.2.0', body);
      expect(await t.app.checkForUpdates(false)).toBeNull();
      expect(t.app.update).toBeNull();
    }
  });

  it('Skip this version hides that release and announces the next one @FR-APP-16', async () => {
    const feed = new FakeUpdateFeed().release('v0.2.0');
    const t = await createTestApp({ updates: feed });
    await t.app.checkForUpdates(false);
    expect(t.app.update?.version).toBe('0.2.0');
    await t.app.skipUpdate();
    expect(t.app.update).toBeNull();
    expect(t.app.settings.updates.skippedVersion).toBe('0.2.0');
    await t.app.checkForUpdates(false);
    expect(t.app.update).toBeNull();
    // A manual check still reports it; a newer release breaks through the skip.
    await t.app.checkForUpdates(true);
    expect(t.app.update?.version).toBe('0.2.0');
    feed.release('v0.3.0');
    await t.app.checkForUpdates(false);
    expect(t.app.update?.version).toBe('0.3.0');
  });

  it('Dismiss closes the banner for this run only; the link opens the release page @FR-APP-16', async () => {
    const feed = new FakeUpdateFeed().release('v0.2.0');
    const t = await createTestApp({ updates: feed });
    await t.app.checkForUpdates(false);
    await t.app.openUpdate();
    expect(t.shell.opened).toEqual(['https://github.com/dbuffoni/Folio/releases/tag/v0.2.0']);
    t.app.dismissUpdate();
    expect(t.app.update).toBeNull();
    expect(t.app.settings.updates.skippedVersion).toBe('');
  });

  it('failures are silent when automatic and reported when manual @FR-APP-16', async () => {
    const feed = new FakeUpdateFeed().release('v0.2.0');
    feed.fail = true;
    const t = await createTestApp({ updates: feed });
    await t.app.setSetting('updates', { ...t.app.settings.updates, check: true });
    await t.app.start();
    await t.app.autoUpdateCheck;
    expect(feed.calls).toBe(1);
    expect(t.toastKeys()).toEqual([]);
    expect(await t.app.checkForUpdates(true)).toBeNull();
    expect(t.toastKeys()).toContain('updates.failed');
    feed.fail = false;
    feed.release('v0.0.9');
    await t.app.checkForUpdates(true);
    expect(t.toastKeys()).toContain('updates.upToDate');
  });

  it('a build without the feed (web) has no update notice @FR-APP-16', async () => {
    const t = await createTestApp();
    expect(t.app.canCheckUpdates).toBe(false);
    expect(await t.app.checkForUpdates(true)).toBeNull();
  });
});
