import { expect, mode, openPdf, test, tool } from './helpers.ts';

test('profiles editor: create from scratch, typed fields, reorder, save as template, add to another profile @FR-FRM-20 @NFR-11', async ({ app }) => {
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Profiles' }).click();
  // Start from nothing: untick the default templates.
  for (const name of ['Identity', 'Address', 'Contacts']) await settings.getByRole('checkbox', { name, exact: true }).uncheck();
  await settings.getByRole('textbox', { name: 'New profile' }).fill('Travel');
  await settings.getByRole('button', { name: 'Add', exact: true }).click();

  const add = async (label: string, type: string): Promise<void> => {
    // The type is chosen first; only a text, number, date, address or choice entry asks for a label.
    await settings.getByRole('combobox', { name: 'Type', exact: true }).selectOption({ label: type });
    if (label) await settings.getByRole('textbox', { name: 'New entry' }).fill(label);
    else await expect(settings.getByRole('textbox', { name: 'New entry' })).toHaveCount(0);
    await settings.getByRole('button', { name: 'Add entry' }).click();
    if (label) await expect(settings.getByRole('textbox', { name: `Label: ${label}` })).toBeVisible();
  };
  await add('Full name', 'Text');
  await add('Date of birth', 'Date');
  await add('', 'E-mail');
  await expect(settings.getByRole('textbox', { name: /^Label: Email/ })).toHaveCount(0);
  await add('Seat', 'Choice');

  // Typed values are validated: a wrong e-mail address is refused with the reason, nothing is written.
  const mail = settings.getByLabel('Email', { exact: true });
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

test('a profile can name a saved signature @FR-STM-01 @FR-AIF-01', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Fill & Sign');
  await tool(app, 'Sign').click();
  await app.getByRole('menuitem', { name: 'Create new signature…' }).click();
  const dialog = app.getByRole('dialog');
  const box = (await dialog.locator('canvas').first().boundingBox())!;
  await app.mouse.move(box.x + 40, box.y + box.height / 2);
  await app.mouse.down();
  for (let i = 1; i <= 12; i++) await app.mouse.move(box.x + 40 + i * 18, box.y + box.height / 2 + Math.sin(i) * 25);
  await app.mouse.up();
  await dialog.getByRole('button', { name: 'Use now' }).click();
  await expect(app.getByRole('dialog', { name: 'Create signature' })).toBeHidden();
  await app.keyboard.press('Escape');

  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Profiles' }).click();
  await settings.getByRole('textbox', { name: 'New profile' }).fill('Signer');
  await settings.getByRole('button', { name: 'Add', exact: true }).click();
  const pick = settings.getByRole('combobox', { name: 'Signature for signature fields' });
  await expect(pick).toHaveValue('');
  const options = await pick.locator('option').allTextContents();
  expect(options.length).toBe(2);
  await pick.selectOption({ index: 1 });
  await settings.getByRole('button', { name: 'Back' }).click();
  await settings.getByRole('button', { name: 'Edit' }).click();
  await expect(pick).not.toHaveValue('');

  // A signature entry: type first (no label asked), then a saved signature and the names it answers to.
  await settings.getByRole('combobox', { name: 'Type', exact: true }).selectOption({ label: 'Signature' });
  await expect(settings.getByRole('textbox', { name: 'New entry' })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Add entry' }).click();
  const entry = settings.getByRole('combobox', { name: 'Saved signature' });
  await entry.selectOption({ index: 1 });
  await settings.getByLabel('Other names').last().fill('genitore, tutore');
  await settings.getByLabel('Other names').last().blur();
  await expect(entry).not.toHaveValue('');
});
