/**
 * The three doors J-92 added to AI configuration, in the real app.
 *
 * ── Why this file exists rather than more assertions in `settings.spec.ts` ──────────────────
 *
 * The AI setup dialog was never missing and was never broken. What was missing were *entry points*:
 * its only unconditional one was the command palette, because the welcome tab's AI card and the chat
 * panel's no-provider empty state are both gated on NOT being configured yet. A user who had already
 * saved a key had one route left, and it was the one that requires knowing the command's name.
 *
 * So every test below asserts a **path**, not a control: the native menu really carries the item and
 * clicking it really sends the channel; ⌘, really reaches AI setup; and the routing band is really
 * offered where the auto-router is pinned — and is really the same stored setting the dialog edits,
 * which is asserted by reading it back through the *other* surface.
 *
 * ── No LLM, and no key ─────────────────────────────────────────────────────────────────────
 *
 * Nothing here sends a message. `seedAiProvider` writes the `apiKeyConfigured` boolean the renderer
 * gates on and no key at all — but read its header before adding a test: not writing a key is not
 * the same as being unable to reach a provider, because the credential store's service name is
 * shared with the real app (J-96). Every test below stops at the UI, which is what keeps that
 * academic.
 */

import { expect, test } from '@playwright/test';
import {
  aiSetupDialog,
  applicationMenuPaths,
  chatCostTier,
  chooseChatCostTier,
  clickMenuItem,
  openAiSetup,
  openChatPanel,
  openSettings,
  openSettingsGroup,
  pinChatModel,
  seedAiProvider,
  settingsDialog,
  withJoineryReact,
} from '../helpers/joinery-actions-react';

/** The catalogue's OpenRouter auto-router, by the name the pickers show. */
const AUTO_ROUTER = 'Auto Router (Beta)';
/** A concrete OpenRouter model — same vendor, no routing band. */
const PLAIN_MODEL = 'Claude Sonnet 4.5';

test.describe('Joinery — the ways into AI setup', () => {
  test('the native menu carries AI Setup beside Settings, in every menu Settings is in', async () => {
    await withJoineryReact(async ({ app, window }) => {
      const paths = await applicationMenuPaths(app);

      // One AI Setup per menu that carries Settings, wherever that is: since J-97 the preferences
      // block is gated on `!isMac`, so macOS has one copy (the app menu) and Windows/Linux have one
      // (Edit) — never two, which is what J-97 fixed. A count, not a `some`: AI Setup drifting away
      // from Settings is the regression this exists to catch, and `some` would not notice.
      const aiSetup = paths.filter(path => path.endsWith('▸ AI Setup...'));
      const settings = paths.filter(path => /▸ (Settings|Preferences)\.\.\.$/.test(path));
      expect(aiSetup).toHaveLength(settings.length);
      expect(aiSetup.length).toBeGreaterThan(0);

      // And EVERY copy's own handler sends the channel the renderer routes — the half
      // `sendMenuCommand` cannot reach, because it fires the channel itself. One send per item, so a
      // second copy wired to the wrong channel (or to nothing) fails here rather than hiding behind
      // the first one.
      const sent = await clickMenuItem(app, 'AI Setup...');
      expect(sent).toEqual(aiSetup.map(() => 'menu:open-ai-setup'));
      await expect(aiSetupDialog(window)).toBeVisible();
    });
  });

  test('⌘, offers an AI group, and its button hands over to the setup dialog', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await openSettings(app, window);
      const group = await openSettingsGroup(window, 'ai');

      // The group holds no preference of its own; what it owes the user is the state and the door.
      await expect(group.getByTestId('settings-ai-state')).toHaveAttribute('data-state', 'none');
      await group.getByTestId('settings-open-ai-setup').click();

      // Handed over, not stacked: settings closes and AI setup opens, so there is only ever one modal.
      await expect(aiSetupDialog(window)).toBeVisible();
      await expect(settingsDialog(window)).toBeHidden();
    });
  });

  test('the AI group reports a configured provider once one is', async () => {
    await withJoineryReact(async ({ app, window }) => {
      await seedAiProvider(window, 'openrouter');

      await openSettings(app, window);
      const group = await openSettingsGroup(window, 'ai');

      await expect(group.getByTestId('settings-ai-state')).toHaveAttribute(
        'data-state',
        'configured'
      );
    });
  });

  test('the routing band is offered where the auto-router is pinned, and only there', async () => {
    await withJoineryReact(async ({ window }) => {
      await seedAiProvider(window, 'openrouter');
      const panel = await openChatPanel(window);

      // Auto is the resting state: the main process picks the model, and may not pick a router.
      await expect(chatCostTier(panel)).toHaveCount(0);

      await pinChatModel(panel, PLAIN_MODEL);
      await expect(chatCostTier(panel)).toHaveCount(0);

      await pinChatModel(panel, AUTO_ROUTER);
      await expect(chatCostTier(panel)).toBeVisible();
      // Unset until the user says otherwise — which is a real instruction to OpenRouter, not `low`.
      await expect(panel.getByTestId('chat-cost-tier-label')).toHaveText('Default');
    });
  });

  test('a band chosen in the composer is the band the setup dialog shows', async () => {
    await withJoineryReact(async ({ window }) => {
      await seedAiProvider(window, 'openrouter');
      const panel = await openChatPanel(window);
      await pinChatModel(panel, AUTO_ROUTER);

      await chooseChatCostTier(panel, 'high');
      await expect(panel.getByTestId('chat-cost-tier-label')).toHaveText('High');

      // The shared-state claim, read back through the OTHER surface. Both render
      // `AIVendorSettings.autoRouterCostTier` for the vendor and both write it through
      // `setAutoRouterCostTier`, so a second store field would fail here and nowhere else.
      const dialog = await openAiSetup(window);
      await expect(dialog.getByTestId('ai-setup-vendor')).toContainText('OpenRouter');
      await expect(dialog.getByTestId('ai-setup-cost-tier')).toContainText('High');
    });
  });

  test('the band survives a restart, because it is main-process state', async () => {
    await withJoineryReact(async ({ window }) => {
      await seedAiProvider(window, 'openrouter');
      const panel = await openChatPanel(window);
      await pinChatModel(panel, AUTO_ROUTER);
      await chooseChatCostTier(panel, 'max');
      await expect(panel.getByTestId('chat-cost-tier-label')).toHaveText('Max');

      // localStorage is wiped first, so a value that comes back can only have come from `AppState`
      // — the same argument `settings.spec.ts` makes about the editor preferences.
      await window.evaluate(() => window.localStorage.clear());
      await window.reload();
      await expect(window.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });

      // The pinned model is per-conversation component state and does not survive, so the dialog is
      // where the persisted band is read.
      const dialog = await openAiSetup(window);
      await expect(dialog.getByTestId('ai-setup-cost-tier')).toContainText('Max');
    });
  });
});
