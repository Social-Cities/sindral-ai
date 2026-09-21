import type { JobContext, StepOutputKind } from './types.js';

const TOKEN_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Replace `{{token}}` placeholders with job context values. Unknown tokens are left blank. */
export function interpolatePrompt(template: string, context: Partial<JobContext>): string {
  return template.replace(TOKEN_RE, (_m, key: string) => {
    const value = (context as Record<string, string | undefined>)[key];
    return value ?? '';
  });
}

export const RESULT_FILE_ENV = 'SINDRAL_RESULT_FILE';
export const OUTPUT_DIR_ENV = 'SINDRAL_OUTPUT_DIR';

const RESULT_SHAPES: Record<StepOutputKind, string> = {
  plan: `{
  "kind": "plan",
  "summary": "one paragraph for the user",
  "plan": "full markdown implementation plan",
  "subtasks": [ { "title": "...", "goal": "..." } ]   // ONLY if the change must be split into multiple PRs; omit otherwise
}`,
  pr: `{
  "kind": "pr",
  "summary": "one paragraph describing what you implemented and how you verified it"
}
(Commit all your changes on the current branch. Do NOT push or open a PR yourself; the worker does that.)`,
  review: `{
  "kind": "review",
  "summary": "one paragraph",
  "report": "full markdown review following the required output sections",
  "verdict": "MATERIAL_FINDINGS" | "NO_MATERIAL_FINDINGS" | "REVIEW_BLOCKED"
}`,
  verdict: `{
  "kind": "verdict",
  "summary": "one paragraph",
  "report": "full markdown readiness report",
  "verdict": "GO" | "NO_GO",
  "feedback": "if NO_GO: precise, actionable changes the implementer must make"
}`,
  document: `{
  "kind": "document",
  "summary": "one paragraph",
  "artifacts": [ { "name": "report.md", "contentType": "text/markdown", "content": "..." } ]
}
(Alternatively write files into $${OUTPUT_DIR_ENV}; every file there is uploaded as an artifact.)`,
  troubleshoot: `{
  "kind": "troubleshoot",
  "summary": "one paragraph",
  "diagnosis": "markdown explanation of the root cause and what you changed",
  "resolved": true | false   // true only if the failed step can now be retried safely
}`,
  'conflict-resolution': `{
  "kind": "conflict-resolution",
  "summary": "one paragraph describing the resolution",
  "taskId": "the task id supplied in the prompt",
  "branch": "the branch supplied in the prompt",
  "resolved": true | false,
  "rationale": "markdown explanation for every conflicted file and why both changes' intent is preserved",
  "resolvedPaths": ["repository/relative/path"],
  "checks": []
}`,
  merge: `{
  "kind": "merge",
  "summary": "worker-owned operation; agents never produce this result",
  "complete": true | false,
  "pullRequests": []
}`,
};

/**
 * Protocol instructions appended to every agent prompt so the worker can parse a
 * machine-readable result regardless of which engine ran the step.
 */
export function protocolInstructions(output: StepOutputKind, resultFile: string): string {
  return [
    '',
    '---',
    '## Sindral protocol (mandatory)',
    `When you are completely finished, write a single JSON object to the file at \`${resultFile}\` with exactly this shape:`,
    '',
    '```json',
    RESULT_SHAPES[output],
    '```',
    '',
    'Rules:',
    '- The file must contain valid JSON and nothing else.',
    '- Never include secrets, tokens or credentials in the result.',
    '- If you cannot complete the task, still write the file with the best summary you can and explain what blocked you.',
  ].join('\n');
}
