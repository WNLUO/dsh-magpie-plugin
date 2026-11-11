/**
 * 这个插件的**路径与命名空间**：落在别人机器上的每一处名字只在这里算一次。
 *
 * 为什么要集中：这个插件会和别的 DSH 插件装在同一台机器上，冲突最可能发生在三处 ——
 * HTTP 路由前缀、`host.data` 的服务名、magpie 网页版那把登录钥匙的存放位置。三处都在
 * 这一份里拼，别处一律从这里取。
 *
 * 刻意避开的名字：
 *  - `/api/mobile/v1/*`（DSH Mobile 移动端插件的移动 API）
 *  - `/api/dsh-mobile-canvas/*`（画布插件）
 *  - `/api/*` 本身：magpie 网页版的接口是 `/api/state` 这类裸路径，直接挂在宿主端口上会和
 *    DSH 自己的 `/api/*` 撞车，所以整段挪进 `/api/dsh-magpie/` 前缀下，扩展页再把它换回来。
 *
 * 纯 Node / ESM，无 cordis 依赖，测试可以直接 import。
 *
 * @module lib/paths.js
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 路由前缀。手机扩展 `extensions/magpie/manifest.json` 的 `hostData.match` 与
 * `package.json` 的 `dshMobileDataServices[].allow` 都要盖住它。
 */
export const ROUTE_PREFIX = '/api/dsh-magpie'

/** `host.data` 用的服务名（扩展清单 `hostData.service` 写的就是这个）。 */
export const SERVICE_NAME = 'dsh-magpie'

/** 扩展包在包内的目录（`package.json` 的 `dshMobileExtensions` 指的就是它）。 */
export const EXTENSION_DIR = 'extensions'
/** 扩展包的 slug（目录名，也是手机侧的包身份）。 */
export const EXTENSION_SLUG = 'magpie'

/** `$DSH_HOME`：与宿主自己那套一致，默认 `~/.dsh`。 */
export function dshHome() {
  const explicit = process.env.DSH_HOME
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit.trim())
  return join(homedir(), '.dsh')
}

/**
 * magpie 网页版登录钥匙的落盘位置。
 *
 * 沿用 DSH Mobile 移动端插件原来那个文件名（`~/.dsh/magpie-web-key`），不是图省事 ——
 * 过渡期两半同时装着，共用一把钥匙才不会出现「一边认领得上、一边认领不上」。
 * `MAGPIE_WEB_KEY_FILE` 可以改。
 */
export function keyFile(env = process.env) {
  const explicit = typeof env.MAGPIE_WEB_KEY_FILE === 'string' ? env.MAGPIE_WEB_KEY_FILE.trim() : ''
  if (explicit !== '') return resolve(explicit)
  return join(dshHome(), 'magpie-web-key')
}
