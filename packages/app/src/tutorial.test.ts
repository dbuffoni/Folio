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

  it('a link opens Settings on its pane, and closing Settings brings the tutorial back on the same slide @FR-APP-17', async () => {
    const t = await createTestApp();
    t.ui.openTutorial();
    t.ui.nextTutorial();
    t.ui.nextTutorial();
    t.app.tutorialToSettings(t.ui, 'profiles');
    expect(t.ui.tutorial).toBeNull();
    expect([t.ui.dialog, t.ui.settingsPane]).toEqual(['settings', 'profiles']);
    // Not ended: the tutorial still counts as unseen until Done or Skip.
    expect(t.app.settings.onboardingDone).toBe(false);
    t.ui.closeDialog();
    expect(t.ui.dialog).toBeNull();
    expect(t.ui.tutorial).toBe(2);
    t.ui.nextTutorial();
    t.app.tutorialToSettings(t.ui, 'smartFill');
    expect(t.ui.settingsPane).toBe('smartFill');
    t.ui.closeDialog();
    expect(t.ui.tutorial).toBe(3);
    // A plain Settings close does not open a tutorial.
    t.ui.openSettings('general');
    t.ui.closeDialog();
    expect(t.ui.tutorial).toBe(3);
    await t.app.endTutorial(t.ui);
    t.ui.openSettings('general');
    t.ui.closeDialog();
    expect(t.ui.tutorial).toBeNull();
  });

  it('the progress dots jump to a slide @FR-APP-17', async () => {
    const t = await createTestApp();
    t.ui.openTutorial();
    t.ui.gotoTutorial(4);
    expect(t.ui.tutorial).toBe(4);
    t.ui.gotoTutorial(9);
    expect(t.ui.tutorial).toBe(4);
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
