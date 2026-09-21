import { useEffect, useState, type FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Field, Notice } from "../lib/ui";
import { Mark } from "../lib/Mark";
import { errorMessage } from "../lib/format";

type Flow = "signIn" | "signUp";

/** How long a resolved sign-in may sit without the provider turning authenticated before staff are told. */
const HANDOFF_TIMEOUT_MS = 20_000;

/**
 * Staff sign in with email and password (Convex Auth Password provider).
 * Judges enter an isolated demo through the Anonymous provider; the demo inn
 * itself is seeded by FrontDeskWorkspace once the anonymous user exists.
 */
export function AuthView() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<Flow>("signIn");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "anonymous" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once signIn resolves. On success this view unmounts (the provider
  // becomes authenticated and FrontDeskWorkspace swaps it out), which clears
  // the timer. If the socket rejects the new token instead, the view is still
  // here after the timeout and says so rather than spinning forever.
  const [handedOff, setHandedOff] = useState<number | null>(null);
  useEffect(() => {
    if (handedOff === null) return;
    const id = window.setTimeout(() => {
      setBusy(null);
      setHandedOff(null);
      setError(
        "Signed in, but the workspace could not open a live connection to the server. Check your network and try again.",
      );
    }, HANDOFF_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [handedOff]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy("password");
    try {
      await signIn("password", { email: email.trim(), password, flow, name: name.trim() });
      setHandedOff(Date.now());
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  async function enterDemo() {
    setError(null);
    setBusy("anonymous");
    try {
      await signIn("anonymous");
      setHandedOff(Date.now());
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <div className="fd-center">
      <div className="fd-center__panel">
        <div className="fd-wordmark">
          <Mark size={26} />
          <span>Front Desk</span>
        </div>

        <div className="fd-tabs" role="tablist" aria-label="Staff sign in">
          <button
            type="button"
            role="tab"
            id="fd-tab-signin"
            aria-selected={flow === "signIn"}
            aria-controls="fd-auth-form"
            className="fd-tabs__tab"
            onClick={() => setFlow("signIn")}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            id="fd-tab-signup"
            aria-selected={flow === "signUp"}
            aria-controls="fd-auth-form"
            className="fd-tabs__tab"
            onClick={() => setFlow("signUp")}
          >
            Create staff account
          </button>
        </div>

        <form id="fd-auth-form" role="tabpanel" aria-labelledby={flow === "signIn" ? "fd-tab-signin" : "fd-tab-signup"} onSubmit={submit}>
          {flow === "signUp" ? (
            <Field label="Your name" htmlFor="fd-auth-name" hint="Shown to other staff on the threads you claim.">
              <input
                id="fd-auth-name"
                className="fd-input"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          ) : null}
          <Field label="Email" htmlFor="fd-auth-email">
            <input
              id="fd-auth-email"
              className="fd-input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field
            label="Password"
            htmlFor="fd-auth-password"
            hint={flow === "signUp" ? "At least 8 characters." : undefined}
          >
            <input
              id="fd-auth-password"
              className="fd-input"
              type="password"
              autoComplete={flow === "signUp" ? "new-password" : "current-password"}
              required
              minLength={flow === "signUp" ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className="fd-btn-row" style={{ marginTop: 14 }}>
            <button type="submit" className="fd-btn fd-btn--primary" disabled={busy !== null}>
              {busy === "password" ? "Signing in…" : flow === "signIn" ? "Sign in" : "Create account"}
            </button>
          </div>
        </form>

        <div className="fd-divider">or</div>

        <div className="fd-demo-callout">
          <p>
            Look around a fictional inn with seeded guest threads. The demo is private to your browser
            session and never sends real email.
          </p>
          <button type="button" className="fd-btn" disabled={busy !== null} onClick={enterDemo}>
            {busy === "anonymous" ? "Opening demo…" : "Open the demo workspace"}
          </button>
        </div>
      </div>
    </div>
  );
}
