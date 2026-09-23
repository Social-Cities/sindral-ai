import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/api";

export const dynamic = "force-dynamic";

// Auth-gated wrapper for flows that run BEFORE the user has an active org —
// onboarding (create the first org) and accepting an invitation. Mirrors
// (app)/layout.tsx's auth check but skips the org-membership requirement
// to avoid a redirect loop.
export default async function SetupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "var(--bg)",
      }}
    >
      {children}
    </div>
  );
}
