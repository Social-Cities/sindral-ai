import { notFound } from "next/navigation";
import { InviteAcceptForm } from "@/components/invite-accept-form";
import { getInvitationPreview } from "@/lib/queries/orgs";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const preview = await getInvitationPreview(token);
  if (!preview) notFound();

  const { invitation, organization } = preview;
  const status =
    invitation.acceptedAt !== null
      ? "accepted"
      : invitation.revokedAt !== null
        ? "revoked"
        : invitation.expiresAt !== null && new Date(invitation.expiresAt) < new Date()
          ? "expired"
          : "pending";

  return (
    <div className="card" style={{ width: 420, padding: 24 }}>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontStyle: "italic",
          fontSize: 26,
          marginBottom: 4,
        }}
      >
        {organization?.name ?? "Organization"}
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 18 }}>
        You&apos;ve been invited to join as a {invitation.role}.
      </div>

      {status === "pending" && <InviteAcceptForm token={token} />}
      {status !== "pending" && (
        <div style={{ fontSize: 13, color: "var(--danger, #c0392b)" }}>
          This invitation is {status}.
        </div>
      )}
    </div>
  );
}
