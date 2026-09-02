/**
 * Visual baselines — the surfaces that float over the workbench.
 *
 * The command palette and the AI assistant in its two resting states. Both are captured as
 * ELEMENTS: an overlay's job is to be a legible card over a dimmed app, and framing the window
 * would put the app underneath into the comparison.
 *
 * ── The Docker panel is NOT here, and that is a finding rather than an omission ─────────────────
 *
 * It was captured, inspected, and pulled. The panel lists every *database container on the host*
 * (`services/docker/detector.ts` filters by image name, not by compose project), so on the machine
 * this tier was written on it showed the four fixture containers followed by three of the
 * developer's own — `mjpg`, `some-postgres`, `sql-cert-fts`. A committed baseline would be asserting
 * one laptop's container inventory, and it would fail for every other developer for a reason that
 * has nothing to do with Joinery.
 *
 * Masking does not rescue it. Docker's status line ("Up 44 minutes (healthy)") is prose the panel
 * renders verbatim and it changes every minute, so it has to be masked in every row — which covers
 * roughly a third of each row, and still leaves the row SET host-dependent. That is masking a
 * surface into meaninglessness, so the surface is flagged instead: a portable Docker baseline needs
 * a deterministic container source behind `docker.detect` (a change under `packages/`, which Task 22
 * is forbidden from making). Recorded for whoever owns that.
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
  ensureJoineryTestSeeded,
  openChatConversations,
  openChatPanel,
  openPalette,
  overlayRows,
  selectDatabase,
} from '../helpers/joinery-actions-react';

const PROFILE = 'Test PG';
const DATABASE = 'joinery_test';

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
  });
}
