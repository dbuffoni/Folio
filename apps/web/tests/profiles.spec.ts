import { expect, test } from './helpers.ts';

test('profiles editor: create from scratch, typed fields, reorder, save as template, add to another profile @FR-FRM-20 @NFR-11', async ({ app }) => {
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Profiles' }).click();
  // Start from nothing: untick the default templates.
  for (const name of ['Identity', 'Address', 'Contacts']) await settings.getByRole('checkbox', { name, exact: true }).uncheck();
  await settings.getByRole('textbox', { name: 'New profile' }).fill('Travel');
  await settings.getByRole('button', { name: 'Add', exact: true }).click();

  const add = async (label: string, type: string): Promise<void> => {
    await settings.getByRole('textbox', { name: 'New entry' }).fill(label);
    await settings.getByRole('combobox', { name: 'Type', exact: true }).selectOption({ label: type });
    await settings.getByRole('button', { name: 'Add entry' }).click();
    await expect(settings.getByRole('textbox', { name: `Label: ${label}` })).toBeVisible();
  };
  await add('Full name', 'Text');
  await add('Date of birth', 'Date');
  await add('Contact e-mail', 'E-mail');
  await add('Seat', 'Choice');

  // Typed values are validated: a wrong e-mail address is refused with the reason, nothing is written.
  const mail = settings.getByLabel('Contact e-mail', { exact: true });
  await mail.fill('not an address');
  await mail.blur();
  await expect(app.getByText(/does not look like an e-mail address/)).toBeVisible();
  await mail.fill('ada@example.org');
  await mail.blur();
  await expect(mail).toHaveValue('ada@example.org');
  const born = settings.getByLabel('Date of birth', { exact: true });
  await born.fill('1988-04-23');
  await born.blur();
  await expect(born).toHaveValue('1988-04-23');

  // Reorder from the keyboard-reachable buttons.
  await settings.getByRole('button', { name: 'Move Seat up' }).click();
  await settings.getByRole('button', { name: 'Move Seat up' }).click();
  const labels = settings.getByRole('textbox', { name: /^Label: / });
  await expect(labels.nth(1)).toHaveAttribute('aria-label', 'Label: Seat');

  // Key is stable when the label changes.
  await expect(settings.getByText('seat', { exact: true }).first()).toBeVisible();
  await settings.getByRole('textbox', { name: 'Label: Seat' }).fill('Preferred seat');
  await settings.getByRole('textbox', { name: 'Label: Seat' }).blur();
  await expect(settings.getByText('seat', { exact: true }).first()).toBeVisible();

  await settings.getByRole('textbox', { name: 'Template name' }).fill('Travel header');
  await settings.getByRole('button', { name: 'Save as template' }).click();
  await settings.getByRole('button', { name: 'Back' }).click();
  await expect(settings.getByRole('listitem').filter({ hasText: 'Travel header' })).toBeVisible();
  await expect(settings.getByRole('listitem').filter({ hasText: 'Travel header' }).getByText('Built-in')).toHaveCount(0);

  // A second profile receives the template.
  await settings.getByRole('textbox', { name: 'New profile' }).fill('Second');
  await settings.getByRole('button', { name: 'Add', exact: true }).click();
  await settings.getByRole('combobox', { name: 'Add fields from a template…' }).selectOption({ label: 'Travel header' });
  await settings.getByRole('button', { name: 'Add', exact: true }).last().click();
  await expect(settings.getByRole('textbox', { name: 'Label: Full name' })).toBeVisible();
});

test('profile editor keeps every control inside the window at any size @FR-FRM-20 @NFR-11', async ({ app }) => {
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Profiles' }).click();
  await settings.getByRole('textbox', { name: 'New profile' }).fill('Narrow');
  await settings.getByRole('button', { name: 'Add', exact: true }).click();
  for (const [width, height] of [[1360, 860], [900, 700], [640, 700], [420, 780]] as const) {
    await app.setViewportSize({ width, height });
    const overflow = await settings.evaluate((el) => {
      const pane = el.querySelector('.setpane')!;
      const edge = pane.getBoundingClientRect().left + pane.clientWidth;
      const controls = [...pane.querySelectorAll('.pfield input, .pfield select, .pfield button')];
      return { right: Math.max(...controls.map((c) => c.getBoundingClientRect().right)) - edge, scroll: pane.scrollWidth - pane.clientWidth };
    });
    expect(overflow.right, `${width}px wide`).toBeLessThanOrEqual(0);
    expect(overflow.scroll, `${width}px wide`).toBeLessThanOrEqual(0);
  }
});
