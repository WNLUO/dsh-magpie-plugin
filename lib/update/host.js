/**
 * 「让跑着的宿主把盘上这份重新装一遍」：找宿主端口、调那条本机调试路由。
 *
 * 两件事分开写是为了能被守卫直接测：找端口只看「谁答得出宿主自己的插件事件流」，调路由只看
 * 那一条请求的结果。真跑时端口由 lsof + 探测定，测试里全部注入。
 *
 * ## 为什么按 `/plugins/events` 认宿主
 *
 * 只看状态码不够：本机上随便一个服务也能回 200，重载就打到别人身上去了（实测踩过：挑到一个
 * 回 `appVersion` 的服务，重载「成功」了但没生效）。`/plugins/events` 是宿主自己的插件图
 * 事件流，回的是 `text/event-stream`，别的服务不会长这样。
 *
 * @module lib/update/host.js
 */

import { execFileSync } from 'node:child_process'

/** 装完要调的那条本机调试路由（插件里实现；没有就走「重启一次」那条）。 */
export const RELOAD_PATH = '/api/dsh-magpie/dev/reload'

/**
 * 那条路由只认带这个头的请求。
 *
 * 光看回环不够：手机上经 `host.data` 转来的请求落点也是宿主回环地址，靠地址分辨不出「这是
 * 本机运维」还是「手机页面在调」。这个头是那道闸的一半（另一半在插件里），值不校验。
 */
export const RELOAD_HEADER = 'x-dsh-dev-reload'

/** 常见端口先试：桌面端的 web 口是随机挑的，这几个只是省掉一次扫描。 */
export const COMMON_PORTS = [60215, 19387, 19388, 3080, 52772]

/** 本机正在听的那批端口（用 lsof 读；读不到就只试常用那几个）。 */
export function listeningPorts({ lsofRunner } = {}) {
  const run =
    lsofRunner ||
    (() =>
      execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'n'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }))
  try {
    const raw = run()
    const ports = new Set()
    for (const line of String(raw).split('\n')) {
      if (!line.startsWith('n')) continue
      const match = /:(\d+)$/.exec(line.slice(1))
      if (match) ports.add(Number(match[1]))
    }
    return [...ports]
  } catch {
    return []
  }
}

/** 这个端口是不是一台在跑的 DSH 宿主。 */
export async function isHostPort(port, { fetchImpl = globalThis.fetch, timeoutMs = 800 } = {}) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/plugins/events`, {
      headers: { accept: 'text/event-stream', [RELOAD_HEADER]: '1' },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    if (!res.ok) return false
    return String(res.headers.get('content-type') ?? '').includes('text/event-stream')
  } catch {
    return false
  }
}

/**
 * 找出宿主端口。
 *
 * 指定端口优先（`--port`），其次常用端口，最后扫一遍本机在听的端口。
 */
export async function findHostPort({ explicit = null, common = COMMON_PORTS, ports = null, ...probeOptions } = {}) {
  if (Number.isInteger(explicit) && explicit > 0) return explicit
  for (const port of common) {
    if (await isHostPort(port, probeOptions)) return port
  }
  for (const port of ports ?? listeningPorts(probeOptions)) {
    if (common.includes(port)) continue
    if (await isHostPort(port, probeOptions)) return port
  }
  return null
}

/**
 * 调一次就地重载。
 *
 * 四种结果分开说，因为它们要人做的事完全不同：
 *
 *  · `reloaded` —— 换掉了，不用重启；
 *  · `no-route` —— 这个进程里还没有那条路由（跑着的还是旧的一份）：装是装进去了，
 *    重启一次 DSH 就从这一版起，**之后**这条路一直在。它不是失败；
 *  · `no-host` —— 没找到在跑的宿主（这条接口只在 `dsh web` 开着时应答）；
 *  · `failed` —— 路由在，但它说换不了（装载失败之类）：盘上换了、跑着的还是旧代码。
 *
 * @returns {Promise<{status: 'reloaded'|'no-route'|'no-host'|'failed', detail?: string}>}
 */
export async function reloadInPlace({
  explicitPort = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  ports = null,
  common = COMMON_PORTS,
} = {}) {
  const port = await findHostPort({ explicit: explicitPort, common, ports, fetchImpl })
  if (port === null) return { status: 'no-host' }
  let response
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}${RELOAD_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RELOAD_HEADER]: '1' },
      body: '{}',
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    })
  } catch (error) {
    return { status: 'no-host', detail: `调不到 ${RELOAD_PATH}：${error?.message || error}` }
  }
  const body = await response.json().catch(() => null)
  if (response.ok && body?.ok === true) return { status: 'reloaded', detail: `端口 ${port}` }
  // 401 / 403 / 404 在这套宿主上都是「这条路由不存在」的统一说法：控制面对未知路径也回 401，
  // 而插件里那条闸对没带头或缺信任的请求回 403。三种都只说明一件事 —— 跑着的进程里还没有它。
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return { status: 'no-route', detail: `这个宿主进程里还没有 ${RELOAD_PATH}（HTTP ${response.status}）` }
  }
  const reason = body?.error?.message || body?.error?.code || `HTTP ${response.status}`
  return { status: 'failed', detail: String(reason) }
}
