import "server-only";
import { cache } from "react";
import { callAuthed } from "@/lib/api";
import type {
  GithubInstallation,
  GithubInstallationRepo,
} from "@/lib/db/types";

export const getGithubInstallations = cache(
  async (): Promise<GithubInstallation[]> => {
    const r = await callAuthed<{ installations: GithubInstallation[] }>(
      "/api/github/installations",
    );
    return r.installations;
  },
);

// Note: this is a POST under the hood (the backend has to hit GitHub) but
// it's idempotent and safe to call from a Server Component. We do not
// memoize it across requests because the user may install a new repo
// between renders.
export async function getGithubInstallationRepos(
  installationId: string,
): Promise<GithubInstallationRepo[]> {
  const r = await callAuthed<{ repos: GithubInstallationRepo[] }>(
    `/api/github/installations/${encodeURIComponent(installationId)}/repos`,
    { method: "POST" },
  );
  return r.repos;
}
