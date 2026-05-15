"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { acceptInvitationAction } from "@/lib/actions/orgs";

export function InviteAcceptForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function accept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptInvitationAction(token);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/inbox");
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {error && (
        <div style={{ fontSize: 12.5, color: "var(--danger, #c0392b)" }}>{error}</div>
      )}
      <button
        type="button"
        onClick={accept}
        disabled={pending}
        style={{
          padding: "8px 12px",
          fontSize: 13,
          background: "var(--accent)",
          color: "white",
          border: 0,
          borderRadius: 6,
          cursor: pending ? "default" : "pointer",
          opacity: pending ? 0.7 : 1,
        }}
      >
        {pending ? "Joining…" : "Accept invitation"}
      </button>
    </div>
  );
}
