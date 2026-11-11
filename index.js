/**
 * magpie 插件的宿主半身。
 *
 * 三件事：
 *  1. 让这个包**存在**：profile 的 `node_modules` 里有它、`package.json` 里有
 *     `dshMobileExtensions` 与 `dshMobileDataServices` 两格，手机扫插件目录时就能把它带的
 *     扩展列进清单，扩展页也才能经 `host.data` 读到 `/api/dsh-magpie/*`。
 *  2. 把 magpie 的 HTTP 路由挂到宿主 `webServer` 上（`/api/dsh-magpie/*`，见 `lib/routes.js`）。
 *  3. 注册的是**转发壳**而不是一条固定的 handler：开发时 `POST /dev/reload` 能把实现模块
 *     重载一遍，已注册的路由原地换成新代码（见 `lib/reload.js`），改一行不必重启整台宿主机。
 *
 * 装载失败只记日志、不抛出：入口模块导入失败会让整个 DSH 起不来，而少一个 magpie 只是少了
 * 一个功能。以「插件多半还能用」换「绝不拖垮宿主」。
 *
 * 本仓库是 ESM（`type: module`）。
 *
 * @module index.js
 */

import { ROUTE_PREFIX } from './lib/paths.js'
import { createReloadable } from './lib/reload.js'

export const name = 'dsh-magpie-plugin'

/** 挂路由要等宿主发布 `webServer`；等不到就一直 pending，不会拖垮宿主。 */
export const inject = ['webServer']

function describeError(error) {
  return String(error?.message ?? error).slice(0, 300)
}

/**
 * 挂载：等 `webServer` 起来，把 prefix 路由注册上去。
 *
 * `ctx.inject(deps, cb)` 在服务缺席或尚未发布时让回调 pending，服务被替换时会重跑 ——
 * 这正是要的：真实 web composition 里插件先于 `webServer` 加载，若在 apply 时直接
 * `ctx.get('webServer')` 只会拿到 undefined，路由就永远注册不上。
 *
 * 注册本身包在 try 里：注册失败只记日志，不往上抛。
 */
export function apply(ctx) {
  const log = (level, message) => {
    const fn = ctx?.logger?.[level]
    if (typeof fn === 'function') fn.call(ctx.logger, message)
  }

  try {
    const app = createReloadable()
    ctx.inject(['webServer'], (scoped) => {
      const server = scoped.webServer
      scoped.effect(() => {
        try {
          return server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: app.handler })
        } catch (error) {
          log('error', `[dsh-magpie] 路由注册失败（${describeError(error)}）`)
          return undefined
        }
      }, 'dsh-magpie: api routes')
      log('info', `[dsh-magpie] magpie 接口已挂到 ${ROUTE_PREFIX}`)
    })
  } catch (error) {
    log('error', `[dsh-magpie] 插件装载失败（${describeError(error)}）`)
  }
}
