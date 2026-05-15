import Link from "next/link";
import { OnboardingForm } from "@/components/onboarding-form";
import { getOrganizations } from "@/lib/queries/orgs";

export default async function OnboardingPage() {
  const memberships = await getOrganizations();

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
        Create an organization
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 18 }}>
        Organizations isolate projects, teammates, and tasks so different
        teams can use Agatha side by side.
      </div>

      <OnboardingForm />

      {memberships.length > 0 && (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 18 }}>
          You already belong to{" "}
          <Link href="/inbox" style={{ color: "var(--accent)" }}>
            {memberships.length === 1
              ? `${memberships[0]?.org.name}`
              : `${memberships.length} organizations`}
          </Link>
          .
        </div>
      )}
    </div>
  );
}
