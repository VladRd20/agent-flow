'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { TIMING } from '@/lib/agent-types'

interface GlassCardProps {
  children: ReactNode
  className?: string
  style?: React.CSSProperties
  visible: boolean
  /** Ref to the rendered card element (for measuring) */
  innerRef?: React.Ref<HTMLDivElement>
  role?: string
  'aria-label'?: string
}

export function GlassCard({ children, className = '', style, visible, innerRef, role, 'aria-label': ariaLabel }: GlassCardProps) {
  const [mounted, setMounted] = useState(false)
  const [animating, setAnimating] = useState(false)

  useEffect(() => {
    if (visible) {
      setMounted(true)
      const raf = requestAnimationFrame(() => setAnimating(true))
      return () => cancelAnimationFrame(raf)
    } else {
      setAnimating(false)
      const timer = setTimeout(() => setMounted(false), TIMING.glassAnimMs)
      return () => clearTimeout(timer)
    }
  }, [visible])

  if (!mounted) return null

  return (
    <div
      ref={innerRef}
      role={role}
      aria-label={ariaLabel}
      className={`glass-card ${className}`}
      style={{
        ...style,
        opacity: animating ? 1 : 0,
        transform: animating ? 'scale(1)' : 'scale(0.95)',
        transition: 'opacity 0.2s ease-out, transform 0.2s ease-out',
      }}
    >
      {children}
    </div>
  )
}
