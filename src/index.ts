/**
 * Mogul — entry point.
 *
 * Starts the Express server, mounts the WhatsApp webhook router,
 * and kicks off the periodic conversation cleanup job.
 */

import express from 'express';
import { config } from './config';
import { whatsappRouter } from './webhook/whatsapp';
import { twilioRouter } from './webhook/twilio';       // DISPOSABLE — remove when Meta is live
import { runCleanup } from './conversation/stateMachine';

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Apply express.raw() to the webhook route so signature verification has
// access to the raw body bytes. All other routes get JSON parsing.
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

app.use('/webhook', whatsappRouter);

// DISPOSABLE — Twilio sandbox adapter. Remove once Meta app is approved.
if (config.twilioAccountSid && config.twilioAuthToken && config.twilioWhatsappFrom) {
  app.use('/webhook-twilio', express.urlencoded({ extended: false }), twilioRouter);
  console.info('[server] Twilio sandbox adapter enabled at /webhook-twilio');
}

// ---------------------------------------------------------------------------
// Cleanup job
// ---------------------------------------------------------------------------

function startCleanupJob(): void {
  const intervalMs = config.cleanupIntervalMs;
  console.info(
    `[cleanup] Starting conversation cleanup job (interval: ${intervalMs / 1000}s)`,
  );
  setInterval(() => {
    runCleanup().catch((err) => {
      console.error('[cleanup] Error during cleanup run:', err);
    });
  }, intervalMs);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(config.port, () => {
  console.info(`[server] Mogul listening on port ${config.port} (${config.nodeEnv})`);
  startCleanupJob();
});

export { app };
