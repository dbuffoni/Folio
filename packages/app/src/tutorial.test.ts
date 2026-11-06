import { describe, expect, it } from 'vitest';
import { TUTORIAL_SLIDES } from './ui.ts';
import { createTestApp } from './testing.ts';

describe('tutorial', () => {
  it('opens by itself on the first start, even with no document open @FR-APP-17', async () => {
    const t = await createTestApp();
    expect(t.app.settings.onboardingDone).toBe(false);
    expect(t.app.active).toBeNull();
    t.ui.startTutorial(t.app.settings.onboardingDone);
    expect(t.ui.tutorial).toBe(0);
  });

  it('does not open by itself for users who already went through the old coach marks @FR-APP-17', async () => {
    const t = await createTestApp();
    await t.app.setSetting('onboardingDone', true);
    t.ui.startTutorial(t.app.settings.onboardingDone);
    expect(t.ui.tutorial).toBeNull();
  });

  it('has six slides with Back, Next and Done; the last Next ends it @FR-APP-17', async () => {
    const t = await createTestApp();
    expect(TUTORIAL_SLIDES).toBe(6);
    t.ui.openTutorial();
    t.ui.backTutorial();
    expect(t.ui.tutorial).toBe(0);
    for (let i = 1; i < TUTORIAL_SLIDES; i++) expect(t.ui.nextTutorial()).toBe(true);
    expect(t.ui.tutorial).toBe(5);
    expect(t.ui.nextTutorial()).toBe(false);
    t.ui.backTutorial();
    expect(t.ui.tutorial).toBe(4);
  });

  it('Skip, Done or Esc remember the tutorial was seen; Help ▸ Tutorial reopens it from slide 1 @FR-APP-17', async () => {
    const t = await createTestApp();
    t.ui.startTutorial(false);
    t.ui.nextTutorial();
    await t.app.endTutorial(t.ui);
    expect(t.ui.tutorial).toBeNull();
    expect(t.app.settings.onboardingDone).toBe(true);
    t.ui.startTutorial(t.app.settings.onboardingDone);
    expect(t.ui.tutorial).toBeNull();
    await t.registry.run('help.tutorial', t.ctx());
    expect(t.ui.tutorial).toBe(0);
  });

  it('links in the slides open Settings directly on the pane they name @FR-APP-17', async () => {
    const t = await createTestApp();
    t.ui.openTutorial();
    await t.app.tutorialToSettings(t.ui, 'profiles');
    expect(t.ui.tutorial).toBeNull();
    expect(t.ui.dialog).toBe('settings');
    expect(t.ui.settingsPane).toBe('profiles');
    await t.app.tutorialToSettings(t.ui, 'smartFill');
    expect(t.ui.settingsPane).toBe('smartFill');
  });

  it('the privacy switches shown in the tutorial start off and change the real settings @FR-APP-17 @FR-APP-16', async () => {
    const t = await createTestApp();
    expect(t.app.settings.keepBackup).toBe(false);
    expect(t.app.settings.updates.check).toBe(false);
    await t.app.setSetting('keepBackup', true);
    await t.app.setSetting('updates', { ...t.app.settings.updates, check: true });
    expect(t.app.settings.keepBackup).toBe(true);
    expect(t.app.settings.updates.check).toBe(true);
  });
});
