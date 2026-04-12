/**
 * BotReply — the type returned by processMessage() and consumed by webhook adapters.
 *
 * string      → plain text, sent as-is
 * ButtonReply → WhatsApp quick-reply (2–3 tappable buttons)
 * ListReply   → WhatsApp list picker (4+ options in a scrollable list)
 */

export interface ButtonReply {
  /** Message body text (question / context shown above the buttons). */
  body: string;
  /** 2–3 button titles. WhatsApp enforces a hard max of 3 quick-reply buttons. */
  buttons: string[];
}

export interface ListItem {
  /** Stable identifier — also accepted as a fallback text input value. */
  id: string;
  /** Display title shown to the user (≤ 24 chars for WhatsApp). */
  title: string;
  /** Optional subtitle. */
  description?: string;
}

export interface ListReply {
  /** Message body shown above the list-open button. */
  body: string;
  /** Label on the button that opens the list (e.g. "Select"). */
  buttonLabel: string;
  /** List items to display. */
  items: ListItem[];
}

export type BotReply = string | ButtonReply | ListReply;

export function isButtonReply(r: BotReply): r is ButtonReply {
  return typeof r === 'object' && 'buttons' in r;
}

export function isListReply(r: BotReply): r is ListReply {
  return typeof r === 'object' && 'items' in r;
}

/**
 * Converts any BotReply to plain text.
 * Used by adapters that don't yet support interactive messages.
 */
export function botReplyToText(reply: BotReply): string {
  if (typeof reply === 'string') return reply;
  if (isButtonReply(reply)) {
    const options = reply.buttons.map((b, i) => `${i + 1} - ${b}`).join('\n');
    return `${reply.body}\n${options}`;
  }
  // ListReply
  const options = reply.items.map((item, i) => `${i + 1} - ${item.title}`).join('\n');
  return `${reply.body}\n${options}`;
}
