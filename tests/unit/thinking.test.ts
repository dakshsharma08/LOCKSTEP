import { describe, expect, it } from 'vitest';
import { ThinkingLevel } from '@google/genai';
import { AppError } from '../../server/lib/errors';
import {
  isThinkingRejection,
  modelFamily,
  parsePlanThinking,
  planThinkingConfig,
  thinkingFallbacks,
} from '../../server/gemini/thinking';
import { redactSecrets, registerSecrets, upstreamReason } from '../../server/lib/redact';

describe('planThinkingConfig', () => {
  it('Gemini 3.x → explicit LOW level (never the model default)', () => {
    for (const m of ['gemini-3.8-flash', 'gemini-3-flash', 'gemini-3.5-flash'])
      expect(planThinkingConfig(m)).toEqual({ includeThoughts: true, thinkingLevel: ThinkingLevel.LOW });
  });
  it('Gemini 2.5 → a token budget (levels are not accepted there)', () => {
    expect(planThinkingConfig('gemini-2.5-flash')).toEqual({ includeThoughts: true, thinkingBudget: 1024 });
  });
  it('aliases and unknown models keep the old behaviour (we do not guess their generation)', () => {
    expect(planThinkingConfig('gemini-flash-latest')).toEqual({ includeThoughts: true });
    expect(modelFamily('gemini-flash-latest')).toBe('unknown');
  });
  it('models that cannot think get no thinkingConfig', () => {
    expect(planThinkingConfig('gemini-2.0-flash')).toBeUndefined();
  });
  it('honours the GEMINI_THINKING_LEVEL setting', () => {
    expect(planThinkingConfig('gemini-3.8-flash', 'high')).toEqual({
      includeThoughts: true,
      thinkingLevel: ThinkingLevel.HIGH,
    });
    expect(planThinkingConfig('gemini-3.8-flash', 'minimal')?.thinkingLevel).toBe(ThinkingLevel.MINIMAL);
    expect(planThinkingConfig('gemini-3.8-flash', 'default')).toEqual({ includeThoughts: true });
    expect(planThinkingConfig('gemini-2.5-flash', 'high')?.thinkingBudget).toBe(8192);
  });
  it('parses the env value safely', () => {
    expect(parsePlanThinking(' LOW ')).toBe('low');
    expect(parsePlanThinking('nonsense')).toBe('auto');
    expect(parsePlanThinking(undefined)).toBe('auto');
  });
  it('falls back from level → includeThoughts only → nothing', () => {
    const chain = thinkingFallbacks(planThinkingConfig('gemini-3.8-flash'));
    expect(chain).toEqual([
      { includeThoughts: true, thinkingLevel: ThinkingLevel.LOW },
      { includeThoughts: true },
      undefined,
    ]);
    expect(thinkingFallbacks(undefined)).toEqual([undefined]);
  });
});

describe('isThinkingRejection', () => {
  const e = (details: string[]) => new AppError('INTERNAL', 'x', { details });
  it('is true only for a 400 whose Google reason mentions thinking', () => {
    expect(
      isThinkingRejection(
        e(['Gemini status 400', 'Google said: INVALID_ARGUMENT: Unknown name "thinkingLevel"']),
      ),
    ).toBe(true);
    expect(
      isThinkingRejection(
        e(['Gemini status 400', 'Google said: INVALID_ARGUMENT: Invalid value at response_json_schema']),
      ),
    ).toBe(false);
    expect(isThinkingRejection(e(['Gemini status 500', 'Google said: thinking']))).toBe(false);
    expect(isThinkingRejection(new Error('thinking'))).toBe(false);
  });
});

// Key-shaped fakes are built at runtime so no key-like literal sits in the source (GitHub secret scanning).
const P = ['AI', 'za'].join('');

describe('redaction', () => {
  it('masks Google keys, key= params, header values and bearer tokens', () => {
    const k = `${P}SyD-abcdefghijklmnopqrstuvwxyz012345`;
    expect(redactSecrets(`url?key=${k}&alt=sse`)).toBe('url?key=[redacted]&alt=sse');
    expect(redactSecrets(`bad ${k} here`)).toBe('bad [redacted] here');
    expect(redactSecrets('x-goog-api-key: supersecretvalue123')).toBe('x-goog-api-key: [redacted]');
    expect(redactSecrets('Authorization: Bearer abcdef0123456789')).toBe('Authorization: Bearer [redacted]');
  });
  it('masks exact registered secrets even when they do not look like a Google key', () => {
    registerSecrets(['my-odd-looking-secret-value']);
    expect(redactSecrets('oops my-odd-looking-secret-value leaked')).toBe('oops [redacted] leaked');
  });
  it("extracts Google's reason from the SDK's JSON error text, shortened and redacted", () => {
    const sdk = new Error(
      `{"error":{"code":400,"message":"Unknown name \\"thinkingLevel\\" (key=${P}SyD-abcdefghijklmnopqrstuvwxyz012345)","status":"INVALID_ARGUMENT"}}`,
    );
    const r = upstreamReason(sdk)!;
    expect(r).toMatch(/^INVALID_ARGUMENT: Unknown name "thinkingLevel"/);
    expect(r).not.toContain(P);
    expect(upstreamReason(new Error('x'.repeat(900)), [], 50)!.length).toBeLessThanOrEqual(51);
  });
});
