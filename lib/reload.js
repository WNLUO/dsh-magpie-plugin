/**
 * 开发用热重载：把插件的**实现模块**重新导入一遍，并让已经注册的那条路由换成新的 handler。
 *
 * **为什么要这一层**：宿主在进程启动时把插件模块 `import` 进来，Node 的 ESM 缓存就此钉住 ——
 * 改 `lib/` 里的代码，跑着的宿主仍是旧的那一份，只能重启 DSH。开发时改一行就重启一次整台
 * 宿主太贵，所以这里给一个**最小但真的换掉代码**的办法：带 `?rev=N` 重新 `import`，拿到新的
 * 模块实例，再用它重建 handler。
 *
 * **换得掉什么、换不掉什么**（照实说，别让人以为全都能热更）：
 *  - 换得掉 `lib/routes.js` / `lib/magpie-web.js` / `lib/proxy.js`；
 *  - 换不掉 `index.js` 自己（宿主那边已经拿着这个实例）；
 *  - 换不掉 `lib/paths.js` 那几格（路由前缀、服务名是契约，换它等于换一份身份）。
 *
 * 路由在注册时只拿到**一个** handler 引用，所以这里注册的是转发壳：每次调用都去问当前那一份，
 * 重载只是把「当前」换掉 —— 已注册的路由原地生效，不必重新 register。
 *
 * 纯 Node / ESM，无 cordis 依赖。
 *
 * @module lib/reload.js
 */

import { ROUTE_PREFIX, SERVICE_NAME } from './paths.js'
import { createRoutes } from './routes.js'
import { createWebHandler } from './magpie-web.js'
import { createProxyHandler } from './proxy.js'

/** 实现模块清单：重载时逐个带 `?rev` 重新导入，再把它们的工厂接进新的 routes。 */
const IMPL_MODULES = ['./routes.js', './magpie-web.js', './proxy.js']

/**
 * 带版本号导入实现模块。
 *
 * 为什么逐个导入而不是只导 `routes.js`：ESM 的缓存按 URL 算，`routes.js?rev=2` 里那句
 * `import './proxy.js'` 仍指回**已经缓存**的那一份。所以三个模块各自带 `?rev`，再由这里把
 * 它们的工厂显式喂给 `createRoutes`（它支持注入），整组才是真的换新的。
 */
async function importImpl(rev) {
  const base = new URL('./', import.meta.url)
  const tag = rev > 0 ? `?rev=${rev}` : ''
  const loaded = await Promise.all(IMPL_MODULES.map((name) => import(new URL(`${name}${tag}`, base).href)))
  const [routes, web, proxy] = loaded
  return { routes, web, proxy }
}

/**
 * 建一个可热换的路由壳。
 *
 * @param {object} [options]
 * @param {object} [options.deps] 透给 `createRoutes`（测试里换掉起进程 / 发请求那一层）
 * @returns {{ handler: Function, reload: Function, state: Function }}
 */
export function createReloadable({ deps = {} } = {}) {
  let current = null
  let rev = 0
  let inFlight = null

  /**
   * 重载一轮。并发调用的都搭同一次的车 —— 两边各换一次，后一次会把前一次刚建好的丢掉。
   *
   * @returns {Promise<{ rev: number, reloaded: true, modules: string[] }>}
   */
  async function reload() {
    if (inFlight) return inFlight
    inFlight = (async () => {
      const next = rev + 1
      const loaded = await importImpl(next)
      current = loaded.routes.createRoutes({
        createWebHandler: loaded.web.createWebHandler,
        createProxyHandler: loaded.proxy.createProxyHandler,
        reload,
        ...deps,
      })
      rev = next
      return { rev, reloaded: true, modules: IMPL_MODULES.map((name) => name.slice(2)) }
    })()
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  /** 第一次调用时把静态那一份装上（`import()` 同一组 URL 走缓存，不必绕）。 */
  function ensureCurrent() {
    if (current !== null) return
    current = createRoutes({ createWebHandler, createProxyHandler, reload, ...deps })
  }

  /** 已注册路由的转发壳：每次调用都去问当前那一份。 */
  async function handler(ctx, req, res) {
    ensureCurrent()
    return current(ctx, req, res)
  }

  return {
    handler,
    reload,
    /** 给 `/dev/reload` 的回包：这一代是第几轮、插件身份有没有被动过。 */
    state: () => ({ rev, loaded: rev > 0, routePrefix: ROUTE_PREFIX, service: SERVICE_NAME }),
  }
}
