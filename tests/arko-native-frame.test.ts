import { expect, it } from 'vitest'
import { arkoNativeFrameDocument } from '../src/client/arko-native-frame.js'

it('installs the account-owned carrier before native bootstrap without changing its assets', () => {
  const source = '<html><head><script src="/native.js"></script></head><body></body></html>'
  const html = arkoNativeFrameDocument(source, 'frame-123', 'http://127.0.0.1:3080')
  expect(html.indexOf('__DSH_TRANSPORT__')).toBeLessThan(html.indexOf('/native.js'))
  expect(html).toContain('<script src="/native.js"></script>')
  expect(html).toContain('frame-123')
  expect(html).toContain('<base href="http://127.0.0.1:3080/">')
  expect(html).not.toContain('fetch =')
})
it('refuses a document without a bootstrap head and invalid bridge identity', () => {
  expect(() => arkoNativeFrameDocument('<body/>', 'valid', 'http://localhost:3080')).toThrow()
  expect(() => arkoNativeFrameDocument('<head></head>', '</script>', 'http://localhost:3080')).toThrow()
})
it('isolates only native session selection in the frame storage realm', () => {
  const html = arkoNativeFrameDocument('<head></head>', 'frame-a', 'http://localhost:3080')
  expect(html).toContain("key !== 'dsh.sessions.current'")
  expect(html).toContain('original.apply(this, arguments)')
  expect(html).not.toContain('localStorage.clear')
})
it('keeps presentation drafts in memory while preserving ordinary session storage', async () => {
  const { runInNewContext } = await import('node:vm')
  class Storage {
    values = new Map<string, string>()
    getItem(key: string) { return this.values.get(key) ?? null }
    setItem(key: string, value: string) { this.values.set(key, String(value)) }
    removeItem(key: string) { this.values.delete(key) }
  }
  const storage = new Storage()
  const carrier = { sessionId: 'presentation' }
  const script = arkoNativeFrameDocument('<head></head>', 'frame-a', 'http://localhost:3080').match(/<script>([\s\S]*?)<\/script>/)![1]!
  runInNewContext(script, { Storage, localStorage: storage, parent: { __arkmeArkoNativeFrames: new Map([['frame-a', carrier]]) } })
  storage.setItem('dsh.conversation.presentation', 'private draft')
  expect(storage.getItem('dsh.conversation.presentation')).toBe('private draft')
  expect(storage.values.has('dsh.conversation.presentation')).toBe(false)
  storage.setItem('dsh.conversation.ordinary', 'ordinary draft')
  expect(storage.values.get('dsh.conversation.ordinary')).toBe('ordinary draft')
  storage.removeItem('dsh.conversation.presentation')
  expect(storage.getItem('dsh.conversation.presentation')).toBeNull()
})
it('normalizes protocol objects into the native frame realm for DSH contract validation', async () => {
  const { runInNewContext, createContext } = await import('node:vm')
  const parentValue = { type: 'ready', host: { home: '' } }
  const carrier = { sessionId: 'p', async *openStream() { yield parentValue } }
  class Storage { getItem() {} setItem() {} removeItem() {} }
  const context = createContext({ Storage, localStorage: new Storage(), parent: { __arkmeArkoNativeFrames: new Map([['frame-a', carrier]]) } })
  const script = arkoNativeFrameDocument('<head></head>', 'frame-a', 'http://localhost:3080').match(/<script>([\s\S]*?)<\/script>/)![1]!
  runInNewContext(script, context)
  expect(await runInNewContext(`(async () => {
    const { value } = await __DSH_TRANSPORT__.openStream().next();
    return Object.getPrototypeOf(value) === Object.prototype && Object.getPrototypeOf(value.host) === Object.prototype;
  })()`, context)).toBe(true)
})
