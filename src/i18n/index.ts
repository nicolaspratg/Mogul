import type { Language } from '../types/easyrent';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const de = require('./de.json') as Record<string, string>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const en = require('./en.json') as Record<string, string>;

const catalogs: Record<Language, Record<string, string>> = {
  de,
  en,
  // Italian falls back to English until Phase 3 translations are added.
  it: en,
};

/**
 * Translate a key into the requested language, interpolating any variables.
 *
 * Variables are wrapped in double curly braces: `{{varName}}`.
 * Missing keys fall back to English, then to the raw key string.
 *
 * @example
 * t('de', 'welcome', { shopName: 'Ski Haus' })
 * t('en', 'reservation_success', { code: 'RES-0042' })
 */
export function t(
  language: Language,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const catalog = catalogs[language] ?? catalogs.en;
  let text = catalog[key] ?? catalogs.en[key] ?? key;

  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{{${name}}}`, String(value));
    }
  }

  return text;
}
