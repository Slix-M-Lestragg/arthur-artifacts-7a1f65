/**
 * Smoke test: connect the bundled AhpClient to the live AHP server,
 * run the full handshake, and dispatch a scripted turn.  Asserts that the
 * echoed actions come back with monotonically increasing serverSeq.
 *
 * Run via:
 *   npx esbuild scripts/ahp-smoke.ts --bundle --platform=node --target=es2018 \
 *     --format=cjs --outfile=scripts/ahp-smoke.cjs
 *   node scripts/ahp-smoke.cjs
 */

import { AhpClient } from '../src/transport/AhpClient';

const SERVER_URL = process.env.AHP_SERVER_URL || 'ws://localhost:4500';

async function run(): Promise<void> {
  const clientId = `obsidian-pi-smoke-${globalThis.crypto.randomUUID()}`;
  const client = new AhpClient(clientId);

  console.log(`[smoke] connecting to ${SERVER_URL} ...`);
  await client.connect(SERVER_URL);

  console.log('[smoke] initialize ...');
  await client.initialize(['0.3.0'], clientId);

  const sessionUri = `ahp-session:/${globalThis.crypto.randomUUID()}`;
  const chatUri = `ahp-chat:/${globalThis.crypto.randomUUID()}`;

  console.log('[smoke] createSession / createChat / subscribe ...');
  await client.createSession(sessionUri);
  await client.createChat(sessionUri, chatUri);
  await client.subscribe(sessionUri);
  await client.subscribe(chatUri);

  const turnId = `turn-smoke-${Date.now()}`;
  const received: Array<{ type: string; serverSeq: number }> = [];

  const unsub = client.onNotification('action', (params) => {
    const envelope = params as { action?: Record<string, unknown>; serverSeq?: number };
    const type = (envelope.action?.type as string) ?? 'unknown';
    received.push({ type, serverSeq: (envelope.serverSeq as number) ?? -1 });
  });

  console.log('[smoke] dispatching chat/turnStarted + chat/delta ...');
  client.dispatchAction(chatUri, {
    type: 'chat/turnStarted',
    turnId,
    message: { text: 'Smoke test turn.', origin: { kind: 'user' } },
  });
  client.dispatchAction(chatUri, {
    type: 'chat/delta',
    turnId,
    partId: `part-${turnId}`,
    content: 'echo',
  });

  await new Promise((r) => setTimeout(r, 600));

  unsub();
  client.close();

  const turnStartedEcho = received.find((r) => r.type === 'chat/turnStarted');
  const deltaEcho = received.find((r) => r.type === 'chat/delta');

  if (!turnStartedEcho) throw new Error('no chat/turnStarted echo received');
  if (!deltaEcho) throw new Error('no chat/delta echo received');
  if (deltaEcho.serverSeq <= turnStartedEcho.serverSeq) {
    throw new Error(`expected delta serverSeq > turnStarted serverSeq, got ${deltaEcho.serverSeq} vs ${turnStartedEcho.serverSeq}`);
  }

  console.log('[smoke] OK — received echoes:', received);
}

run().then(
  () => {
    console.log('[smoke] PASSED');
    process.exit(0);
  },
  (err) => {
    console.error('[smoke] FAILED:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
