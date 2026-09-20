// DSH rc.2 has no zero-width sidebar API. Keep its React owners mounted while
// the center spans the vacated first track; the right panel retains its track.
const conversationOnlyLayout = `
  button[aria-haspopup="listbox"][aria-label="指令"],
  button[aria-haspopup="listbox"][aria-label="Commands"] {
    display: none !important;
  }
  body div:has(> :first-child > [data-slot="sidebar"]):has(> [data-rightbar-col]) > :first-child,
  body div:has(> :first-child > [data-slot="sidebar"]):has(> [data-rightbar-col]) > [data-side="sidebar"] {
    display: none !important;
  }
  body div:has(> :first-child > [data-slot="sidebar"]):has(> [data-rightbar-col]) > :nth-child(2) {
    grid-column: 1 / 3; grid-row: 1;
  }
  body div:has(> :first-child > [data-slot="sidebar"]):has(> [data-rightbar-col]) > [data-rightbar-col] {
    grid-column: 3; grid-row: 1;
  }
`

/** The owning parent installs a per-frame carrier before any native DSH code executes. */
export function arkoNativeFrameDocument(html: string, key: string, origin: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(key) || !/<head(?:\s[^>]*)?>/i.test(html)) throw new Error('Arko 原生页面启动配置无效')
  const base = new URL('/', origin).href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  return html.replace(/<head(?:\s[^>]*)?>/i, head => `${head}<base href="${base}"><style data-arkme-arko-layout>${conversationOnlyLayout}</style><script>
const carrier = parent.__arkmeArkoNativeFrames?.get(${JSON.stringify(key)});
if (!carrier) throw new Error('Arko native carrier unavailable');
// Session selection belongs to this document, not the ordinary DSH tab.
const storage = globalThis.localStorage;
const isolated = new Map();
const conversationKey = 'dsh.conversation.' + carrier.sessionId;
for (const method of ['getItem', 'setItem', 'removeItem']) {
  const original = Storage.prototype[method];
  Storage.prototype[method] = function(key, value) {
    if (this !== storage || (key !== 'dsh.sessions.current' && key !== conversationKey)) return original.apply(this, arguments);
    if (method === 'getItem') return isolated.get(key) ?? null;
    if (method === 'removeItem') isolated.delete(key);
    else isolated.set(key, String(value));
  };
}
globalThis.__DSH_TRANSPORT__ = {
  async fetch(...args) {
    const response = await carrier.fetch(...args);
    return new Response(await response.text(), { status: response.status, headers: { 'content-type': 'application/json' } });
  },
  async *openStream(...args) {
    for await (const value of carrier.openStream(...args)) yield JSON.parse(JSON.stringify(value));
  },
};
globalThis.__ARKME_NATIVE_ARKO__ = carrier;
</script>`)
}
