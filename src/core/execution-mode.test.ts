import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

describe('startup execution mode', () => {
  it.each(['true', '', 'TRUE', undefined])('defaults to DRY for %s', async value => {
    vi.resetModules();
    vi.stubEnv('DRY_RUN', value);
    const { executionMode } = await import('./execution-mode.js');
    expect(executionMode.mode).toBe('DRY');
    expect(() => executionMode.assertCanWrite('test')).toThrow(/DRY/);
  });

  it.each(['true', 'false'])('is immutable after startup (DRY_RUN=%s)', async value => {
    vi.resetModules();
    vi.stubEnv('DRY_RUN', value);
    const { executionMode } = await import('./execution-mode.js');
    const initial = value === 'false' ? 'LIVE' : 'DRY';
    vi.stubEnv('DRY_RUN', value === 'false' ? 'true' : 'false');
    expect(executionMode.mode).toBe(initial);
    expect(Object.isFrozen(executionMode)).toBe(true);
    executionMode.halt();
    expect(executionMode.mode).toBe('HALT');
    expect(executionMode.startupMode).toBe(initial);
    expect(() => executionMode.assertCanWrite('order')).toThrow(/HALT/);
    executionMode.halt();
    expect(executionMode.mode).toBe('HALT');
  });
});
