import type { SimulationState } from './types'
import {
  TOOL_MIN_DISPLAY_S, TOOL_MAX_RUNNING_S,
  DISCOVERY_HOLD_S, DISCOVERY_LERP_SPEED,
  BUBBLE_VISIBLE_S, MOCK_END_BUFFER_S,
  ANIM_SPEED,
} from '@/lib/canvas-constants'

export interface AnimateOptions {
  useMockData: boolean
  mockScenarioLength: number
  mockScenarioEndTime: number
}

function animateAgents(agents: SimulationState['agents'], deltaTime: number, currentTime: number): SimulationState['agents'] {
  let newAgents = agents
  for (const [id, agent] of agents) {
    let updated = false
    let opacity = agent.opacity
    let scale = agent.scale
    let messageBubbles = agent.messageBubbles

    // Target opacity/scale by state, approached from whatever the agent's
    // current value is — NOT gated on "not complete" for the fade-IN side.
    // A session-switch replay (use-agent-simulation.ts's `capturedEvents`
    // loop) can process an agent's entire history — spawn through
    // completion — in one batch, inside a single animate() call, before this
    // function ever runs. handleAgentSpawn starts every agent at opacity 0
    // (for the live spawn fade-in effect); the old `state !== 'complete'`
    // guard meant an agent that reached 'complete' within that same batch
    // never got a chance to fade in at all — main agents (exempt from
    // fade-out below) were then stuck invisible at opacity 0 forever, which
    // is exactly what reproduced as "main node not visible" when switching
    // to an already-completed session's tab.
    const targetOpacity = agent.state === 'complete' ? (agent.isMain ? 1 : 0) : 1
    const targetScale = agent.state === 'complete' ? (agent.isMain ? 1 : 0.8) : 1
    if (opacity !== targetOpacity) {
      opacity = opacity < targetOpacity
        ? Math.min(targetOpacity, opacity + deltaTime * ANIM_SPEED.agentFadeIn)
        : Math.max(targetOpacity, opacity - deltaTime * ANIM_SPEED.agentFadeOut)
      updated = true
    }
    if (scale !== targetScale) {
      scale = scale < targetScale
        ? Math.min(targetScale, scale + deltaTime * ANIM_SPEED.agentScaleIn)
        : Math.max(targetScale, scale - deltaTime * ANIM_SPEED.agentScaleOut)
      updated = true
    }
    // timeAlive only feeds a "12.3s" stats label. Accumulate it IN PLACE: copying
    // the agent (and the whole agents Map) 60x/s for a label made every frame
    // look like a structural change and defeated identity-based change checks.
    if (agent.state !== 'complete') agent.timeAlive += deltaTime
    // Prune expired message bubbles
    if (messageBubbles.length > 0) {
      const pruned = messageBubbles.filter(b => currentTime - b.time <= BUBBLE_VISIBLE_S)
      if (pruned.length !== messageBubbles.length) { messageBubbles = pruned; updated = true }
    }
    if (updated) {
      if (newAgents === agents) newAgents = new Map(agents)
      newAgents.set(id, { ...agent, opacity, scale, messageBubbles })
    }
  }
  return newAgents
}

function animateEdges(edges: SimulationState['edges'], deltaTime: number): SimulationState['edges'] {
  if (edges.some(e => e.opacity < 1)) {
    return edges.map(e =>
      e.opacity < 1 ? { ...e, opacity: Math.min(1, e.opacity + deltaTime * ANIM_SPEED.edgeFadeIn) } : e
    )
  }
  return edges
}

function animateToolCalls(toolCalls: SimulationState['toolCalls'], deltaTime: number, newTime: number): SimulationState['toolCalls'] {
  let newToolCalls = toolCalls
  for (const [id, tc] of toolCalls) {
    let newOpacity = tc.opacity
    if (tc.state === 'running') {
      const runningSince = newTime - tc.startTime
      if (runningSince > TOOL_MAX_RUNNING_S) {
        newOpacity = Math.max(0, tc.opacity - deltaTime * ANIM_SPEED.toolFadeOut)
      } else {
        newOpacity = Math.min(1, tc.opacity + deltaTime * ANIM_SPEED.toolFadeIn)
      }
    } else {
      const timeSinceComplete = newTime - (tc.completeTime ?? 0)
      if (timeSinceComplete < TOOL_MIN_DISPLAY_S) {
        newOpacity = Math.min(1, tc.opacity + deltaTime * ANIM_SPEED.toolFadeIn)
      } else {
        newOpacity = Math.max(0, tc.opacity - deltaTime * ANIM_SPEED.toolFadeOut)
      }
    }
    if (newOpacity !== tc.opacity) {
      if (newToolCalls === toolCalls) newToolCalls = new Map(toolCalls)
      newToolCalls.set(id, { ...tc, opacity: newOpacity })
    }
  }
  return newToolCalls
}

function cleanupFaded(
  agents: SimulationState['agents'],
  toolCalls: SimulationState['toolCalls'],
  edges: SimulationState['edges'],
  originalAgents: SimulationState['agents'],
  originalToolCalls: SimulationState['toolCalls'],
): { agents: SimulationState['agents']; toolCalls: SimulationState['toolCalls']; edges: SimulationState['edges'] } {
  let newAgents = agents
  let newToolCalls = toolCalls
  let filteredEdges = edges

  // Cleanup faded agents (completed sub-agents) and their edges
  const fadedAgentIds: string[] = []
  for (const [id, agent] of newAgents) {
    if (!agent.isMain && agent.state === 'complete' && agent.opacity <= 0) {
      fadedAgentIds.push(id)
    }
  }
  if (fadedAgentIds.length > 0) {
    if (newAgents === originalAgents) newAgents = new Map(originalAgents)
    const fadedSet = new Set(fadedAgentIds)
    for (const id of fadedAgentIds) newAgents.delete(id)
    filteredEdges = filteredEdges.filter(e => !fadedSet.has(e.from) && !fadedSet.has(e.to))
  }

  // Cleanup faded tool calls (opacity <= 0) and their edges
  const fadedToolIds: string[] = []
  for (const [id, tc] of newToolCalls) {
    if (tc.opacity <= 0) fadedToolIds.push(id)
  }
  if (fadedToolIds.length > 0) {
    if (newToolCalls === originalToolCalls) newToolCalls = new Map(originalToolCalls)
    const fadedSet = new Set(fadedToolIds)
    for (const id of fadedToolIds) newToolCalls.delete(id)
    filteredEdges = filteredEdges.filter(e => !(e.type === 'tool' && fadedSet.has(e.to)))
  }

  // Remove orphaned edges whose endpoints no longer exist
  const isOrphan = (e: SimulationState['edges'][number]) =>
    !newAgents.has(e.from) || !(newAgents.has(e.to) || newToolCalls.has(e.to))
  if (filteredEdges.some(isOrphan)) filteredEdges = filteredEdges.filter(e => !isOrphan(e))
  return { agents: newAgents, toolCalls: newToolCalls, edges: filteredEdges }
}

function animateDiscoveries(discoveries: SimulationState['discoveries'], deltaTime: number, newTime: number): SimulationState['discoveries'] {
  if (discoveries.length === 0) return discoveries
  const lerpT = Math.min(1, deltaTime * DISCOVERY_LERP_SPEED)
  let out: SimulationState['discoveries'] | null = null
  for (let i = 0; i < discoveries.length; i++) {
    const d = discoveries[i]
    const age = newTime - d.timestamp
    let x = d.x + (d.targetX - d.x) * lerpT
    let y = d.y + (d.targetY - d.y) * lerpT
    if (Math.abs(d.targetX - x) < 0.01) x = d.targetX
    if (Math.abs(d.targetY - y) < 0.01) y = d.targetY
    const opacity = age < DISCOVERY_HOLD_S
      ? Math.min(0.9, d.opacity + deltaTime * ANIM_SPEED.discoveryFadeIn)
      : Math.max(0, d.opacity - deltaTime * ANIM_SPEED.discoveryFadeOut)
    if (opacity <= 0) {
      if (!out) out = discoveries.slice(0, i)
      continue
    }
    if (x === d.x && y === d.y && opacity === d.opacity) {
      if (out) out.push(d)
      continue
    }
    if (!out) out = discoveries.slice(0, i)
    out.push({ ...d, x, y, opacity })
  }
  return out ?? discoveries
}

function animateParticles(particles: SimulationState['particles'], deltaTime: number, speed: number): SimulationState['particles'] {
  if (particles.length === 0) return particles
  const step = deltaTime * ANIM_SPEED.particleSpeed * speed
  const out: SimulationState['particles'] = []
  for (const p of particles) {
    if (p.type === 'return' || p.type === 'tool_return') {
      const progress = Math.max(0, p.progress - step)
      if (progress <= 0) continue
      out.push({ ...p, progress })
    } else {
      const progress = Math.min(1, p.progress + step)
      if ((p.type === 'dispatch' || p.type === 'tool_call' || p.type === 'message') && progress >= 1) continue
      out.push({ ...p, progress })
    }
  }
  return out
}

export function computeNextFrame(prev: SimulationState, deltaTime: number, newTime: number, maxT: number, currentState: SimulationState, options: AnimateOptions): SimulationState {
      const newAgentsRaw = animateAgents(currentState.agents, deltaTime, currentState.currentTime)
      const newEdgesRaw = animateEdges(currentState.edges, deltaTime)
      const newToolCallsRaw = animateToolCalls(currentState.toolCalls, deltaTime, newTime)

      const { agents: newAgents, toolCalls: newToolCalls, edges: filteredEdges } =
        cleanupFaded(newAgentsRaw, newToolCallsRaw, newEdgesRaw, currentState.agents, currentState.toolCalls)

      const newDiscoveries = animateDiscoveries(currentState.discoveries, deltaTime, newTime)
      const newParticles = animateParticles(currentState.particles, deltaTime, currentState.speed)

      // Stop playback when mock scenario ends (user can restart manually)
      if (options.useMockData && currentState.eventIndex >= options.mockScenarioLength && newTime > options.mockScenarioEndTime + MOCK_END_BUFFER_S) {
        return {
          ...currentState, currentTime: newTime, eventIndex: currentState.eventIndex,
          agents: newAgents, toolCalls: newToolCalls,
          particles: newParticles, edges: filteredEdges,
          discoveries: newDiscoveries,
          maxTimeReached: maxT,
          isPlaying: false,
        }
      }

      return {
        ...currentState, currentTime: newTime, eventIndex: currentState.eventIndex,
        agents: newAgents, toolCalls: newToolCalls,
        particles: newParticles, edges: filteredEdges,
        discoveries: newDiscoveries,
        maxTimeReached: maxT,
      }
}
