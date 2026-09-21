/** Variables that must never reach an agent subprocess. */
const STRIPPED = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'SINDRAL_WORKER_KEY']);

/**
 * Builds the environment for an agent process: the worker's environment minus
 * credentials, plus the Sindral protocol variables.
 */
export function buildAgentEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || STRIPPED.has(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra, GIT_TERMINAL_PROMPT: '0' };
}
