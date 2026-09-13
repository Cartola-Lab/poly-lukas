import 'dotenv/config';

export type ExecutionMode = 'DRY' | 'LIVE' | 'HALT';

// Normalize once per process, including SDK/script consumers. No runtime setter.
const startupMode: 'DRY' | 'LIVE' = process.env.DRY_RUN === 'false' ? 'LIVE' : 'DRY';
let halted = false;

export class WriteBlockedError extends Error {
  readonly code = 'WRITE_BLOCKED';

  constructor(operation: string, mode: ExecutionMode) {
    super(`${operation} blocked: execution mode is ${mode}. Mode changes require a process restart.`);
    this.name = 'WriteBlockedError';
  }
}

export const executionMode = Object.freeze({
  startupMode,
  get mode(): ExecutionMode {
    return halted ? 'HALT' : startupMode;
  },
  halt(): void {
    halted = true;
  },
  assertCanWrite(operation: string): void {
    const mode = halted ? 'HALT' : startupMode;
    if (mode !== 'LIVE') throw new WriteBlockedError(operation, mode);
  },
});

/** Shared by the dashboard command handler; never changes mode or subscriptions. */
export function rejectRuntimeModeChange(): string {
  return `toggleDryRun rejected: execution mode is ${executionMode.mode}. ` +
    'Changing DRY/LIVE requires a process restart with DRY_RUN configured at startup.';
}
