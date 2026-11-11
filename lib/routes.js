/**
 * magpie 插件的 HTTP 路由层。
 *
 * 全部挂在 `ROUTE_PREFIX`（`/api/dsh-magpie`，见 `lib/paths.js`）下面：
 *   - `GET /web`         —— 能力探测：本机 magpie 网页版在哪、用什么 key（手机不调它，留着调试）
 *   - `ANY /api/...`     —— **透明代理**，见下
 *   - `POST /dev/reload` —— 本机开发用：重新加载本插件的实现模块（要本机回环 + 专用请求头）
 *
 * **为什么是透明代理而不是一条 `POST /data`**：手机那条通用通道把页面发来的 `/api/state`
 * 原样（连同 method、正文、content-type）转到宿主自己的端口上，落到这里；它只认「目标服务的
 * 真实响应」。所以剥掉前缀之后凡是 `/api/` 开头的请求一律原样转给 magpie 网页版，回包也是
 * 真实状态码 + 真实正文，不包信封。包了信封，页面 `res.json()` 读到的就是我们的外壳。
 *
 * `handler` 的形状与宿主 `webServer.register({ kind:'prefix', handler })` 对得上：
 * `(ctx, req, res)`，返回 Promise。前缀可能已经被宿主剥掉，也可能原样交过来 —— 两种都认，
 * 好让同一条 handler 在测试里直接拿完整 URL 喂进来。
 *
 * 依赖（`deps.createWebHandler` / `deps.createProxyHandler` / `deps.reload`）由入口注入：
 * 热重载要能整组换成新实例，守卫里则把「起进程 / 真发请求」换成假体。
 *
 * 纯 Node / ESM，无 cordis 依赖，测试可以直接 import。
 *
 * @module lib/routes.js
 */

import { ROUTE_PREFIX } from './paths.js'
import { createWebHandler } from './magpie-web.js'
import { createProxyHandler } from './proxy.js'

/** 只放行这几种方法：读、写、删各一个，别的一律当非法。 */
const PROXY_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** 回一句「没有这条路」。 */
function notFound(res) {
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ ok: false, error: { code: 'not-found', message: 'unknown route' } }))
}

/** 回一句「方法不对」。 */
function methodNotAllowed(res) {
  res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } }))
}

/**
 * 开发路由的放行判据：本机回环 **且** 带了 `x-dsh-dev-reload` 请求头。
 *
 * 为什么光看回环地址不够：手机那条 `host.data` 通道最后的落点也是宿主自己的回环地址（请求由
 * 宿主进程代发），所以「127.0.0.1」区分不出「开发脚本」与「扩展页」。而那条通道只转 method /
 * 正文 / content-type，**不转发自定义请求头** —— 用一个自定义头当凭据，恰好把扩展页挡在外面，
 * 又不牵扯发令牌那一套。转发头（`x-forwarded-for` / `forwarded`）出现时同样拒。
 */
export function isLocalRequest(req) {
  const headers = req?.headers || {}
  if (headers['x-forwarded-for'] || headers['forwarded']) return false
  if (!headers['x-dsh-dev-reload']) return false
  const addr = String(req?.socket?.remoteAddress || '')
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/**
 * 建前缀路由 handler。
 *
 * @param {object} [deps]
 * @param {Function} [deps.createWebHandler]  能力探测那条 handler 的工厂
 * @param {Function} [deps.createProxyHandler] 透明代理的工厂
 * @param {Function} [deps.reload]            `() => Promise<{ rev, loaded }>`，重新加载实现模块
 * @returns {(ctx: object, req: object, res: object) => Promise<void>}
 */
export function createRoutes(deps = {}) {
  const ensureWebDeps = {
    ...(deps.ensureWebFn ? { ensureWebFn: deps.ensureWebFn } : {}),
    ...(deps.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
    ...(deps.probe ? { probe: deps.probe } : {}),
    ...(deps.portFreeFn ? { portFreeFn: deps.portFreeFn } : {}),
    ...(deps.probeKeyFn ? { probeKeyFn: deps.probeKeyFn } : {}),
    ...(deps.findBinaryFn ? { findBinaryFn: deps.findBinaryFn } : {}),
  }
  const webHandler = (deps.createWebHandler ?? createWebHandler)(ensureWebDeps)
  const proxyHandler = (deps.createProxyHandler ?? createProxyHandler)({
    ensureWebFn: deps.ensureWebFn,
    cookieFn: deps.cookieFn,
    proxyFn: deps.proxyFn,
  })

  /** `POST /dev/reload`：把实现模块重载一遍，回这次装上的那一代。 */
  async function handleDevReload(_ctx, req, res) {
    if (!isLocalRequest(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: { code: 'not-local', message: '开发路由只对本机开发脚本开放' } }))
      return
    }
    let result
    try {
      result = typeof deps.reload === 'function'
        ? await deps.reload()
        : { rev: 0, loaded: [], reloaded: false }
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        ok: false,
        error: { code: 'reload-failed', message: String(error?.message ?? error).slice(0, 300) },
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, ...result }))
  }

  return async function handler(ctx, req, res) {
    const url = new URL(req?.url ?? '/', 'http://localhost')
    const stripped = url.pathname.startsWith(ROUTE_PREFIX)
      ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
      : url.pathname
    const routePath = stripped.replace(/\/+$/, '') || '/'
    const method = String(req?.method ?? 'GET').toUpperCase()

    if (routePath === '/web') {
      if (method !== 'GET') return methodNotAllowed(res)
      return webHandler(ctx, req, res)
    }
    if (routePath === '/dev/reload') {
      if (method !== 'POST') return methodNotAllowed(res)
      return handleDevReload(ctx, req, res)
    }
    // 剩下的一切 `/api/...` 走透明代理；别的前缀没有理由存在。
    if (stripped.startsWith('/api/')) {
      // 方法不对回 405 而不是 404：路径明明存在，别让人照着 404 去查路由表。
      if (!PROXY_METHODS.has(method)) return methodNotAllowed(res)
      return proxyHandler(ctx, req, res)
    }
    return notFound(res)
  }
}

export default createRoutes
