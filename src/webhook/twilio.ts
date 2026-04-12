/**
 * Twilio WhatsApp sandbox adapter.
 *
 * DISPOSABLE — delete this file and remove the /webhook-twilio mount from
 * index.ts once a production Meta app is approved and whatsapp.ts is live.
 *
 * Routes:
 *   POST /webhook-twilio/:shopId  — Incoming messages from Twilio sandbox
 *
 * Auth:
 *   Validates AccountSid in the form body matches TWILIO_ACCOUNT_SID in .env.
 *
 * Payload differences vs Meta Cloud API (whatsapp.ts):
 *   - Form-encoded body (application/x-www-form-urlencoded) instead of JSON
 *   - Fields: From (whatsapp:+xxx), Body, MessageSid, AccountSid
 *   - Send endpoint: Twilio REST API with Basic auth (AccountSid:AuthToken)
 */

import { Router, type Request, type Response } from 'express';
import { pool } from '../db/pool';
import { processMessage } from '../conversation/stateMachine';
import { config } from '../config';
import { type BotReply, type ButtonReply, type ListReply, isButtonReply, isListReply, botReplyToText } from '../types/bot';

export const twilioRouter = Router();

const MAX_WA_MESSAGE_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Reset command (mirrors whatsapp.ts)
// ---------------------------------------------------------------------------

const RESET_KEYWORDS = new Set(['reset', 'neustart', 'ricominciare']);

function isResetCommand(text: string): boolean {
  return RESET_KEYWORDS.has(text.trim().toLowerCase());
}

async function resetConversation(shopId: string, waPhone: string): Promise<void> {
  await pool.query(
    `UPDATE conversations
     SET status = 'expired', updated_at = NOW()
     WHERE wa_phone = $1 AND shop_id = $2 AND status = 'active'`,
    [waPhone, shopId],
  );
}

// ---------------------------------------------------------------------------
// Message deduplication (mirrors whatsapp.ts)
// ---------------------------------------------------------------------------

async function isAlreadyProcessed(messageId: string): Promise<boolean> {
  const { rows } = await pool.query<{ message_id: string }>(
    `SELECT message_id FROM processed_messages WHERE message_id = $1`,
    [messageId],
  );
  return rows.length > 0;
}

async function markProcessed(messageId: string, shopId: string): Promise<void> {
  await pool.query(
    `INSERT INTO processed_messages (message_id, shop_id)
     VALUES ($1, $2)
     ON CONFLICT (message_id) DO NOTHING`,
    [messageId, shopId],
  );
}

// ---------------------------------------------------------------------------
// Send via Twilio REST API
// ---------------------------------------------------------------------------

function splitMessage(text: string): string[] {
  if (text.length <= MAX_WA_MESSAGE_LENGTH) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_WA_MESSAGE_LENGTH) {
    const chunk = remaining.slice(0, MAX_WA_MESSAGE_LENGTH);
    const lastNewline = chunk.lastIndexOf('\n');
    const cutAt = lastNewline > 0 ? lastNewline : MAX_WA_MESSAGE_LENGTH;
    parts.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function twilioBasicAuth(sid: string, token: string): string {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

async function sendTwilioTextMessage(to: string, body: string): Promise<void> {
  const { twilioAccountSid, twilioAuthToken, twilioWhatsappFrom } = config;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;

  const params = new URLSearchParams({
    From: twilioWhatsappFrom!,
    To: `whatsapp:${to}`,
    Body: body,
  });

  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: twilioBasicAuth(twilioAccountSid!, twilioAuthToken!),
      },
      body: params.toString(),
    });
  } catch (err) {
    console.error('[twilio] Network error sending message:', err);
    return;
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error(`[twilio] API error ${response.status} sending to ${to}:`, errBody);
  }
}

async function sendTextReply(to: string, text: string): Promise<void> {
  const parts = splitMessage(text);
  for (const part of parts) {
    await sendTwilioTextMessage(to, part);
  }
}

// ---------------------------------------------------------------------------
// Twilio Content API — on-demand interactive message templates
// ---------------------------------------------------------------------------

/** In-memory cache: content hash → ContentSid */
const templateCache = new Map<string, string>();

function templateCacheKey(reply: ButtonReply | ListReply): string {
  if (isButtonReply(reply)) {
    return `btn:${reply.body}::${reply.buttons.join('|')}`;
  }
  return `list:${reply.body}::${reply.buttonLabel}::${reply.items.map(i => `${i.id}=${i.title}`).join('|')}`;
}

async function getOrCreateContentSid(
  sid: string,
  token: string,
  reply: ButtonReply | ListReply,
): Promise<string | null> {
  const key = templateCacheKey(reply);
  const cached = templateCache.get(key);
  if (cached) return cached;

  let types: Record<string, unknown>;
  if (isButtonReply(reply)) {
    types = {
      'twilio/quick-reply': {
        body: reply.body,
        actions: reply.buttons.map((title, i) => ({ title, id: `btn_${i}` })),
      },
    };
  } else {
    types = {
      'twilio/list-picker': {
        body: reply.body,
        button: reply.buttonLabel,
        items: reply.items.map(item => ({
          id: item.id,
          item: item.title,
          ...(item.description ? { description: item.description } : {}),
        })),
      },
    };
  }

  let response: globalThis.Response;
  try {
    response = await fetch('https://content.twilio.com/v1/Content', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: twilioBasicAuth(sid, token),
      },
      body: JSON.stringify({
        friendly_name: `mogul_${Date.now()}`,
        language: 'en',
        types,
      }),
    });
  } catch (err) {
    console.error('[twilio] Network error creating content template:', err);
    return null;
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error(`[twilio] Content API error ${response.status}:`, errBody);
    return null;
  }

  const json = await response.json() as { sid: string };
  templateCache.set(key, json.sid);
  console.info(`[twilio] Created content template ${json.sid}`);
  return json.sid;
}

async function sendTwilioContentMessage(
  to: string,
  contentSid: string,
): Promise<void> {
  const { twilioAccountSid, twilioAuthToken, twilioWhatsappFrom } = config;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;

  const params = new URLSearchParams({
    From: twilioWhatsappFrom!,
    To: `whatsapp:${to}`,
    ContentSid: contentSid,
  });

  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: twilioBasicAuth(twilioAccountSid!, twilioAuthToken!),
      },
      body: params.toString(),
    });
  } catch (err) {
    console.error('[twilio] Network error sending interactive message:', err);
    return;
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error(`[twilio] API error ${response.status} sending interactive to ${to}:`, errBody);
  }
}

/** WhatsApp interactive message body hard limit (Twilio Content API). */
const INTERACTIVE_BODY_MAX = 1024;

async function sendReply(to: string, reply: BotReply): Promise<void> {
  if (typeof reply === 'string') {
    await sendTextReply(to, reply);
    return;
  }

  const { twilioAccountSid, twilioAuthToken } = config;
  if (!twilioAccountSid || !twilioAuthToken) {
    await sendTextReply(to, botReplyToText(reply));
    return;
  }

  // If the body is too long for an interactive message (e.g. booking summary),
  // send the long content as plain text first, then send a short interactive
  // message using only the last paragraph (after the final double-newline).
  let interactiveReply: ButtonReply | ListReply = reply;
  if (isButtonReply(reply) && reply.body.length > INTERACTIVE_BODY_MAX) {
    const split = reply.body.lastIndexOf('\n\n');
    const textPart = split > 0 ? reply.body.slice(0, split) : reply.body;
    const shortBody = split > 0 ? reply.body.slice(split + 2) : '↑';
    await sendTextReply(to, textPart);
    interactiveReply = { body: shortBody, buttons: reply.buttons };
  }

  const contentSid = await getOrCreateContentSid(twilioAccountSid, twilioAuthToken, interactiveReply);
  if (!contentSid) {
    console.warn('[twilio] Falling back to plain text for interactive reply');
    await sendTextReply(to, botReplyToText(reply));
    return;
  }

  await sendTwilioContentMessage(to, contentSid);
}

// ---------------------------------------------------------------------------
// Incoming message handler
// ---------------------------------------------------------------------------

twilioRouter.post('/:shopId', async (req: Request, res: Response) => {
  const { shopId } = req.params;

  // 1. Acknowledge immediately
  res.status(200).send('');

  // 2. Validate credentials are configured
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioWhatsappFrom) {
    console.warn('[twilio] Twilio env vars not set — ignoring incoming message');
    return;
  }

  // 3. Verify AccountSid matches
  const accountSid = req.body.AccountSid as string | undefined;
if (accountSid !== config.twilioAccountSid) {
    console.warn('[twilio] AccountSid mismatch for shop:', shopId);
    return;
  }

  // 4. Parse fields
  const rawFrom = req.body.From as string | undefined;   // "whatsapp:+1234567890"
  const incomingText = req.body.Body as string | undefined;
  const messageSid = req.body.MessageSid as string | undefined;

  if (!rawFrom || !incomingText || !messageSid) {
    console.warn('[twilio] Missing required fields in payload');
    return;
  }

  // Strip "whatsapp:" prefix for storage
  const waPhone = rawFrom.startsWith('whatsapp:') ? rawFrom.slice('whatsapp:'.length) : rawFrom;

  console.info(`[twilio] Message from ${waPhone} → shop ${shopId}: "${incomingText}"`);

  // 5. Deduplicate
  let alreadySeen: boolean;
  try {
    alreadySeen = await isAlreadyProcessed(messageSid);
  } catch (err) {
    console.error('[twilio] Error checking dedup:', messageSid, err);
    alreadySeen = false;
  }

  if (alreadySeen) {
    console.info(`[twilio] Duplicate message ${messageSid} — skipping`);
    return;
  }

  try {
    await markProcessed(messageSid, shopId);
  } catch (err) {
    console.warn('[twilio] Failed to mark message as processed:', messageSid, err);
  }

  // 6. Handle reset command
  if (isResetCommand(incomingText)) {
    try {
      await resetConversation(shopId, waPhone);
    } catch (err) {
      console.error('[twilio] Error resetting conversation:', err);
    }
  }

  // 7. Run the state machine
  let reply: BotReply;
  try {
    reply = await processMessage(shopId, waPhone, isResetCommand(incomingText) ? '1' : incomingText);
  } catch (err) {
    console.error('[twilio] Unhandled state machine error:', err);
    reply = 'Sorry, something went wrong. Please try again.';
  }

  // 8. Send reply (interactive or plain text)
  await sendReply(waPhone, reply);
});
