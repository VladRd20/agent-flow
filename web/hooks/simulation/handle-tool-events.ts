import { COLORS } from '@/lib/colors'
import { TOOL_DEDUP_WINDOW_S } from '@/lib/canvas-constants'
import type { ToolCallNode } from '@/lib/agent-types'
import { pushTimelineBlock, type ProcessEventContext, type MutableEventState } from './process-event'
import { appendConversation, asString, asBoolean, LABEL_LEN_PARTICLE, LABEL_LEN_TIMELINE } from './types'

/** Extract file path from tool input data or fall back to first token of args */
function extractFilePath(inputData?: Record<string, unknown>, args?: string): string {
  return asString(inputData?.file_path) || args?.split(' ')[0] || ''
}

export function handleToolCallStart(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
): void {
  const agentName = asString(payload.agent)
  const toolName = asString(payload.tool)
  const args = asString(payload.args)
  const inputData = (payload.inputData && typeof payload.inputData === 'object' && !Array.isArray(payload.inputData))
    ? payload.inputData as Record<string, unknown> : undefined
  // The transcript's tool_use block id — the exact per-call identifier Claude's
  // own protocol assigns (same id pairing tool_use/tool_result). When present
  // this is the primary matching key; the agent+toolName+args heuristic below
  // is only a fallback for event sources that don't carry it.
  const toolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined
  const agent = state.agents.get(agentName)

  if (agent) {
    // Dedup: skip if there's already a running tool call that is exactly the
    // same real call. With a tool_use_id, this is exact: any other running
    // call carrying the identical id IS the same call (a race between Hook
    // Server and Session Watcher reporting it twice). Without one (older
    // transcript formats), fall back to the agent+tool+args/file heuristic —
    // matching on args/file too (not just agent+tool) is required so that two
    // genuinely distinct concurrent calls to the same tool (e.g. parallel
    // `Read` on different files) don't get one of them silently dropped here.
    const newFilePath = extractFilePath(inputData, args)
    let isDuplicate = false
    for (const tc of state.toolCalls.values()) {
      if (tc.agentId !== agentName || tc.toolName !== toolName || tc.state !== 'running') continue
      // An exact tool_use_id match IS the same call, full stop — no window.
      // A slow call (big read, long-running Bash) easily takes longer than
      // TOOL_DEDUP_WINDOW_S between its Hook Server report and its Session
      // Watcher report, and gating the exact-id check behind the window
      // (as this used to) let a late-arriving duplicate slip through as a
      // second "ghost" node for the same real call.
      if (toolUseId && tc.toolUseId) {
        if (tc.toolUseId === toolUseId) { isDuplicate = true; break }
        continue
      }
      // No id on one or both sides — fall back to the time-boxed heuristic.
      if ((currentTime - tc.startTime) >= TOOL_DEDUP_WINDOW_S) continue
      const tcFilePath = extractFilePath(tc.inputData, tc.args)
      if (tcFilePath === newFilePath && tc.args === args) {
        isDuplicate = true
        break
      }
    }
    if (isDuplicate) return

    state.agents.set(agentName, {
      ...agent,
      state: 'tool_calling',
      currentTool: toolName,
      toolCalls: agent.toolCalls + 1
    })

    const toolId = `tool-${agentName}-${toolName}-${currentTime}`

    const pos = ctx.findToolSlot(agent, state.agents, state.toolCalls, currentTime)

    state.toolCalls.set(toolId, {
      id: toolId, agentId: agentName, toolName,
      state: 'running',
      args,
      inputData,
      x: pos.x,
      y: pos.y,
      startTime: currentTime,
      opacity: 0,
      toolUseId,
    })

    state.edges.push({ id: `edge-${toolId}`, from: agentName, to: toolId, type: 'tool', opacity: 0 })

    state.particles.push({
      id: `p-tc-${currentTime}-${toolId}`,
      edgeId: `edge-${toolId}`, progress: 0,
      type: 'tool_call', color: COLORS.tool,
      size: 4, trailLength: 0.15,
      label: `${toolName} ${args}`.slice(0, LABEL_LEN_PARTICLE),
    })

    // Timeline block
    const entry = state.timelineEntries.get(agentName)
    if (entry) {
      pushTimelineBlock(entry, currentTime, { type: 'tool_call', label: `${toolName}: ${args}`.slice(0, LABEL_LEN_TIMELINE), color: COLORS.tool }, ctx)
    }

    // Track file attention
    if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
      const filePath = extractFilePath(inputData, args)
      if (filePath) {
        const prev = state.fileAttention.get(filePath)
        const updated = prev
          ? { ...prev, agents: [...prev.agents] }
          : { path: filePath, reads: 0, edits: 0, totalTokens: 0, lastAccessed: currentTime, agents: [] as string[] }
        if (toolName === 'Read') updated.reads++
        else updated.edits++
        updated.lastAccessed = currentTime
        if (!updated.agents.includes(agentName)) updated.agents.push(agentName)
        state.fileAttention.set(filePath, updated)
      }
    }

    appendConversation(state.conversations, agentName, {
      type: 'tool_call', content: `> ${toolName} ${args}`, timestamp: currentTime,
      toolName, inputData,
    })
  }
}

export function handleToolCallEnd(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
): void {
  const agentName = asString(payload.agent)
  const toolName = asString(payload.tool)
  const result = asString(payload.result, 'Done')
  const tokenCost = typeof payload.tokenCost === 'number' ? payload.tokenCost : undefined
  const isError = asBoolean(payload.isError)
  const errorMessage = typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined
  const toolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined
  const agent = state.agents.get(agentName)

  if (agent) {
    state.agents.set(agentName, {
      ...agent,
      state: isError ? 'error' : 'thinking',
      currentTool: undefined,
      tokensUsed: agent.tokensUsed + (tokenCost ?? 0),
    })

    const toolState: 'error' | 'complete' = isError ? 'error' : 'complete'
    // Track which tool call this end event actually completed, so the
    // file-attention token cost below is attributed to THAT call, not to
    // whichever same-agent+same-tool call happens to be first in the map.
    // With a tool_use_id this is exact — it's the same id the transcript used
    // to pair this tool_result with its tool_use. Without one (older event
    // sources), fall back to the first running same-agent+same-tool call,
    // which could be a much older, already-completed call for the same tool
    // if two truly-concurrent same-tool calls are in flight.
    let completedTc: ToolCallNode | undefined
    let completedId: string | undefined
    if (toolUseId) {
      for (const [id, tc] of state.toolCalls) {
        if (tc.toolUseId === toolUseId && tc.state === 'running') {
          completedId = id
          break
        }
      }
    }
    if (!completedId) {
      for (const [id, tc] of state.toolCalls) {
        if (tc.agentId === agentName && tc.toolName === toolName && tc.state === 'running' && !tc.toolUseId) {
          completedId = id
          break
        }
      }
    }
    if (completedId) {
      const tc = state.toolCalls.get(completedId)!
      completedTc = { ...tc, state: toolState, completeTime: currentTime, result, tokenCost, errorMessage: isError ? (errorMessage || result) : undefined }
      state.toolCalls.set(completedId, completedTc)

      const edgeId = `edge-${completedId}`
      // Snap any still-traveling outgoing particle to the end
      const outIdx = state.particles.findIndex(p => p.edgeId === edgeId && p.type === 'tool_call')
      if (outIdx !== -1) state.particles[outIdx] = { ...state.particles[outIdx], progress: 0.95 }

      state.particles.push({
        id: `p-tr-${currentTime}-${completedId}`,
        edgeId, progress: 1,
        type: 'tool_return', color: COLORS.return,
        size: 4, trailLength: 0.15,
        label: result.slice(0, LABEL_LEN_PARTICLE),
      })
    }

    // Timeline block end
    const entry = state.timelineEntries.get(agentName)
    if (entry) {
      if (isError) {
        const lastBlock = entry.blocks[entry.blocks.length - 1]
        if (lastBlock && !lastBlock.endTime) {
          lastBlock.color = COLORS.error
          lastBlock.label = `${toolName}: FAILED`
        }
      }
      pushTimelineBlock(entry, currentTime, { type: 'thinking', label: 'Thinking...', color: COLORS.thinking }, ctx)
    }

    // File attention token cost — attribute to the call we just completed above,
    // not to an arbitrary same-agent+same-tool call (see completedTc comment).
    if (tokenCost) {
      const filePath = extractFilePath(completedTc?.inputData, completedTc?.args)
      if (filePath) {
        const existing = state.fileAttention.get(filePath)
        if (existing) {
          state.fileAttention.set(filePath, { ...existing, totalTokens: existing.totalTokens + tokenCost })
        }
      }
    }

    appendConversation(state.conversations, agentName, {
      type: 'tool_result',
      content: `< ${result}${tokenCost ? ` (${tokenCost} tokens)` : ''}`,
      timestamp: currentTime,
      toolName,
    })
  }
}
