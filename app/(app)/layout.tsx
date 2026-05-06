import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PeopleProvider } from "@/components/providers/people-context";
import { getCurrentUser } from "@/lib/api";
import { getHumans, getTeammates } from "@/lib/queries/people";
import { getProjectsWithCounts } from "@/lib/queries/projects";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [teammates, humans, projects] = await Promise.all([
    getTeammates(),
    getHumans(),
    getProjectsWithCounts(),
  ]);
  return (
    <PeopleProvider teammates={teammates} humans={humans} currentUserId={user.id}>
      <AppShell projects={projects} currentUserEmail={user.email}>{children}</AppShell>
    </PeopleProvider>
  );
}
