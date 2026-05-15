import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PeopleProvider } from "@/components/providers/people-context";
import { getCurrentUser } from "@/lib/api";
import { getHumans, getTeammates } from "@/lib/queries/people";
import { getOrganizations, getCurrentOrganization } from "@/lib/queries/orgs";
import { getProjectsWithCounts } from "@/lib/queries/projects";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Gate the app on having (a) at least one membership and (b) a current
  // org cookie. Both are bootstrapped automatically — sign-up creates a
  // personal org, and lib/api.ts auto-picks the first membership on the
  // first authenticated call — but a user can also land here after leaving
  // every org, in which case we send them to onboarding to create one.
  const memberships = await getOrganizations();
  if (memberships.length === 0) redirect("/onboarding");
  const currentOrg = await getCurrentOrganization();
  if (!currentOrg) redirect("/onboarding");

  const [teammates, humans, projects] = await Promise.all([
    getTeammates(),
    getHumans(),
    getProjectsWithCounts(),
  ]);
  return (
    <PeopleProvider teammates={teammates} humans={humans} currentUserId={user.id}>
      <AppShell
        projects={projects}
        currentUserEmail={user.email}
        currentOrg={currentOrg}
        memberships={memberships}
      >
        {children}
      </AppShell>
    </PeopleProvider>
  );
}
