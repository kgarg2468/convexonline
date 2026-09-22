import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Field, Notice } from "../lib/ui";
import { errorMessage } from "../lib/format";
import { AuthCard, AuthScreen, CardText, OrDivider, Wordmark } from "./AuthCard";

type Flow = "signIn" | "signUp";

/** How long a resolved sign-in may sit without the provider turning authenticated before staff are told. */
const HANDOFF_TIMEOUT_MS = 20_000;

/** Tab underline in the accent, on the card's hairline. */
const tabClass =
  "h-9 flex-1 rounded-none px-2 text-[14px] text-ink-2 hover:text-ink-1 data-active:text-ink-1 after:bottom-[-1px] after:bg-accent-9";

/**
 * Staff sign in with email and password (Convex Auth Password provider).
 * Judges enter an isolated demo through the Anonymous provider; the demo inn
 * itself is seeded by FrontDeskWorkspace once the anonymous user exists.
 */
export function AuthView({ banner }: { banner?: ReactNode } = {}) {
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

  const form = (
    <form id="fd-auth-form" onSubmit={submit} className="flex flex-col gap-4">
      {flow === "signUp" ? (
        <Field label="Your name" htmlFor="fd-auth-name" hint="Shown to other staff on the threads you claim.">
          <Input id="fd-auth-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      ) : null}
      <Field label="Email" htmlFor="fd-auth-email">
        <Input
          id="fd-auth-email"
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
        <Input
          id="fd-auth-password"
          type="password"
          autoComplete={flow === "signUp" ? "new-password" : "current-password"}
          required
          minLength={flow === "signUp" ? 8 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {error ? (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      ) : null}
      <Button type="submit" size="lg" className="w-full" disabled={busy !== null}>
        {busy === "password" ? "Signing in…" : flow === "signIn" ? "Sign in" : "Create account"}
      </Button>
    </form>
  );

  return (
    <AuthScreen>
      <AuthCard>
        <Wordmark />

        {banner ? <div>{banner}</div> : null}

        {/* One form serves both tabs: it lives in whichever panel is active, so
            the typed email and password survive switching tabs. Both panels stay
            mounted (the inactive one hidden) so each trigger's aria-controls
            resolves and the panel ids never change. */}
        <Tabs value={flow} onValueChange={(value) => setFlow(value as Flow)} className="gap-5">
          <TabsList variant="line" aria-label="Staff sign in" className="h-9 w-full gap-0 border-b border-border-1 p-0">
            <TabsTrigger value="signIn" className={tabClass}>
              Sign in
            </TabsTrigger>
            <TabsTrigger value="signUp" className={tabClass}>
              Create staff account
            </TabsTrigger>
          </TabsList>
          <TabsContent value="signIn" forceMount hidden={flow !== "signIn"}>
            {flow === "signIn" ? form : null}
          </TabsContent>
          <TabsContent value="signUp" forceMount hidden={flow !== "signUp"}>
            {flow === "signUp" ? form : null}
          </TabsContent>
        </Tabs>

        <OrDivider>or</OrDivider>

        <div className="flex flex-col gap-3 rounded-[10px] bg-bg-2 p-4">
          <CardText>
            Look around a fictional inn with seeded guest threads. The demo is private to your browser
            session and never sends real email.
          </CardText>
          <Button type="button" variant="outline" size="lg" className="w-full bg-white" disabled={busy !== null} onClick={enterDemo}>
            {busy === "anonymous" ? "Opening demo…" : "Open the demo workspace"}
          </Button>
        </div>
      </AuthCard>
    </AuthScreen>
  );
}
