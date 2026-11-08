'use client'

import { memo } from 'react'

import { CARD, Z, type AgentState } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import { TranscriptMessage } from './transcript-message'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { PanelHeader, SlidingPanel, stopPropagationHandlers } from './shared-ui'
import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useFocusReturn } from '@/hooks/use-focus-return'

interface ChatPanelProps {
  visible: boolean
  agentName: string
  agentState: AgentState
  conversation: ConversationMessage[]
  runtime?: 'claude' | 'codex'
  onClose: () => void
}

function AgentChatPanelImpl({
  visible,
  agentName,
  agentState,
  conversation,
  runtime,
  onClose,
}: ChatPanelProps) {
  const { ref: logRef } = useAutoScroll(conversation.length, visible)
  const isMobile = useIsMobile()
  useFocusReturn(visible)

  const stateColor = getStateColor(agentState)

  return (
    <SlidingPanel
      visible={visible}
      position={{ bottom: 'calc(var(--af-above-bar) + 4px)', right: 'var(--af-right)' }}
      zIndex={Z.chatPanel}
      mobileZIndex={Z.sheet}
      width={CARD.chat.width}
      label={`${agentName} conversation`}
      onDismiss={onClose}
      // No dimming backdrop: the chat sits above the agent detail sheet and the graph stays visible
      mobileBackdrop={false}
      // Mobile: bottom sheet spanning full width instead of a floating card.
      // Sits above the agent detail sheet (--af-detail-h) when both are open.
      mobilePosition={{ bottom: 'var(--af-detail-h)', left: 0, right: 0 }}
      mobileWidth="100%"
      mobileAxis="Y"
      mobileClassName="af-chat-slot"
      {...stopPropagationHandlers}
    >
      <div
        className={`glass-card af-selectable ${isMobile ? 'af-sheet af-mh-chat' : ''}`}
        style={{
          display: 'flex',
          flexDirection: 'column',
          maxHeight: isMobile ? undefined : CARD.chat.maxHeight,
          borderRadius: isMobile ? '12px 12px 0 0' : undefined,
        }}
      >
        <PanelHeader onClose={onClose} className="mb-2 flex-shrink-0">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: stateColor, boxShadow: `0 0 6px ${stateColor}` }}
          />
          <span className="text-[10px] font-mono tracking-wider" style={{ color: COLORS.textPrimary }}>
            {agentName.toUpperCase()}
          </span>
          <span className="text-[9px] font-mono capitalize" style={{ color: stateColor + '90' }}>
            {agentState}
          </span>
        </PanelHeader>

        {/* Messages */}
        <div
          ref={logRef}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain space-y-1.5 mb-2 [overflow-wrap:anywhere]"
          style={{
            minHeight: isMobile ? 80 : CARD.chat.messagesMinHeight,
            maxHeight: isMobile ? undefined : CARD.chat.messagesMaxHeight,
          }}
        >
          {conversation.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-[10px] font-mono" style={{ color: COLORS.textMuted }}>
                No messages yet...
              </p>
            </div>
          ) : (
            conversation.map((msg) => (
              <TranscriptMessage key={msg.id} message={msg} assistantLabel={runtime === 'codex' ? 'CODEX' : 'CLAUDE'} />
            ))
          )}
        </div>

      </div>
    </SlidingPanel>
  )
}

export const AgentChatPanel = memo(AgentChatPanelImpl)
