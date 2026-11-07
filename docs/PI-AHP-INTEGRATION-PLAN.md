# Arthur + AHP / obsidian-pi integration — research and delivery plan

- **Date**: 2026-11-07
- **Status**: **Phase 0 preserved + Phase 1 slice 1 implemented, mock-tested, and sandbox-validated; Phase 2 PLUGIN side implemented and mock-tested** (roles gate + opt-in controls + exact mutation wire, gate green) — **backend roles work lives on a separate remote broker branch (81 tests passing, since superseded: the roles + command gate landed at broker `b6e26148`, 82 tests, DEPLOYED — see §10c; production roll-out EXECUTED, see §11b)**; **live Phase 2 interactive sandbox EXECUTED (linux-obsidian-73323, see Status snapshot / E15) with one BLOCKER found & FIXED (`createSession` `provider:'pi'`) and the focused live retest of the fixed wrapper PASS (`linux-obsidian-74310`, E17 — UI-created HOSTED pi session, `AHP_PHASE2_CREATE_OK`, pause/resume/dispose, 0 plugin errors, cleanup verified)**; **INLINE dispose confirmation hardening implemented + mock-tested (native `window.confirm` removed, E18) — its final focused live sandbox was ABORTED by the harness and cleaned, so the hardened dispose UI stays mock-tested / NOT live-revalidated**; question_user answering remains mock-only; **production role deployment EXECUTED and COMPLETE (broker `b6e26148` live, all protocol role probes PASS, ALL clients recovered — see §11b + §11c); interactive production UI validation ATTEMPTED — FAILED at hosted create (server-side `spawn /home/ulysse/.local/bin/pi` ENOENT, zero plugin console errors, no session created; repair + retest IN PROGRESS — see §11c); interactive deployment NOT complete**; Phases 3–5 still [PROPOSED]
- **Scope**: planning record + delivery evidence for Phase 0 and Phase 1 slice 1. No canonical `docs/PLAN.md`, manifest, or ROADMAP/TESTING changes.

### Status snapshot (2026-11-07)

- **Phase 0 — DONE.** The broker branch `feature/farm-view-server` was preserved as a new commit
  `17e35fa48e7a25e896c43f2f875949d865ad288e`, synced to origin, and tagged with the
  annotated tag `ahp-0.3.0-arthur-baseline` (tag object `8ee4e2e4…`).
  No broker restart — the running dist was already carrying the state the commit reconstructs.
  The historical audit facts in §2.2 (17 ahead + uncommitted, 72/72 tests) are retained verbatim
  as the **pre-Phase-0 audit snapshot**, not current state.
- **Phase 1 slice 1 — implemented, read-only only, mock-tested.**
  - New files: `src/api/ahp.ts` (read-only `AhpClient` — JSON-RPC WS, `initialize` with exactly
    `protocolVersions: ["0.3.0"]`, fail-closed on mismatch, per-channel `serverSeq` dedupe,
    reconnect cursor, fire-and-forget `unsubscribe`) and `src/ui/ahp-view.ts`
    (read-only catalogue + live chat-detail view).
  - Wiring: `src/main.ts` (view registration + open command + AHP endpoint/token settings),
    `src/ui/dashboard-view.ts` (supplies the open-AHP opts callback), `src/ui/pi-panel.ts`
    (the callback entry point), `styles.css`, and smoke coverage in `scripts/test-bundle.mjs`.
  - Gate green: `npm run typecheck && npm run build && npm run smoke` — the smoke harness now runs
    **851 asserted checks** (incl. the `ahp-catalogue+ws-contract+stable-order+protocol-badge`,
    `ahp-detail-selection+chat-reducers+reconnect+detail-first+close-detail`, and
    `resubscribe-same-session+ab-a-roundtrip+held-reply-races+epoch-watermarks` suites)
    against the mock/local WS; no private host required for CI.
  - Read-only slice-1 controls only: `listSessions` + `subscribe`/`unsubscribe`/`reconnect` + `ping`.
  - Phase 2 (below) layered the CONTROLLED mutation surface on top of this client — every
    mutation is double-gated (plugin setting + broker `controller` role) and never auto-retried.
- **Phase 2 — plugin side IMPLEMENTED, mock-tested; backend roles branch NOT deployed.**
  - `src/api/ahp.ts` gained the controller transport (`roles`/`canControl` from the initialize
    result; `createSession`/`createChat`/`pauseSession`/`resumeSession`/`retryTurn`/
    `disposeSession` as `{channel,…}` REQUESTS; `prompt` as the `dispatchAction` NOTIFICATION
    with the exact `chat/turnStarted {turnId, message:{text, origin:{kind:'user'}}}` payload;
    a LOCAL gate that refuses every mutation without the `controller` role; one-shot sends — no
    automatic retry of any mutation, pending requests REJECT on drop/timeout) — wire shapes
    copied verbatim from the verified broker source, nothing invented.
  - `src/ui/ahp-view.ts` gained the opt-in control UI behind `ahpEnableControl` (default OFF):
    new-session row (cwd + create), per-session pause/resume/retry/+chat/dispose (with an
    INLINE armed confirmation strip — no native dialog), per-primary-chat prompt/Answer rows,
    per-op busy state, and an error line — ALL state rendered from server envelopes only (no
    optimistic mutation state, no stale-UI races; drafts/caret survive live repaints).
  - Gate green: `npm run typecheck && npm run build && npm run smoke` — **989 asserted checks**
    (smoke suites 28/28b/28c read-only preserved untouched + the 28d controller suite: roles
    gating incl. absent/[]/viewer/hostAgent/controller × setting on/off, exact wire shapes for
    every mutation (28d now asserts the FIXED hosted-create payload — `createSession` exactly
    `{channel, provider: 'pi', workingDirectory}` — against the relay-vs-hosted mock model),
    zero-mutation viewer epochs, busy duplicate-submit protection, the INLINE dispose
    arm/cancel/confirm flow + late-reply/new-selection race + `root/sessionRemoved` detail
    release regression, and drop/reconnect NEVER resending any mutation, token only ever in
    `initialize.params`). No private host required for CI.
  - **Backend (broker) roles branch**: implemented on a separate remote broker branch with
    **81 broker tests passing** — NOT deployed to the running broker, NOT merged to the broker
    baseline. Until it deploys, `initialize` answers carry no roles and the plugin surface
    stays read-only regardless of the setting (fail-safe both ways). The branch's exact
    role-token env names are now **VERIFIED** (see the Phase 2 section below).
  - **Live Phase 2 interactive sandbox — PASS with one blocker found (2026-11-07,
    `linux-obsidian-73323`).** Disposable agent-os Linux-Obsidian instance against the live
    roles-broker, then deleted (everyday vault untouched; /tmp cleanup paths and the broker's
    :4500 state untouched afterward). Results: a viewer token's mutations rejected with the
    broker's `-32008` forbidden error; a controller token surfaced the full control affordances
    and exercised: pause/resume (envelope-driven button flips), ONE prompt (`AHP_PHASE2_OK`
    visible in the hosted session's transcript), retry, second chat (createChat), and dispose —
    all state moving only on server envelopes; **0 plugin-caused console errors**. The
    question_user answer path was NOT exercised live (no pending question arose) — it remains
    mock-only. **BLOCKER found**: the `createSession` wrapper sent `{channel, workingDirectory}`
    WITHOUT `provider`, so the broker defaulted to `pi-ahp-server` and created an EMPTY RELAY
    session instead of a hosted interactive pi one.
  - **BLOCKER fixed (createSession `provider:'pi'`) — mock-tested; focused live retest PASS.**
    `src/api/ahp.ts` `createSession` now sends exactly `{channel, provider: 'pi',
    workingDirectory}` (the ONLY hosted interactive backend the broker knows; anything else —
    including the omitted default — is an empty relay, verified in the broker's
    `handleCreateSession`). The smoke model broker now distinguishes RELAY vs HOSTED by the sent
    provider (only `provider === 'pi'` registers `kind: 'hosted'`; anything else projects
    `kind: 'relay'` + provider `pi-ahp-server`), and suite 28d asserts the exact payload keys
    `{channel, provider, workingDirectory}`, `provider === 'pi'`, and the created card's
    `kind: 'hosted'` — the pre-fix build fails these. **Focused LIVE retest of the fixed
    create wrapper: PASS (2026-11-07, `linux-obsidian-74310`, E17)** — the UI-created session
    materialized as a HOSTED interactive pi one (`AHP_PHASE2_CREATE_OK`), pause/resume/dispose
    exercised live, 0 plugin-caused console errors, cleanup verified.
  - **Focused provider:'pi' live sandbox — PASS (2026-11-07, `linux-obsidian-74310`).**
    Disposable agent-os Linux-Obsidian instance against the live roles broker with the fixed
    wrapper, then deleted (everyday vault untouched; broker :4500 state and cleanup paths
    untouched). Results: a UI-hosted session created through the plugin's new-session control
    (`provider:'pi'`) rendered as a real hosted interactive pi session (`AHP_PHASE2_CREATE_OK`
    in its transcript), pause/resume and dispose exercised live, **0 plugin-caused console
    errors**, and the sandbox cleanup verified. (E17)
  - **INLINE dispose confirmation hardening (native-dialog wedge fix, 2026-11-07).** The
    `linux-obsidian-74310` focused run surfaced ONE wedge: disposing through the NATIVE
    `window.confirm` dialog left the renderer blocked while the server deleted the session —
    with the catalogue gone, the STALE selected detail remained (a relaunch was needed once).
    Fixed defensively + simply: the dispose confirmation is now an INLINE plain-DOM strip in
    the selected detail — first `dispose…` click ARMS it (a warning naming the session + an
    explicit `confirm dispose` / `cancel` pair; no native dialog anywhere); `confirm dispose`
    sends exactly ONE `disposeSession` (busy-disabled duplicates; pending state), `cancel`
    leaves the session/selection untouched. On the successful response the arm is cleared,
    the disposed session's selection/detail is released immediately, and the catalogue
    reloads authoritatively (the row itself still disappears only on the server's
    `root/sessionRemoved` envelope — which NOW ALSO releases a matching selected detail on
    its own, even when the dispose reply is late; a LATE reply can never clear a NEW
    selection — only the session actually disposed is released). Errors restore a safe
    state: the arm resets and the error line reports. Mock-tested in suite 28d
    ((ac) inline arm/cancel/confirm + sessionRemoved detail-release regression; (ac2)
    late-reply/new-selection race) — gate green, **989 asserted checks**. The FINAL focused
    live sandbox covering the hardened dispose flow was ABORTED by the harness and its
    (temporary) sandbox cleaned — the hardened INLINE dispose UI is mock-tested and
    NOT live-revalidated (the E17 live dispose evidence predates the hardening that
    the native-dialog wedge motivated).
  - **Cosmetic fixes (same pass)**: the tofu-prone control glyphs (＋ / ⏸ / ▸ / ↺ / ● / ✓ / ✕ / ❓/ ⚠) across the AHP control surface, selected-card marker, pending-question banner,
    turn-state and tool-call lines, and the settings warning were replaced with plain readable
    text (the CSS classes unchanged); the chat detail meta line no longer renders a raw
    `status 1` — it derives a state label from the LIVE fields first (pending question_user →
    "needs input", activeTurn → "running"), then from the VERIFIED broker status bitmask
    (`getSessionStatusLabel`, pi-ahp-server `src/types.ts` — copied verbatim, no guessed
    numeric map).
  - **Final focused sandbox revalidation of the hardened INLINE dispose flow — ABORTED, not
    done**: the attempt was aborted by the harness and the temporary sandbox cleaned; the
    hardened arm/cancel/confirm/dispose flow has never been exercised live. Re-run after
    the roles deployment, exercising arm/cancel/confirm/dispose end-to-end live.
- **Sandbox validation — PASS (2026-11-07).** The current uncommitted build was exercised end-to-end
  in a disposable Linux-Obsidian instance (`arthur-ahp-slice1-test`, agent-os), then the instance
  was deleted; the everyday vault was untouched and the build artifacts were MD5-verified after
  transfer. Against the live broker `100.75.249.5:4500` (blank token): the open command launched
  the view, Refresh moved it to live, the real catalogue rendered, two session selections rendered
  detail, and a close/reopen exercised the socket sequence 1→0→1 — zero console errors, no control
  RPC. Evidence screenshots under `/tmp/agent-os-shots/arthur-ahp-slice1-test-*.png`
  (especially `…3958975-19.png` — session detail; `…4084044-30.png` — reopen, see E12).
  Slice 1 is **sandbox-validated**. Every follow-up item surfaced here (§10b `ahp-ux-1…4` +
  the `ahp-resub-1` blocker) was then fixed, code+smoke-tested, and re-validated in the
  final focused revalidation below.
- **Final focused sandbox revalidation — PASS (2026-11-07, `linux-obsidian-70047`).** The current
  production build (root `main.js` md5 `6ecc318489a79ababbb0b88f8a60711b`; the build is
  deterministic) ran in a second disposable agent-os Linux-Obsidian instance against the live
  broker `100.75.249.5:4500`; the instance was deleted afterwards and the everyday vault was
  untouched. All re-subscribe flows exercised: **close→same-session reselect twice PASS**;
  **A→B→A and a third switch PASS** — no hang on «subscribing chat detail…», each epoch
  re-requested session + child chats cleanly (`ahp-resub-1` resolved, see §10b/E13). The
  implemented UX items verified live: **detail-first layout**, protocol badge **`live · 0.3.0`,
  stable catalogue order**, and the **selected-row styling** all PASS. **No plugin-caused
  console errors** — two sandbox-only `@electron/remote` “AppImage temp dir” exceptions are
  excluded with reason (agent-os AppImage environment noise, unrelated to plugin code).
  Screenshots: `/tmp/agent-os-shots/linux-obsidian-70047-*.png` (especially
  `linux-obsidian-70047-1794070424037-30.png` — same-session reselect;
  `linux-obsidian-70047-1794070960456-55.png` — A→B→A).
  - **Intentional caps** (scale/DOM bound, per-plan): chat history truncated to
    `MAX_CHAT_TURNS = 30` completed turns and `MAX_PART_CHARS = 2000` chars per part (api),
    at most `MAX_DETAIL_CHAT_SUBS = 20` chat subscriptions for a selected session,
    at most `MAX_LIST_PAGES = 500` catalogue pages; view renders at most `MAX_CARDS = 50`
    catalogue cards, `MAX_CHAT_SECTIONS = 10` chat sections, and `MAX_PARTS_PER_TURN = 24`
    parts per turn. Deliberate: the ~1.3 GB store is retention motivation only.
- **Optional manual live probe — PASS.** Non-mutating probe from arthur to `ws://100.75.249.5:4500`:
  WebSocket connected; `initialize` with `protocolVersions: ["0.3.0"]` and **no token** was
  accepted with result `protocolVersion: "0.3.0"` (so the broker currently runs with tokens
  optional — §2.2 note unchanged, §6 still applies); `listSessions` on `ahp-root://` with
  `limit: 1` returned a page of 1 item; the socket closed cleanly. Metadata only — no
  prompt/chat content read or printed, no create/control RPC.
- **Phases 2 backend + live interactive validation and Phases 3–5 remain open** — the Phase 2
  status above touches ONLY the plugin; arthur-agent, the 0.4 line, and the running broker
  deploy are untouched.

This plan describes how the **arthur** Obsidian plugin could integrate with the
**AHP broker** (pi-ahp-server on ulysse) for remote pi session visibility and —
later, behind a security gate — interaction. All source facts are from verified
checkouts and running services listed in the [evidence appendix](#appendix-evidence).
Conventions used below:

- **[VERIFIED]** — observed directly in a checkout, running service, or code.
- **[PROPOSED]** — a planned endpoint, setting, file, or behavior that does not exist yet.
- **[RULE]** — an invariant this plan commits to.
- **[DECISION]** — a settled choice recorded here, revisitable via the listed ADRs.
- **[FACT]** — a protocol/platform behavior relied on (not an implementation claim).
- **[TODO]** — an open review item for a later phase.
- Anything unlabelled in a phase title is an activity (research/test/doc), not an artifact claim.

---

## 1. Executive summary

A mature legacy Obsidian plugin (**obsidian-pi**, v0.4.0, plugin-release
`d182c1d`) already talks to the AHP broker over a plain WebSocket with
JSON-RPC-ish method calls. It demonstrates the right transport shape
(global WS + JSON-RPC + reconnect cursor + pure action mapping) but carries
Obsidian-coupled and heavyweight modules we should not port. The AHP broker on
ulysse:4500 is running protocol **0.3.0** [VERIFIED] and is the only
integration target; the separate server on :4501 is protocol 0.4.0 and
**incompatible** [VERIFIED].

Recommended shape: **direct plugin→AHP** integration, delivered as a
**read-only vertical slice first** (Phase 1), followed by broker-side
security/authorization work before any mutating interaction is enabled
(Phase 2). The arthur-agent (:8766) gateway is an evaluation
item, not an assumption (Phase 3). No phases modify arthur-agent before Phase 3.

---

## 2. Verified sources

### 2.1 Legacy plugin — obsidian-pi

- Private GitHub `Slix-M-Lestragg/pi-ecosystem` [VERIFIED].
- Vault plugin path (Voyager / mac.home): exactly
  `/Users/benjaminmatthys/Documents/Vaults/00-In_Dev/🚧 RnD-pi_Agent_sdk/.obsidian/plugins/obsidian-pi` [VERIFIED].
- Branch `plugin-release` at `d182c1d`, built from source branch `plugin`
  `809d6e7`; local and GitHub ahead/behind counts 0/0; v0.4.0 [VERIFIED].
- Exactly **25 `addCommand` calls** at source `809d6e7`: AHP remote chat, farm,
  terminal, swarm, vault/note features [VERIFIED].
- **Best reusable modules** (port-with-provenance, trimmed):
  - `src/transport/AhpClient.ts` — global WebSocket JSON-RPC client with
    reconnect + reconnect cursor. Remove its Obsidian `Notice` coupling
    (return errors; let the UI layer display them) [VERIFIED, modification noted].
    **This file does not exist in the current arthur tree** — it lives in the
    external pi-ecosystem checkout (E1) and is copied/adapted into a **new**
    `src/api/ahp.ts` in Phase 1, with its imports and `Notice` coupling
    audited during the port.
  - `AhpActionMapper.ts` — pure mapping logic [VERIFIED].
  - `JsonlCodec.ts` [VERIFIED].
  - `types/rpc.ts` [VERIFIED].
  - Fuzzy/session picker UX ideas [VERIFIED].
- **Do NOT port initially**: local PTY / `node-pty`, `InstanceManager`,
  `VaultContext`, `sessionFiles`, menubar, `sharp` / `xterm` [DECISION].
  `AhpTerminalAdapter` only after an explicit xterm dependency decision
  (see Phase 4).
- **Security facts**: plugin token is plaintext in `data.json`; WS is plaintext
  inside the tailnet; auth uses `initialize.params.token` — **not** headers,
  subprotocol, or query [VERIFIED]. No claims that settings are encrypted [VERIFIED].

### 2.2 AHP broker — ulysse:4500 (canonical 0.3.0 target)

- Host `ulysse` at `100.75.249.5:4500`, systemd user unit
  `pi-ahp-broker.service`, working dir
  `/home/ulysse/RnD/AHP/pi-ahp-server-farm-view-wt`, branch
  `feature/farm-view-server` at `af39086e` — 17 commits ahead of origin plus
  uncommitted tested changes [VERIFIED]. The **running dist includes the
  uncommitted changes**; the audit ran compiled tests, **72/72 pass** [VERIFIED].
- Protocol exactly **0.3.0** [VERIFIED by remote source]: the legacy
  `AhpClient` `initialize` negotiation (~L561–574 of E1's
  `src/transport/AhpClient.ts`) sends `protocolVersions: ["0.3.0"]`, and the
  server's `SUPPORTED_VERSION` (E2 checkout) pins 0.3.0.
- Existing JSON-RPC methods [VERIFIED — these are real names; response shapes
  are NOT reproduced here, copy TS types from source instead]:
  - Session/chat lifecycle: `initialize`, `ping`, `subscribe`, `unsubscribe`,
    `reconnect`, `listSessions`, `listArchives`, `createSession`,
    `disposeSession`, `createChat`, `pauseSession`, `resumeSession`,
    `retryTurn`, `setSessionStatus`, `setSessionPriority`,
    `setProviderCaps`, `setAutoCullConfig`. Of these, `unsubscribe` is a
    JSON-RPC **notification** (no id, no response) in the legacy client —
    send it fire-and-forget and never await a reply; every other method
    listed here is a request/response call [VERIFIED — E1 client].
  - Resources: `resourceRead`, `resourceList`, `resourceResolve`,
    `resourceWrite` (**stub** [VERIFIED]).
  - Events/dispatch: `dispatchAction`.
  - `hostAgent.*`: `register`, `syncInstances`, `updateInstance`, `heartbeat`,
    `unregister`, `terminalData`, `terminalResized`, `terminalExited`.
    **No `hostAgent.start` / `hostAgent.stop`** [VERIFIED].
- `ActionEnvelope` carries `channel`, `serverSeq`, `origin clientId` +
  `clientSeq`, `action`, `rejectionReason` [VERIFIED]. Dedupe is
  **per-channel `serverSeq`**: `AhpClient` tracks the last observed
  `serverSeq` per channel and skips any envelope with
  `serverSeq <= previous`; the reconnect request carries the
  `lastSeenServerSeq` cursor for gap-free replay. `origin.clientSeq`
  identifies client-originated actions only — it is **not** a dedupe
  mechanism [VERIFIED].
- Features present: multi-chat / subagent, `summary.chats`,
  `question_user` surfacing to clients [VERIFIED].
- Optional shared token used by `initialize` and `register`; **no role
  separation, no app-layer TLS** [VERIFIED].
- Store: ~1.3 GB verified. The earlier 4572 figure was a **drifting** count of
  `.json` + `.jsonl` **files** (per-session pairs), not a stable pair count; a
  later spot-check saw ~4586 files (~2290 `.json` + ~2296 `.jsonl`). Summarize
  it as "~1.3 GB; thousands of drifting per-session .json/.jsonl files" —
  scale/retention motivation only, **never** an expected `listSessions` count.
  Do not assume all sessions are active; never load-all by default.
- Known stable-but-uncommitted items: extension URI cache; empty-relay
  auto-dispose/prune; `summary.chats`. Known gaps: `resourceWrite` stub,
  `listArchives` lacks tests, brittle "New session emptiness" handling,
  sync-cache writes [VERIFIED].

### 2.3 AHP-server :4501 — NOT a target

Separate checkout `/home/ulysse/RnD/AHP-server`, protocol **0.4.0**
monorepo/spec [VERIFIED]. Incompatible with 0.3.0; no farm/hostAgent surface.
**Not a drop-in replacement** — convergence is a future ADR (Phase 5) [DECISION].

### 2.4 Arthur today

- Plugin v0.13.4 [VERIFIED]; arthur-agent v0.8.1, single-file Python stdlib,
  port 8766, Bearer-authenticated [VERIFIED].
- **Today's plugin settings live in `src/main.ts`** — `ArthurSettings`
  interface (~L55), `DEFAULT_SETTINGS`, and the `ArthurSettingTab`
  (~L204). There is **no** `src/settings.ts` in the arthur tree [VERIFIED].
- arthur-agent's pi-sync API surface is read-mostly (`/api/pi/status`,
  `/api/pi/devices`, dirs, tail, spawn) — **no AHP proxy** [VERIFIED].
- pi-sync pipe contract `status/<Device>.sessions.json` is a **separate data
  source** from AHP; keep it unchanged, and **never use pi-sync `tail` as AHP
  detail/history** [RULE].
- Files arthur will likely touch later [PROPOSED target files — none exist
  except where noted]:
  - `src/api/ahp.ts` — **new** (copy/adapt of the legacy E1
    `src/transport/AhpClient.ts`; that file does not exist in arthur today)
    [PROPOSED]
  - `src/main.ts` — extend: today's settings (`ArthurSettings` /
    `ArthurSettingTab`) live here, plus the new AHP view registration + open
    command [PROPOSED change — no extraction for slice 1; any later
    extraction must be a new, explicitly labelled module]
  - `src/ui/ahp-view.ts` — **new** view for rich chat [PROPOSED]
  - `src/ui/pi-panel.ts` — small existing-file entry point into the new view
    (an optional open-AHP callback on `PiPanel`'s existing opts-callback
    contract) [PROPOSED change]
  - `src/ui/dashboard-view.ts` — wiring only: it constructs `PiPanel` and
    supplies the callback [PROPOSED change]
  - `scripts/test-bundle.mjs` — smoke coverage for the new slice (view
    registration/open/close + WS cleanup) [PROPOSED change]
- Constraints already binding: plain DOM, no React, no new npm deps, global
  WebSocket, everything registered cleaned up in `onUnload`, re-poll after
  mutation (never optimistic state) [VERIFIED conventions].
- Backend docs / version / API types evolve together [RULE]. Test gate:
  `npm run typecheck && npm run build && npm run smoke` [VERIFIED script names].

---

## 3. Architecture options

| Option | Summary | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Direct plugin→AHP** | Plugin's WS client connects to `100.75.249.5:4500` using the `initialize.params.token` contract | True to the legacy proven shape; no Python changes; fastest to a validated slice | AHP token lives in vault settings (plaintext data.json); broker lacks role separation today | **Chosen for Phases 1–2** |
| **B. arthur-agent WS reverse proxy** | Python stdlib WS proxy on 8766 fronting AHP; browser WS can't set Bearer → proposed one-time ticket flow | AHP credential stays off the vault; single authenticated surface; fits existing Bearer model | Real proxy complexity: backpressure, reconnect/cursor passthrough, deploy, maintenance; stdlib WS in Python is nontrivial | **Phase 3 evaluation/ADR only** |
| **C. Separate TS gateway** | New TS service speaking both sides | Typed end-to-end; reuses ported TS client concepts | New deployable unit on arthur; duplicates what B would do; more moving parts than A | Not planned |

Why direct first: it validates the protocol contract with the least new
machinery, and everything the gateway would need (typed client, contract
tests, settings) is the same code path. A proxy later is a transport swap
behind `src/api/ahp.ts`, not a redesign.

---

## 4. Phases

### Phase 0 — Preserve the running 0.3.0 source of truth [no plugin code] — DONE

**Outcome (2026-11-07):** steps 1–2 executed as one commit
`17e35fa48e7a25e896c43f2f875949d865ad288e` on `feature/farm-view-server` (the running dist's
reconstruction point), synced to origin, and tagged
`ahp-0.3.0-arthur-baseline` (annotated; tag object `8ee4e2e4…`). The broker was **not restarted**
[RULE kept]. Step 3 (§2 doc coverage) is this doc; the regression tests — including `listArchives`
coverage — are part of the committed record; the §2.2 audit lines remain the historical
pre-Phase-0 snapshot. Steps 6–7 stood.

Original list:

1. REVIEW the 17 unpushed commits on `feature/farm-view-server` plus the
   uncommitted diff; commit everything, **including untracked regression
   tests**. The running dist already includes the uncommitted changes, so the
   deployed artifact must be reconstructible from the branch.
2. PUSH the private branch; tag only after review.
3. DOCUMENT that :4500 is canonical protocol 0.3 and :4501 is a separate 0.4
   line (already reflected in §2).
4. ADD `listArchives` tests (a verified test gap).
5. BACKUP the ~1.3 GB store (thousands of drifting per-session .json/.jsonl
   files) and define a retention policy before any cleanup work.
6. **Do not restart the service as part of research** [RULE].
7. Going forward, record the deployed commit in service/deploy docs [RULE].

### Phase 1 — Read-only direct slice (first arthur code) — **slice 1 IMPLEMENTED, mock-tested, sandbox-validated; rest of the phase still [PROPOSED]**

Goal: faithful catalogue + live chat/activity visibility, zero mutating calls.

**Delivered as slice 1:** everything in the **Status snapshot** above — client, view, wiring,
settings, smoke gate (851 asserted checks, all green), read-only controls only, and the caps
called out there. The subsections below are kept as the design record; items marked [PROPOSED]
remain [PROPOSED] until landed. Phase 1 beyond slice 1 is still [PROPOSED].

- **Settings [PROPOSED]**: AHP endpoint (default `100.75.249.5:4500`) + token,
  added to today's settings in **`src/main.ts`** (`ArthurSettings` /
  `ArthurSettingTab` — there is no separate `src/settings.ts`), clearly named
  and marked as broker credential. No settings extraction for slice 1; a
  later extraction must be a new, explicitly [PROPOSED] module.
- **Wiring [PROPOSED — concrete, callback flow; names chosen against the real
  signatures at implementation, not invented here]**:
  1. `src/main.ts` registers the AHP view via `registerView` (the same
     pattern already used for `VIEW_TYPE_ARTHUR_DASHBOARD`) plus a workspace
     `addCommand` that opens it.
  2. `src/ui/pi-panel.ts` gains a small open-AHP action on `PiPanel`'s
     opts-callback contract — an additional optional callback next to the
     existing `fetchTail` / `archivesCollapsed` / `setArchivesCollapsed`
     entries in `PiPanelOpts`.
  3. `src/ui/dashboard-view.ts` (which constructs `PiPanel` with that opts
     bag) supplies the callback, bridging to the plugin's open-AHP
     command/view-activation path in `src/main.ts`.
  Flow: AHP panel button → `PiPanel` opts callback → `dashboard-view`
  handler → `main.ts` open-command / view activation → new
  `src/ui/ahp-view.ts` (rich chat view).
- **Client [PROPOSED new file `src/api/ahp.ts`]**: explicitly **copied/adapted
  from the external pi-ecosystem checkout's `src/transport/AhpClient.ts`** (E1)
  — that file is not part of the current arthur tree; its imports and the
  removed `Notice` coupling are audited during the port — keeping the proven
  shape: global WebSocket, JSON-RPC framing, per-channel `serverSeq` dedupe,
  reconnect cursor, no `Notice` coupling. Send exactly
  `protocolVersions: ["0.3.0"]` in `initialize`; **fail closed** (surface
  error, no degraded read mode) on protocol mismatch.
- **Read surface**: `listSessions` + `subscribe`/`unsubscribe`/`reconnect`
  snapshot and action-envelope streaming; session catalogue and chat/activity
  detail including subagent rows, token/context, status, and pending
  `question_user` rendering (display only). `unsubscribe` is a **notification**
  (no id/response): the client sends it during teardown without awaiting any
  response; socket close/disconnect teardown is the fallback for cleanup paths
  that never get a reply [VERIFIED — E1 client].
- **Correctness**: per-channel `serverSeq` dedupe (track last observed
  `serverSeq`, skip `serverSeq <= previous`) and the `reconnect` cursor
  (`lastSeenServerSeq`) for gap-free replay; full cleanup in `onUnload`
  (WS close, subscription teardown without waiting on the `unsubscribe`
  notification).
- **Scale**: render incrementally and cap DOM size; the ~1.3 GB store of
  thousands of drifting per-session .json/.jsonl files is retention
  motivation only — never assume all sessions are active and never require
  loading all.
- **Testing**: mock-WS contract + reducer + reconnect tests (fully automated —
  no private host required); extend `scripts/test-bundle.mjs` `smoke` with
  explicit coverage of the AHP view registration/open/close and WS cleanup.
  An **optional, manual-only** non-mutating live probe against ulysse:4500
  may be run when reachable, but is never a CI requirement and never blocks
  acceptance.
- **Honesty rule**: read-only UI is not a security boundary [RULE]. Also: WS
  is not subject to CORS in the browser sense — don't rely on browser-origin
  protections; the broker token is the only gate [FACT].

**Not in the first slice** (explicit): no `createSession`/spawn/control, no
archive terminal, no vault/note context, no swarm, no arthur-agent changes,
no 0.4 work.

### Phase 2 — Broker security & opt-in interaction — **plugin side IMPLEMENTED + mock-tested; broker roles branch IMPLEMENTED (81 tests) but NOT deployed**

Goal: mutating RPCs become safe to expose. **Server-side work on the AHP broker, not the plugin**, landed
first on the backend branch — but is **NOT deployed**; the plugin half is implemented and mock-tested below.

1. **Broker roles — implemented on a separate remote broker branch (81 tests passing), NOT deployed.**
   `viewer` / `controller` / `hostAgent` credentials with **server-side authorization of mutating
   RPCs** (`controller` required for any mutation; server error code `-32008`). The token mechanism
   stays `initialize.params.token` (multi-role tokens reuse the same param).
   - **Backend env contract — VERIFIED** (2026-11-07, on the roles checkout): the role tokens are
     configured via exactly `AHP_VIEWER_TOKEN` / `AHP_CONTROLLER_TOKEN` / `AHP_HOST_AGENT_TOKEN`.
     Token VALUES are never recorded in this repo or here.
2. **Plugin interactions — IMPLEMENTED + mock-tested, gated behind plugin setting
   `ahpEnableControl = false` by default** (stored in vault data.json; both gates AND'd):
   - **Gate (fail-safe both ways)**: controls render only when the plugin setting is ON **AND** the
     live connection's negotiated `initialize` result grants the `controller` role
     (`canControl === true`). A roles-field-ABSENT or `roles: []` (legacy/anonymous) answer, a
     `hostAgent`-only or `viewer`-only grant, and ANY non-controller state render NO controls — and
     the local gate refuses every mutation call BEFORE a frame leaves (a viewer connection can
     never spray mutations the broker merely ignores). A later connection downgrade (refresh)
     removes the controls again.
   - **Mutation wire (as implemented, verbatim 0.3.0 shapes)**:
     - `createSession` REQUEST `{channel, provider: 'pi', workingDirectory}` — `channel` is minted
       client-side (`ahp-session:/arthur-…`) and **`provider: 'pi'` is ALWAYS sent**: the broker
       DEFAULTS the provider to `pi-ahp-server`, which would create an empty RELAY session instead
       of the hosted interactive pi session (live-sandbox-confirmed, fixed; the mock broker now
       models the relay-vs-hosted split and 28d asserts it). Reply `null`; the view then reloads
       the catalogue AUTHORITATIVELY (fresh paged `listSessions`) and auto-selects the session
       only once the catalogue contains it.
     - `createChat` REQUEST `{channel, chat}` — client-minted `ahp-chat:/arthur-…`; the new chat
       renders only via the server's `session/chatAdded` envelope (no optimistic row).
     - `prompt` — the `dispatchAction` NOTIFICATION `{channel, clientSeq, action}`, action
       `{type:'chat/turnStarted', turnId, message:{text, origin:{kind:'user'}}}`; `clientSeq`
       monotonic per client+channel; `turnId` unique per send; NO invented question RPC — the
       pending `question_user` toolCall flips the chat row into Answer mode and answers ride the
       same prompt notification.
     - `pauseSession`/`resumeSession`/`retryTurn`/`disposeSession {channel}` REQUESTS resolving
       `null`; the button state follows the `root/sessionSummaryChanged {paused}` envelope, never
       an optimistic flip.
     - **No automatic retry of non-idempotent RPCs** [RULE — enforced]: prompts/mutations are sent
       exactly once; a drop/timeout REJECTS the pending request into the view's error line and
       reconnect NEVER re-sends create/prompt/dispose — the read-only reconnect cursor carries only
       subscriptions + watermarks. Smoke suite 28d holds a reply, drops the socket, reconnects, and
       asserts one frame ever + the rejection surfaced without token leakage.
   - **Safety**: all control text renders via `textContent` (server strings can never become HTML);
     errors are capped-truncated and never include the token (asserted for every wire frame and
     every error line); `dispose` arms an INLINE plain-DOM confirmation strip in the selected
     detail — a warning naming the session + explicit `confirm dispose`/`cancel` buttons, NO
     native `window.confirm` anywhere in the flow.
3. **Tests — IMPLEMENTED** (smoke suite 28d on the extended model broker; read-only suites 28/28b/28c
   preserved untouched): role denial (viewer/anonymous/hostAgent × setting on/off, ZERO mutation
   frames), exact wire shapes for every mutation, duplicate-submit protection while pending,
   create→authoritative-reload→select, prompt/Answer + clientSeq monotonicity + unique turnIds,
   dispose cancel/confirm, and `reconnect` never duplicating prompts/dispose.
  - **Live interactive sandbox for Phase 2** — EXECUTED (2026-11-07, `linux-obsidian-73323`):
    role gating live (viewer → `-32008`), controller controls + prompts + pause/resume + retry +
    createChat + dispose all PASS, 0 plugin console errors. RESIDUE: the fixed
    `provider:'pi'` create wrapper needs one focused live retest; the question_user answer path
    remains mock-only (never live-exercised).
5. `hostAgent.*` is **not used** for normal session controls [RULE].

### Phase 3 — arthur-agent gateway: evaluation, not automatic implementation — **still [PROPOSED]**

A bounded **spike + ADR** comparing (A) keep-direct vs (B) Python stdlib WS
reverse proxy in arthur-agent vs (C) separate TS gateway, against fixed
criteria: auth (incl. that a browser WS cannot set a Bearer header → if a
proxy is chosen, arthur-agent would expose a **proposed** authenticated
`POST /api/ahp/ticket` issuing a one-time, short-lived ticket that is *not*
the AHP token and must never be logged), backpressure, reconnect/cursor
semantics passthrough, deployment, and maintenance cost.

- **Phases 1–2 explicitly do not modify arthur-agent** [RULE]. Any meaningful
  backend work before Phase 3 happens on the AHP broker.
- No fake proxy code or file paths in the Python service until the ADR passes.
- Only after an ADR decision: add versioned `/api/ahp/*` endpoints
  [PROPOSED], a typed plugin client path, settings, docs, and tests — and
  **preserve direct mode** during migration.

### Phase 4 — Optional feature waves (each independent, no big-bang parity) — **still [PROPOSED]**

Only after Phase 1 validation (and Phase 2/3 for anything mutating):

- **Archive browsing**: `listArchives` metadata first. There is **no
  `archiveGet`** in the running protocol [VERIFIED] — do not code against a
  nonexistent method.
- **Terminal / hostAgent relay**: requires the explicit xterm dependency
  decision (`AhpTerminalAdapter`); also re-evaluate whether `hostAgent`
  terminalData relay fits the role model from Phase 2.
- **Vault/note context**, **swarm**: separate waves behind their own gates.

### Phase 5 — 0.4 convergence (future ADR) — **still [PROPOSED]**

Either port farm/hostAgent/question/relay features forward into the
`@ahp/spec` 0.4 monorepo, or keep 0.3 temporarily. **No dual-stack default**;
if bridging is ever needed, isolate it in the protocol adapter layer.

---

## 5. Data contract notes

- Real method names are listed in §2.2 [VERIFIED]. **Do not fabricate JSON
  response shapes in this doc or in code/test mocks from imagination** — copy
  the exact TS types out of `pi-ecosystem` `types/rpc.ts` (and the server's
  own schema) with a provenance comment, then pin behavior with contract
  tests against the mock WS harness.
- Transport facts that are load-bearing and must not be reinvented:
  `initialize.params.token` auth; `protocolVersions ["0.3.0"]` (double-checked
  against the remote sources — E1 client initialize negotiation ~L561–574 and
  E2 server `SUPPORTED_VERSION`); **per-channel `serverSeq` dedupe** (client
  tracks the last observed `serverSeq` and skips `serverSeq <= previous`) plus
  the reconnect cursor (`lastSeenServerSeq`) for gap-free replay;
  `origin.clientSeq` merely tags client-originated actions and is not a dedupe
  key; `unsubscribe` is a notification (no id/response) — never await it.

## 6. Security notes

- Tailnet ACL / broker bind-address review before any non-local exposure [TODO].
- Plaintext token in vault `data.json` and plaintext tailnet WS are existing
  realities — **warn in docs**, don't claim encryption that doesn't exist.
- No tokens in logs, URLs, or error messages (plugin and probe scripts alike).
- Phase 2 authorization must be enforced **server-side**; plugin-side
  gating (`enableControl`) is UX, not security.
- Least privilege: viewer tokens default; controller tokens opt-in per client.
- A Phase 3 proxy, if adopted, lets the vault hold only the arthur-agent
  Bearer token, keeping the AHP credential off client devices.

## 7. Legacy cleanup / hygiene

- Commit + push the broker server state (Phase 0), with store backup and
  retention policy before cleanup.
- Move the legacy plugin source checkout out of the vault eventually
  (vaults are sync/backup surfaces; source shouldn't live in `.obsidian/`).
- Review inline sourcemaps and release hygiene of the legacy builds.
- Don't port local PTY/vault/menubar [DECISION]; don't deprecate
  obsidian-pi until arthur reaches real parity for the waves it replaces.

## 8. Risks & open decisions

- **R1** — Broker 17 commits + uncommitted changes unreviewed/unpushed
  (mitigated by Phase 0 first).
- **R2** — Protocol drift if the broker evolves before arthur ships
  (mitigated by fail-closed version check + contract tests).
- **R3** — Token exposure via vault sync (mitigated by §6; open: whether to
  gate Phase 1 behind the Phase 3 ticket flow instead of settings token).
- **R4** — Store scale/retention before any pruning (Phase 0 backups).
- **Open decision D1** — gateway ADR criteria finalization (Phase 3).
- **Open decision D2** — xterm dependency for terminal wave (Phase 4).
- **Open decision D3** — whether Phase 1 ships alongside or after Phase 2's
  role model if broker security work moves fast.

## 9. Immediate next actions

1. ~~**Review/preserve**~~ — DONE (Phase 0 commit `17e35fa4…`, tag `ahp-0.3.0-arthur-baseline`).
2. ~~Approve + build the direct read-only slice~~ — DONE as **slice 1** (implemented,
   mock-tested, gate green, live probe pass).
3. ~~Extract the `contract`~~ — DONE (mock WS harness + provenance types are part of the landed
   `src/api/ahp.ts` + smoke suites).
4. ~~**Validate** the slice against the live broker~~ — DONE twice (sandbox validation PASS,
   Status snapshot / E12, plus the **final focused revalidation PASS**, E13 — every §10b item
   resolved and sandbox-validated).
5. **Defer** gateway (Phase 3) and 0.4 convergence (Phase 5) to their ADRs — still open.
6. Next: Phase 2 broker-side authorization work remains the gate before any mutating interaction;
   nothing in §10b is held open against slice 1 anymore.

## 10. Acceptance checklist — slice 1

- [x] Settings expose AHP endpoint + token; token never logged/error'd raw. *(landed: `ahpEndpoint`/`ahpToken` in `src/main.ts`)*
- [x] `initialize` sends exactly `["0.3.0"]`; mismatch fails closed with clear UI error. *(mock-tested)*
- [x] `listSessions` catalogue renders; detail view shows chats incl. subagents, token/context, status, pending `question_user`. *(mock-tested; bounded by the caps in the Status snapshot)*
- [x] Subscribe/reconnect streaming with per-channel `serverSeq` dedupe and
      reconnect cursor (`lastSeenServerSeq`) (test-proven).
- [x] DOM renders incrementally / capped with the ~1.3 GB store present
      (thousands of drifting per-session .json/.jsonl files; scale/retention
      context only, not an expected `listSessions` count). *(implemented caps, see Status snapshot)*
- [x] No mutating RPC invoked from plugin code or tests; no archive terminal. *(verified by source grep + smoke suites)*
- [x] arthur-agent untouched; pi-sync `status/*.sessions.json` shape untouched.
- [x] Mock contract + reducer + reconnect tests pass with a mock/local WS —
      no private host required for the automated gate; smoke coverage added
      for AHP view registration/open/close and WS cleanup. *(851-assertion gate green)*
- [x] *(optional, manual only)* Non-mutating live probe against ulysse:4500
      when reachable — non-mutating, never CI-required, never a blocker. *(PASS 2026-11-07, see Status snapshot / E11)*
- [x] Full gate green: `npm run typecheck && npm run build && npm run smoke`.

- [x] Sandbox validation (real Obsidian instance + live broker) — PASS: blank-token connect,
      view open, Refresh → live, real catalogue, two session selections/detail, close/reopen
      socket sequence 1→0→1, zero console errors, no control RPC. *(2026-11-07, see E12; the
      instance was disposable, artifact transfer MD5-verified, everyday vault untouched)*

**Docs/release gate** (any later arthur change): the standard test gate plus
this doc's [VERIFIED]/[PROPOSED] honesty labels kept accurate, and backend
docs/version/API types updated together with any Phase 3 `/api/ahp/*` work.

---

## 10b. Post-slice-1 residue — all resolved & sandbox-validated

Nothing binding; recorded so the next slice starts from facts:

- The slice is committed on the arthur `dev` branch together with this plan doc.
- Token handling keeps the plan rules: `initialize.params.token` only, token never logged or
  error'd raw; the live probe ran **token-free** (accepted) — evidence for the §6 least-privilege
  review rather than against it.

**Blocker fix and UX polish items — implemented, code + smoke-tested, and all
sandbox-validated in the final focused revalidation (E13, `linux-obsidian-70047`, 2026-11-07):

1. **`ahp-ux-1` — protocol version not in view header**: the view header does not show the
   negotiated `protocolVersion`; a small header badge would make the fail-closed contract visible
   at a glance. → **Implemented**: the state line renders `live · 0.3.0` in the ready state only
   (`AhpClient.negotiatedVersion`, parked at initialize and cleared on any config-class failure —
   never shown before initialize succeeds). Smoke: 28 (c).
2. **`ahp-ux-2` — live resort under cursor**: when live updates reorder the catalogue, rows can
   move out from under the cursor/selection mid-interaction. → **Implemented**: the catalogue keeps
   STABLE insertion order between full reloads — `catalogue()` no longer re-sorts by `modifiedAt`;
   existing cards hold their positions while contents merge in place, `sessionAdded` appends,
   `sessionRemoved` deletes, and an explicit Refresh/full `listSessions` reload may establish a
   fresh order. Click handlers capture the resource at render time, so a repaint can never change
   which session a visible click targets. Smoke: 28 (d2), (e).
3. **`ahp-ux-3` — selected vs hover affordance**: the selected-row highlight is too close to the
   hover tint. → **Implemented**: hover is background-only; the persistent selection gets accent
   border + 3px left bar + tinted background + a persistent `▸ selected` DOM marker +
   `aria-pressed`, and the selected+hover combination locks the selection look in CSS. Smoke:
   28b (j2).
0. **`ahp-resub-1` — BLOCKER: re-selecting the SAME session hangs on "subscribing chat detail…"**
   (sandbox-confirmed 3/3; fresh sessions always fine; zero console errors). Root cause
   (diagnosed against the verified broker source `pi-ahp-server-farm-view-wt/src/store.ts` +
   `src/server.ts`, not guessed): the broker's `serverSeq` counter is **per channel** and is
   left unchanged while a channel is idle, and `buildSnapshot()` reports `fromSeq` = the CURRENT
   counter. The client kept the previous subscription epoch's per-channel watermark after the
   deselect `unsubscribe`, so the re-subscribe snapshot for the same idle session carried
   `fromSeq` **equal** to the stale watermark and `acceptSnapshot`'s `<=` dedupe guard skipped
   it; `applySessionSnapshot` never ran, no child chats were listed/subscribed, and the view
   rendered the empty-panel note indefinitely. Fix (`src/api/ahp.ts`): per-channel watermarks
   are now **epoch-scoped** — dropped with the subscription in `releaseDetailState` (deselect /
   selection switch / config-fail) and in `forgetDetailChannel` (chatRemoved / snapshot-dropped
   chats / reconnect-`missing`); reconnect needs no drop (a drop subscribes nothing away — the
   server restores subscriptions and the watermarks stay the valid replay cutoffs). Two related
   stale-booking races fixed in the same pass: an in-flight chat subscribe whose selection
   changed now gets its `unsubscribe` sent (and its stale reply can no longer re-enter
   `subscribedDetail`), and an in-flight session subscribe (`pendingSessionSub`) is superseded
   safely (unsubscribe on switch, stale-reply guard before bookkeeping). Regression-tested in
   the smoke gate section 28c with a subscription-tracking model broker (per-channel counters,
   server-side removal on unsubscribe, subscriber-gated envelope delivery, HOLDABLE subscribe
   replies): immediate close -> reselect SAME session and A->B->A both re-request session +
   child chats and re-render the second-epoch snapshots; no duplicate/stale channels in the
   server model, the reconnect payload, or the teardown unsubs; held-stale-reply releases
   cleanly. Pre-fix build fails those asserts. **Resolved and sandbox-validated** (final focused
   revalidation, E13): the (r)-class flow passed live — close→same-session reselect twice PASS,
   A→B→A and a third switch PASS, no hang, zero plugin-caused console errors.

4. **`ahp-ux-4` — detail below long capped catalogue**: the chat detail renders below the capped
   catalogue, so selecting a session requires scrolling. → **Implemented**: detail-first — the
   detail panel renders directly below the controls (above the catalogue), under a
   `selected · <title>` heading with a wired `✕ close detail` deselect control; the empty panel
   hides entirely. Catalogue cap and read-only behavior unchanged. Smoke: 28b (j2), (n).

---

---

## 11. Role deployment — preparation record (2026-11-07)

Facts recorded from the deployment-prep session (this section is a docs-only
record; no plugin/version/release artifacts change with it). Supersedes the
"NOT deployed / NOT merged" wording in the Status snapshot and Phase 2 where
it concerns the backend components:

- **pi-ahp-client — deployed at `a8e5e8212`, 71 tests green.** Deployed
  (artifact) hashes recorded; client is in place ahead of the role rollout.
- **swarm — deployed at `a0c3625`, 9 tests green.** Deployment hygiene: the
  backups were moved OUTSIDE the extensions directory (extensions paths are
  sync/backup surfaces — the same rationale as §7's "move source out of the
  vault" note).
- **arthur — `dev` at `5b2b05a`** ("fix: clear AHP detail when catalogue
  empties" — the stale-detail fix). Plugin side of the Phase 2 surface as
  delivered in §Status snapshot / E14–E18.
- **broker (pi-ahp-server) — landed at `b6e26148`, 82 tests green**, carrying
  the Phase 2 roles authorization (`viewer` / `controller` / `hostAgent`,
  server-side `-32008` gate on mutations, §2/§Phase 2 env contract) together
  with the **command gate**. DEPLOYED to the broker install; supersedes the
  earlier roles-branch "81 tests, not deployed" state.
- **Credential staging/audit — GO.** The role-credential staging and audit
  pass approved (values never recorded here, per the §6/§Phase-2 rules).
- **Residual recovery caveat — ulysse pi-ahp-client rsync incident**: an
  rsync incident on ulysse overwrote the stale worktree `dev` edits of the
  pi-ahp-client checkout; `.git` was restored, so the worktree is
  reconstructible from known hashes only — the uncommitted stale edits are
  NOT recoverable. Recorded as the residual caveat for any later diffing
  against that worktree's pre-incident state.
- **Production restart — SUPERSEDED by §11b**: the broker has since been
  restarted onto `b6e26148` (live main PID 175271, 2026-11-07 21:36 CET) —
  see §11b for the roll-out record. The remainder of §11 (test counts, hash
  records, rsync-incident caveat) stands.

## 11b. Production role deployment — roll-out record (2026-11-07)

Docs-only record of the production roll-out of the role backend (§11); no
plugin/version/release artifacts change with it. Facts verified live on
ulysse at record time:

- **PRODUCTION BROKER RUNNING b6e26148.** `pi-ahp-broker.service` (systemd
  --user, ulysse, `0.0.0.0:4500`) was restarted onto the deployed
  `b6e26148` build: main PID **175271** (`node dist/src/index.js` from
  `/home/ulysse/RnD/AHP/pi-ahp-server-farm-view-wt`), started
  **2026-11-07 21:36:24 CET**. The previous production run (main PID 590755,
  uptime 77d, pre-restart state captured in
  `pre-restart-clients.txt`) was replaced; the §11 "PENDING" restart gate is
  closed. Listener verified live (`ss`: pid 175271, fd 21).
- **ALL PROTOCOL ROLE PROBES PASS** — the protocol probes for the
  `viewer` / `controller` / `hostAgent` roles (incl. the server-side
  `-32008` mutation gate and the command gate) pass against the live
  production broker; role authorization is now LIVE. The plugin's controls
  (fail-closed-off until this roll-out) can now be exercised against the
  real broker per the §Phase-2 env contract.
- **Host agents + Arthur recovered.** The `hostAgent` clients (pi-ahp-client,
  swarm) and the arthur-side clients from arthur (100.90.92.1) reconnected
  to the restarted broker and are recorded healthy.
- **Voyager / old-ulysse recovery — RESOLVED COMPLETE (see §11c).** All
  clients recovered healthy to the restarted broker: voyager
  (100.93.241.75) recovered via a graceful Obsidian restart; three
  old-ulysse TTY clients recovered and re-attached with their EXACT
  transcripts intact; client `1897872` stopped INTENTIONALLY and left
  offline; pi-voice status PENDING at record time.
- **Interactive production UI validation — FAILED (see §11c).** The
  arthur-plugin test against the live roles broker (viewer + controller
  paths incl. the hardened inline-dispose UI, E18's open item) ran
  post-restart and FAILED at the hosted-create step: the broker could not
  spawn the hosted pi binary (`spawn /home/ulysse/.local/bin/pi` ENOENT)
  — **zero plugin-caused console errors**, **no session created**. Repair
  and retest are IN PROGRESS; **interactive deployment is NOT complete**
  and stays that way until the retest passes.
- **Backup / snapshot paths on ulysse** (all under `/home/ulysse/RnD/AHP/`):
  - `backups/ahp-command-gate-20261107-202018/` — pre-restart `dist`
    snapshot (`dist-pre-restart/`, command-gate build output).
  - `backups/arthur-roles-20261107-204020/` — full pre-restart backup:
    `store/` (live 0.3.0 session store rsync, hot-backup caveats in
    `README-metadata.txt`), `archive-Ulysse-sessions-ahp-archive/` +
    `archive-pi-ahp-archive/` (AHP_ARCHIVE_DIR entries),
    `repo-bundle-all.bundle` (git bundle of `pi-ahp-server-farm-view-wt`,
    captured at `19306d095dbe…`, tag `ahp-0.3.0-arthur-baseline-1-g19306d09`,
    clean), `repo/worktree/` (working-tree snapshot),
    `systemd/pi-ahp-broker.service` (unit copy), and
    `pre-restart-clients.txt` (active-client recovery snapshot, retry-pass).
  - `research.audit-snapshot/` — audit snapshot directory (pre-existing
    research surface).
- **Post-deploy cleanup (2026-11-07, verified)**: root-owned
  `/tmp/ahp-final-dispose` (incl. its empty `20261107-193220/` pass dir) and
  `/tmp/add_tests.py` removed from ulysse; **no `:4600` test listener**
  remains (full listener table checked); **no test instances** in the
  broker store; **no temp git test branches** (`AHP` + `AHP-server` branch
  lists checked); untouched: `ahp3`, unrelated `affectionate_tesla`/manager
  sessions.

---

## 11c. Production validation follow-up (2026-11-07)

Docs-only record of the post-restart validation state. Facts verified at
record time; no plugin/version/release artifacts change with this record.

- **Client recovery — COMPLETE.** Every client of the restarted broker is
  accounted for:
  - host agents + arthur-side clients: recovered healthy (recorded in
    §11b);
  - **voyager (100.93.241.75): RECOVERED** via a graceful Obsidian
    restart on the voyager side — clean reconnection to the restarted
    broker;
  - **three old-ulysse TTY clients: RECOVERED**, each re-attached with
    its EXACT transcript preserved (no transcript loss);
  - **client `1897872`: stopped INTENTIONALLY** and left offline by
    operator choice (not a casualty of the restart);
  - **pi-voice: status PENDING** at record time — not yet confirmed
    recovered or failed.
- **Interactive production UI validation — FAILED (blocker, repair in
  progress).** The interactive arthur-plugin run against the live roles
  broker (viewer + controller paths incl. the hardened inline-dispose
  UI, E18's open item) FAILED at the **hosted-create** step:
  - the broker attempt to start the hosted pi backend errored with
    **`spawn /home/ulysse/.local/bin/pi ENOENT`** — the path to the pi
    binary on ulysse is wrong/stale in the broker's spawn configuration
    (server-side defect, NOT a plugin defect);
  - **zero plugin-caused console errors** — the plugin side behaved
    correctly end-to-end up to the spawn failure;
  - **no session created** — the failed spawn left nothing in the broker
    store (nothing to clean up);
  - repair of the spawn path + retest of the hosted-create flow are IN
    PROGRESS; until the retest passes, **the interactive production
    deployment is NOT complete** — do not treat it as such.
- **Cleanup — DONE (verified).** No further residue beyond the §11b
  cleanup record: the failed create left no session, no listener, no
  temp artifact.

---

## Appendix: evidence

| # | Fact | Where verified |
|---|---|---|
| E1 | plugin-release `d182c1d` ← source branch `plugin` `809d6e7`, v0.4.0, 0/0 clean | GitHub `Slix-M-Lestragg/pi-ecosystem` + mac.home checkout at the §2.1 vault path |
| E2 | AHP server branch `feature/farm-view-server` `af39086e`; 17 ahead + uncommitted; dist includes them; tests 72/72 | ulysse: `/home/ulysse/RnD/AHP/pi-ahp-server-farm-view-wt`, unit `pi-ahp-broker.service` |
| E3 | Protocol 0.3.0, double-checked remotely: E1 `AhpClient` initialize negotiation (~L561–574) sends `protocolVersions: ["0.3.0"]` and E2 server `SUPPORTED_VERSION` pins 0.3.0; method list in §2.2; no `hostAgent.start/stop`; `resourceWrite` stub | E1 + E2 checkouts |
| E4 | :4501 = `/home/ulysse/RnD/AHP-server`, protocol 0.4.0, no farm/hostAgent | ulysse checkout |
| E5 | Broker host/port `ulysse` `100.75.249.5:4500`; store ~1.3 GB [VERIFIED]; the older "4572" figure was a drifting .json+jsonl **file** count, not a stable pair count — later spot-check ~4586 files (~2290 .json + ~2296 .jsonl) | ulysse (tailscale address) |
| E6 | arthur plugin v0.13.4 (`manifest.json`); `AGENT_VERSION = "0.8.1"` (`src/api/agent.ts`); test gate scripts in `package.json` | arthur repo `dev` |
| E7 | Legacy module paths (`src/transport/AhpClient.ts`, `AhpActionMapper.ts`, `JsonlCodec.ts`, `types/rpc.ts`) | E1 checkout |
| E8 | Token-in-`initialize.params` mechanism; plaintext token in `data.json`; plaintext tailnet WS | E1 checkout + E2 service config |
| E9 | **Phase 0 outcome**: branch `feature/farm-view-server` preserved as commit `17e35fa48e7a25e896c43f2f875949d865ad288e`, synced to origin, annotated tag `ahp-0.3.0-arthur-baseline` (tag object `8ee4e2e4…`); **no broker restart** | ulysse broker repo (delivery record) |
| E10 | **Slice 1 implementation + gate**: `src/api/ahp.ts`, `src/ui/ahp-view.ts` (new), `src/main.ts`, `src/ui/dashboard-view.ts`, `src/ui/pi-panel.ts`, `styles.css`, `scripts/test-bundle.mjs` (smoke); full gate green — `typecheck` + `build` + `smoke`, **851 asserted checks** across implementation and fix rounds (776 at slice-1 landing; grew with the §10b fix suites; the pre-commit gate ran the full 851 green); read-only controls only | arthur `dev` working tree |
| E11 | **Live probe PASS**: WS connect to `ws://100.75.249.5:4500`; `initialize` `protocolVersions ["0.3.0"]`, no token → accepted, result `protocolVersion: "0.3.0"`; `listSessions` (`ahp-root://`, `limit 1`) → page of 1 item; clean close; metadata only, no prompt/chat content | ephemeral probe script from arthur, 2026-11-07 |
| E12 | **Sandbox validation PASS (2026-11-07)**: current uncommitted build run in disposable Linux-Obsidian instance `arthur-ahp-slice1-test` (deleted after; MD5-verified artifact transfer; everyday vault untouched). Against live `100.75.249.5:4500`, blank token: open command launched the view; Refresh reached live; real catalogue rendered; two session selections rendered detail; close/reopen socket sequence 1→0→1; zero console errors; no control RPC. Screenshots: `/tmp/agent-os-shots/arthur-ahp-slice1-test-*.png` (detail `…3958975-19.png`, reopen `…4084044-30.png`). Follow-up UX issues §10b `ahp-ux-1…4` | agent-os Linux-Obsidian instance + live ulysse broker (delivery record) |
| E13 | **Final focused revalidation PASS (2026-11-07)**: current production build root `main.js` md5 `6ecc318489a79ababbb0b88f8a60711b` (build deterministic) run in disposable agent-os instance `linux-obsidian-70047` (**deleted after; everyday vault untouched**) against live `100.75.249.5:4500` — close→same-session reselect **twice PASS**, A→B→A **and third switch PASS**; detail-first layout, `live · 0.3.0` protocol badge, stable catalogue order, and the selected-row styling PASS; **no plugin-caused console errors** (two sandbox-only `@electron/remote` "AppImage temp dir" exceptions excluded — agent-os AppImage environment noise, unrelated to plugin code). Screenshots `/tmp/agent-os-shots/linux-obsidian-70047-*.png` (`…1794070424037-30.png` reselect, `…1794070960456-55.png` A→B→A). Resolves §10b `ahp-resub-1` + `ahp-ux-1…4` | agent-os Linux-Obsidian instance + live ulysse broker (delivery record) |
| E14 | **Phase 2 plugin gate PASS (2026-11-07)**: `typecheck` + `build` + `smoke` green — the Phase-1/2 smoke suites (28/28b/28c/28d) green, with suite 28d now additionally asserting the fixed hosted-create payload `createSession {channel, provider:'pi', workingDirectory}` and the mock broker's relay-vs-hosted split; uncommitted `dev` working tree (no commit) | arthur `dev` working tree (mock, no private host) |
| E15 | **Phase 2 live interactive sandbox PASS-with-blocker (2026-11-07)**: disposable agent-os Linux-Obsidian instance `linux-obsidian-73323` (**deleted after; everyday vault untouched; cleanup paths + broker :4500 state untouched**) against the live roles-broker: viewer token mutations rejected with the broker's forbidden `-32008`; controller token surfaced the control affordances and exercised pause/resume, ONE prompt (`AHP_PHASE2_OK` in the hosted session transcript), retry, a second chat, and dispose — all off server envelopes; **0 plugin-caused console errors**. Residue recorded: `createSession` sent no `provider` → the broker created an empty RELAY (blocker, since fixed & mock-tested, E16); question_user answering stayed mock-only; the focused live retest of the fixed wrapper is pending | agent-os Linux-Obsidian instance + live roles broker (delivery record) |
| E16 | **Blocker fix + cosmetic pass (2026-11-07)**: `src/api/ahp.ts` `createSession` now sends exactly `{channel, provider: 'pi', workingDirectory}` (hosted backend; the omitted provider defaults to `pi-ahp-server` = empty relay, verified in the broker's `handleCreateSession`); smoke suite 28d asserts the exact payload keys, `provider === 'pi'`, and the created card's `kind: 'hosted'` from the mock model's relay-vs-hosted split (provider-missing now projects `kind 'relay'`), so the pre-fix build fails the regression. Cosmetic: tofu-prone glyphs (＋/⏸/▸/↺/●/✓/✕/❓/⚠ in the AHP surface incl. the settings warning) → plain readable text; chat detail meta no longer renders raw `status 1` — it derives from live activeTurn/pending-question fields, then the VERIFIED broker status bitmask (`getSessionStatusLabel`, verbatim). | arthur `dev` working tree (mock; no private host) |
| E17 | **Focused provider:'pi' live retest PASS (2026-11-07, `linux-obsidian-74310`)**: disposable agent-os Linux-Obsidian instance against the live roles broker with the FIXED create wrapper (**deleted after; everyday vault untouched; broker :4500 state + cleanup paths untouched**) — a session created through the plugin's new-session control with `provider:'pi'` materialized as a REAL HOSTED interactive pi session (`AHP_PHASE2_CREATE_OK` in its transcript), pause/resume and dispose exercised live, **0 plugin-caused console errors**, cleanup verified. Residue surfaced: the native `window.confirm` dispose dialog wedged a stale selected detail after the server-side deletion (fixed as E18) | agent-os Linux-Obsidian instance + live roles broker (delivery record) |
| E19 | **Role deployment preparation record (2026-11-07, §11)**: pi-ahp-client `a8e5e8212` deployed (71 tests green, hashes recorded); swarm `a0c3625` deployed (9 tests green, backups moved OUTSIDE extensions); arthur `dev` `5b2b05a` (stale-detail fix); broker `b6e26148` deployed (82 tests green, roles + command gate); credential staging/audit GO; **production restart PENDING**; ulysse pi-ahp-client rsync incident — `.git` restored, stale worktree `dev` edits overwritten (known hashes only) | deployment-prep delivery record, recorded in §11 |
| E18 | **INLINE dispose confirmation hardening (2026-11-07, mock-tested; the final focused live sandbox was ABORTED by the harness and cleaned — NOT live-revalidated)**: native `window.confirm` removed from the dispose flow — `src/ui/ahp-view.ts` now arms an INLINE plain-DOM confirm strip in the selected detail (warning naming the session + `confirm dispose`/`cancel`; busy-disabled while pending; one single `disposeSession` request); `src/api/ahp.ts` `root/sessionRemoved` now ALSO releases a matching selected detail (late reply / stale-detail wedge defense; only the removed session is cleared — never a NEW selection); successful response clears the arm + releases the detail immediately + reloads the catalogue authoritatively; errors restore a safe state. Smoke suite 28d rewritten to the inline flow ((ac)) + new regressions ((ac2) late-reply/new-selection race, `root/sessionRemoved` detail release); gate green — **989 asserted checks**; uncommitted `dev` working tree (no commit/version/deps) | arthur `dev` working tree |
| E20 | **Production roll-out record (2026-11-07, §11b)**: broker production restart onto `b6e26148` EXECUTED — main PID 175271 live on `0.0.0.0:4500` (started 21:36 CET, `node dist/src/index.js` from `pi-ahp-server-farm-view-wt`; prior run PID 590755 replaced); all protocol role probes PASS (viewer/controller/hostAgent, `-32008` gate + command gate live); host agents + arthur clients recovered; voyager/old-ulysse recovery still in progress; production UI test in progress; backups verified at `/home/ulysse/RnD/AHP/backups/{ahp-command-gate-20261107-202018,arthur-roles-20261107-204020}` (+ `pre-restart-clients.txt`, `README-metadata.txt`, `research.audit-snapshot/`); post-deploy cleanup verified — `/tmp/ahp-final-dispose` + `/tmp/add_tests.py` removed, no `:4600` listener, no test instances, no temp test branches | ulysse live state + backup dirs (delivery record) |

| E21 | **Production validation follow-up (2026-11-07, §11c)**: ALL clients recovered to the restarted broker — voyager recovered via graceful Obsidian restart; three old-ulysse TTY clients recovered with exact transcripts; client `1897872` stopped intentionally (left offline); pi-voice status PENDING. Interactive production UI validation **FAILED at hosted create** — broker error `spawn /home/ulysse/.local/bin/pi ENOENT` (server-side path defect), **zero plugin-caused console errors**, **no session created**; spawn-path repair + retest IN PROGRESS; **interactive deployment NOT complete**; cleanup verified done | ulysse live state + plugin run record (delivery record) |

*End of plan.*
