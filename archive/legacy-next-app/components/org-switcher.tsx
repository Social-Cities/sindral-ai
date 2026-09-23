"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { switchOrganizationAction } from "@/lib/actions/orgs";
import type { OrgMembership, Organization } from "@/lib/db/types";

export function OrgSwitcher({
  currentOrg,
  memberships,
}: {
  currentOrg: Organization;
  memberships: OrgMembership[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function pick(orgId: string) {
    if (orgId === currentOrg.id) {
      setOpen(false);
      return;
    }
    startTransition(async () => {
      await switchOrganizationAction(orgId);
      setOpen(false);
    });
  }

  return (
    <div className="org-switcher" style={{ position: "relative", padding: "8px 10px 0" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={pending}
        style={{
          width: "100%",
          textAlign: "left",
          background: "var(--surface-2, rgba(0,0,0,0.04))",
          border: "1px solid var(--border, rgba(0,0,0,0.08))",
          borderRadius: 6,
          padding: "6px 8px",
          fontSize: 12,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span style={{ fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
          {currentOrg.name}
        </span>
        <span style={{ color: "var(--text-faint)" }}>▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "100%",
            left: 10,
            right: 10,
            marginTop: 4,
            background: "var(--surface, white)",
            border: "1px solid var(--border, rgba(0,0,0,0.12))",
            borderRadius: 6,
            boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
            zIndex: 20,
            padding: 4,
          }}
        >
          {memberships.map(({ org, role }) => (
            <button
              key={org.id}
              type="button"
              role="option"
              aria-selected={org.id === currentOrg.id}
              onClick={() => pick(org.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 8px",
                fontSize: 12,
                background: org.id === currentOrg.id ? "var(--surface-2, rgba(0,0,0,0.04))" : "transparent",
                border: 0,
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 600 }}>{org.name}</div>
              <div style={{ color: "var(--text-faint)", fontSize: 11 }}>{role}</div>
            </button>
          ))}
          <div style={{ height: 1, background: "var(--border, rgba(0,0,0,0.08))", margin: "4px 0" }} />
          <Link
            href="/onboarding"
            onClick={() => setOpen(false)}
            style={{
              display: "block",
              padding: "6px 8px",
              fontSize: 12,
              color: "var(--text)",
              textDecoration: "none",
            }}
          >
            + New organization
          </Link>
          <Link
            href={`/orgs/${currentOrg.id}/settings`}
            onClick={() => setOpen(false)}
            style={{
              display: "block",
              padding: "6px 8px",
              fontSize: 12,
              color: "var(--text)",
              textDecoration: "none",
            }}
          >
            Manage members
          </Link>
        </div>
      )}
    </div>
  );
}
