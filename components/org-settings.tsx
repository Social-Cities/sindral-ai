"use client";

import { useState, useTransition } from "react";
import {
  createInvitationAction,
  removeMemberAction,
  revokeInvitationAction,
} from "@/lib/actions/orgs";
import type {
  OrgInvitation,
  OrgMember,
  OrgRole,
  Organization,
} from "@/lib/db/types";

const isAdminish = (r: OrgRole) => r === "owner" || r === "admin";

export function OrgSettings({
  organization,
  myRole,
  members,
  invitations,
}: {
  organization: Organization;
  myRole: OrgRole;
  members: OrgMember[];
  invitations: OrgInvitation[];
}) {
  const canManage = isAdminish(myRole);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newRole, setNewRole] = useState<"member" | "admin">("member");
  const [newEmail, setNewEmail] = useState("");
  const [latestToken, setLatestToken] = useState<string | null>(null);

  function createInvite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createInvitationAction({
        orgId: organization.id,
        email: newEmail.trim() || undefined,
        role: newRole,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLatestToken(result.invitation.token);
      setNewEmail("");
    });
  }

  function revoke(invitationId: string) {
    startTransition(async () => {
      await revokeInvitationAction({ orgId: organization.id, invitationId });
    });
  }

  function remove(userId: string) {
    if (!confirm("Remove this member from the organization?")) return;
    startTransition(async () => {
      await removeMemberAction({ orgId: organization.id, userId });
    });
  }

  const inviteUrl = (token: string) =>
    typeof window === "undefined" ? "" : `${window.location.origin}/invite/${token}`;

  return (
    <div style={{ padding: "24px 32px", maxWidth: 760 }}>
      <h1 style={{ fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: 28, marginBottom: 4 }}>
        {organization.name}
      </h1>
      <div className="muted" style={{ fontSize: 13, marginBottom: 24 }}>
        Manage members and invitations. Your role: <strong>{myRole}</strong>.
      </div>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Members</h2>
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-faint)" }}>
              <th style={{ padding: "6px 8px" }}>Email</th>
              <th style={{ padding: "6px 8px" }}>Role</th>
              <th style={{ padding: "6px 8px" }}>Joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId} style={{ borderTop: "1px solid var(--border, rgba(0,0,0,0.06))" }}>
                <td style={{ padding: "6px 8px" }}>{m.email ?? m.userId.slice(0, 8)}</td>
                <td style={{ padding: "6px 8px" }}>{m.role}</td>
                <td style={{ padding: "6px 8px", color: "var(--text-faint)" }}>
                  {new Date(m.createdAt).toLocaleDateString()}
                </td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>
                  {canManage && m.role !== "owner" && (
                    <button
                      type="button"
                      onClick={() => remove(m.userId)}
                      disabled={pending}
                      style={{
                        background: "transparent",
                        border: "1px solid var(--border, rgba(0,0,0,0.12))",
                        borderRadius: 4,
                        padding: "2px 8px",
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {canManage && (
        <section>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Invitations</h2>

          <form onSubmit={createInvite} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="Email (optional)"
              style={{
                flex: 1,
                padding: "6px 8px",
                fontSize: 13,
                border: "1px solid var(--border, rgba(0,0,0,0.12))",
                borderRadius: 6,
              }}
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as "member" | "admin")}
              style={{
                padding: "6px 8px",
                fontSize: 13,
                border: "1px solid var(--border, rgba(0,0,0,0.12))",
                borderRadius: 6,
              }}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button
              type="submit"
              disabled={pending}
              style={{
                padding: "6px 12px",
                fontSize: 13,
                background: "var(--accent)",
                color: "white",
                border: 0,
                borderRadius: 6,
                cursor: pending ? "default" : "pointer",
              }}
            >
              Create invitation
            </button>
          </form>

          {error && (
            <div style={{ fontSize: 12.5, color: "var(--danger, #c0392b)", marginBottom: 8 }}>
              {error}
            </div>
          )}

          {latestToken && (
            <div
              style={{
                fontSize: 12.5,
                background: "var(--surface-2, rgba(0,0,0,0.04))",
                padding: 8,
                borderRadius: 6,
                marginBottom: 12,
                wordBreak: "break-all",
              }}
            >
              Share this link: <code>{inviteUrl(latestToken)}</code>
            </div>
          )}

          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-faint)" }}>
                <th style={{ padding: "6px 8px" }}>Email</th>
                <th style={{ padding: "6px 8px" }}>Role</th>
                <th style={{ padding: "6px 8px" }}>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => {
                const status =
                  inv.acceptedAt
                    ? "Accepted"
                    : inv.revokedAt
                      ? "Revoked"
                      : inv.expiresAt && new Date(inv.expiresAt) < new Date()
                        ? "Expired"
                        : "Pending";
                return (
                  <tr key={inv.id} style={{ borderTop: "1px solid var(--border, rgba(0,0,0,0.06))" }}>
                    <td style={{ padding: "6px 8px" }}>{inv.email ?? "(any)"}</td>
                    <td style={{ padding: "6px 8px" }}>{inv.role}</td>
                    <td style={{ padding: "6px 8px" }}>{status}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>
                      {status === "Pending" && (
                        <button
                          type="button"
                          onClick={() => revoke(inv.id)}
                          disabled={pending}
                          style={{
                            background: "transparent",
                            border: "1px solid var(--border, rgba(0,0,0,0.12))",
                            borderRadius: 4,
                            padding: "2px 8px",
                            fontSize: 12,
                            cursor: "pointer",
                          }}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
