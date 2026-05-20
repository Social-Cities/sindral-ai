import { getGithubInstallations } from "@/lib/queries/github";
import { GithubSettingsView } from "@/components/github-settings-view";

interface PageProps {
  searchParams?: Promise<{
    installed?: string;
    setup?: string;
    error?: string;
  }>;
}

export default async function GithubSettingsPage({ searchParams }: PageProps) {
  const installations = await getGithubInstallations();
  const sp = (await searchParams) ?? {};
  const banner =
    sp.installed === "1"
      ? {
          kind: "ok" as const,
          text:
            sp.setup === "update"
              ? "GitHub App updated."
              : "GitHub App connected.",
        }
      : sp.error
        ? { kind: "err" as const, text: sp.error }
        : null;

  return <GithubSettingsView installations={installations} banner={banner} />;
}
