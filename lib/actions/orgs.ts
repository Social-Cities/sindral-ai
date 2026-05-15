"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, callAuthed } from "@/lib/api";
import {
  clearCurrentOrgId,
  readCurrentOrgId,
  writeCurrentOrgId,
} from "@/lib/session";
import type { OrgInvitation, Organization } from "@/lib/db/types";

function toMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Request failed";
}

export type CreateOrgResult =
  | { ok: true; organization: Organization }
  | { ok: false; error: string };

export async function createOrganizationAction(input: {
  name: string;
  slug?: string;
}): Promise<CreateOrgResult> {
  try {
    const r = await callAuthed<{ organization: Organization }>("/orgs", {
      method: "POST",
      body: input,
      skipOrgHeader: true,
    });
    await writeCurrentOrgId(r.organization.id);
    revalidatePath("/", "layout");
    return { ok: true, organization: r.organization };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function switchOrganizationAction(orgId: string): Promise<void> {
  await writeCurrentOrgId(orgId);
  revalidatePath("/", "layout");
}

export async function leaveOrCloseCurrentOrgCookieAction(): Promise<void> {
  await clearCurrentOrgId();
  revalidatePath("/", "layout");
}

export type CreateInvitationResult =
  | { ok: true; invitation: OrgInvitation }
  | { ok: false; error: string };

export async function createInvitationAction(input: {
  orgId: string;
  email?: string;
  role?: "admin" | "member";
  expiresInHours?: number;
}): Promise<CreateInvitationResult> {
  try {
    const { orgId, ...body } = input;
    const r = await callAuthed<{ invitation: OrgInvitation }>(
      `/orgs/${encodeURIComponent(orgId)}/invitations`,
      { method: "POST", body, skipOrgHeader: true },
    );
    revalidatePath(`/orgs/${orgId}/settings`);
    return { ok: true, invitation: r.invitation };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function revokeInvitationAction(input: {
  orgId: string;
  invitationId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await callAuthed(
      `/orgs/${encodeURIComponent(input.orgId)}/invitations/${encodeURIComponent(
        input.invitationId,
      )}`,
      { method: "DELETE", skipOrgHeader: true },
    );
    revalidatePath(`/orgs/${input.orgId}/settings`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function removeMemberAction(input: {
  orgId: string;
  userId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await callAuthed(
      `/orgs/${encodeURIComponent(input.orgId)}/members/${encodeURIComponent(
        input.userId,
      )}`,
      { method: "DELETE", skipOrgHeader: true },
    );
    revalidatePath(`/orgs/${input.orgId}/settings`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function acceptInvitationAction(
  token: string,
): Promise<{ ok: true; orgId: string } | { ok: false; error: string }> {
  try {
    const r = await callAuthed<{
      membership: { orgId: string; userId: string; role: string } | null;
    }>(`/invitations/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      skipOrgHeader: true,
    });
    if (!r.membership) return { ok: false, error: "Failed to accept invitation" };
    await writeCurrentOrgId(r.membership.orgId);
    revalidatePath("/", "layout");
    return { ok: true, orgId: r.membership.orgId };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

// Used by the create-org / accept-invitation pages once the work is done.
export async function redirectHomeAction(): Promise<never> {
  const orgId = await readCurrentOrgId();
  if (orgId) redirect("/");
  redirect("/onboarding");
}
