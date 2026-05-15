import { notFound } from "next/navigation";
import { OrgSettings } from "@/components/org-settings";
import {
  getOrgInvitations,
  getOrgMembers,
  getOrganizations,
} from "@/lib/queries/orgs";

export default async function OrgSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const memberships = await getOrganizations();
  const membership = memberships.find((m) => m.org.id === orgId);
  if (!membership) notFound();

  const [members, invitations] = await Promise.all([
    getOrgMembers(orgId),
    getOrgInvitations(orgId),
  ]);

  return (
    <OrgSettings
      organization={membership.org}
      myRole={membership.role}
      members={members}
      invitations={invitations}
    />
  );
}
