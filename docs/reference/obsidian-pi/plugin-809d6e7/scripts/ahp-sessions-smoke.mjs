/**
 * AHP sessions smoke test (Node 22+ global WebSocket).
 *
 * Mirrors the plugin's new "pi: AHP — open remote session" code path against a
 * live AHP server:
 *   1. connect + initialize (0.3.0)
 *   2. subscribeRoot()  → subscribe ahp-root:// + seed catalogue + live root/* handlers
 *   3. the D3 emitter creates a session the deterministic way
 *      (ahp-session:/pi-<id> + ahp-chat:/pi-<id>) and dispatches a transcript
 *   4. the viewer receives root/sessionAdded  → the session appears in getSessions()
 *      (the data the picker renders); root/activeSessionsChanged bumps the count
 *   5. "select" the session: attach (subscribe to its chat) + dispatch a NEW live
 *      turn, capture the `action` echoes — the exact stream ChatView + AhpActionMapper
 *      render from — and assert they arrive in order
 *
 * Run: node scripts/ahp-sessions-smoke.mjs
 *      AHP_SERVER_URL=ws://localhost:4500 node scripts/ahp-sessions-smoke.mjs
 */

const SERVER_URL = process.env.AHP_SERVER_URL || 'ws://localhost:4500';
const PROTOCOL_VERSION = '0.3.0';
const RESPONSE_TIMEOUT_MS = 30_000;

class SmokeAhpClient {
  constructor(clientId) {
    this.clientId = clientId;
    this.nextId = 1;
    this.nextClientSeq = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = null;
    this.sessions = new Map();
    this.activeSessionCount = undefined;
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      let opened = false;
      this.ws.onopen = () => { opened = true; resolve(); };
      this.ws.onmessage = (event) => this.handleMessage(event.data);
      this.ws.onerror = () => { if (!opened) reject(new Error('WebSocket error')); };
      this.ws.onclose = () => { if (!opened) reject(new Error('WebSocket closed before open')); };
      setTimeout(() => { if (!opened) { this.ws?.close(); reject(new Error('open timeout')); } }, RESPONSE_TIMEOUT_MS);
    });
  }
  close() { this.ws?.close(); }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('WebSocket not open')); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: '${method}'`)); }, RESPONSE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
  notify(method, params) { this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params })); }

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { console.error('[smoke] parse error:', raw); return; }
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(`JSON-RPC ${msg.error.code}: ${msg.error.message}`));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const list = this.handlers.get(msg.method) || [];
      for (const h of list) { try { h(msg.params ?? {}); } catch (err) { console.error('[smoke] handler error:', err); } }
    }
  }

  onNotification(method, handler) { return this._on(method, handler); }
  _on(method, handler) {
    const list = this.handlers.get(method) || [];
    list.push(handler);
    this.handlers.set(method, list);
    return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); };
  }

  initialize(pv, id) { this.clientId = id; return this.request('initialize', { protocolVersions: pv, clientId: id }); }
  createSession(channel) { return this.request('createSession', { channel }); }
  createChat(channel, chat) { return this.request('createChat', { channel, chat }); }
  subscribe(channel) { return this.request('subscribe', { channel }); }
  dispatchAction(channel, action) { const clientSeq = this.nextClientSeq++; this.notify('dispatchAction', { channel, clientSeq, action }); return clientSeq; }

  async subscribeRoot() {
    const snapshot = await this.subscribe('ahp-root://');
    const snap = snapshot ?? {};
    const rootSnap = snap.snapshot ?? snap;
    const state = rootSnap.state ?? {};
    if (Array.isArray(state.sessions)) for (const s of state.sessions) if (s && typeof s.resource === 'string') this.sessions.set(s.resource, s);
    if (typeof state.activeSessions === 'number') this.activeSessionCount = state.activeSessions;
    this._on('root/sessionAdded', (p) => { const s = p.summary; if (s && typeof s.resource === 'string') this.sessions.set(s.resource, s); });
    this._on('root/sessionRemoved', (p) => { if (typeof p.session === 'string') this.sessions.delete(p.session); });
    this._on('action', (p) => { if (p.channel !== 'ahp-root://') return; const a = p.action ?? {}; if (a.type === 'root/activeSessionsChanged' && typeof a.activeSessions === 'number') this.activeSessionCount = a.activeSessions; });
    await this.refreshSessions();
    return snapshot;
  }
  async listSessions(limit = 200) {
    const result = await this.request('listSessions', { channel: 'ahp-root://', limit });
    return Array.isArray(result?.items) ? result.items : [];
  }
  async refreshSessions() { try { for (const s of await this.listSessions()) if (s && typeof s.resource === 'string') this.sessions.set(s.resource, s); } catch { /* listSessions optional on Phase-9 server */ } return this.getSessions(); }
  getSessions() { return Array.from(this.sessions.values()).sort((a, b) => String(b.modifiedAt ?? '').localeCompare(String(a.modifiedAt ?? ''))); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const emitter = new SmokeAhpClient('ahp-sessions-smoke-emitter');
  const viewer = new SmokeAhpClient('ahp-sessions-smoke-viewer');

  console.log(`[smoke] connecting to ${SERVER_URL}`);
  await emitter.connect(SERVER_URL);
  await viewer.connect(SERVER_URL);
  await emitter.initialize([PROTOCOL_VERSION], emitter.clientId);
  await viewer.initialize([PROTOCOL_VERSION], viewer.clientId);

  // D3-style deterministic URIs.
  const id = `smoke-${Date.now()}`;
  const sUri = `ahp-session:/pi-${id}`;
  const cUri = `ahp-chat:/pi-${id}`;
  console.log(`[smoke] target session: ${sUri}`);

  // 2. viewer subscribes to root (the plugin's subscribeRoot path).
  await viewer.subscribeRoot();
  console.log(`[smoke] root subscribed. activeSessions=${viewer.activeSessionCount ?? '?'} baseline sessions=${viewer.getSessions().length}`);

  // Register the sessionAdded waiter BEFORE the emitter creates the session.
  const added = new Promise((resolve) => {
    const u = viewer._on('root/sessionAdded', (p) => {
      if (p.summary?.resource === sUri) { u(); resolve(p.summary); }
    });
  });

  // 3. emitter creates the session the D3 way + dispatches an initial transcript.
  await emitter.createSession(sUri);
  await emitter.createChat(sUri, cUri);
  await emitter.subscribe(sUri);
  await emitter.subscribe(cUri);

  const turnId = `turn-${id}`;
  const partId = `part-${turnId}-text`;
  const dispatch = (a) => emitter.dispatchAction(cUri, a);
  dispatch({ type: 'chat/turnStarted', turnId, message: { text: 'Summarize the repo.', origin: { kind: 'user' }, model: 'demo-model', agent: 'demo-agent' } });
  dispatch({ type: 'chat/delta', turnId, partId, content: 'A thin-client renders a remote AHP session.' });
  dispatch({ type: 'chat/turnComplete', turnId });

  // 4. the viewer discovers the session via root/sessionAdded (picker data).
  const addedSummary = await Promise.race([added, sleep(3000).then(() => null)]);
  if (!addedSummary) throw new Error('root/sessionAdded NOT received by viewer within 3s — discovery failed');
  console.log(`[smoke] ✓ root/sessionAdded received: ${addedSummary.resource} title="${addedSummary.title ?? ''}"`);

  const listed = viewer.getSessions();
  const found = listed.find((s) => s.resource === sUri);
  if (!found) throw new Error(`getSessions() did NOT include the discovered session ${sUri} (got ${listed.length})`);
  console.log(`[smoke] ✓ picker data: getSessions() lists the session (total=${listed.length}, title="${found.title ?? ''}")`);

  // 5. "select" the session: attach (subscribe to its chat) + dispatch a NEW live
  //    turn. Capture the `action` echoes — exactly what ChatView + AhpActionMapper render.
  await viewer.subscribe(sUri);
  await viewer.subscribe(cUri);
  await sleep(100);

  const echoes = [];
  viewer._on('action', (p) => { if (p.channel !== cUri) return; echoes.push(p.action?.type ?? 'unknown'); });

  const liveTurn = `live-${id}`;
  const livePart = `part-${liveTurn}-text`;
  const tc = `tc-${liveTurn}-bash`;
  dispatch({ type: 'chat/turnStarted', turnId: liveTurn, message: { text: 'List files.', origin: { kind: 'user' }, model: 'demo-model', agent: 'demo-agent' } });
  dispatch({ type: 'chat/delta', turnId: liveTurn, partId: livePart, content: 'Here is the tree: ' });
  dispatch({ type: 'chat/delta', turnId: liveTurn, partId: livePart, content: 'src/ docs/.' });
  dispatch({ type: 'chat/toolCallStart', turnId: liveTurn, toolCallId: tc, toolName: 'bash', displayName: 'Run terminal command', intention: 'ls' });
  dispatch({ type: 'chat/toolCallComplete', turnId: liveTurn, toolCallId: tc, toolName: 'bash', result: { success: true, pastTenseMessage: 'Listed files.', content: [{ type: 'text', text: 'main.ts\nREADME.md' }] } });
  dispatch({ type: 'chat/usage', turnId: liveTurn, usage: { inputTokens: 10, outputTokens: 20, model: 'demo-model', cacheReadTokens: 0 } });
  dispatch({ type: 'chat/turnComplete', turnId: liveTurn });

  await sleep(700);

  const expected = ['chat/turnStarted', 'chat/delta', 'chat/delta', 'chat/toolCallStart', 'chat/toolCallComplete', 'chat/usage', 'chat/turnComplete'];
  console.log(`[smoke] live-turn echoes on chat: ${JSON.stringify(echoes)}`);
  const match = echoes.length === expected.length && echoes.every((t, i) => t === expected[i]);
  if (!match) throw new Error(`render-path echo mismatch.\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(echoes)}`);

  emitter.close();
  viewer.close();

  console.log('\n[smoke] --- result ---');
  console.log('root/sessionAdded received : yes');
  console.log(`picker lists session       : yes (total ${listed.length})`);
  console.log(`live render-path echoes    : ${echoes.length}/${expected.length} in order`);
  console.log('[smoke] PASSED');
}

main().then(
  () => process.exit(0),
  (err) => { console.error('[smoke] FAILED:', err instanceof Error ? err.message : String(err)); process.exit(1); },
);