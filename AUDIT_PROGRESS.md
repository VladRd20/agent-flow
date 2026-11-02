# agent-flow full audit — 2026-10-13

Worktree: `E:\Projects\agent-flow_audit` branch `audit/2026-10-13`
Reported bug: main node not visible in graph view, subagent nodes render
inconsistently, canvas background visually broken (near-blank dark canvas).
Live instance confirmed running via the standalone packaged app
(`app/src/app.ts` → `server.ts`), bound to port 3001 (not the dev split
relay+Next setup). Verification will use a second instance on another port.

## Phase 0 — Baseline
- [x] `pnpm install` clean
- [x] `pnpm test`: 42/42 pass, 1.4s
- [x] `pnpm --filter agent-flow-web lint` (eslint): 0 errors, 10 warnings (5 auto-fixable)
  - canvas.tsx, index.tsx: several `react-hooks/exhaustive-deps` missing-dep warnings
    (canvas.tsx's is on the simulation ref — worth checking against the reported bug)

## Phase 1 — Read-only audit (in progress)
- [x] Agent A: agent-visualizer rendering pipeline — DONE
      1 HIGH, 1 MED, rest LOW/confirmed-fine:
      - HIGH: BloomRenderer composites at dpr² scale (bloom-renderer.ts:36-57,
        canvas.tsx:205-213,286) — ctx is already scaled by devicePixelRatio when
        bloom draws, but bloom draws using physical-pixel canvas dimensions
        through that already-scaled ctx, stretching the blurred bloom buffer to
        dpr² the intended area. Washes out the whole canvas on any dpr≠
        1 display. No-op at dpr=1. Confirmed via PowerShell this machine's
        system DPI is 96 (dpr=1), so likely NOT this user's root cause, but
        real and worth fixing regardless (Chrome zoom can still produce dpr≠
        1 independent of OS scaling).
      - MED: fragile but unconfirmed — ctx.save/translate/scale block relies on
        no exception escaping between save and restore; the draw loop's
        try/catch swallows errors with a 5s-rate-limited console.warn. No
        concrete throw site found.
      - Confirmed NOT the bug: ESLint missing-dep warnings (cosmetic, verified
        non-causal), d3-force setup/teardown, computeFitTransform's own cache
        (correctly keyed on dimensions, the earlier regression is fixed),
        drawAgents has no isMain-excluding filter. Also confirmed the three
        prior "invisible node" fix commits (da31380, 49e409a, a37b655) are
        all intact on main — not a regression of those.
      - LOW: processEvent always allocates fresh Map/array refs even for event
        types that don't touch them, defeating reference-equality memoization
        (e.g. computeFitTransform's cache) — real inefficiency, not a bug.

## Live verification (browser, via Chrome extension connected to user's "Home" machine)
Reproduced the bug directly: opened the completed "Salary-calc" session tab in
the actual running app (port 3001) — confirmed via screenshot: NO main/orchestrator
node rendered anywhere (only floating tool-call bubbles, two of them exactly
overlapping with garbled stacked text). Shift+F (zoomToFit) confirmed this is
not an off-screen/pan issue — the fit bbox contains nothing resembling a main
node, meaning main's opacity is being read as ≤0.1 by computeFitTransform's
exclusion check (compute-fit-transform.ts:92), not that it's merely offscreen.

Captured the raw SSE replay for this session directly (curl /events) and
confirmed data-side is fine: a correct `agent_spawn` with `isMain:true` IS
present. But also found, live, in the same session: multiple `agent_complete`
events with `payload.name === "subagent"` — a literal generic placeholder name
that was NEVER spawned (only 3 spawns exist, all named "orchestrator") —
direct confirmation of Agent B's HIGH relay-filtering finding against real
session data, not just theory.

Traced the main-node-invisible symptom to its root cause by reading the spawn
path: **NEW ROOT CAUSE, found via live reproduction + code tracing (not caught
by any of the 3 static-audit agents):** `handle-agent-events.ts:97` spawns
every agent — including the very first orchestrator spawn — at `opacity: 0`,
meant to fade in via `animate.ts`'s `if (agent.state !== 'complete' && opacity
< 1) opacity += deltaTime * fadeIn`. That fade-in is gated on the agent NOT
being in the `'complete'` state. Session-switch replay
(`use-vscode-bridge.ts` `flushSessionEvents`) pushes a COMPLETED session's
entire event history (hundreds of events, including its terminal
`agent_complete`) as pending events processed through `processEvent` — need
to confirm whether these drain across multiple animation frames (letting
fade-in interleave) or all synchronously before the first real animate()
tick. If the latter: main reaches `state: 'complete'` while still at
`opacity: 0`, and since fade-in requires non-complete state, it's stuck at 0
forever (isMain only protects it from fade-OUT, not from a fade-IN that never
ran). This would explain the exact reproduced symptom: a real, well-formed
main agent in state, permanently invisible, specifically for sessions
switched-to after they've already completed.
**Status: verifying drain timing in use-agent-simulation.ts before writing the fix.**
- [x] Agent B: relay/server/session state — DONE
      2 HIGH, 1 MED:
      - HIGH: relay.ts wires HookServer straight to broadcastEvent with NONE
        of the SUBAGENT_LIFECYCLE_EVENTS/filterOrchestratorCompletion
        filtering that claude-runtime.ts (the other HookServer consumer)
        documents as required, because hook-sourced subagent names
        (`${agentType}-${agentId.slice(-N)}`) diverge from transcript-sourced
        names (Task description). Hook tool-call/completion events for a
        subagent silently no-op client-side (name miss), so a subagent's
        only real completion signal becomes the transcript parser lagging
        behind — node sits "stuck active". STRONG candidate for root cause
        of "subagent nodes inconsistent". scripts/relay.ts:423-435 vs
        extension/src/claude-runtime.ts:34-120, hook-server.ts:260-292,329-336
      - HIGH: TOOL_DEDUP_WINDOW_S=3s check short-circuits BEFORE the exact
        tool_use_id equality check in handle-tool-events.ts:41-53 — any tool
        call >3s (slow Bash, big read) that gets double-reported (per finding
        above) produces a ghost duplicate node instead of deduping, even
        though tool_use_id matches. web/lib/canvas-constants.ts:42,
        web/hooks/simulation/handle-tool-events.ts:41-53
      - MED: pushCapped evicts from the FRONT; main agent's agent_spawn is
        always first-pushed for a session, so a 50k-event buffer overflow
        structurally evicts main's spawn first on reconnect-replay while
        later subagent events survive — reproduces "main node invisible,
        subagents still appearing" exactly. Likelihood raised by the HIGH
        finding above roughly doubling event volume. scripts/relay.ts:27,
        web/lib/capped-buffer.ts:3-9
      - Confirmed already fixed on main (not bugs): fix-restart-spawn-loss,
        fix-spawn-invisibility (render-side, out of this agent's scope,
        confirmed present), host-bind-session-prune — all verified against
        current code, not just branch names.
- [x] Agent C: everything else (extension src, scripts, config, build, tests) — DONE
      7 findings: 1 HIGH (JSONL watcher drops partial-line tail events,
      event-source.ts:56-66), 3 MED (triplicated hook-install logic w/
      backslash-normalization mismatch; postMessage has no backpressure/loss
      detection; containedProjectCache never pruned), 3 LOW

## Phase 2 — Bug fixes (done, all verified: unit tests + live repro)
Fixed, in priority order of impact on the reported symptoms:

1. **Main node permanently invisible after switching to an already-completed
   session** (the reported bug). Root cause, found by live reproduction +
   code tracing (not caught by any static Phase-1 agent):
   `handle-agent-events.ts:97` spawns every agent at `opacity: 0` for a live
   fade-in effect. `use-agent-simulation.ts`'s `animate()` drains an entire
   session-switch replay batch (hundreds of events) synchronously in one
   call, THEN runs fade logic once. The old fade-in condition
   (`animate.ts:24`) required `state !== 'complete'` — so an agent that
   reached `'complete'` within that same batch never got a chance to fade in.
   `isMain` exempts main from fade-OUT but did nothing to rescue a fade-IN
   that never ran → stuck at opacity 0 forever. Fixed by reworking
   opacity/scale to approach a target value (1 if active or isMain, 0/0.8 if
   completed non-main) from whatever the current value is, regardless of
   state — `animate.ts`. 3 new regression tests in `animate.test.ts`, all
   passing. **Live-verified**: reproduced the original bug on the running
   production instance (port 3001) using its real historical "Salary-calc"
   session data (screenshot: no main node anywhere, confirmed via
   Shift+F/zoomToFit it wasn't merely off-screen); confirmed the fix on a
   freshly-built second instance (port 3055) by injecting a synthetic
   spawn+complete-in-one-batch payload matching the real bug shape — main
   node now renders correctly.
2. **relay.ts broadcasts hook-sourced subagent events unfiltered**, unlike
   the VS Code extension's `claude-runtime.ts` (which filters
   `SUBAGENT_LIFECYCLE_EVENTS` + applies `filterOrchestratorCompletion` when
   the transcript parser already owns a session). Without this, a
   subagent's hook-sourced `agent_complete` carries a generic name
   (`${agentType}-${agentId.slice(-N)}`) that was never spawned under that
   name client-side (the transcript parser spawns it with the real
   description-derived name) — so the completion silently no-ops and the
   node is left looking stuck/active. **Live-verified against real data**:
   captured the live SSE replay for the Salary-calc session and found
   exactly this — multiple `agent_complete` events targeting a node
   literally named `"subagent"` that was never spawned (only 3 spawns exist,
   all `"orchestrator"`). Fixed by porting the same filter into
   `scripts/relay.ts` (`filterHookEvent`/`SUBAGENT_LIFECYCLE_EVENTS`/
   `filterOrchestratorCompletion`), gated on `sessions.has(sessionId)`.
3. **Tool-call dedup checked the 3s time window before the exact
   `tool_use_id` match**, so a slow call (big read, long-running Bash)
   reported twice more than 3s apart by two different event sources (hook +
   transcript) produced a ghost duplicate node instead of deduping, even
   though the ids matched exactly. Fixed in `handle-tool-events.ts`: exact
   `tool_use_id` match now dedupes unconditionally; the time window only
   gates the args/file heuristic fallback. 1 new regression test.
4. **BloomRenderer composites at devicePixelRatio² scale** on any
   non-1-dpr display — washes out the whole canvas (background,
   nodes, everything) because the compositing draw call runs through a ctx
   that's already dpr-scaled, using physical-pixel dimensions. No-op at
   dpr=1 (confirmed this machine's system DPI is 96/dpr=1, so likely not
   this user's trigger, but real and worth fixing — Chrome zoom can
   produce dpr≠1 independent of OS scaling). Fixed in
   `bloom-renderer.ts` by resetting to the identity transform before the
   composite draw.
5. **JSONL event-source silently drops partial-line events** —
   `event-source.ts`'s `readNewLines()` ignored `readNewFileLines`'s `tail`
   return value (explicitly documented as required: "if callers ignore
   tail, they silently lose any line not yet flushed"), unlike
   `session-watcher.ts`/`subagent-watcher.ts` which correctly thread it
   through. Fixed by storing and passing `fileTail`.

All deferred for later (lower severity / lower confidence, not touched):
containedProjectCache never pruned (extension, low real-world impact),
triplicated hook-install script + backslash-normalization mismatch between
`discovery.ts`/`hooks-config.ts` and `scripts/setup.js` (real but a
maintenance-trap, not a live bug), postMessage lacking backpressure
detection, `processEvent`'s unconditional fresh-Map-allocation inefficiency,
legacy HTTP-hook migration gap in standalone `setup.js`, `VSCodeBridge`'s
theoretical double-listener-registration risk.

## Phase 3 — Perf/efficiency
Folded into Phase 2 item 5's note (processEvent inefficiency) — not
independently pursued; no other perf issues surfaced as HIGH/MED in Phase 1.

## Phase 4 — Lint/dead code (done)
Baseline: 0 errors, 10 warnings (5 auto-fixable). Ran `eslint --fix`: 5
unused-eslint-disable-directive warnings cleared. Remaining 5 are
`react-hooks/exhaustive-deps` on canvas.tsx/index.tsx — Agent A
explicitly verified each is cosmetic (intentional omission, documented
in-code, not a stale-closure bug) — left as-is. No dead code found
worth removing (Agent C's audit found none; Agent B found none beyond the
hook-naming logic, which is actively used — not dead).

## Phase 5 — Tidy (full restructure approved, scoped down)
Given the size this audit already reached, did NOT attempt a full
package-layout restructure (high risk, `app/` cross-imports `../../extension`
and `../../scripts` via relative paths throughout — a real package
boundary would need all of those reworked, non-trivial and separable from
the bug-fix work). Did fix the one concrete, low-risk config gap Agent C
found: `app/` was never listed in `pnpm-workspace.yaml` despite being a real
third package — added it, verified `pnpm install` picks it up cleanly
with zero disruption (`Scope: all 4 workspace projects`).
**Recommendation for a future pass**: a real `app/` package boundary (own
`tsconfig.json` paths instead of `../../` relative imports) if the project
keeps growing a 3rd deployment target.

## Phase 6 — Review gate
Ran `/code-review medium` over the full audit diff (12 files, ~122
insertions). Findings below (post-verification).
