import { useState, type FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { describeError } from "../errors";

export function SignIn() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    form.set("flow", flow);
    try {
      await signIn("password", form);
    } catch (err) {
      setError(flow === "signIn" ? "Could not sign in. Check your email and password." : describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function demo() {
    setBusy(true);
    setError(null);
    try {
      await signIn("anonymous");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell shell-center">
      <h1>Front Desk</h1>
      <p className="muted">The email front desk for inns that live in their inbox.</p>
      <section className="panel">
        <h2>Staff sign in</h2>
        <form onSubmit={submit}>
          {flow === "signUp" && (
            <label>
              Name
              <input name="name" autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete={flow === "signUp" ? "new-password" : "current-password"}
            />
          </label>
          <div className="row" style={{ marginTop: 8 }}>
            <button type="submit" disabled={busy}>
              {flow === "signIn" ? "Sign in" : "Create account"}
            </button>
            <button type="button" onClick={() => setFlow(flow === "signIn" ? "signUp" : "signIn")}>
              {flow === "signIn" ? "New inn? Create an account" : "Have an account? Sign in"}
            </button>
          </div>
        </form>
        {error && <p className="error">{error}</p>}
      </section>
      <section className="panel" style={{ marginTop: 12 }}>
        <h2>Judge demo</h2>
        <p className="muted">
          Opens a private, seeded demo inn. Demo sessions never send real email.
        </p>
        <button onClick={() => void demo()} disabled={busy}>
          Open the demo
        </button>
      </section>
    </main>
  );
}
