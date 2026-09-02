/**
 * Visual baselines — the surfaces that float over the workbench.
 *
 * The command palette and the AI assistant in its two resting states. Both are captured as
 * ELEMENTS: an overlay's job is to be a legible card over a dimmed app, and framing the window
 * would put the app underneath into the comparison.
 *
 * ── The Docker panel, and the hatch that made it baselineable (J-76) ───────────────────────────
 *
 * Task 22 captured it, inspected it, and pulled it. The panel lists every *database container on
 * the host* (`services/docker/detector.ts` filters by image name, not by compose project), so on
 * the machine this tier was written on it showed the four fixture containers followed by three of
 * the developer's own — `mjpg`, `some-postgres`, `sql-cert-fts`. A committed baseline would have
 * been asserting one laptop's container inventory, and it would have failed for every other
 * developer for a reason that has nothing to do with Joinery. Masking does not rescue it either:
 * Docker's status line ("Up 44 minutes (healthy)") is prose the panel renders verbatim and it
 * changes every minute, so it has to be masked in every row — roughly a third of each row — and the
 * row SET stays host-dependent regardless.
 *
 * So the surface was flagged for a deterministic source behind `docker.detect`, under `packages/`,
 * which Task 22 was forbidden from making. J-76 made it:
 * `packages/main/src/services/docker/docker-fixture.ts` lets a launch pin what `detect()` and
 * `listVolumes()` answer, and `DOCKER_FIXTURE` below is what this tier pins them to. The shot needs
 * **no masks at all** as a result, which is the whole point — a masked third of every row was the
 * alternative on offer.
 *
 * ── The assistant, and why there is no streamed transcript here ────────────────────────────────
 *
 * No test in this suite calls an LLM (`tests/helpers/react/chat.ts` states the rule), and this tier
 * is not the place to introduce the first one: a scripted stream would need a fake provider wired
 * into the main process, i.e. a change under `packages/` that Task 22 is forbidden from making, and
 * a baseline of a *mocked* transcript would then be a picture of the mock's copy. The two states
 * that are real without a key are the ones captured — the empty panel, and the panel with a
 * conversation selected and the conversation list open. A streamed-transcript baseline is worth
 * having and belongs with whatever task builds the provider fake.
 */

import { VISUAL_THEMES, blurFocus, expect, shoot, test, withVisualApp } from './fixtures';
import {
  chatPanel,
  connectFromSidebar,
  createChatConversation,
  createPostgresProfile,
  dismissToasts,
  dockerContainerNames,
  ensureJoineryTestSeeded,
  openChatConversations,
  openChatPanel,
  openDockerPanel,
  openPalette,
  overlayRows,
  selectDatabase,
} from '../helpers/joinery-actions-react';
import {
  DOCKER_FIXTURE_ENV_VAR,
  type DockerFixture,
} from '../../packages/main/src/services/docker/docker-fixture';

const PROFILE = 'Test PG';
const DATABASE = 'joinery_test';

/**
 * The container inventory this tier's Docker baselines are a picture of.
 *
 * **Typed against main's own `DockerFixture`**, so it is checked rather than believed: the shape
 * `docker.detect` answers is `DockerDetectionResult` from `@joinery/shared`, and a fixture that
 * drifted from it would fail `pnpm run typecheck` instead of quietly producing a panel that renders
 * from fields the real detector never sets.
 *
 * Chosen to put every branch of a container row in the frame, because a baseline only guards what it
 * contains: a running container with a published port AND a bind mount (the `docker-container-binds`
 * sub-list), a second running one, a STOPPED one with no published port (the grey pip, the Start
 * button, and Connect disabled with "no published port"), and two named volumes (the `Volumes`
 * section, which is conditional — `docker-panel.tsx` renders it only when main answers with some).
 *
 * Every string here is fixed, including the two that are volatile on a real daemon: `status` is
 * Docker's own prose, which moves every minute, and `created` is a timestamp. Names are prefixed
 * `joinery-fixture-` so a reader of a failing diff can tell at a glance that no real container of
 * theirs is in the picture.
 */
const DOCKER_FIXTURE: DockerFixture = {
  detect: {
    dockerRunning: true,
    containers: [
      {
        id: 'fixture-postgres',
        name: 'joinery-fixture-postgres',
        image: 'postgres:16-alpine',
        state: 'running',
        status: 'Up 2 hours (healthy)',
        port: 15432,
        hostBinding: '0.0.0.0',
        volumeMappings: [
          {
            hostPath: '/Users/joinery/backups',
            containerPath: '/var/lib/postgresql/backups',
            mode: 'rw',
          },
        ],
        created: '2026-01-04T09:00:00.000Z',
      },
      {
        id: 'fixture-mysql',
        name: 'joinery-fixture-mysql',
        image: 'mysql:8.4',
        state: 'running',
        status: 'Up 2 hours',
        port: 13306,
        hostBinding: '0.0.0.0',
        volumeMappings: [],
        created: '2026-01-04T09:00:00.000Z',
      },
      {
        id: 'fixture-mssql',
        name: 'joinery-fixture-sqlserver',
        image: 'mcr.microsoft.com/mssql/server:2022-latest',
        state: 'exited',
        status: 'Exited (0) 3 days ago',
        port: null,
        hostBinding: '0.0.0.0',
        volumeMappings: [],
        created: '2026-01-01T09:00:00.000Z',
      },
    ],
  },
  volumes: [
    {
      name: 'joinery-fixture_pgdata',
      driver: 'local',
      mountpoint: '/var/lib/docker/volumes/joinery-fixture_pgdata/_data',
    },
    {
      name: 'joinery-fixture_mysqldata',
      driver: 'local',
      mountpoint: '/var/lib/docker/volumes/joinery-fixture_mysqldata/_data',
    },
  ],
};

/** What a launch has to carry for the panel to show {@link DOCKER_FIXTURE} instead of the host. */
const DOCKER_FIXTURE_ENV = { [DOCKER_FIXTURE_ENV_VAR]: JSON.stringify(DOCKER_FIXTURE) };

test.beforeAll(ensureJoineryTestSeeded);

for (const theme of VISUAL_THEMES) {
  test.describe(`Joinery (React) — overlay baselines, ${theme}`, () => {
    test('command palette over a connected app', async () => {
      await withVisualApp(theme, async ({ window }) => {
        await createPostgresProfile(window, PROFILE);
        await connectFromSidebar(window, PROFILE);
        await selectDatabase(window, DATABASE);
        await dismissToasts(window);
        // Connecting can open a query tab on its own (`sidebar.tsx`'s `openQueryForConnection`), so
        // whether focus is in an editor by this point is not something this spec controls. J-73 made
        // ⌘K work from inside Monaco — the editor releases the keystroke back to the window — so this
        // is no longer a workaround for a swallowed key. It stays because a focused editor draws a
        // caret and a focus ring behind the overlay, and a baseline must not depend on that.
        await blurFocus(window);

        const palette = await openPalette(window);
        // Connected on purpose: roughly half the catalogue is `unavailable` without a connection, and
        // the row treatment for an available command is the one a user sees most.
        await expect(overlayRows(window, 'palette').first()).toBeVisible();
        // No query has been run in this launch, so the "recent queries" section is empty — which is
        // what keeps the row list a function of the catalogue rather than of history.
        await expect(window.locator('[data-palette-key^="recent:"]')).toHaveCount(0);

        await shoot(palette, `command-palette-${theme}.png`);
      });
    });

    test('AI assistant panel, no conversation', async () => {
      await withVisualApp(theme, async ({ window }) => {
        const panel = await openChatPanel(window);
        await shoot(panel, `chat-empty-${theme}.png`);
      });
    });

    test('AI assistant panel with a conversation and the list open', async () => {
      await withVisualApp(theme, async ({ window }) => {
        const panel = await openChatPanel(window);
        await createChatConversation(panel);
        await openChatConversations(panel);
        // One row, titled by the store rather than by this spec, and dated "Today" — the only clock-
        // derived string in the shot, and it is stable for any run that does not straddle midnight
        // (`formatConversationDate` buckets by whole days).
        await expect(panel.getByTestId('chat-conversation')).toHaveCount(1);
        await expect(chatPanel(window).getByTestId('chat-title')).toHaveText('New Chat');

        await shoot(panel, `chat-conversation-${theme}.png`);
      });
    });

    test('Docker panel over a pinned container inventory', async () => {
      await withVisualApp(
        theme,
        async ({ window }) => {
          const panel = await openDockerPanel(window);

          // The claim the whole hatch exists for: these three rows and nothing else. Any container
          // of the developer's own — or any of the five harness ones this tier's other specs
          // connect to — would show up here, which is what made the surface unbaselineable.
          expect(await dockerContainerNames(window)).toEqual([
            'joinery-fixture-mysql',
            'joinery-fixture-postgres',
            'joinery-fixture-sqlserver',
          ]);
          // Conditional sections, asserted present so the shot is known to contain them rather than
          // being a picture of their absence.
          await expect(panel.getByTestId('docker-volumes')).toBeVisible();
          await expect(panel.getByTestId('docker-container-binds')).toHaveCount(1);
          await expect(panel.getByTestId('docker-empty')).toBeHidden();

          // ── Why the pip has to be let go of before the shutter ────────────────────────────
          //
          // `Popover` is non-modal (`ui/popover.tsx`), so opening it leaves focus on the trigger —
          // and the trigger is wrapped in a `Tooltip`, which Radix opens on FOCUS as well as on
          // hover. Both halves are live here: `openDockerPanel` clicks the pip, which both focuses
          // it and parks the pointer on it. `shoot` refuses to take a picture with a tooltip up, so
          // this is the difference between a baseline and a red run rather than tidiness.
          //
          // Blur does not dismiss the popover: Radix's dismissal watches `focusin` outside the
          // layer, and `blur()` moves focus to `<body>` without firing one. Asserted rather than
          // assumed, immediately below.
          await window.mouse.move(0, 0);
          await blurFocus(window);
          await expect(panel).toBeVisible();

          await shoot(panel, `docker-panel-${theme}.png`);
        },
        { envOverrides: DOCKER_FIXTURE_ENV }
      );
    });
  });
}
