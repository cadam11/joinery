/**
 * The composer: the model picker, the box, and the one button that is Send or Stop.
 *
 * ── The input's text does not live in the surface ──────────────────────────────────────────
 *
 * It is state in THIS component, which is the second half of the R3 arrangement: the surface
 * subscribes to the store's message list, so a keystroke held one level up would re-render the whole
 * transcript per character — the chat equivalent of R2's "10k rows per keystroke". Nothing above the
 * composer needs to know what has been typed; `onSend` is called with it once.
 *
 * ── Two reasons the box refuses, and they are different states ─────────────────────────────
 *
 * 1. **A stream is open**: the button cancels it and the box is disabled — the Angular behaviour
 *    (`:321-329`).
 * 2. **A tool call is waiting on the user.** This one is NOT covered by the first, even though the
 *    two now overlap: since J-61 the main process keeps the turn open across a confirmation — it
 *    emits the `pendingConfirmation` chunk and withholds `done` until the call is answered — so
 *    `streaming` is true while the card is on screen and gate 1 already disables the box. Gate 2 is
 *    what makes that reliable rather than incidental, because a confirmation can outlive its stream
 *    (a decline, or a card restored from history), and a message sent underneath one orphans the card
 *    (see `selectHasPendingConfirmation` in `state/chat.ts` for what breaks on both sides of the
 *    bridge). The box says which of the two buttons above it is waiting.
 *
 * Between them they are also what keeps HOUSE-RULES §5's "at most one filled oxide affordance per
 * visible surface" true with two filled buttons in the feature. **Send** is filled, because it is what
 * this surface is for; **Run it** on a tool confirmation is filled, because approving is what that card
 * is for. They cannot both be armed. While the turn is open the composer renders **Stop** in Send's
 * place, and Stop is `variant="outline"`; on the paths where a confirmation outlives its stream, Send
 * is back but disabled, and `Button`'s disabled-`primary` treatment drops the fill entirely
 * (`ui/button.tsx`). Either way the confirmation's Run it is the only filled control on screen.
 *
 * One deliberate difference from Angular: focus returns to the box when a stream **ends**, not on
 * every `streaming` read. The Angular effect fired on mount too and re-fired on any false read
 * (`:1202-1208`), so a background stream finishing could pull focus out of the SQL editor a user was
 * typing in. Here the transition is what triggers it — plus a focus on mount, which is correct
 * because this surface only mounts when the user opens the panel or the tab.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Gauge, Square, SendHorizontal } from 'lucide-react';
import type { AIVendor, OpenRouterCostTier } from '@joinery/shared';
import {
  OPENROUTER_AUTO_ROUTERS,
  OPENROUTER_COST_TIERS,
  OPENROUTER_COST_TIER_LABELS,
} from '@joinery/shared';

import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Icon,
  Textarea,
  Tooltip,
  cn,
} from '../../ui';

/** An explicit model override. `null` means "let the main process choose" (`Auto`). */
export interface SelectedModel {
  readonly vendorId: string;
  readonly modelApiName: string;
  /** The label the picker shows. Held with the selection so the trigger needs no lookup. */
  readonly label: string;
}

export interface ChatComposerProps {
  readonly streaming: boolean;
  /**
   * A tool call in this conversation is waiting on the user. The box refuses until it is answered —
   * see the header, and `selectHasPendingConfirmation`.
   */
  readonly awaitingConfirmation: boolean;
  /** No provider configured: the box states why instead of sending into a refusal. */
  readonly providerConfigured: boolean;
  readonly vendors: readonly AIVendor[];
  readonly model: SelectedModel | null;
  readonly onModelChange: (model: SelectedModel | null) => void;
  /**
   * The selected model's vendor's persisted routing band, or `undefined` for "send no preference".
   *
   * Read from and written back to `AIVendorSettings.autoRouterCostTier` by the caller — the same
   * per-vendor field the AI setup dialog's selector edits, because it *is* the same setting. This
   * component holds no copy of it (J-92).
   */
  readonly costTier: OpenRouterCostTier | undefined;
  readonly onCostTierChange: (costTier: OpenRouterCostTier | undefined) => void;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
}

/**
 * Whether a routing band means anything for the next message.
 *
 * Reads the SAME shared map the main process's request builder looks the outgoing model up in, and
 * that the setup dialog gates its own selector on (`shared/types/ai.types.ts`), so the three places
 * cannot disagree about which models take a band.
 *
 * `Auto` (`model === null`) is excluded deliberately: the main process chooses the model then, and
 * it may well not choose a router — a band shown there would be a claim about a decision that has
 * not been made yet.
 */
export function offersCostTier(model: SelectedModel | null): model is SelectedModel {
  return model !== null && OPENROUTER_AUTO_ROUTERS.has(model.modelApiName);
}

/**
 * A band's name, short enough for a 20px strip.
 *
 * Derived from the shared label table rather than written out a second time, so a band is still
 * named in exactly one place: the menu rows carry the full label ("Low — cheapest models"), the
 * trigger carries its head ("Low").
 */
function shortTierName(costTier: OpenRouterCostTier): string {
  return OPENROUTER_COST_TIER_LABELS[costTier].split('—')[0]?.trim() ?? costTier;
}

/**
 * The strip's trigger treatment. Both pickers use it, so a change to the chrome cannot move one and
 * leave the other behind.
 */
const STRIP_TRIGGER_CLASSES = cn(
  'flex h-5 items-center gap-1 rounded-xs px-1',
  'font-mono text-2xs tracking-eyebrow text-fg-muted uppercase',
  'hover:bg-hover hover:text-fg',
  'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus'
);

/**
 * The routing band, where the auto-router is chosen (J-92).
 *
 * The band is a per-vendor *setting*, and it lived only in the AI setup dialog — a surface with no
 * menu item and no Settings entry at the time — while the place a user actually pins
 * `openrouter/auto-beta` is this strip. Pinning a router therefore gave no hint that a band existed
 * at all. This control writes through the same store action the dialog's selector does, so the two
 * are the same setting seen twice rather than two settings that have to be kept in step.
 */
function CostTierPicker({
  costTier,
  onCostTierChange,
}: Pick<ChatComposerProps, 'costTier' | 'onCostTierChange'>) {
  const name = costTier === undefined ? 'Default' : shortTierName(costTier);

  return (
    <DropdownMenu>
      {/* The trigger is abbreviated to fit the strip, so the tooltip is where the setting is named
          in full — including which of the six states it is in.

          `aria-label` says the same thing for a screen reader, which does NOT get the tooltip: the
          visible text is one word ("Default", "High"), and a word with no noun is not a control.
          The band is in the label as well as the name, so the announcement is complete on its own —
          the model picker beside it gets away with a bare tooltip because its text is a model name,
          which is self-describing, and this one is not. */}
      <Tooltip content={`Auto-router cost tier: ${name.toLowerCase()}`}>
        <DropdownMenuTrigger
          data-testid="chat-cost-tier-trigger"
          aria-label={`Auto-router cost tier: ${name.toLowerCase()}`}
          className={cn(STRIP_TRIGGER_CLASSES, 'min-w-0')}
        >
          <Icon icon={Gauge} size="sm" className="shrink-0 stroke-fg-muted" />
          <span data-testid="chat-cost-tier-label" className="min-w-0 truncate">
            {name}
          </span>
          <Icon icon={ChevronDown} size="sm" className="shrink-0 stroke-fg-muted" />
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" data-testid="chat-cost-tier-menu">
        <DropdownMenuLabel>Auto-router cost tier</DropdownMenuLabel>
        {/* Unset is a distinct instruction, not a synonym for the cheapest band: with no preference
            OpenRouter chooses the band itself. Same sentence as the dialog's sentinel row. */}
        <DropdownMenuCheckboxItem
          checked={costTier === undefined}
          data-testid="chat-cost-tier-unset"
          onSelect={() => onCostTierChange(undefined)}
        >
          Provider default
        </DropdownMenuCheckboxItem>
        {OPENROUTER_COST_TIERS.map(tier => (
          <DropdownMenuCheckboxItem
            key={tier}
            checked={costTier === tier}
            data-testid="chat-cost-tier-option"
            data-tier={tier}
            onSelect={() => onCostTierChange(tier)}
          >
            {OPENROUTER_COST_TIER_LABELS[tier]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelPicker({
  vendors,
  model,
  onModelChange,
}: Pick<ChatComposerProps, 'vendors' | 'model' | 'onModelChange'>) {
  // Nothing to pick from — and the transcript is already saying why. A trigger that opens an empty
  // menu is worse than no trigger.
  if (vendors.length === 0) return null;

  return (
    <DropdownMenu>
      <Tooltip content="The model this message goes to">
        <DropdownMenuTrigger
          data-testid="chat-model-trigger"
          className={cn(STRIP_TRIGGER_CLASSES, 'shrink-0')}
        >
          <span data-testid="chat-model-label">{model?.label ?? 'Auto'}</span>
          <Icon icon={ChevronDown} size="sm" className="stroke-fg-muted" />
        </DropdownMenuTrigger>
      </Tooltip>
      {/* Checkbox items, like the status bar's theme menu: the states are mutually exclusive AND the
          current one has to be visible. The `CostTier` band each model carries (economy / standard /
          premium, a catalogue fact) is deliberately not shown — it is a settings-surface fact
          (Task 19), and a `<kbd>` reading "economy" is not a keystroke. That is a different setting
          from OpenRouter's `autoRouterCostTier`, which `CostTierPicker` above does surface here
          because it changes where the *next message* is routed. */}
      <DropdownMenuContent align="start" side="top" data-testid="chat-model-menu">
        <DropdownMenuCheckboxItem
          checked={model === null}
          data-testid="chat-model-auto"
          onSelect={() => onModelChange(null)}
        >
          Auto
        </DropdownMenuCheckboxItem>
        {vendors.map(vendor => (
          <DropdownMenuGroup key={vendor.id}>
            <DropdownMenuLabel>{vendor.name}</DropdownMenuLabel>
            {vendor.models.map(candidate => {
              const selected =
                model?.vendorId === vendor.id && model.modelApiName === candidate.apiName;
              return (
                <DropdownMenuCheckboxItem
                  key={candidate.id}
                  checked={selected}
                  data-testid="chat-model-option"
                  onSelect={() =>
                    // Re-selecting the current model goes back to Auto, as the Angular picker did
                    // (`:1484-1495`) — it is the only way back without a separate "clear" row.
                    onModelChange(
                      selected
                        ? null
                        : {
                            vendorId: vendor.id,
                            modelApiName: candidate.apiName,
                            label: candidate.name,
                          }
                    )
                  }
                >
                  {candidate.name}
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ChatComposer({
  streaming,
  awaitingConfirmation,
  providerConfigured,
  vendors,
  model,
  onModelChange,
  costTier,
  onCostTierChange,
  onSend,
  onStop,
}: ChatComposerProps) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement | null>(null);
  /** Whether the box was refusing on the previous render. See the effect. */
  const wasBlocked = useRef(false);

  // The box refuses while a stream runs OR while a confirmation waits: both are "not your turn".
  const blocked = streaming || awaitingConfirmation;

  // Mount, and every time the box becomes usable again. See the header for why the transition — not
  // the value — is the trigger. `focus()` on a detached node (an inactive Dockview panel) is a no-op,
  // not an error.
  useEffect(() => {
    if (blocked) {
      wasBlocked.current = true;
      return;
    }
    wasBlocked.current = false;
    box.current?.focus();
  }, [blocked]);

  const send = (): void => {
    const message = text.trim();
    if (message === '') return;
    setText('');
    onSend(message);
  };

  const canSend = providerConfigured && !blocked && text.trim() !== '';

  return (
    // The hairline spans the pane, because it is the pane's divider; the CONTENTS take the same 76ch
    // measure the transcript uses (`chat-transcript.tsx`), so in a full-width chat tab the box lines up
    // with the prose above it instead of running the width of the pane on its own.
    <div className="shrink-0 border-t border-rule">
      <div className="mx-auto flex w-full max-w-[76ch] flex-col gap-1 p-2">
        {vendors.length === 0 ? null : (
          <div className="flex min-w-0 items-center gap-1">
            <ModelPicker vendors={vendors} model={model} onModelChange={onModelChange} />
            {/* Only beside a pinned auto-router — see `offersCostTier`. Nothing else OpenRouter
                offers takes a band, and no other vendor has a router at all. */}
            {offersCostTier(model) ? (
              <CostTierPicker costTier={costTier} onCostTierChange={onCostTierChange} />
            ) : null}
          </div>
        )}

        {/* Why the box is refusing, said where the refusal is. Not a `role="alert"`: nothing has gone
            wrong and the card above it already has the user's attention. */}
        {awaitingConfirmation ? (
          <p data-testid="chat-confirm-blocked" className="text-sm text-fg-muted text-pretty">
            Answer the tool request above — run it or cancel it — before sending another message.
          </p>
        ) : null}

        <div className="flex min-w-0 items-end gap-1.5">
          <Textarea
            ref={box}
            name="chat-message"
            aria-label="Message the assistant"
            data-testid="chat-input"
            rows={1}
            value={text}
            disabled={blocked}
            placeholder={
              awaitingConfirmation
                ? 'Waiting on the tool request above'
                : providerConfigured
                  ? 'Ask about your database…'
                  : 'Configure an AI provider to chat'
            }
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              // Enter sends; ⇧↩ is a newline. Ported from `onEnter` (`:1414`).
              if (event.key !== 'Enter' || event.shiftKey) return;
              event.preventDefault();
              send();
            }}
            // `field-sizing-content` grows the box with its content; `max-h-32` caps it at ~8 lines so
            // a pasted query cannot push the transcript off the panel.
            className="min-h-8.5 field-sizing-content max-h-32 resize-none"
          />

          {streaming ? (
            <Tooltip content="Stop the response">
              <Button
                size="sm"
                variant="outline"
                iconOnly
                leadingIcon={Square}
                aria-label="Stop the response"
                data-testid="chat-stop"
                onClick={onStop}
              />
            </Tooltip>
          ) : (
            <Tooltip content="Send (↩)">
              <Button
                size="sm"
                variant="primary"
                iconOnly
                leadingIcon={SendHorizontal}
                aria-label="Send"
                data-testid="chat-send"
                disabled={!canSend}
                onClick={send}
              />
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
