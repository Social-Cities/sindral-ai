import Link from "next/link";
import { SignUpForm } from "@/components/auth-forms";

export default function SignUpPage() {
  return (
    <div className="card" style={{ width: 360, padding: 24 }}>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontStyle: "italic",
          fontSize: 26,
          marginBottom: 4,
        }}
      >
        Create account
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 18 }}>
        Spin up a fresh workspace with demo data you can poke at.
      </div>
      <SignUpForm />
      <div className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>
        Already have an account?{" "}
        <Link href="/login" style={{ color: "var(--accent)" }}>
          Sign in
        </Link>
      </div>
    </div>
  );
}
