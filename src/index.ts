/**
 * Mogul — entry point.
 *
 * Starts the Express server, mounts the WhatsApp webhook router,
 * and kicks off the periodic conversation cleanup job.
 */

import express from 'express';
import { config } from './config';
import { whatsappRouter } from './webhook/whatsapp';
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
