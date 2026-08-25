/**
 * The welcome tab — the one surface the UI audit called brand-correct, kept editorial (Decision D4) and
 * made theme-aware.
 *
 * Replaces `features/welcome/welcome.component.ts` (953, of which 613 were a stylesheet).
 *
 * ── What "make it theme-aware" actually meant ───────────────────────────────────────────────
 *
 * The Angular hero was hardcoded light: the audit found the `--concept-*` block declaring its own ivory
 * canvas, ink text and rule greys as literal hexes, so under the ink theme the whole section stayed
 * cream while the app around it went dark. Nothing here declares a colour: every surface, rule and
 * foreground is a Layer 2 token (`bg-canvas`, `bg-surface`, `border-rule`, `text-fg-muted`), so both
 * themes follow with no `dark:` variant anywhere — HOUSE-RULES §3's "a `dark:` variant is a signal that
 * a token is missing".
 *
 * The two Layer 1 uses are deliberate and are what HOUSE-RULES §5 reserves Layer 1 for: the brand mark,
 * and the diagram's verified-join pip.
 *
 * ── Why the editorial shape survived a rewrite that deleted its CSS ─────────────────────────
 *
 * D4 says keep it editorial, and the reason is that this is the only screen in the app whose job is to
 * say what Joinery is rather than to operate a database. So the display type, the kicker, the numbered
 * action grid and the relation diagram are all still here — as ~10 Tailwind utilities each instead of
 * 613 lines of hand-written CSS with nine off-grid spacing values and a `1fr 1fr` grid that overflowed
 * below 900px. The grid is `@container`-driven now (HOUSE-RULES §1), because a welcome TAB can be 400px
 * wide in a split dock and window width tells it nothing.
 *
 * ── The one testid that is a contract ───────────────────────────────────────────────────────
 *
 * `data-testid="welcome-new-connection"` is the e2e helper's way in
 * (`tests/helpers/joinery-actions-react.ts`), inherited from the Angular surface. It must survive every
 * restyle of this file.
 */

import { ArrowRight, ArrowUpRight, BookOpen, GitBranch, Server, Sparkles } from 'lucide-react';
import { DOCS_SITE_URL, type ConnectionProfile } from '@joinery/shared';

import { dispatchCommand, handlerCount } from '../../commands';
import { ipc, isIpcAvailable } from '../../ipc';
import { useDocker } from '../docker';
import { BrandMark } from '../../shell/sidebar/brand-mark';
import { chatPanelStore } from '../../state/chat';
import { connectionStore, useConnectionStore } from '../../state/connection';
import { diagnostics, notify } from '../../state/diagnostics';
import { explorerStore } from '../../state/explorer';
import { selectHasConfiguredVendors, useAIStore } from '../../state/ai';
import { Button, Icon, cn } from '../../ui';

/** How many saved profiles the recent list shows. The Angular value (`welcome.component.ts:90`). */
const MAX_RECENT_PROFILES = 5;

export function WelcomePanel() {
  return (
    /* `@container` on the scroller rather than on a shell element, per HOUSE-RULES §1: everything below
       sizes itself against THIS panel, which may be a 400px pane in a split dock. */
    <div
      data-testid="panel-welcome"
      className="@container h-full min-h-0 overflow-y-auto bg-canvas"
    >
      <div className="mx-auto flex max-w-[64rem] flex-col gap-8 p-6">
        <Hero />
        <ActionGrid />
        <RecentConnections />
        <AiSection />
        <GettingStarted />
        <Footer />
      </div>
    </div>
  );
}

// ── The hero ───────────────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section aria-label="Joinery" className="flex flex-col gap-6 border-b border-rule pb-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <BrandMark />
          <span className="text-lg text-fg">Joinery</span>
        </span>
        <span className="font-mono text-2xs tracking-eyebrow text-fg-subtle uppercase">
          Relational workbench / local desktop
        </span>
      </header>

      {/* Two columns once the panel is wide enough for the diagram to be legible, one before that. */}
      <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-[1.2fr_1fr] @3xl:items-center">
        <div className="flex flex-col gap-4">
          <span className="font-mono text-2xs tracking-eyebrow text-fg-muted uppercase">
            SQL Server · PostgreSQL · MySQL
          </span>
          {/* Display type carries its own tracking and line-height in the token — HOUSE-RULES §2 says
              never to add `leading-*` or `tracking-*` here. */}
          <h1 className="font-display text-display-md text-fg text-balance @3xl:text-display-lg">
            Your database, fitted to the way you work.
          </h1>
          <p className="max-w-[42ch] text-md text-fg-muted text-pretty">
            Write, understand and safely operate across every relationship — with AI that reads the
            schema and shows its work.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {/* THE contract testid. See the file header. The one filled oxide affordance on this
                surface, per HOUSE-RULES §5 — everything else here is outline or ghost. */}
            <Button
              variant="primary"
              data-testid="welcome-new-connection"
              trailingIcon={ArrowUpRight}
              onClick={() => dispatchCommand('open-connection-dialog')}
            >
              Fit a connection
            </Button>
            <TourButton />
          </div>
        </div>

        <RelationDiagram />
      </div>
    </section>
  );
}

/**
 * "See how it joins" — the guided tour's entry point.
 *
 * **Live since Task 19b**, with no edit to this file: `features/onboarding/TourHost` mounts the handler
 * and the shell mounts that, so the dispatch below now raises the spotlight overlay. This is what the
 * `handlerCount` check was designed for — 19a shipped the button dispatching into a registered-but-unowned
 * channel and saying so, and 19b made it work by subscribing.
 *
 * The refusal branch is KEPT rather than deleted. It is not dead: the dev pages (`src/dev/`) render this
 * surface without the shell's non-visual mounts, and any future build that drops `TourHost` gets a sentence
 * instead of a button that does nothing. The toast NAMES the owner, for the same reason a disabled palette
 * row does (`Not wired yet — <owner>`, `features/command-palette/command-palette.tsx:262`).
 *
 * `handlerCount`, not `dispatchCommand`'s return value: that boolean means "a handler CLAIMED it",
 * which only `menu-copy` ever does. The same reasoning the palette records at
 * `features/command-palette/command-palette.tsx:186`.
 */
function TourButton() {
  return (
    <Button
      data-testid="welcome-start-tour"
      onClick={() => {
        if (handlerCount('start-tour') === 0) {
          notify.info('The guided tour is not in this build yet — Task 19b.');
          return;
        }
        dispatchCommand('start-tour');
      }}
    >
      See how it joins
    </Button>
  );
}

/**
 * The editorial diagram: two tables and the key between them.
 *
 * Decorative — `aria-hidden`, because it says nothing the hero copy does not, and a screen reader
 * reading "customers id · name customer_id orders" would be noise. The ERD tab is the real thing.
 */
function RelationDiagram() {
  return (
    <div
      aria-hidden="true"
      data-testid="welcome-diagram"
      className="flex flex-col gap-2 rounded-md border border-rule bg-surface p-4"
    >
      <span className="font-mono text-2xs tracking-eyebrow text-fg-subtle uppercase">
        Relation / 03
      </span>
      <div className="flex flex-col gap-1.5">
        <DiagramNode name="customers" fields="id · name" />
        <div className="flex items-center gap-2 pl-3">
          <span className="h-4 w-px bg-rule-strong" />
          <span className="font-mono text-2xs text-fg-muted">customer_id</span>
        </div>
        <DiagramNode name="orders" fields="id · total" />
      </div>
      <p className="flex items-center gap-1.5 font-mono text-2xs tracking-eyebrow uppercase">
        {/* Chartreuse as a fill on a dark pip, never as light-mode text — HOUSE-RULES §5. */}
        <span className="size-1.5 rounded-full bg-j-chartreuse" />
        <span className="text-fg-muted">Join verified</span>
        <span className="text-fg tabular-nums">18 ms</span>
      </p>
    </div>
  );
}

function DiagramNode({ name, fields }: { readonly name: string; readonly fields: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-sm border border-rule bg-canvas px-3 py-2">
      <span className="font-mono text-sm text-fg">{name}</span>
      <span className="font-mono text-2xs text-fg-subtle">{fields}</span>
    </div>
  );
}

// ── The numbered action grid ───────────────────────────────────────────────────────────────

/**
 * Four entries, and each one is a command dispatch rather than a local call.
 *
 * The Angular grid's second card scrolled to a Docker section that only existed when containers were
 * found — a button that silently did nothing on most machines. Here it reports what Docker says
 * instead, which is the information the card was there to carry.
 */
function ActionGrid() {
  const docker = useDockerSummary();

  return (
    <section
      aria-label="Getting connected"
      className="grid grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-4"
    >
      <ActionCard
        index="01"
        title="Connect"
        note="Credentials in the system keychain"
        testId="welcome-action-connect"
        onClick={() => dispatchCommand('open-connection-dialog')}
      />
      <ActionCard
        index="02"
        title="Understand"
        note={docker}
        testId="welcome-action-docker"
        onClick={() => dispatchCommand('open-object-search')}
      />
      <ActionCard
        index="03"
        title="Query"
        note="Ask with the schema in context"
        testId="welcome-action-chat"
        onClick={() => chatPanelStore.getState().openPanel()}
      />
      <ActionCard
        index="04"
        title="Verify"
        note="Every write is confirmed first"
        testId="welcome-action-verify"
        onClick={() => dispatchCommand('open-settings')}
      />
    </section>
  );
}

function ActionCard({
  index,
  title,
  note,
  testId,
  onClick,
}: {
  readonly index: string;
  readonly title: string;
  readonly note: string;
  readonly testId: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex flex-col items-start gap-1 rounded-sm border border-rule bg-surface p-3 text-left',
        'hover:border-rule-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
      )}
    >
      <span className="font-mono text-2xs tracking-eyebrow text-fg-subtle tabular-nums">
        {index}
      </span>
      <span className="font-mono text-sm tracking-eyebrow text-fg uppercase">{title}</span>
      <span className="text-xs text-fg-muted">{note}</span>
    </button>
  );
}

/**
 * One line about Docker, from the SAME query the status-bar pip and the Docker panel read.
 *
 * Task 19a shipped this as a one-shot effect of its own, because the Docker surface did not exist yet and
 * a third source of truth was better than an invented one. It exists now, so the effect is deleted:
 * `useDocker()` is one cached pair of queries and `DockerPip.tooltip` is the sentence it produces. Three
 * consumers, one fetch, one answer — and starting a container in the panel updates this line too, which
 * an effect that ran once on mount could not do.
 *
 * Its old `filter(c => c.isSqlServer)` went with it: main sets that flag to `true` on every container it
 * returns, so it was a no-op (`features/docker/docker-model.ts`, finding 1).
 */
function useDockerSummary(): string {
  const { pip } = useDocker();
  return isIpcAvailable() ? pip.tooltip : 'Local containers unavailable';
}

// ── Recent connections ─────────────────────────────────────────────────────────────────────

/**
 * The saved profiles, newest-saved first, as one-click connects.
 *
 * Ported behaviour and one fix: the Angular version called `connectionState.connect()` and then added
 * the server node itself, duplicating four lines of the sidebar's own connect path — and swallowed the
 * failure entirely (`connectTo` checked `success` and simply did nothing when it was false). Here the
 * connect is awaited, the node work is the same two store calls, and a refusal says so.
 */
function RecentConnections() {
  const profiles = useConnectionStore(state => state.profiles);
  if (profiles.length === 0) return null;

  const connect = (profile: ConnectionProfile): void => {
    void (async () => {
      const connected = await connectionStore.getState().connect(profile.id);
      if (!connected) {
        // The store already toasts the reason; this is the "and so nothing opened" half.
        return;
      }
      explorerStore.getState().addServerNode(profile.id, profile.name);
      await explorerStore.getState().expandNode(`server-${profile.id}`);
    })();
  };

  return (
    <section aria-label="Recent connections" className="flex flex-col gap-2">
      <h2 className="font-mono text-2xs tracking-eyebrow text-fg-muted uppercase">
        Saved connections
      </h2>
      <ul className="flex flex-col">
        {profiles.slice(0, MAX_RECENT_PROFILES).map(profile => (
          <li key={profile.id}>
            <button
              type="button"
              data-testid="welcome-recent-connection"
              onClick={() => connect(profile)}
              className={cn(
                'flex w-full items-center gap-3 border-b border-rule px-2 py-2 text-left',
                'hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus'
              )}
            >
              <Icon icon={Server} size="sm" className="stroke-fg-muted" />
              <span className="flex min-w-0 grow flex-col">
                <span className="truncate text-base text-fg">{profile.name}</span>
                <span className="truncate font-mono text-xs text-fg-subtle">
                  {profile.server}:{profile.port}
                </span>
              </span>
              <Icon icon={ArrowRight} size="sm" className="stroke-fg-subtle" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── AI ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The AI entry point, and the one place on this surface whose copy changed meaning.
 *
 * The Angular promo card offered "Maybe Later", whose handler was an empty method with a comment saying
 * the card would be back next launch. A control that does nothing is the J-44 defect, so it is gone:
 * the card is what it always was — an offer — and not dismissing it costs the user nothing.
 *
 * `selectHasConfiguredVendors` is the gate, matching the main process's own
 * (`chat-service.ts:selectVendorAndModel` looks for an enabled vendor with a key and does NOT consult
 * the master `enabled` flag). The store is hydrated by `features/ai-setup/AiSetupHost`, which the shell
 * mounts, so this reads real settings on first paint.
 */
function AiSection() {
  const configured = useAIStore(selectHasConfiguredVendors);

  if (configured) {
    return (
      <section
        aria-label="AI features"
        data-testid="welcome-ai-active"
        className="flex flex-wrap items-center gap-3 rounded-md border border-rule bg-surface p-4"
      >
        <Icon icon={Sparkles} size="md" className="stroke-fg-muted" />
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="text-md text-fg">AI is set up</span>
          <span className="text-sm text-fg-muted text-pretty">
            Chat, result analysis and schema-aware completion are available.
          </span>
        </span>
        <Button
          data-testid="welcome-open-chat"
          onClick={() => chatPanelStore.getState().openPanel()}
        >
          Open the assistant
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-label="AI features"
      data-testid="welcome-ai-setup"
      className="flex flex-wrap items-center gap-3 rounded-md border border-rule bg-surface p-4"
    >
      <Icon icon={Sparkles} size="md" className="stroke-fg-muted" />
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="text-md text-fg">Set up AI</span>
        <span className="text-sm text-fg-muted text-pretty">
          One API key enables the assistant, result explanations and schema-aware completion. The
          key is held in the system keychain.
        </span>
      </span>
      <Button data-testid="welcome-ai-setup-open" onClick={() => dispatchCommand('open-ai-setup')}>
        Choose a provider
      </Button>
    </section>
  );
}

// ── Getting started ────────────────────────────────────────────────────────────────────────

const TIPS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'Three engines, one workbench',
    body: 'SQL Server, PostgreSQL and MySQL. Reach a server directly or through an SSH tunnel.',
  },
  {
    title: 'Docker for local work',
    body: 'Containers running any of the three engines are detected automatically.',
  },
  {
    title: 'Credentials stay in the keychain',
    body: 'Passwords and API keys are held by the operating system, never in a file this app writes.',
  },
];

function GettingStarted() {
  return (
    <section aria-label="Getting started" className="flex flex-col gap-3 border-t border-rule pt-6">
      <h2 className="font-mono text-2xs tracking-eyebrow text-fg-muted uppercase">
        Getting started
      </h2>
      <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-3">
        {TIPS.map(tip => (
          <div key={tip.title} className="flex flex-col gap-1">
            <h3 className="text-base text-fg text-balance">{tip.title}</h3>
            <p className="text-sm text-fg-muted text-pretty">{tip.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Footer ─────────────────────────────────────────────────────────────────────────────────

const DOCS_URL = DOCS_SITE_URL;
const REPO_URL = 'https://github.com/cadam11/joinery';

/**
 * Two external links, opened through `app.openExternal` — never as `<a href>`.
 *
 * The Angular version used `<a href="#">` with a `preventDefault` handler, which works and is a
 * navigation waiting to happen: there is no `will-navigate` guard and no `setWindowOpenHandler` in main
 * (PLAN.md §7's closing note), so an anchor that ever escaped its handler would navigate the app window
 * away from itself with no way back. A `<button>` cannot.
 */
function Footer() {
  const open = (url: string): void => {
    if (!isIpcAvailable()) return;
    void ipc()
      .app.openExternal(url)
      .catch(error => diagnostics.error('failed to open an external link', error));
  };

  return (
    <footer className="flex items-center gap-2 border-t border-rule pt-4">
      <Button
        variant="ghost"
        size="sm"
        leadingIcon={BookOpen}
        data-testid="welcome-docs"
        onClick={() => open(DOCS_URL)}
      >
        Documentation
      </Button>
      <Button
        variant="ghost"
        size="sm"
        leadingIcon={GitBranch}
        data-testid="welcome-github"
        onClick={() => open(REPO_URL)}
      >
        GitHub
      </Button>
    </footer>
  );
}
