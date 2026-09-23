import Link from "next/link";
import { LoginForm } from "@/components/auth-forms";

export default function LoginPage() {
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
        Sign in
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 18 }}>
        Welcome back to Sindral AI.
      </div>
      <LoginForm />
      <div className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>
        New here?{" "}
        <Link href="/signup" style={{ color: "var(--accent)" }}>
          Create an account
        </Link>
      </div>
    </div>
  );
}
