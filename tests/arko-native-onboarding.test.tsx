// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply } from '../src/client/arko-native-client.js'

it('shadows only the Arko welcome step and completes it without acknowledging shared settings', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const registrations: Array<{ options: { name: string; id: string; priority?: number }; component: React.ComponentType<{ complete(): void }> }> = []
  const ctx = {
    effect: vi.fn(),
    slots: {
      inject: (_name: string, install: () => void) => install(),
      register: (options: typeof registrations[number]['options'], component: typeof registrations[number]['component']) => { registrations.push({ options, component }) },
    },
  }
  window.__ARKME_NATIVE_ARKO__ = {} as NonNullable<typeof window.__ARKME_NATIVE_ARKO__>
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    apply(ctx as unknown as ClientContext)
    const onboarding = registrations.filter(entry => entry.options.name === 'settings.onboarding')
    expect(onboarding).toHaveLength(1)
    expect(onboarding[0]!.options).toMatchObject({ id: 'welcome-notice', priority: -100 })
    const Step = onboarding[0]!.component
    const complete = vi.fn()
    await act(async () => root.render(<Step complete={complete} />))
    expect(complete).toHaveBeenCalledTimes(1)
    expect(host.textContent).toBe('')
    expect(localStorage.length).toBe(0)
  } finally {
    await act(async () => root.unmount())
    delete window.__ARKME_NATIVE_ARKO__
    vi.unstubAllGlobals()
  }
})
it('cannot install the notice override in an ordinary DSH document', () => {
  const inject = vi.fn()
  expect(() => apply({ slots: { inject } } as unknown as ClientContext)).toThrow('Arko native carrier missing')
  expect(inject).not.toHaveBeenCalled()
})
