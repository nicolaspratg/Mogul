/**
 * Quick connectivity probe for Easyrent server.
 *
 * Tests:
 *   1. TCP reachability (can we connect at all?)
 *   2. REST /aliveserver (lightweight health check)
 *   3. REST /testaccess (credential validation)
 *   4. SOAP testmethod (WSDL fetch + method call)
 *   5. REST /branches (first real data call — gives us branchId)
 *   6. REST /reservation/reservablearticles (equipment catalog)
 *
 * Usage:
 *   npx tsx src/scripts/probeEasyrent.ts
 */

import * as net from 'net';
import * as soap from 'node-soap';

// ---------------------------------------------------------------------------
// Riml Sports config (from seed-riml-sports.sql)
// ---------------------------------------------------------------------------

const HOST = '83.218.162.16';
const PORT = 11122;
const ACCESS_ID = 'bRimlOber';
// const ACCESS_ID = 'bG2wLPacN#';
const REST_BASE = `http://${HOST}:${PORT}/easyrest/rest`;
const SOAP_URL = `http://${HOST}:${PORT}/wsa/wsa1/wsdl?targetURI=urn:wseasyrent`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(icon: string, label: string, detail?: string): void {
  const msg = detail ? `${icon} ${label}: ${detail}` : `${icon} ${label}`;
  console.log(msg);
}

async function tcpCheck(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function probeTcp(): Promise<boolean> {
  process.stdout.write('  1. TCP connect... ');
  const ok = await tcpCheck(HOST, PORT);
  if (ok) {
    log('✓', `${HOST}:${PORT} reachable`);
  } else {
    log('✗', `${HOST}:${PORT} unreachable — check firewall/VPN`);
  }
  return ok;
}

async function probeAliveServer(): Promise<boolean> {
  process.stdout.write('  2. GET /aliveserver... ');
  try {
    const url = `${REST_BASE}/aliveserver?accessId=${encodeURIComponent(ACCESS_ID)}`;
    const res = await fetchWithTimeout(url);
    const body = await res.text();
    log('✓', `HTTP ${res.status}`, body.slice(0, 200));
    return res.ok;
  } catch (err) {
    log('✗', 'failed', err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function probeTestAccess(): Promise<boolean> {
  process.stdout.write('  3. GET /testaccess... ');
  try {
    const url = `${REST_BASE}/testaccess?accessId=${encodeURIComponent(ACCESS_ID)}`;
    const res = await fetchWithTimeout(url);
    const body = await res.text();
    log('✓', `HTTP ${res.status}`, body.slice(0, 300));
    return res.ok;
  } catch (err) {
    log('✗', 'failed', err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function probeSoapTestMethod(): Promise<boolean> {
  process.stdout.write('  4. SOAP testmethod... ');
  try {
    const client = await soap.createClientAsync(SOAP_URL);
    const [result] = await client.testmethodAsync({ accessid: ACCESS_ID });
    log('✓', 'response', JSON.stringify(result, null, 2).slice(0, 300));
    return true;
  } catch (err) {
    log('✗', 'failed', err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function probeBranches(): Promise<boolean> {
  process.stdout.write('  5. GET /branches... ');
  try {
    const url = `${REST_BASE}/branches?accessId=${encodeURIComponent(ACCESS_ID)}`;
    const res = await fetchWithTimeout(url);
    const body = await res.text();
    if (res.ok) {
      try {
        const data = JSON.parse(body);
        log('✓', `HTTP ${res.status} — ${Array.isArray(data) ? data.length : '?'} branch(es)`, JSON.stringify(data, null, 2).slice(0, 500));
      } catch {
        log('✓', `HTTP ${res.status}`, body.slice(0, 500));
      }
    } else {
      log('✗', `HTTP ${res.status}`, body.slice(0, 300));
    }
    return res.ok;
  } catch (err) {
    log('✗', 'failed', err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function probeReservableArticles(): Promise<boolean> {
  process.stdout.write('  6. GET /reservation/reservablearticles... ');
  try {
    const url = `${REST_BASE}/reservation/reservablearticles?accessId=${encodeURIComponent(ACCESS_ID)}`;
    const res = await fetchWithTimeout(url);
    const body = await res.text();
    if (res.ok) {
      try {
        const data = JSON.parse(body);
        log('✓', `HTTP ${res.status} — ${Array.isArray(data) ? data.length : '?'} article(s)`, JSON.stringify(data, null, 2).slice(0, 800));
      } catch {
        log('✓', `HTTP ${res.status}`, body.slice(0, 800));
      }
    } else {
      log('✗', `HTTP ${res.status}`, body.slice(0, 300));
    }
    return res.ok;
  } catch (err) {
    log('✗', 'failed', err instanceof Error ? err.message : String(err));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n' + '═'.repeat(60));
  console.log('  Easyrent Server Probe — Riml Sports');
  console.log('═'.repeat(60));
  console.log(`  Host:      ${HOST}:${PORT}`);
  console.log(`  REST base: ${REST_BASE}`);
  console.log(`  SOAP URL:  ${SOAP_URL}`);
  console.log(`  Access ID: ${ACCESS_ID.slice(0, 4)}***`);
  console.log('─'.repeat(60) + '\n');

  const results: boolean[] = [];

  // TCP first — if this fails, skip the rest
  const tcpOk = await probeTcp();
  results.push(tcpOk);

  if (!tcpOk) {
    console.log('\n  TCP failed — skipping API probes.');
    console.log('  Possible causes:');
    console.log('    • Server is behind a firewall that blocks external access');
    console.log('    • You need a VPN to reach the server');
    console.log('    • The server is down');
    console.log('    • Ask Kai if they need to whitelist your IP\n');
    process.exit(1);
  }

  console.log();
  results.push(await probeAliveServer());
  console.log();
  results.push(await probeTestAccess());
  console.log();
  console.log('  4. SOAP testmethod... skipped (wseasyrent not deployed on test server)');
  console.log();
  results.push(await probeBranches());
  console.log();
  results.push(await probeReservableArticles());

  // Summary
  const passed = results.filter(Boolean).length;
  console.log('\n' + '─'.repeat(60));
  console.log(`  Results: ${passed}/${results.length} passed (SOAP skipped — not deployed)`);
  console.log('═'.repeat(60) + '\n');

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('[probe] Fatal:', err);
  process.exit(1);
});
