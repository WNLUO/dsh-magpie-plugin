/**
 * 「有没有新版」由插件自己回答：直接问 npm 注册表（`<registry>/<name>/latest`）。
 *
 * 绕开插件市场的理由很具体：市场没装、太老或坏了，「检查更新」就整个答不出来。一条
 * `GET` 就够，解析出来的只有版本号那一个字段。
 *
 * 边界：这里只查不装，不碰 profile、不写盘。`source`（盘上是怎么装的）由调用方给，本模块
 * 只透传，不会为它去敲市场。判据是「线上版本严格大于盘上版本」—— 线上更旧一律报没有新版，
 * 「这次更新会降级」必须由版本比较判定，不能只凭注册表回了什么。
 *
 * 纯 Node / ESM，`fetchImpl` 与 `now` 都能注入，守卫里可以直接喂假返回。
 *
 * @module lib/update/registry.js
 */

/** 默认注册表：官方源。私有镜像 / 测试用 `DSH_MAGPIE_NPM_REGISTRY` 覆盖。 */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** 本插件的 npm 包名（`package.json` 的 name）。 */
export const DEFAULT_NAME = 'dsh-magpie-plugin'

/** 一次查询的上限：查更新是背景动作，宁可如实报「连不上」也不要挂住终端。 */
export const REQUEST_TIMEOUT_MS = 8000

/** 注册表地址（去掉末尾斜杠；空串当没设）。 */
export function registryBase(env = process.env) {
  const value = typeof env?.DSH_MAGPIE_NPM_REGISTRY === 'string' ? env.DSH_MAGPIE_NPM_REGISTRY.trim() : ''
  return value ? value.replace(/\/+$/, '') : DEFAULT_REGISTRY
}

/**
 * 版本号比较：只认 `x.y.z` 的三段数字，返回正数表示 `a` 比 `b` 新。
 *
 * 预发布后缀（`-rc.1`）按主段比，缺段补 0。与移动端插件那份（`lib/update-registry.cjs`）
 * 同一口径：两份都是十几行，语义必须一致。
 */
export function compareVersion(a, b) {
  const left = String(a || '0').split('-')[0].split('.').map(Number)
  const right = String(b || '0').split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const l = Number.isFinite(left[i]) ? left[i] : 0
    const r = Number.isFinite(right[i]) ? right[i] : 0
    if (l !== r) return l - r
  }
  return 0
}

/** 注册表的错误：带上一个稳定 code，调用方照着说人话。 */
export class RegistryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
  }
}

/**
 * 问一次「线上最新是几」。
 *
 * `fetchImpl` 注入只为测试（真跑时用全局 fetch）；`timeoutMs` 同理。
 */
export async function latestVersion({ base, name = DEFAULT_NAME, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new RegistryError('registry-unavailable', '这个运行时里没有 fetch，问不了 npm 注册表')
  }
  const url = `${base || registryBase()}/${name}/latest`
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  let response
  try {
    response = await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    })
  } catch (error) {
    throw new RegistryError('registry-unreachable', `连不上 npm 注册表：${error?.message ? error.message : error}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!response || response.ok !== true) {
    const status = response && Number.isFinite(response.status) ? response.status : 0
    if (status === 404) throw new RegistryError('registry-not-found', `npm 上找不到 ${name}（404）`)
    throw new RegistryError(`registry-http-${status || 'unknown'}`, `npm 注册表返回 HTTP ${status || '未知'}`)
  }
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  const version = body && typeof body.version === 'string' ? body.version.trim() : ''
  if (!version) throw new RegistryError('registry-bad-response', 'npm 注册表没有给出可读的版本号')
  return version
}

/**
 * 查一次更新。
 *
 * `installedVersion` 由调用方给（profile 里那份的版本号）；给不出来时如实返回
 * `installedVersion: null` + `updateAvailable: false` —— 比不出来就不喊「有新版」，
 * 免得把人引去装一次什么都没变的更新。
 */
export async function checkForUpdate({
  installedVersion = null,
  source = null,
  base,
  name = DEFAULT_NAME,
  fetchImpl,
  timeoutMs = REQUEST_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const latest = await latestVersion({ base, name, fetchImpl, timeoutMs })
  const installed = typeof installedVersion === 'string' && installedVersion ? installedVersion : null
  return {
    installedVersion: installed,
    latestVersion: latest,
    updateAvailable: installed !== null && compareVersion(latest, installed) > 0,
    source: typeof source === 'string' && source ? source : null,
    checkedAt: new Date(now()).toISOString(),
  }
}
