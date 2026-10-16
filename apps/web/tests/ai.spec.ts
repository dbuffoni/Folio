// AI settings against a simulated local server (Ollama on localhost:11434), answered by Playwright.
import type { Page, Route } from '@playwright/test';
import { expect, mode, openPdf, test, tool } from './helpers.ts';

interface ChatBody {
  response_format?: { type: string };
  messages: Array<{ role: string; content: unknown }>;
}

/** Answers like an OpenAI-compatible server on this computer; `vision: false` refuses images. */
async function fakeOllama(page: Page, opts: { vision: boolean }): Promise<string[]> {
  const seen: string[] = [];
  const reply = (route: Route, content: unknown) =>
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*' },
      contentType: 'application/json',
      body: JSON.stringify({
        model: 'llama3.2',
        choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
      }),
    });
  await page.route('http://localhost:11434/**', async (route) => {
    const req = route.request();
    seen.push(`${req.method()} ${new URL(req.url()).pathname} ${req.headers().authorization ?? 'no-auth'}`);
    if (req.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET, POST',
        },
      });
    if (req.url().endsWith('/models'))
      return route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        contentType: 'application/json',
        body: JSON.stringify({ data: [{ id: 'llama3.2' }, { id: 'llava' }] }),
      });
    const body = req.postDataJSON() as ChatBody;
    const text = JSON.stringify(body.messages);
    if (text.includes('What colour is this image')) {
      // A text-only model answers without having seen anything (a 4xx would be logged by the browser).
      return reply(route, opts.vision ? 'Red' : 'I cannot see images.');
    }
    if (text.includes('Reply with the JSON object')) return reply(route, { ok: true });
    const payload = JSON.parse(body.messages[1]!.content as string) as {
      candidates: Array<{ id: string; label?: string; type: string }>;
      keys: Array<{ key: string; label: string }>;
    };
    return reply(route, {
      fields: payload.candidates.map((c) => ({
        ref: c.id,
        label: c.label ?? '',
        fieldType: c.type,
        profileKey: payload.keys.find((k) => k.label === c.label)?.key ?? null,
        transform: 'none',
        choiceValue: null,
        confidence: 0.95,
      })),
      newAreas: [],
    });
  });
  return seen;
}

test('Ollama preset: no key, Test connection, capabilities, and Smart Fill through the local server @FR-AIF-12 @FR-AIF-13', async ({
  app,
  outbound,
}) => {
  const seen = await fakeOllama(app, { vision: false });
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Profiles' }).click();
  await settings.getByRole('textbox', { name: 'New profile' }).fill('Personal');
  await settings.getByRole('button', { name: 'Add', exact: true }).click();
  const first = settings.getByLabel('First name', { exact: true });
  await first.fill('Ada');
  await first.blur();
  await settings.getByRole('button', { name: 'Smart Fill', exact: true }).click();
  // Opening the pane sends nothing.
  expect(seen).toEqual([]);
  await settings.getByLabel('Provider').selectOption('ollama');
  await expect(settings.getByLabel('Base URL')).toHaveValue('http://localhost:11434/v1');
  await expect(settings.getByTestId('ai-local')).toHaveText('Local: data stays on this computer');
  await expect(settings.getByText('Not needed for a server on this computer.')).toBeVisible();
  expect(seen).toEqual([]);
  await settings.getByRole('button', { name: 'Test connection' }).click();
  await expect(
    settings.getByRole('status').filter({ hasText: 'Connected. 2 models available.' }),
  ).toBeVisible();
  await expect(settings.getByTestId('ai-caps')).toContainText('Images: No');
  await expect(settings.getByTestId('ai-caps')).toContainText('Structured output: Yes');
  // Without vision the image option cannot be switched on.
  await expect(settings.getByRole('checkbox', { name: 'Include an image of the page' })).toBeDisabled();
  await settings.getByRole('checkbox', { name: 'Use an AI service for Smart Fill' }).check();
  await settings.getByRole('button', { name: 'Done' }).click();

  await openPdf(app, 'flat-form.pdf');
  await mode(app, 'Fill & Sign');
  await tool(app, 'Smart Fill').click();
  const preflight = app.getByRole('dialog', { name: 'Before anything is sent' });
  await expect(
    preflight.getByText(
      'Smart Fill will send this to the local server on localhost:11434. It stays on this computer:',
    ),
  ).toBeVisible();
  await expect(preflight.getByText('An image of the page')).toHaveCount(0);
  await preflight.getByRole('button', { name: 'Send and continue' }).click();
  const panel = app.getByRole('complementary', { name: 'Inspector' });
  await expect(panel.getByRole('textbox', { name: 'First name' })).toHaveValue('Ada');
  // Every request went to the local server, none carried a key.
  expect(seen.length).toBeGreaterThan(3);
  expect(seen.every((s) => s.endsWith('no-auth'))).toBe(true);
  expect(outbound.every((u) => u.startsWith('http://localhost:11434/'))).toBe(true);
  outbound.length = 0;
});
