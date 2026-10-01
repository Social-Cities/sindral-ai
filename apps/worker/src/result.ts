import fs from 'node:fs/promises';
import { agentResultSchema, rawAgentResultFileSchema, type AgentResult, type StepOutputKind } from '@sindral/shared';
import type { Redactor } from './redact.js';

export type RawResult = Record<string, unknown> & { kind: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Parses the JSON the agent wrote to the result file. `kind` is filled from the
 * step when the agent omitted it. Some engines wrap JSON in a code fence
 * despite instructions; that is tolerated.
 */
export function parseRawResult(text: string | null, defaultKind: StepOutputKind): Parsed<RawResult> {
  if (text === null) return { ok: false, reason: 'the agent did not write the result file' };
  const body = stripFence(text.trim());
  if (!body) return { ok: false, reason: 'the result file is empty' };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    return { ok: false, reason: `the result file is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const parsed = rawAgentResultFileSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: `the result file is not a JSON object: ${issues(parsed.error.issues)}` };
  const kind = parsed.data.kind ?? defaultKind;
  return { ok: true, value: { ...parsed.data, kind } };
}

export function validateResult(raw: Record<string, unknown>): Parsed<AgentResult> {
  const parsed = agentResultSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `the result does not match the expected shape: ${issues(parsed.error.issues)}` };
  return { ok: true, value: parsed.data };
}

/** Some agents return the requested plan as Markdown instead of writing JSON. */
export function markdownPlanResult(text: string | null | undefined): RawResult | null {
  const plan = text?.trim();
  if (!plan) return null;
  const heading = plan.split(/\r?\n/).find((line) => /^#{1,3}\s+\S/.test(line.trim()));
  const summary = heading?.replace(/^#{1,3}\s+/, '').trim() || firstMeaningfulLine(plan) || 'Plan created';
  return { kind: 'plan', summary: summary.slice(0, 20_000), plan };
}

/** Reads the result file; `null` when it does not exist. */
export async function readResultFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function summaryOf(raw: Record<string, unknown>): string | null {
  const summary = raw['summary'];
  return typeof summary === 'string' && summary.trim() ? summary.trim() : null;
}

/** Failure message for the server: what went wrong plus the agent's last lines, redacted. */
export function describeFailure(reason: string, tail: string[], redactor: Redactor): string {
  const lines = [`Agent finished but ${reason}.`];
  if (tail.length > 0) lines.push('', `Last ${tail.length} lines of agent output:`, ...tail.map((l) => `  ${l}`));
  return redactor.redact(lines.join('\n')).slice(0, 20_000);
}

function stripFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  return match?.[1] ?? text;
}

/**
 * Finds a JSON object with a `summary` field inside free text. This keeps older
 * or partially blocked agent runs recoverable when they print the result instead
 * of writing the protocol file.
 */
export function extractJsonCandidate(text: string | null | undefined): string | null {
  if (!text) return null;
  const candidates: string[] = [];
  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (fence[1]) candidates.push(fence[1].trim());
  }
  // Fall back to the outermost braces; try successively smaller trailing objects.
  const first = text.indexOf('{');
  if (first >= 0) {
    for (let end = text.lastIndexOf('}'); end > first; end = text.lastIndexOf('}', end - 1)) {
      candidates.push(text.slice(first, end + 1));
      if (candidates.length > 20) break;
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'summary' in parsed) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function issues(list: { path: PropertyKey[]; message: string }[]): string {
  return list
    .slice(0, 6)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

function firstMeaningfulLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^\s*[-*]\s+/, '');
    if (trimmed) return trimmed;
  }
  return null;
}
