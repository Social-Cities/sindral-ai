import type { AgentEngine, WorkflowStep } from '@sindral/shared';

export interface EngineRunOptions {
  cwd: string;
  prompt: string;
  step: WorkflowStep;
  /** Full environment for the subprocess (already stripped of secrets). */
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Directories outside the cwd the agent must be allowed to write (results, outputs). */
  writableDirs?: string[];
  onOutput: (line: string) => void;
}

export interface EngineRunResult {
  exitCode: number | null;
  /** Last human-readable output lines, for failure messages. */
  tail: string[];
  /** The agent's final message, used as a fallback when it could not write the result file. */
  finalText: string | null;
  timedOut: boolean;
  cancelled: boolean;
  /** The engine binary could not be spawned (ENOENT). */
  missing: boolean;
}

export interface EngineCapabilities {
  available: boolean;
  version: string | null;
}

export interface Engine {
  readonly name: AgentEngine;
  /** Probes the binary once and caches the answer. */
  probe(): Promise<EngineCapabilities>;
  run(opts: EngineRunOptions): Promise<EngineRunResult>;
}

export const TAIL_LINES = 40;

/** Keeps the last N lines of output for error reporting. */
export class OutputTail {
  private readonly lines: string[] = [];
  constructor(private readonly limit: number = TAIL_LINES) {}
  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.limit) this.lines.shift();
  }
  get(): string[] {
    return [...this.lines];
  }
}

export function extractVersion(output: string): string | null {
  const match = /\d+\.\d+(?:\.\d+)?/.exec(output);
  return match ? match[0] : null;
}
