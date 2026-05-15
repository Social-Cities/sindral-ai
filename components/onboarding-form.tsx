"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createOrganizationAction } from "@/lib/actions/orgs";

export function OnboardingForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    startTransition(async () => {
      const result = await createOrganizationAction({ name: trimmed });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/inbox");
    });
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label style={{ fontSize: 12.5, color: "var(--text-faint)" }}>
        Organization name
      </label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Acme Robotics"
        autoFocus
        style={{
          padding: "8px 10px",
          fontSize: 14,
          border: "1px solid var(--border, rgba(0,0,0,0.12))",
          borderRadius: 6,
        }}
      />
      {error && (
        <div style={{ fontSize: 12.5, color: "var(--danger, #c0392b)" }}>{error}</div>
      )}
      <button
        type="submit"
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
        {pending ? "Creating…" : "Create organization"}
      </button>
    </form>
  );
}
