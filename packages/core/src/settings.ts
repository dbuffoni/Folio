import { z } from 'zod';

export const DATE_FORMATS = ['iso', 'dmy', 'mdy', 'long'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/** Application settings (FR-APP-10). Persisted as one row per top-level key in the `settings` table. */
export const settingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2563eb'),
  uiScale: z.number().min(0.9).max(1.5).default(1),
  language: z.string().default('en'),
  /** 'fit-width' | 'fit-page' | 'actual' or a percentage 10–800. */
  defaultZoom: z.union([z.enum(['fit-width', 'fit-page', 'actual']), z.number().min(10).max(800)]).default('fit-width'),
  defaultLayout: z.enum(['continuous', 'single', 'two-page']).default('continuous'),
  pageTheme: z.enum(['normal', 'dark', 'sepia', 'high-contrast']).default('normal'),
  units: z.enum(['mm', 'in', 'pt']).default('mm'),
  keepBackup: z.boolean().default(true),
  recoveryIntervalSec: z.number().int().min(5).max(600).default(30),
  authorName: z.string().default(''),
  dateFormat: z.enum(DATE_FORMATS).default('iso'),
  highlightFields: z.boolean().default(true),
  flattenStampsOnSave: z.boolean().default(false),
  encryptSignatures: z.boolean().default(false),
  reduceMotion: z.boolean().default(false),
  sidebar: z.object({ open: z.boolean().default(true), width: z.number().min(160).max(480).default(208), tab: z.enum(['thumbnails', 'outline', 'annotations', 'attachments', 'search']).default('thumbnails') }).default({}),
  inspector: z.object({ open: z.boolean().default(true), width: z.number().min(220).max(480).default(288) }).default({}),
  onboardingDone: z.boolean().default(false),
  signatureNoteShown: z.boolean().default(false),
  ai: z
    .object({
      enabled: z.boolean().default(false),
      baseUrl: z.string().url().default('https://api.openai.com/v1'),
      model: z.string().default('gpt-4o-mini'),
      mode: z.enum(['mapping_only', 'with_values']).default('mapping_only'),
      includeImage: z.boolean().default(false),
      /** Modes for which the user ticked "Don't ask again" in the pre-flight dialog. */
      preflightAcknowledged: z.array(z.enum(['mapping_only', 'with_values'])).default([]),
      maxPagesPerRun: z.number().int().min(1).max(20).default(3),
    })
    .default({}),
});
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

/** Validates stored values key by key; invalid or unknown entries fall back to defaults. */
export function parseSettings(raw: Record<string, unknown>): Settings {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(settingsSchema.shape) as SettingsKey[]) {
    const field = settingsSchema.shape[key];
    const res = key in raw ? field.safeParse(raw[key]) : undefined;
    out[key] = res?.success ? res.data : DEFAULT_SETTINGS[key];
  }
  return out as Settings;
}

/** Formats a date for date stamps (FR-STM-05). Locale-independent except 'long'. */
export function formatDate(d: Date, format: DateFormat, locale = 'en'): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = p(d.getMonth() + 1);
  const day = p(d.getDate());
  switch (format) {
    case 'iso':
      return `${y}-${m}-${day}`;
    case 'dmy':
      return `${day}/${m}/${y}`;
    case 'mdy':
      return `${m}/${day}/${y}`;
    case 'long':
      return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  }
}
