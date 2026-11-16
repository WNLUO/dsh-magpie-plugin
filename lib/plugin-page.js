/**
 * 插件页「自包含」那一份：`GET /api/dsh-magpie/__pluginpage?url=/…`
 *
 * **为什么要有它**：magpie 的插件页（`/_magpie/plugin/<hash>/…`）是电脑上现场生成的网页，
 * 不在扩展包的快照里。扩展页从手机本地文件打开（`file://`），帧里塞不动一个跨源的地址，
 * 所以光有代理只解决「取得到」、解决不了「画在哪」。
 *
 * 这一条把它解决在扩展自己内部：宿主把那一页抓下来，**把它的 js / css / 图片 / 字体全部内联
 * 进去**（没有外部引用的 HTML 不需要任何地址就能渲染），页面侧把这段正文塞进帧的 `srcdoc`。
 * 于是它在手机上是靠扩展自己画出来的 —— 不经过 App、不需要令牌、也不开内置浏览器。
 *
 * 口径都是刻意的：
 *  1. **只认 `/_magpie/` 这棵子树**：别的路径一律 400，不给它当通用抓取器。
 *  2. **资源逐个取、取不到的跳过并记一笔**：上游本身可能缺文件（有的图标就是 404），
 *     少一张图不该让整页打不开。
 *  3. **有界**：一页的内联总量有上限，超了回一份说明，不硬吃进内存。
 */

import { sendJson } from './http-util.js'
import { magpieCookie, proxyRequest } from './proxy.js'
import { ensureWeb } from './magpie-web.js'

/** 一页内联之后的总字节上限（那几页现在最大 226 KB，这里留足）。 */
const MAX_INLINE_BYTES = 4 * 1024 * 1024
/** 最多内联多少个引用：防着一份奇怪的页面把我们拖住。 */
const MAX_INLINE_REFS = 64

/** 只看这三样：`src` / `href` 与 CSS 里的 `url()`。 */
const REF_PATTERN = /(\b(?:src|href)\s*=\s*"([^"]*)")|(\b(?:src|href)\s*=\s*'([^']*)')|url\(\s*['"]?([^'")]+)['"]?\s*\)/g

/** 按扩展名决定怎么塞。其余一律当二进制，走 data:。 */
function kindOf(pathname) {
  if (/\.m?js$/i.test(pathname)) return 'script'
  if (/\.css$/i.test(pathname)) return 'style'
  return 'data'
}

function contentTypeOf(pathname) {
  const ext = (pathname.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()
  const table = {
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    json: 'application/json; charset=utf-8',
  }
  return table[ext] || 'application/octet-stream'
}

const isLocalRef = (ref) => !!ref
  && !/^(?:data:|#|mailto:|javascript:|blob:|about:)/i.test(ref)
  && !/^(?:https?:)?\/\//i.test(ref)

/**
 * 把一段引用变成可以内联的写法。
 *
 * 解析地址用的是页面自己那个目录：插件页里的 `_magpie/bridge.js` 就是相对那一页。
 */
function resolveRef(ref, pageUrl) {
  if (ref.startsWith('/')) return ref
  if (ref.startsWith('?')) return pageUrl.split('?')[0] + ref
  const base = pageUrl.split('?')[0].split('#')[0]
  const dir = base.slice(0, base.lastIndexOf('/') + 1)
  return new URL(ref, `http://x${dir}`).pathname
}

/**
 * 造那一条路由。依赖全部注入（与透明代理由同一个入口给）：守卫里不许真起进程、不许真发请求。
 */
export function createPluginPageHandler(deps = {}) {
  const ensure = deps.ensureWebFn ?? ensureWeb
  const cookie = deps.cookieFn ?? magpieCookie
  const proxyFn = deps.proxyFn ?? proxyRequest

  async function fetchOne(port, cookie, path) {
    const result = await proxyFn(port, cookie, 'GET', path);
    return result && result.status === 200 ? result.body : null
  }

  return async function handlePluginPage(ctx, req, res) {
    const url = new URL(req?.url ?? '/', 'http://localhost')
    const raw = String(url.searchParams.get('url') || '').trim()
    if (!raw.startsWith('/_magpie/')) {
      return sendJson(res, 400, { ok: false, code: 'bad-target', message: '只认 /_magpie/ 下面的插件页' })
    }

    let web
    let why = ''
    try {
      web = await ensure({})
    } catch (error) {
      web = null
      why = String((error && error.message) || error)
    }
    if (!web || !web.available || !web.port) {
      return sendJson(res, 503, {
        ok: false,
        code: 'no-magpie',
        message: '这台电脑上的 magpie 网页版没跑起来',
        // 带上为什么：这一条只有本机看得到，用来分清「没跑」「探不到端口」「ensure 自己抛了」。
        reason: (web && web.reason) || why || 'unavailable',
      })
    }
    let cookieValue = ''
    try { cookieValue = await cookie(web.port, web.key) } catch { cookieValue = '' }

    const page = await fetchOne(web.port, cookieValue, raw)
    if (page === null) {
      return sendJson(res, 502, { ok: false, code: 'page-unavailable', message: `这一页取不到：${raw}` })
    }

    const html = page.toString('utf8')
    const refs = [...new Set([...html.matchAll(REF_PATTERN)].map((m) => m[2] ?? m[4] ?? m[5]).filter(isLocalRef))]
      .slice(0, MAX_INLINE_REFS)

    const cache = new Map()
    let total = 0
    const load = async (ref) => {
      if (cache.has(ref)) return cache.get(ref)
      const pathname = resolveRef(ref, raw)
      if (!pathname.startsWith('/_magpie/')) { cache.set(ref, null); return null }
      const body = await fetchOne(web.port, cookieValue, pathname)
      cache.set(ref, body)
      return body
    }

    // 逐个把引用换掉：脚本与样式**整个标签**换掉，其余（图片 / 字体 / CSS 里的 url()）换成 data:。
    const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let out = html
    for (const ref of refs) {
      const body = await load(ref)
      if (body === null) continue; // 上游自己缺这一份：少一样东西，不该让整页打不开
      total += body.length
      if (total > MAX_INLINE_BYTES) break
      const pathname = resolveRef(ref, raw)
      const kind = kindOf(pathname)
      if (kind === 'script') {
        const code = body.toString('utf8').replace(/<\/script>/gi, '<\\/script>')
        out = out.replace(new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["']${esc(ref)}["'][^>]*>\\s*<\\/script>`, 'gi'), () => `<script>${code}</script>`)
        continue
      }
      if (kind === 'style') {
        out = out.replace(new RegExp(`<link\\b[^>]*\\bhref\\s*=\\s*["']${esc(ref)}["'][^>]*>`, 'gi'), () => `<style>${body.toString('utf8')}</style>`)
        continue
      }
      const dataUrl = `data:${contentTypeOf(pathname)};base64,${body.toString('base64')}`
      out = out.split(ref).join(dataUrl)
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(out)
  }
}

export { MAX_INLINE_BYTES, MAX_INLINE_REFS }
