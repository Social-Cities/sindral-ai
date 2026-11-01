import { interpolatePrompt, protocolInstructions, OUTPUT_DIR_ENV, type JobContext, type StepOutputKind, type WorkflowStep } from '@sindral/shared';
import type { Workspace } from './workspace.js';

export interface PromptInput {
  step: WorkflowStep;
  output: StepOutputKind;
  context: Partial<JobContext>;
  resultFile: string;
  outputDir: string;
  workspace: Workspace;
}

export function workspaceNote(workspace: Workspace, outputDir: string, canModifyRepository = true): string {
  const lines = ['', '---', '## Workspace'];
  if (workspace.repos.length === 0) {
    lines.push(
      `This task has no repository. Your working directory is \`${workspace.cwd}\`.`,
      `Write any deliverable files into \`${outputDir}\` (\`$${OUTPUT_DIR_ENV}\`); every file there is uploaded as an artifact.`,
    );
    return lines.join('\n');
  }
  workspace.repos.forEach((repo, index) => {
    const role = index === 0 ? ' (your current working directory)' : '';
    lines.push(`- Repository \`${repo.repo.full}\` is checked out at \`${repo.dir}\`${role} on branch \`${repo.branch}\` (base branch \`${repo.baseBranch}\`).`);
  });
  if (workspace.repos.length > 1) {
    lines.push('This task spans several repositories; use the absolute paths above to work in the others.');
  }
  lines.push('Hard rule: never create, edit, rename, or delete GitHub Actions workflow files under `.github/workflows/`; omit those changes from your final work.');
  if (canModifyRepository) {
    lines.push(
      'Commit your work on the current branch with clear messages when possible. If local hooks or commit policy block you, leave the changes staged or unstaged and still finish; the worker commits through its publish path. Do NOT push, do NOT switch branches and do NOT open a pull request; the worker does that after you finish.',
      `Non-code deliverables (reports, notes) go into \`${outputDir}\` (\`$${OUTPUT_DIR_ENV}\`).`,
    );
  } else {
    lines.push(
      'Inspect the repository only. Do NOT modify repository files, commit changes, switch branches, push, or open a pull request.',
      `Write only the required result JSON file and, if needed, non-code deliverables in \`${outputDir}\` (\`$${OUTPUT_DIR_ENV}\`).`,
    );
  }
  return lines.join('\n');
}

/** Step prompt with context interpolated, followed by the result-file protocol and workspace notes. */
export function buildPrompt(input: PromptInput): string {
  const body = interpolatePrompt(input.step.prompt ?? '', input.context).trim();
  const canModifyRepository = new Set(input.step.permissions ?? []).has('write');
  return [body, protocolInstructions(input.output, input.resultFile, input.context), workspaceNote(input.workspace, input.outputDir, canModifyRepository)].join('\n');
}
