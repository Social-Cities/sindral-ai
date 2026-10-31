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
  design: `{
  "kind": "design",
  "summary": "what changed and what the user should review",
  "designUrl": null,
  "specification": "markdown handoff: intent, screens and flows, responsive behavior, tokens and components, empty/loading/error states, decisions, open questions and testable implementation criteria",
  "questions": [],
  "screens": [{ "name": "Main screen", "path": "index.html" }],
  "outcome": "the user-visible design outcome",
  "acceptanceCriteria": "observable design acceptance criteria",
  "files": []
}
(Create the preview, source, and assets directly under $${OUTPUT_DIR_ENV} using your coding tools. The worker collects files and hashes them; leave files empty in your JSON. Preview HTML must be self-contained with inline CSS/JS and embedded images; it must work without network access, a dev server, or a build step. Separate source files may accompany the preview. PNG/SVG artboards are also supported. Leave designUrl null; no hosted artifact or /design command is required. A completed design requires at least one screen and an implementation specification. For a clarification-only turn, return designUrl: null, specification: "", screens: [], files: [], and nonempty questions. Existing workspace files remain saved for the next turn.)`,
  'bdd-plan': `{
  "kind": "bdd-plan",
  "summary": "BDD behavior and test design summary",
  "plan": "full markdown BDD test plan with stable scenario IDs, Given/When/Then, test files, fixtures and executable commands for every selected platform",
  "scenarios": [{ "id": "BDD-1", "given": "initial conditions", "when": "user action", "then": "observable assertions" }],
  "outcome": "user-visible result",
  "acceptanceCriteria": "observable testable conditions"
}`,
  plan: `{
  "kind": "plan",
  "summary": "one paragraph for the user",
  "plan": "full markdown implementation plan. Start with concise sections named exactly: What behavior is changing, What files/systems are affected, Important invariants, Edge cases, and How correctness will be verified. Then include the detailed implementation plan.",
  "outcome": "the concise user-visible result this task must achieve",
  "acceptanceCriteria": "a markdown list of observable, testable conditions"
}`,
  implementation: `{
  "kind": "implementation",
  "summary": "a concise reviewer-friendly summary of the implementation work completed locally",
  "outcome": "required only when the current task outcome is empty",
  "acceptanceCriteria": "required only when the current task acceptance criteria are empty"
}
(Commit all your changes on the current branch. Do NOT push or open a PR yourself; a later review-slicing step does that.)`,
  pr: `{
  "kind": "pr",
  "motivation": "a concise reviewer-friendly explanation of why this change was needed",
  "proposedSolution": "a concise markdown list or short paragraphs describing what changed",
  "assumptions": "a markdown list of implementation assumptions and constraints, or 'None.'",
  "risks": "a markdown list of risks, tradeoffs, or rollout concerns, or 'None.'",
  "testing": "a markdown list of checks you ran and their results, or 'Not run.'",
  "summary": "a concise reviewer-friendly summary of the implementation",
  "outcome": "required only when the current task outcome is empty",
  "acceptanceCriteria": "required only when the current task acceptance criteria are empty"
}
(Commit all your changes on the current branch. Do NOT push or open a PR yourself; the worker does that.)`,
  'review-slice': `{
  "kind": "review-slice",
  "motivation": "a concise reviewer-friendly explanation of why this change was needed",
  "proposedSolution": "a concise markdown list or short paragraphs describing what changed",
  "assumptions": "a markdown list of implementation assumptions and constraints, or 'None.'",
  "risks": "a markdown list of risks, tradeoffs, or rollout concerns, or 'None.'",
  "testing": "a markdown list of checks you ran and their results, or 'Not run.'",
  "summary": "a concise reviewer-friendly summary of the sliced implementation",
  "slices": [
    {
      "repository": "owner/name",
      "commit": "commit sha or unambiguous short sha",
      "title": "reviewable commit title",
      "summary": "what this commit does and why it belongs as one review unit",
      "files": ["path/to/file.ts"],
      "reviewNotes": "optional focused guidance for reviewers"
    }
  ],
  "outcome": "required only when the current task outcome is empty",
  "acceptanceCriteria": "required only when the current task acceptance criteria are empty"
}
(Rewrite the local branch into ordered reviewable commits if needed. Do NOT push or open a PR yourself; the worker does that.)`,
  review: `{
  "kind": "review",
  "summary": "one paragraph",
  "report": "full markdown review following the required output sections",
  "verdict": "MATERIAL_FINDINGS" | "NO_MATERIAL_FINDINGS" | "REVIEW_BLOCKED",
  "outcome": "required only when the current task outcome is empty",
  "acceptanceCriteria": "required only when the current task acceptance criteria are empty"
}`,
  verdict: `{
  "kind": "verdict",
  "summary": "one paragraph",
  "report": "full markdown readiness report",
  "verdict": "GO" | "NO_GO",
  "feedback": "if NO_GO: precise, actionable changes the implementer must make",
  "bddChecks": [{ "scenarioId": "BDD-1", "platform": "ios", "command": "exact executed test command", "status": "passed", "evidence": "observed test output and assertions" }],
  "dddChecks": [{ "scope": "each required DDD verification scope from the prompt", "criterion": "bounded-contexts", "status": "passed", "evidence": "concrete source paths, observed dependencies and executed test commands/outcomes" }],
  "outcome": "required only when the current task outcome is empty",
  "acceptanceCriteria": "required only when the current task acceptance criteria are empty"
}`,
  document: `{
  "kind": "document",
  "summary": "one paragraph",
  "outcome": "required only when the current task outcome is empty",
  "acceptanceCriteria": "required only when the current task acceptance criteria are empty",
  "artifacts": [ { "name": "report.md", "contentType": "text/markdown", "content": "..." } ]
}
(Alternatively write files into $${OUTPUT_DIR_ENV}; every file there is uploaded as an artifact.)`,
  troubleshoot: `{
  "kind": "troubleshoot",
  "summary": "one paragraph",
  "diagnosis": "markdown explanation of the root cause and what you changed",
  "resolved": true | false,   // true only if the failed step can now be retried safely
  "outcome": "required only when the current task outcome is empty",
  "acceptanceCriteria": "required only when the current task acceptance criteria are empty"
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

const OUTPUT_RULES: Partial<Record<StepOutputKind, string[]>> = {
  verdict: [
    '- For code workflows, include dddChecks for all five criteria (bounded-contexts, domain-isolation, invariants, dependency-direction, domain-tests) in every required scope from the prompt. Use actual scope names, cite inspected source and executed test evidence, and return NO_GO if a required check failed or is blocked. Omit dddChecks for non-code tasks.',
    '- For mobile workflows, include one bddChecks entry per approved scenario and selected platform with executed command and observed evidence. Use the actual scenario IDs. Omit bddChecks for other workflows.',
    '- For a verdict result, `verdict` must be exactly `GO` or `NO_GO`.',
    '- Do not copy review verdict values such as `MATERIAL_FINDINGS`, `NO_MATERIAL_FINDINGS`, `REVIEW_BLOCKED`, `VERIFIED`, or `BLOCKED` into the final `verdict` field.',
  ],
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
    `- Write the JSON to \`$${RESULT_FILE_ENV}\` (the same path shown above), not just in your final response.`,
    '- Before your final response, verify the result file exists and is non-empty.',
    '- If writing the file fails, make your final response contain only a fenced `json` block with the same JSON object.',
    '- Never include secrets, tokens or credentials in the result.',
    '- If you cannot complete the task, still return the JSON result with the best summary you can and explain what blocked you.',
    ...(OUTPUT_RULES[output] ?? []),
  ].join('\n');
}
