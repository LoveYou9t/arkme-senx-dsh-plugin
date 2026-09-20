import { useEffect, useState } from 'react'
import { ArkmeArkoSurface } from './ArkmeArkoSurface.js'

/** The workspace keys this single retained panel by authenticated account scope. */
export function ArkmeArkoPanel({ visible }: { visible: boolean }) {
  const [visited, setVisited] = useState(false)
  useEffect(() => { if (visible) setVisited(true) }, [visible])
  if (!visible && !visited) return null
  return <div data-arkme-owned="arko-panel" aria-hidden={!visible || undefined}
    {...(!visible ? { inert: '' } : {})}
    style={{ position: 'absolute', inset: 0, visibility: visible ? 'visible' : 'hidden',
      pointerEvents: visible ? 'auto' : 'none', zIndex: visible ? 1 : 0 }}>
    <ArkmeArkoSurface native />
  </div>
}
