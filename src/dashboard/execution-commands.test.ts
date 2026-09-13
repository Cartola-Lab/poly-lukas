import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

afterEach(() => vi.unstubAllEnvs());

describe('dashboard mode commands', () => {
  it.each(['true', 'false'])('rejects toggle from startup DRY_RUN=%s', async value => {
    vi.resetModules();
    vi.stubEnv('DRY_RUN', value);
    const { executionMode } = await import('../core/execution-mode.js');
    const { handleExecutionModeCommand } = await import('./execution-commands.js');
    const mode = executionMode.mode;
    const report = vi.fn();
    expect(handleExecutionModeCommand('toggleDryRun', report)).toBe(true);
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/rejected.*restart/i));
    expect(executionMode.mode).toBe(mode);
    executionMode.halt();
    expect(handleExecutionModeCommand('toggleDryRun', report)).toBe(true);
    expect(executionMode.mode).toBe('HALT');
    expect(handleExecutionModeCommand('other', report)).toBe(false);
  });

  it('keeps the real bot handler wired to rejection, with no mode assignment', () => {
    // Importing this entry point would start the bot. Check its wiring without
    // executing it; behavior is exercised through the handler above.
    const source = readFileSync(new URL('../../bot-with-dashboard.ts', import.meta.url), 'utf8');
    expect(source).toContain('handleExecutionModeCommand(command,');
    expect(source).not.toMatch(/CONFIG\.dryRun\s*=/);
    const handler = source.slice(source.indexOf("if (command === 'emergencyStop')"));
    expect(handler.indexOf('executionMode.halt()')).toBeLessThan(handler.indexOf('await '));
  });
});
