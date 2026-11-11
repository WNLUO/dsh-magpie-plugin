/**
 * 透明代理：把手机扩展页里的 `/api/...` 请求落到这台电脑上的 magpie 网页版。
 *
 * **整条链路长这样**（与「包一层 JSON 信封」的写法完全不同，别按那种改回来）：
 *
 *   扩展页 `fetch('/api/state')`
 *     → 页面在 boot 阶段把前缀改写成 `/api/dsh-magpie/api/state`
 *     → App 按清单的 `hostData.match` 拦下，交宿主 `host.data` 通用通道
 *     → 宿主把请求转发到**自己的 web 端口、原路径**
 *     → 落到本插件注册的前缀路由，剥掉 `/api/dsh-magpie` 之后是 `/api/state`
 *     → 这里原样转发给 magpie 网页版（`127.0.0.1:<port>`）
 *
 * 所以这一层必须是**透明代理**：真实 method、真实 content-type、真实请求体进；真实状态码、
 * 真实 content-type、真实正文出。**不许包成 `{ ok, status, headers, body }` 的 JSON 信封** ——
 * 上一跳会把目标服务的响应原样递给页面，信封会让页面 `res.json()` 读到我们这层的外壳而不是
 * magpie 的数据（症状是「页面能显示，数据一直转圈」）。4xx / 5xx 同样照原样透传，页面自己判。
 *
 * **凭据**：magpie 网页版认 cookie，不认 key。先用 `/?k=<key>` 换一张 cookie（缓存一分钟），
 * 再带上它去问。取不到也照常转发，接口会按 401 如实回，页面能看见。
 *
 * **边界收着**：只代理 `/api/` 前缀（页面资源在扩展包里，不必回头取），只认五个常规方法，
 * 请求体与响应体都有限长（超了如实回错，不硬吃进内存），一条请求有总时限。
 *
 * 纯 Node / ESM，无 cordis 依赖；依赖全部可注入，守卫里不许起真进程、不许真发请求。
 *
 * @module lib/proxy.js
 */

import http from 'node:http'

import { readRawBody, sendJson } from './http-util.js'
import { ensureWeb } from './magpie-web.js'
import { ROUTE_PREFIX } from './paths.js'

/** 请求体的上限：扩展页发来的是「一条请求」，几个 KB 的 JSON 足够，2MB 已经很宽松。 */
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
/** 响应体的上限：几百 KB 是常态（magpie 供应商列表就 324KB），给到 16MB 兜住异常大包。 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
/** 一条代理请求的总时限。目标都是本机服务，慢到这份上就是它自己卡住了。 */
const REQUEST_TIMEOUT_MS = 20000
/** 只放行这几种方法：读、写、删各一个，别的一律当非法。 */
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
/** 只代理 magpie 自己的接口前缀；页面资源由扩展包自带，不必回头取。 */
const ALLOW = ['/api/']

/** 拿 cookie 的结果缓存（端口 + key → { cookie, at }），同一把 key 不必每发一个请求都换一次。 */
const cookieCache = new Map()
const COOKIE_TTL_MS = 60 * 1000

/**
 * magpie 网页版的登录那一跳：`GET /?k=<key>` 会 303 并 `Set-Cookie`，把 key 换成一张 cookie。
 * 后面每条 `/api/*` 都靠这张 cookie 认证。取不到就回空串。
 */
export function magpieCookie(port, key) {
  const cacheKey = `${port}:${key}`
  const hit = cookieCache.get(cacheKey)
  if (hit && Date.now() - hit.at < COOKIE_TTL_MS) return Promise.resolve(hit.cookie)
  return new Promise((resolve) => {
    let done = false
    let req = null
    const finish = (cookie) => {
      if (done) return
      done = true
      try { req?.destroy() } catch { /* 已经断了 */ }
      if (cookie) cookieCache.set(cacheKey, { cookie, at: Date.now() })
      resolve(cookie)
    }
    try {
      req = http.request({
        host: '127.0.0.1',
        port,
        path: `/?k=${encodeURIComponent(key)}`,
        method: 'GET',
        timeout: 5000,
      }, (res) => {
        const raw = res.headers['set-cookie']
        res.resume()
        if (!raw || !raw.length) return finish('')
        // 只取 `name=value` 那一段，属性（Path/HttpOnly…）不进请求头。
        finish(String(raw[0]).split(';')[0])
      })
    } catch {
      return finish('')
    }
    req.on('timeout', () => finish(''))
    req.on('error', () => finish(''))
    req.end()
  })
}

/** 只要这几项响应头：页面解析正文够用了，别把一整套头也搬来搬去。 */
function pickHeaders(headers) {
  const out = {}
  if (headers && typeof headers['content-type'] === 'string') out['content-type'] = headers['content-type']
  return out
}

/**
 * 把一条请求原样代发到 magpie，收集状态码 / 头 / 正文**字节**。
 *
 * 返回 Buffer 而不是 string：magpie 有几条接口回的不一定是 UTF-8（图标、导出文件），
 * 先解码再编码会把字节改坏。失败也回一个形状正常的对象（`status: 0` + 一段带 `code` 的
 * 正文），不抛 —— 调用方要的是「这一条成没成」。
 */
export function proxyRequest(port, cookie, method, path, body, contentType) {
  return new Promise((resolve) => {
    const headers = { accept: 'application/json, */*' }
    if (cookie) headers.cookie = cookie
    const hasBody = Buffer.isBuffer(body) && body.length > 0
    if (hasBody) {
      headers['content-type'] = contentType || 'application/json'
      headers['content-length'] = body.length
    }
    let done = false
    let req = null
    const finish = (result) => {
      if (done) return
      done = true
      resolve(result)
    }
    try {
      req = http.request({
        host: '127.0.0.1',
        port,
        path,
        method,
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        const chunks = []
        let total = 0
        res.on('data', (chunk) => {
          total += chunk.length
          if (total > MAX_RESPONSE_BYTES) {
            try { req.destroy() } catch { /* 已断 */ }
            finish({ status: 0, headers: {}, body: Buffer.from(JSON.stringify({ code: 'response-too-large' })) })
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => finish({
          status: res.statusCode || 0,
          headers: pickHeaders(res.headers),
          body: Buffer.concat(chunks),
        }))
        res.on('error', (error) => finish({
          status: 0,
          headers: {},
          body: Buffer.from(JSON.stringify({ code: 'response-failed', message: String(error.message || error) })),
        }))
      })
    } catch (error) {
      return finish({
        status: 0,
        headers: {},
        body: Buffer.from(JSON.stringify({ code: 'request-failed', message: String(error.message || error) })),
      })
    }
    req.on('timeout', () => {
      try { req.destroy() } catch { /* 已断 */ }
      finish({ status: 0, headers: {}, body: Buffer.from(JSON.stringify({ code: 'timeout' })) })
    })
    req.on('error', (error) => finish({
      status: 0,
      headers: {},
      body: Buffer.from(JSON.stringify({ code: 'request-failed', message: String(error.message || error) })),
    }))
    if (hasBody) req.write(body)
    req.end()
  })
}

/**
 * 写一个**真实的 HTTP 响应**：状态码、content-type、正文都由上游决定。
 *
 * 与 `sendJson` 的差别就在这：这条不包信封。上一跳会把 status 与正文原样交给页面，
 * 包一层会让页面的 `res.json()` 读到我们的外壳。
 */
export function sendRaw(res, status, headers, body) {
  const out = { ...(headers || {}) }
  if (!out['content-type']) out['content-type'] = 'application/octet-stream'
  out['cache-control'] = 'no-store'
  out['content-length'] = body ? body.length : 0
  try {
    res.writeHead(status, out)
    res.end(body || Buffer.alloc(0))
  } catch {
    /* 连接已关闭 */
  }
}

/** 这一层自己的失败：状态码照实给（页面按 HTTP 语义判），正文还是这个插件的失败口径。 */
function fail(res, status, code, message) {
  return sendJson(res, status, { ok: false, error: { code, ...(message === undefined ? {} : { message }) } })
}

/** 路径必须落在这个本源内的 `/api/` 下：不以 `/` 开头、`//host`、别的前缀一律拒。 */
function pathAllowed(pathname) {
  return ALLOW.some((prefix) => pathname.startsWith(prefix))
}

/** 去掉路由前缀，留下「路径 + 查询串」交给上游。前缀可能已被宿主剥掉，也可能还在。 */
function targetOf(url) {
  const raw = url.pathname.startsWith(ROUTE_PREFIX)
    ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
    : url.pathname
  return `${raw}${url.search}`
}

/**
 * 建透明代理 handler。
 *
 * 依赖全可注入（`ensureWebFn` / `cookieFn` / `proxyFn`）：守卫里把「起进程」与「真发请求」
 * 整个换掉，一条测试都不许因为跑它的机器上正好开着 magpie 而变绿或变红。
 *
 * @param {object} [deps]
 * @returns {(ctx: object, req: object, res: object) => Promise<void>}
 */
export function createProxyHandler(deps = {}) {
  const ensure = deps.ensureWebFn ?? ensureWeb
  const cookie = deps.cookieFn ?? magpieCookie
  const proxy = deps.proxyFn ?? proxyRequest

  return async function handleProxy(_ctx, req, res) {
    const url = new URL(req?.url ?? '/', 'http://localhost')
    const method = String(req?.method ?? 'GET').toUpperCase()
    if (!METHODS.has(method)) return fail(res, 405, 'method-not-allowed', `不支持的方法：${method}`)
    if (!pathAllowed(url.pathname.startsWith(ROUTE_PREFIX)
      ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
      : url.pathname)) {
      return fail(res, 403, 'path-not-allowed', '这个服务只代理 /api/ 下的路径')
    }

    // 先收完整请求体再转发：上游要 content-length，而宿主可能已经把流读掉一半。
    const raw = await readRawBody(req, MAX_REQUEST_BYTES)
    if (!raw.ok) return fail(res, 413, 'request-too-large', '请求体超过 2MB')

    let entry
    try {
      entry = await ensure({})
    } catch {
      entry = { available: false, reason: 'unexpected' }
    }
    if (!entry || !entry.available) {
      return fail(res, 503, 'service-unavailable', `magpie 现在不可用：${(entry && entry.reason) || 'unavailable'}`)
    }

    let cookieValue = ''
    try { cookieValue = await cookie(entry.port, entry.key) } catch { cookieValue = '' }

    const contentType = typeof req?.headers?.['content-type'] === 'string' ? req.headers['content-type'] : undefined
    const result = await proxy(entry.port, cookieValue, method, targetOf(url), raw.body, contentType)
    return sendRaw(res, result.status || 0, result.headers, result.body)
  }
}

export { ALLOW, METHODS, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS }
