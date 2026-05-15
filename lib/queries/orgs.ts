import "server-only";
import { cache } from "react";
import { callAuthed } from "@/lib/api";
import { readCurrentOrgId } from "@/lib/session";
import type {
  OrgInvitation,
  OrgMember,
  OrgMembership,
  Organization,
} from "@/lib/db/types";

// All org-management endpoints bypass the x-org-id header — they're either
// listing memberships or scoped by the URL parameter directly.

export const getOrganizations = cache(async (): Promise<OrgMembership[]> => {
  const r = await callAuthed<{
    organizations: Array<{ role: OrgMembership["role"]; org: Organization }>;
  }>("/orgs", { skipOrgHeader: true });
  return r.organizations;
});

export const getCurrentOrganization = cache(
  async (): Promise<Organization | null> => {
    const id = await readCurrentOrgId();
    if (!id) return null;
    try {
      const r = await callAuthed<{ organization: Organization }>(
        `/orgs/${encodeURIComponent(id)}`,
        { skipOrgHeader: true },
      );
      return r.organization;
    } catch {
      return null;
    }
  },
);

export const getOrgMembers = cache(async (orgId: string): Promise<OrgMember[]> => {
  const r = await callAuthed<{ members: OrgMember[] }>(
    `/orgs/${encodeURIComponent(orgId)}/members`,
    { skipOrgHeader: true },
  );
  return r.members;
});

export const getOrgInvitations = cache(
  async (orgId: string): Promise<OrgInvitation[]> => {
    const r = await callAuthed<{ invitations: OrgInvitation[] }>(
      `/orgs/${encodeURIComponent(orgId)}/invitations`,
      { skipOrgHeader: true },
    );
    return r.invitations;
  },
);

export const getInvitationPreview = cache(
  async (
    token: string,
  ): Promise<{
    invitation: OrgInvitation;
    organization: Organization | null;
  } | null> => {
    try {
      const r = await callAuthed<{
        invitation: OrgInvitation;
        organization: Organization | null;
      }>(`/invitations/${encodeURIComponent(token)}`, { skipOrgHeader: true });
      return { invitation: r.invitation, organization: r.organization };
    } catch {
      return null;
    }
  },
);
