import { ViewTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Correction, InnDetail, InnSummary, RecordVersionResult, ThreadStats, Viewer, WorkspaceView } from "./types";
import { AuthView } from "./auth/AuthView";
import { InnPicker } from "./onboarding/InnPicker";
import { InvitationGate } from "./onboarding/InvitationGate";
import { Shell, type ShellHeader } from "./shell/Shell";
import { DemoActions } from "./shell/DemoActions";
import { useDemoPolicy } from "./shell/useDemoPolicy";
import { CommandPalette } from "./shell/CommandPalette";
import { ShortcutsSheet } from "./shell/ShortcutsSheet";
import { useShortcuts } from "./shell/useShortcuts";
import { CorrectionsView } from "./corrections/CorrectionsView";
import { InboxView } from "./inbox/InboxView";
import { InboxStats } from "./inbox/InboxStats";
import type { QueueKeyHandler } from "./inbox/QueueList";
import { SourcesSheet } from "./inbox/SourcesSheet";
import { KnowledgeView } from "./knowledge/KnowledgeView";
import { SettingsView } from "./settings/SettingsView";
import { Notice, Spinner } from "./lib/ui";
import { errorMessage } from "./lib/format";
import { forgetConsumedUrl, replaceUrl, useIsMid, useIsNarrow, useNow, useRoute, useStoredState } from "./lib/hooks";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePendingInvite, type PendingInvite } from "./lib/invitations";
import { WorkspaceAccessBoundary } from "./lib/WorkspaceAccessBoundary";

const INN_KEY = "frontdesk.innId";
export const STALL_AFTER_MS = 20_000;

/**
 * Classes styles/motion.css animates, by the transition type `useRoute` tags
 * each navigation with. The routed view is keyed by view, so a view swap is an
 * enter/exit pair and the inbox's list ↔ detail (narrow screens) is an update
 * of the one inbox boundary.
 */
const VIEW_ENTER = {
  default: "none",
  "nav-forward": "vt-fade-in",
  "nav-back": "vt-back-in",
};
const VIEW_EXIT = {
  default: "none",
  "nav-forward": "vt-fade-out",
  "nav-back": "vt-back-out",
};
const VIEW_UPDATE = {
  default: "none",
  "nav-mobile-detail": "vt-detail-in",
  "nav-back": "vt-detail-out",
};

/** Marks a history entry pushed by opening a thread from the list on a narrow screen (see selectThread). */
type ListState = { fdFromList?: boolean } | null;

/** The stored property is per account: it goes when the account does. */
function forgetStoredInn() {
  try {
    window.localStorage.removeItem(INN_KEY);
  } catch {
    /* storage unavailable */
  }
}

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
              <Notice tone="caution" role="status">
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
        <Notice tone="error" role="alert">
          This invitation link is not valid. Ask the property owner for a new one.
        </Notice>
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

  // Signing out (or the session ending) forgets the stored property and lets a
  // later sign-in in this tab read the address bar again.
  const leave = useCallback(() => {
    forgetStoredInn();
    void signOut();
  }, [signOut]);
  useEffect(() => () => forgetConsumedUrl(), []);

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
              <button type="button" className="fd-btn fd-btn--primary" onClick={leave}>
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
            <Notice tone="error" role="alert">
              Could not open the demo. {demoError}
            </Notice>
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
    // The demo inn is refused like any other when a subscription fails; a
    // visitor gets the same honest screen, with the inbox as the way back.
    return (
      <WorkspaceAccessBoundary key={demoInn.innId} onReturn={() => window.location.assign("/inbox")} returnLabel="Back to the inbox">
        <Workspace key={demoInn.innId} viewer={viewer} inns={inns} current={demoInn} onSwitchInn={setStoredInn} onSignOut={leave} />
      </WorkspaceAccessBoundary>
    );
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
      <Workspace viewer={viewer} inns={inns} current={current} onSwitchInn={openInn} onSignOut={leave} />
    </WorkspaceAccessBoundary>
  );
}

function Workspace({
  viewer,
  inns,
  current,
  onSwitchInn,
  onSignOut,
}: {
  viewer: Viewer;
  inns: InnSummary[];
  current: InnSummary;
  onSwitchInn: (innId: string) => void;
  onSignOut: () => void;
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
  const narrow = useIsNarrow();
  // Two-pane inbox: the sources pane is a sheet opened from the header.
  const mid = useIsMid();
  // The URL is the source of truth for the view and the open thread (lib/router.ts).
  const { route, navigate } = useRoute(current.isDemo);
  const view = route.view;
  const selectedThread = route.view === "inbox" ? (route.threadId as Id<"threads"> | null) : null;
  // The thread that was open last, so "Inbox" from another view returns to it on wide screens.
  const lastThread = useRef<Id<"threads"> | null>(null);
  useEffect(() => {
    if (selectedThread) lastThread.current = selectedThread;
  }, [selectedThread]);
  // Result of the last scripted demo page edit. Held here so the sentence
  // stays on screen when the review zero-state hero gives way to the cards.
  const [lastDemoChange, setLastDemoChange] = useState<RecordVersionResult | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // One instance of the demo's scripted edit, so the header control, the review
  // hero and the palette share its busy and error state.
  const demo = useDemoPolicy(innId, current.isDemo);
  // View-level keys (`j` / `k` in the queue) register here; the one listener in useShortcuts serves them.
  const inboxKeys = useRef<QueueKeyHandler | null>(null);
  const registerInboxKeys = useCallback((handler: QueueKeyHandler | null) => {
    inboxKeys.current = handler;
  }, []);

  const goTo = useCallback(
    (next: WorkspaceView) => {
      navigate(next === "inbox" ? { view: "inbox", threadId: narrow ? null : lastThread.current } : { view: next });
    },
    [navigate, narrow],
  );

  // On a narrow screen a thread opened over the list is one history entry
  // deeper than the list, and is marked so: going back to the list is then a
  // real `history.back()` and the stack does not grow with every round trip.
  const atList = route.view === "inbox" && route.threadId === null;
  const fromList = narrow && atList ? { state: { fdFromList: true } } : undefined;

  function openThread(threadId: Id<"threads">) {
    navigate({ view: "inbox", threadId }, narrow ? "nav-mobile-detail" : "nav-forward", fromList);
  }

  /** Selection inside the inbox: a slide on narrow screens, a plain URL change beside an open queue. */
  function selectThread(threadId: Id<"threads"> | null) {
    if (threadId !== null) {
      navigate({ view: "inbox", threadId }, narrow ? "nav-mobile-detail" : "nav-none", fromList);
      return;
    }
    if ((window.history.state as ListState)?.fdFromList) {
      window.history.back(); // popstate restores the list with nav-back
      return;
    }
    // Deselecting is not a place to return to: the entry is rewritten, never added.
    navigate({ view: "inbox", threadId: null }, "nav-back", { replace: true });
  }

  /** The open thread belongs to another property (ThreadDetail says so): drop it from the address bar and from memory. */
  const onForeignThread = useCallback(() => {
    replaceUrl("/inbox");
    lastThread.current = null;
  }, []);

  function demoChanged(result: RecordVersionResult) {
    setLastDemoChange(result);
    goTo("corrections");
  }

  useShortcuts({
    onGo: goTo,
    onTogglePalette: () => {
      setShortcutsOpen(false);
      setPaletteOpen((open) => !open);
    },
    onHelp: () => {
      setPaletteOpen(false);
      setShortcutsOpen(true);
    },
    onEscape: () => {
      if (narrow && selectedThread) selectThread(null);
    },
    onKey: (event) => inboxKeys.current?.(event) ?? false,
  });

  const header = ((): ShellHeader => {
    switch (view) {
      case "corrections":
        return {
          title: "Policy changes",
          sub: "See which replies need a second look",
          actions: (
            <Button type="button" variant="outline" size="sm" className="text-[13px]" onClick={() => goTo("inbox")}>
              Go to inbox
            </Button>
          ),
        };
      case "inbox":
        return {
          title: "Inbox",
          sub: detail?.inn.inboxAddress ?? (current.isDemo ? "Seeded guest threads" : "No inbox set up yet"),
          meta: stats ? <InboxStats stats={stats} timezone={detail?.inn.timezone} /> : undefined,
          actions:
            (mid && selectedThread) || current.isDemo ? (
              <>
                {mid && selectedThread ? <SourcesSheet key={selectedThread} threadId={selectedThread} /> : null}
                {current.isDemo ? (
                  <DemoActions innId={innId} demo={demo} last={lastDemoChange} onResult={demoChanged} />
                ) : null}
              </>
            ) : undefined,
        };
      case "knowledge":
        return { title: "Knowledge", sub: current.siteUrl };
      case "settings":
        return { title: "Settings", sub: "Property, guest inbox, providers and team" };
    }
  })();

  const flush = view === "inbox";

  return (
    <>
      <Shell
        viewer={viewer}
        inns={inns}
        currentInn={current}
        onSwitchInn={onSwitchInn}
        view={view}
        onNavigate={goTo}
        correctionsCount={openCorrections ? new Set(openCorrections.map((c) => c.sentReplyId)).size : undefined}
        isDemo={current.isDemo}
        header={header}
        flush={flush}
        onOpenPalette={() => setPaletteOpen(true)}
        onSignOut={onSignOut}
      >
        {/* Updates inside a view (list ↔ detail) animate on narrow screens only: on wide ones a
            selection beside the queue must not start a view transition, which would hold the next
            commits until it settles. */}
        <ViewTransition key={view} default="none" enter={VIEW_ENTER} exit={VIEW_EXIT} update={narrow ? VIEW_UPDATE : "none"}>
          <div className={cn("min-w-0 flex-1", flush && "flex min-h-0")}>
            {view === "corrections" ? (
              <CorrectionsView
                innId={innId}
                viewerId={viewer._id}
                isDemo={current.isDemo}
                demo={demo}
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
                onSelect={selectThread}
                onOpenCorrections={() => goTo("corrections")}
                onForeignThread={onForeignThread}
                registerKeys={registerInboxKeys}
              />
            ) : view === "knowledge" ? (
              <KnowledgeView innId={innId} siteUrl={current.siteUrl} isDemo={current.isDemo} />
            ) : detail === undefined ? (
              <Spinner label="Loading property" />
            ) : (
              <SettingsView viewer={viewer} detail={detail} />
            )}
          </div>
        </ViewTransition>
      </Shell>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        innId={innId}
        isDemo={current.isDemo}
        demo={demo}
        onGo={goTo}
        onOpenThread={openThread}
        onDemoResult={demoChanged}
      />
      <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  );
}
