/**
 * Which model plans when GEMINI_MODEL is not set. For this submission the default is gemini-3.1-flash-lite
 * (it wrote a valid plan on the developer's key, full /api/plan flow 7.3 s, 7/7 checks), used only if the
 * key lists it; otherwise the existing rule (newest stable Flash) still applies.
 */
import { describe, expect, it } from 'vitest';
import {
  chooseDefaultModel,
  DEFAULT_PRIMARY_MODEL,
  FALLBACK_MODEL,
  ModelResolver,
  type GeminiLike,
} from '../../server/gemini/client';

const KEY_LIST = [
  'models/gemini-3.8-flash',
  'models/gemini-3.6-flash',
  'models/gemini-3.5-flash',
  'models/gemini-3.1-flash-lite',
  'models/gemini-2.5-flash',
];

describe('chooseDefaultModel', () => {
  it('the default is gemini-3.1-flash-lite', () => {
    expect(DEFAULT_PRIMARY_MODEL).toBe('gemini-3.1-flash-lite');
  });
  it('uses the default when the key lists it (with or without the models/ prefix)', () => {
    expect(chooseDefaultModel(KEY_LIST)).toBe('gemini-3.1-flash-lite');
    expect(chooseDefaultModel(KEY_LIST.map((n) => n.replace('models/', '')))).toBe('gemini-3.1-flash-lite');
  });
  it('a key that does not list it keeps the old rule: the newest stable Flash model', () => {
    expect(chooseDefaultModel(KEY_LIST.filter((n) => !n.includes('lite')))).toBe('gemini-3.8-flash');
  });
  it('a list with no usable model gives the alias, as before', () => {
    expect(chooseDefaultModel(['models/gemini-embedding-001'])).toBe(FALLBACK_MODEL);
  });
  it('when listing failed, the verified default (not the alias, which may point at an exhausted model)', () => {
    expect(chooseDefaultModel(null)).toBe('gemini-3.1-flash-lite');
  });
  it('another default can be passed in', () => {
    expect(chooseDefaultModel(KEY_LIST, 'gemini-3.5-flash')).toBe('gemini-3.5-flash');
  });
});

describe('ModelResolver', () => {
  const gemini = (names: string[] | Error): GeminiLike =>
    ({
      models: {
        list: async () => {
          if (names instanceof Error) throw names;
          return (async function* () {
            for (const n of names) yield { name: n, supportedActions: ['generateContent'] };
          })();
        },
      },
    }) as unknown as GeminiLike;
  const opts = { pinned: null, heavy: null, cacheMs: 60_000 };

  it('GEMINI_MODEL (pinned) always wins over the default', async () => {
    expect(await new ModelResolver(gemini(KEY_LIST), { ...opts, pinned: 'gemini-3.5-flash' }).resolve()).toBe(
      'gemini-3.5-flash',
    );
  });
  it('without GEMINI_MODEL: the default, because this key lists it', async () => {
    expect(await new ModelResolver(gemini(KEY_LIST), opts).resolve()).toBe('gemini-3.1-flash-lite');
  });
  it('without GEMINI_MODEL, on a key without it: the newest stable Flash model', async () => {
    expect(
      await new ModelResolver(gemini(['models/gemini-3.8-flash', 'models/gemini-3.5-flash']), opts).resolve(),
    ).toBe('gemini-3.8-flash');
  });
  it('listing fails: the default', async () => {
    expect(await new ModelResolver(gemini(new Error('503')), opts).resolve()).toBe('gemini-3.1-flash-lite');
  });
  it('fallbacks after the default primary are still 3.5, then 3.6 (unchanged fallback logic)', async () => {
    const r = new ModelResolver(gemini(KEY_LIST), opts);
    expect(await r.fallbacksFor(await r.resolve())).toEqual(['gemini-3.5-flash', 'gemini-3.6-flash']);
  });
});
