import { rejectRuntimeModeChange } from '../core/execution-mode.js';

/** Returns true when the command was consumed, without changing runtime state. */
export function handleExecutionModeCommand(
  command: string,
  reportRejection: (message: string) => void,
): boolean {
  if (command !== 'toggleDryRun') return false;
  reportRejection(rejectRuntimeModeChange());
  return true;
}
