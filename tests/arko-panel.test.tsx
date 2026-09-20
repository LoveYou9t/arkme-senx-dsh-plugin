// @vitest-environment jsdom
import { useEffect } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ArkmeArkoPanel } from '../src/client/ArkmeArkoPanel.js'
const lifecycle = vi.hoisted(() => ({ mounted: vi.fn(), disposed: vi.fn() }))
vi.mock('../src/client/ArkmeArkoSurface.js', () => ({ ArkmeArkoSurface: () => {
  useEffect(() => { lifecycle.mounted(); return lifecycle.disposed }, [])
  return <input aria-label="草稿" defaultValue="" />
} }))
it('loads only on first visit and retains the same instance across navigation while isolating account changes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host=document.createElement('div');document.body.append(host)
  const root=createRoot(host)
  try {
    await act(async()=>root.render(<ArkmeArkoPanel key="prod:a" visible={false} />))
    expect(lifecycle.mounted).not.toHaveBeenCalled()
    await act(async()=>root.render(<ArkmeArkoPanel key="prod:a" visible />))
    const input=host.querySelector('input')!;input.value='保留草稿'
    expect(lifecycle.mounted).toHaveBeenCalledTimes(1)
    await act(async()=>root.render(<ArkmeArkoPanel key="prod:a" visible={false} />))
    expect(host.querySelector('input')).toBe(input)
    expect(host.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(host.firstElementChild?.hasAttribute('inert')).toBe(true)
    expect(lifecycle.disposed).not.toHaveBeenCalled()
    await act(async()=>root.render(<ArkmeArkoPanel key="prod:a" visible />))
    expect(host.querySelector('input')?.value).toBe('保留草稿')
    expect(host.firstElementChild?.hasAttribute('inert')).toBe(false)
    expect(lifecycle.mounted).toHaveBeenCalledTimes(1)
    await act(async()=>root.render(<ArkmeArkoPanel key="test:a" visible={false} />))
    expect(lifecycle.disposed).toHaveBeenCalledTimes(1)
    expect(host.querySelector('input')).toBeNull()
    await act(async()=>root.render(<ArkmeArkoPanel key="test:a" visible />))
    expect(host.querySelector('input')?.value).toBe('')
    expect(lifecycle.mounted).toHaveBeenCalledTimes(2)
    await act(async()=>root.render(null))
    expect(lifecycle.disposed).toHaveBeenCalledTimes(2)
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()}
})
