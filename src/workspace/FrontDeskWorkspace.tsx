import { useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Correction, InnDetail, InnSummary, RecordVersionResult, ThreadStats, Viewer, WorkspaceView } from "./types";
import { AuthView } from "./auth/AuthView";
import { InnPicker } from "./onboarding/InnPicker";
import { InvitationGate } from "./onboarding/InvitationGate";
import { Shell, HeaderTitle } from "./shell/Shell";
import { DemoActions } from "./shell/DemoActions";
import { CorrectionsView } from "./corrections/CorrectionsView";
import { InboxView } from "./inbox/InboxView";
import { KnowledgeView } from "./knowledge/KnowledgeView";
import { SettingsView } from "./settings/SettingsView";
import { Notice, Spinner } from "./lib/ui";
import { errorMessage } from "./lib/format";
import { useNow, useStoredState } from "./lib/hooks";
import { usePendingInvite, type PendingInvite } from "./lib/invitations";
import { WorkspaceAccessBoundary } from "./lib/WorkspaceAccessBoundary";
import "./workspace.css";

const INN_KEY = "frontdesk.innId";
export const STALL_AFTER_MS = 20_000;

/** True once `pending` has been continuously true for STALL_AFTER_MS; never fakes success. */
function useStalled(pending: boolean): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const id = window.setTimeout(() => setStalled(true), STALL_AFTER_MS);
    return () => {
      window.clearTimeout(id);
      setStalled(false);
    };
  }, [pending]);
  return stalled && pending;
}

/**
 * Root of the staff workspace. Render inside <ConvexAuthProvider>.
 * Decides between: signed out → AuthView; anonymous → seed and open the demo
 * inn; staff with no inn → onboarding; otherwise the shell with the chosen inn.
 */
export function FrontDeskWorkspace() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const viewer = useQuery(api.users.viewer, isAuthenticated ? {} : "skip") as Viewer | null | undefined;
  const pending = isLoading || (isAuthenticated && viewer === undefined);
  const stalled = useStalled(pending);
  // Captured from the #invite= fragment before anything else renders, so the
  // token is out of the address bar whichever screen comes next.
  const { invite, clear: clearInvite } = usePendingInvite();

  if (pending) {
    return (
      <div className="fd-root fd-center">
        <div className="fd-center__panel">
          <Spinner label="Opening Front Desk" />
          {stalled ? (
            <div style={{ marginTop: 14 }}>
              <Notice tone="caution">
                Still connecting after {STALL_AFTER_MS / 1000} seconds. The workspace could not confirm your session with the
                server.{" "}
                <button type="button" className="fd-btn fd-btn--small" onClick={() => window.location.reload()}>
                  Try again
                </button>
              </Notice>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  if (!isAuthenticated || viewer === null || viewer === undefined) {
    return (
      <div className="fd-root">
        <AuthView
          banner={
            invite?.kind === "token" ? (
              <Notice tone="info">
                <strong>You have a staff invitation.</strong> Sign in, or create a staff account, to see which property
                it is for and join it. It stays in this tab until you decide.
              </Notice>
            ) : invite?.kind === "malformed" ? (
              <Notice tone="caution">
                <strong>The invitation link you opened is not valid.</strong> Ask the property owner for a new one. You
                can still sign in, or create a staff account, and set the link aside there.
              </Notice>
            ) : undefined
          }
        />
      </div>
    );
  }
  return (
    <div className="fd-root">
      <SignedIn viewer={viewer} invite={invite} onInviteDone={clearInvite} />
    </div>
  );
}

/**
 * An invitation link was opened that cannot be read as one. Nothing is sent
 * to the server and the raw fragment is never shown; the only way on is to
 * dismiss it, which drops it from this tab.
 */
function MalformedInvitation({ viewer, onDismiss }: { viewer: Viewer; onDismiss: () => void }) {
  return (
    <div className="fd-center">
      <div className="fd-center__panel" role="region" aria-labelledby="fd-invite-title">
        <h2 className="fd-h2" id="fd-invite-title">
          Staff invitation
        </h2>
        <p className="fd-lede">Signed in as {viewer.name ?? viewer.email ?? "staff"}.</p>
        <Notice tone="error">This invitation link is not valid. Ask the property owner for a new one.</Notice>
        <div className="fd-btn-row" style={{ marginTop: 16 }}>
          <button type="button" className="fd-btn" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function SignedIn({
  viewer,
  invite,
  onInviteDone,
}: {
  viewer: Viewer;
  invite: PendingInvite | null;
  onInviteDone: () => void;
}) {
  const inns = useQuery(api.inns.mine, {}) as InnSummary[] | undefined;
  const enterDemo = useMutation(api.demo.enter);
  const { signOut } = useAuthActions();
  const [storedInn, setStoredInn] = useStoredState<string>(INN_KEY, "");
  // Set by "Back to properties" on the access screen. Without it, a sole inn
  // is re-selected by the fallback below and the same errored boundary stays
  // mounted; with it, the picker shows until a property is chosen or joined.
  const [choosingInn, setChoosingInn] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const seeding = useRef(false);

  function openInn(innId: string) {
    setStoredInn(innId);
    setChoosingInn(false);
  }

  // Anonymous visitors get their private demo inn seeded once, idempotently.
  const needsDemo = viewer.isAnonymous && inns !== undefined && !inns.some((i) => i.isDemo);
  useEffect(() => {
    if (!needsDemo || seeding.current) return;
    seeding.current = true;
    enterDemo({})
      .then((innId) => setStoredInn(innId as string))
      .catch((e) => setDemoError(errorMessage(e)))
      .finally(() => {
        seeding.current = false;
      });
  }, [needsDemo, enterDemo, setStoredInn]);

  const current = useMemo(() => {
    if (!inns) return null;
    return inns.find((i) => i.innId === storedInn) ?? (inns.length === 1 ? inns[0]! : null);
  }, [inns, storedInn]);

  if (inns === undefined) return <Spinner label="Loading your properties" />;

  if (invite?.kind === "malformed") {
    return <MalformedInvitation viewer={viewer} onDismiss={onInviteDone} />;
  }

  if (viewer.isAnonymous) {
    // A demo visitor cannot hold a staff membership, so the invitation is never
    // sent to the server from here: it waits for a real sign-in.
    if (invite) {
      return (
        <div className="fd-center">
          <div className="fd-center__panel" role="region" aria-labelledby="fd-invite-demo-title">
            <h2 className="fd-h2" id="fd-invite-demo-title">
              Staff invitation waiting
            </h2>
            <p className="fd-lede">
              You opened a staff invitation while looking at the demo. The demo visitor cannot join a real property;
              leave the demo and sign in (or create a staff account) to accept it. The invitation stays in this tab.
            </p>
            <div className="fd-btn-row">
              <button type="button" className="fd-btn fd-btn--primary" onClick={() => void signOut()}>
                Leave demo and sign in
              </button>
              <button type="button" className="fd-btn fd-btn--quiet" onClick={onInviteDone}>
                Discard invitation
              </button>
            </div>
          </div>
        </div>
      );
    }
    if (demoError) {
      return (
        <div className="fd-center">
          <div className="fd-center__panel">
            <Notice tone="error">Could not open the demo. {demoError}</Notice>
          </div>
        </div>
      );
    }
    const demoInn = current?.isDemo ? current : inns.find((i) => i.isDemo);
    if (!demoInn) {
      return (
        <div className="fd-center">
          <Spinner label="Setting up your demo inn" />
        </div>
      );
    }
    return <Workspace key={demoInn.innId} viewer={viewer} inns={inns} current={demoInn} onSwitchInn={setStoredInn} />;
  }

  if (invite) {
    return (
      <InvitationGate
        token={invite.token}
        viewer={viewer}
        onJoined={(innId) => {
          openInn(innId);
          onInviteDone();
        }}
        onDismiss={onInviteDone}
      />
    );
  }
  if (choosingInn || !current) {
    return <InnPicker viewer={viewer} inns={inns} onSelect={openInn} />;
  }
  // Keyed by inn so a refused subscription for one property never lingers over another.
  return (
    <WorkspaceAccessBoundary
      key={current.innId}
      onReturn={() => {
        setStoredInn("");
        setChoosingInn(true);
      }}
    >
      <Workspace viewer={viewer} inns={inns} current={current} onSwitchInn={openInn} />
    </WorkspaceAccessBoundary>
  );
}

function Workspace({
  viewer,
  inns,
  current,
  onSwitchInn,
}: {
  viewer: Viewer;
  inns: InnSummary[];
  current: InnSummary;
  onSwitchInn: (innId: string) => void;
}) {
  const innId = current.innId;
  const detail = useQuery(api.inns.get, { innId }) as InnDetail | undefined;
  const openCorrections = useQuery(api.corrections.list, { innId, status: "needs_review" }) as
    | Correction[]
    | undefined;
  // The minute nonce re-subscribes the stats query as the inn's local day
  // rolls over (no row changes then); the server decides the actual cutoff.
  const statsMinute = Math.floor(useNow(15_000) / 60_000);
  const stats = useQuery(api.threads.stats, { innId, clock: statsMinute }) as ThreadStats | undefined;
  // Judges land on the policy-change review; staff land on the inbox.
  const [view, setView] = useState<WorkspaceView>(current.isDemo ? "corrections" : "inbox");
  const [selectedThread, setSelectedThread] = useState<Id<"threads"> | null>(null);
  // Result of the last scripted demo page edit. Held here so the sentence
  // stays on screen when the review zero-state hero gives way to the cards.
  const [lastDemoChange, setLastDemoChange] = useState<RecordVersionResult | null>(null);

  function openThread(threadId: Id<"threads">) {
    setSelectedThread(threadId);
    setView("inbox");
  }

  const header = (() => {
    switch (view) {
      case "corrections":
        return (
          <>
            <HeaderTitle title="Policy changes" sub="See which replies need a second look" />
            <div className="fd-header__actions">
              <button type="button" className="fd-btn" onClick={() => setView("inbox")}>
                Go to inbox
              </button>
            </div>
          </>
        );
      case "inbox":
        return (
          <>
            <HeaderTitle
              title="Inbox"
              sub={
                stats
                  ? `${stats.open} open · ${stats.needsStaff} need you · ${stats.ready} ready · ${stats.sentToday} sent today`
                  : detail?.inn.inboxAddress ?? (current.isDemo ? "Seeded guest threads" : "No inbox set up yet")
              }
            />
            <div className="fd-header__actions">
              {current.isDemo ? (
                <DemoActions
                  innId={innId}
                  last={lastDemoChange}
                  onResult={(r) => {
                    setLastDemoChange(r);
                    setView("corrections");
                  }}
                />
              ) : null}
            </div>
          </>
        );
      case "knowledge":
        return <HeaderTitle title="Knowledge" sub={current.siteUrl} />;
      case "settings":
        return <HeaderTitle title="Settings" />;
    }
  })();

  return (
    <Shell
      viewer={viewer}
      inns={inns}
      currentInn={current}
      onSwitchInn={onSwitchInn}
      view={view}
      onNavigate={setView}
      correctionsCount={openCorrections?.length}
      isDemo={current.isDemo}
      header={header}
      flush={view === "inbox"}
    >
      {view === "corrections" ? (
        <CorrectionsView
          innId={innId}
          viewerId={viewer._id}
          isDemo={current.isDemo}
          liveMail={detail?.liveMail}
          lastDemoChange={lastDemoChange}
          onDemoChange={setLastDemoChange}
          onOpenThread={openThread}
        />
      ) : view === "inbox" ? (
        <InboxView
          innId={innId}
          viewerId={viewer._id}
          isDemo={current.isDemo}
          liveMail={detail?.liveMail}
          selected={selectedThread}
          onSelect={setSelectedThread}
          onOpenCorrections={() => setView("corrections")}
        />
      ) : view === "knowledge" ? (
        <KnowledgeView innId={innId} siteUrl={current.siteUrl} isDemo={current.isDemo} />
      ) : detail === undefined ? (
        <Spinner label="Loading property" />
      ) : (
        <SettingsView viewer={viewer} detail={detail} />
      )}
    </Shell>
  );
}
