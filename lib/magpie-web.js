/**
 * magpie 网页版：把这台电脑上 magpie 自带的那个网页界面端给手机，需要时替它起来。
 *
 * **为什么是「网页版」这件事本身**：手机扩展里的页面是 magpie 原版前端的快照（`web/` → 构建
 * 进 `extensions/magpie/`），数据要落回这台电脑上的 magpie。网页版就是它自己的服务端 ——
 * `/api/state`、`/api/settings` 那些。这个模块负责两件事：找到它、需要时把它拉起来，再把
 * 「在哪、凭什么」交出去。
 *
 * **为什么 key 要稳定**：magpie 网页版每次运行随机一把 key（除非设了 `MAGPIE_WEB_KEY`），
 * 页面拿 `/?k=<key>` 换一张 cookie 之后才认。插件热重载 / 宿主重启时内存里那份记录会没，
 * 而网页版进程是 detached 的、还活着 —— 若这时现造一把新 key，就跟在跑的那个对不上，用户被
 * 要求自己去设环境变量。所以按「用户设的 → 上次落盘的 → 现造并落盘」取，落盘位置由
 * `lib/paths.js` 的 `keyFile()` 定（与原移动端插件同一个文件名，过渡期两半共用一把）。
 *
 * **key 是凭据**：只出现在 `ensureWeb` 的返回值与 `handleMagpieWeb` 那一份回包里，不进日志。
 *
 * 纯 Node / ESM，无 cordis 依赖，测试可以直接 import。
 *
 * @module lib/magpie-web.js
 */

import { spawn as spawnImpl } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { sendJson } from './http-util.js'
import { keyFile } from './paths.js'

/** 网页版默认端口（magpie 自己的缺省）。 */
const DEFAULT_WEB_PORT = 3430
/** 起来之后最多等这么久让它把页面端出来。冷启动实测 3~6 秒（要读各家配置与订阅）。 */
const START_TIMEOUT_MS = 25000
/** 探测间隔。 */
const POLL_MS = 250
/** 上面等不到时的退避：同一个端口短时间内不反复起进程。 */
const START_COOLDOWN_MS = 5000

/** key 只要够长、能进查询串；magpie 自己要求 16 位以上字母数字与 `-._~`。 */
const KEY_RE = /^[A-Za-z0-9._~-]{16,}$/

/** 正在起来的那个：同一时刻只许一个（连点两下不该起两个进程）。 */
let starting = null
/**
 * 我们自己起的那个进程用的 key（端口 → key）。
 *
 * **必须记住**：没设 `MAGPIE_WEB_KEY` 时 key 是这里现造的，而那一次运行之内它一直有效 ——
 * 第二次点开时进程已经在跑，如果不记得当初用了哪把，就只能回「拿不到凭据」，用户看到的是
 * 「第一次能开、第二次打不开」。进程随插件重载消失，这份记录也跟着走。
 */
const startedKeys = new Map()
/**
 * 上次起失败的时刻与原因（按端口记）：失败之后短时间内不再对**同一个端口**反复试。
 *
 * 按端口而不是全局：一个端口被别的东西占着起不来，不该把另一个能用的端口也一起封住。
 */
const failures = new Map()

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 网页版该占哪个端口。
 *
 * magpie 自己的默认是 3430；`settings.json` 里没有单独的「网页版端口」这一项（那是命令行
 * 参数），所以这里只认 `$MAGPIE_WEB_PORT` 与默认值。端口被别的东西占着时往上找几个。
 */
export function preferredPort(env = process.env) {
  const raw = Number(text(env.MAGPIE_WEB_PORT))
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_WEB_PORT
}

/**
 * 这个端口上是不是已经有一个 magpie 网页版在答。
 *
 * 判据是它回 303/302（`/?k=` 换 cookie 那一跳）或 401（认得出是它、只是没带 key）——
 * 别的程序占着这个端口时不会这么答。不带 key 请求，所以这条探测不会泄漏任何东西。
 */
export function probeWeb(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* 已经断了 */ }
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.on('error', () => finish(false))
    socket.on('connect', () => {
      socket.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n'
        + 'User-Agent: dsh-magpie-plugin\r\n\r\n',
      )
    })
    let raw = ''
    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1')
      if (raw.length > 2048) raw = raw.slice(0, 2048)
      const status = raw.match(/^HTTP\/1\.[01] (\d{3})/)
      if (!status) return
      const code = Number(status[1])
      // 303/302 = 有 key 就换 cookie 的那一跳；401 = 是它、但这次没给 key。
      finish(code === 303 || code === 302 || code === 401)
    })
    socket.on('close', () => finish(false))
  })
}

/** 端口空着没有（起进程前先看一眼，别去撞一个不认识的程序）。 */
export function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    let done = false
    const finish = (free) => {
      if (done) return
      done = true
      try { server.close() } catch { /* 没起来 */ }
      resolve(free)
    }
    server.once('error', () => finish(false))
    server.listen(port, '127.0.0.1', () => finish(true))
    server.unref()
  })
}

/**
 * 找一个「能端东西」的端口：优先默认，被占了就往上找几个。
 *
 * 回 `{ port, running }`：`running` 是「这个端口上已经有一个 magpie 网页版」——
 * 光空着不够，能认领现成的那个更好。两个探测都能注入，测试里不碰真网络。
 */
export async function pickPort(env = process.env, { probe = probeWeb, portFreeFn = portFree } = {}) {
  const base = preferredPort(env)
  for (let offset = 0; offset < 10; offset += 1) {
    const port = base + offset
    if (await probe(port, 600)) return { port, running: true }
    if (await portFreeFn(port)) return { port, running: false }
  }
  return null
}

/**
 * 只找空端口，别的不管。
 *
 * 与 `pickPort` 的差别就在这一行：`ensureWeb` 要起自己的进程，而这时**不能**挑一个「在跑
 * 但不是我们的」端口 —— 那上面已经有个别人家的 magpie（或别的程序）了。所以它只认「空着」。
 */
async function pickFreePort(env, portFreeFn) {
  const base = preferredPort(env)
  for (let offset = 0; offset < 10; offset += 1) {
    const port = base + offset
    if (await portFreeFn(port)) return port
  }
  return null
}

/**
 * 找 magpie 可执行文件。
 *
 * magpie 三个桌面系统都有（菜单栏 / 窗口 / TUI / 网页 / CLI 是同一个程序的不同入口），
 * 装法也各不相同，所以按「先 PATH、再各系统的常规落点」找，别只认 macOS 那一个 .app 包：
 *   - PATH：`install.sh` 与 `go install` 都往某个 bin 目录里放一个 `magpie`（Windows 是
 *     `magpie.exe`），只要那个目录在 PATH 上就能直接命中。
 *   - macOS：官方 .app 包里的可执行文件，外加 Homebrew 的两个前缀。
 *   - Windows：安装器放在 `%LOCALAPPDATA%\Programs\magpie`、`%ProgramFiles%\magpie`；
 *     `go install` 落在 `%USERPROFILE%\go\bin`。
 *   - Linux：`~/.local/bin`、`/usr/local/bin`、`/usr/bin`、`/opt/magpie`，以及 `go install`
 *     的 `~/go/bin`。
 *
 * `MAGPIE_BIN` 给了就只认它：用户明确指了一条路径，指错时如实回「找不到」，而不是悄悄去
 * PATH 里找另一个 —— 那样排查起来是「我明明改了变量，它却还在跑旧的那个」。
 */
export function findBinary(env = process.env) {
  const explicit = text(env.MAGPIE_BIN)
  if (explicit) return isExecutable(explicit) ? explicit : null
  const home = os.homedir()
  const names = process.platform === 'win32' ? ['magpie.exe', 'magpie'] : ['magpie']
  const candidates = []
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) candidates.push(path.join(dir, name))
  }
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Magpie.app/Contents/MacOS/magpie')
    candidates.push(path.join(home, 'Applications', 'Magpie.app', 'Contents', 'MacOS', 'magpie'))
    candidates.push('/opt/homebrew/bin/magpie')
    candidates.push('/usr/local/bin/magpie')
  } else if (process.platform === 'win32') {
    const local = text(env.LOCALAPPDATA)
    if (local) candidates.push(path.join(local, 'Programs', 'magpie', 'magpie.exe'))
    for (const key of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
      const base = text(env[key])
      if (base) candidates.push(path.join(base, 'magpie', 'magpie.exe'))
    }
    candidates.push(path.join(home, 'go', 'bin', 'magpie.exe'))
  } else {
    candidates.push(path.join(home, '.local', 'bin', 'magpie'))
    candidates.push('/usr/local/bin/magpie')
    candidates.push('/usr/bin/magpie')
    candidates.push('/opt/magpie/magpie')
    candidates.push(path.join(home, 'go', 'bin', 'magpie'))
  }
  for (const file of candidates) {
    if (isExecutable(file)) return file
  }
  return null
}

/** 这个路径上是不是一个能执行的文件。 */
function isExecutable(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 网页版这次用的 key：只按「环境变量或现造」判定（纯函数，方便单测）。
 *
 * `ensureWeb` 实际用的是 `resolveKey`：多一层「上次留下的那份」。
 */
export function webKey(env = process.env) {
  const given = text(env.MAGPIE_WEB_KEY)
  if (KEY_RE.test(given)) return given
  // 32 位十六进制，够长且只含字母数字。
  return randomBytes(16).toString('hex')
}

/** 读上次留下的 key；没有 / 不合规就回空串。 */
export function readStoredKey(env = process.env) {
  try {
    const value = fs.readFileSync(keyFile(env), 'utf8').trim()
    return KEY_RE.test(value) ? value : ''
  } catch {
    return ''
  }
}

/** 留一份 key 给下次用（0600，只有当前用户能读）。写不进去就算了，退回「本次进程记住」，不阻断打开。 */
function writeStoredKey(env, key) {
  try {
    const file = keyFile(env)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, key, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
  } catch { /* 落盘失败不致命：startedKeys 在本次进程内仍然记得 */ }
}

/**
 * 这次网页版用的 key，按优先级：用户设的 `MAGPIE_WEB_KEY` → 上次留下那份 → 现造并存下。
 *
 * **为什么要「上次留下那份」**：见文件头。一句话 —— 让插件重载 / 宿主重启之后仍能认领那个
 * 还活着的 detached 进程，不必让用户去配环境变量（与 magpie 自己把 key 放进 service file
 * 一个路数）。
 */
export function resolveKey(env = process.env) {
  const given = text(env.MAGPIE_WEB_KEY)
  if (KEY_RE.test(given)) return given
  const stored = readStoredKey(env)
  if (stored) return stored
  const key = webKey(env)
  writeStoredKey(env, key)
  return key
}

/**
 * 带 key 请求一下，看这个端口上跑着的 magpie 认不认这把 key。
 *
 * 认（登录那一跳 3xx）就说明正是我们自己起的那一个；401 / 别的都算不认。用来在起进程之前
 * 先「认领」一个还活着的旧进程，而不是又起一个新的。
 */
export function probeKey(port, key, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try { req.destroy() } catch { /* 已经断了 */ }
      resolve(ok)
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `/?k=${encodeURIComponent(key)}`,
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      const code = res.statusCode
      res.resume()
      // 302/303 是换 cookie 的那一跳；3xx 都算「key 被接受」。
      finish(typeof code === 'number' && code >= 300 && code < 400)
    })
    req.on('timeout', () => finish(false))
    req.on('error', () => finish(false))
    req.end()
  })
}

/** 等网页版在这个端口上答起来。 */
async function waitForWeb(port, deadline, probe = probeWeb) {
  for (;;) {
    if (await probe(port, 800)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/**
 * 把这台电脑上的 magpie 网页版准备好，回「在哪、用什么 key」。
 *
 * 三种结局：已经有一个我们对得上 key 的在跑（认领它）、没有就起一个新的、起不来（如实说
 * 为什么）。**失败不抛**：这是一次能力探测，抛出去只会变成一条看不出哪一格缺了的 500。
 *
 * 认领优先于新起：网页版进程是 detached 的，插件热重载 / 宿主重启之后它常常还活着，而内存里
 * 的 `startedKeys` 已经没了 —— 这时用稳定 key 探一下就能把它认回来，不必再起第二个。
 *
 * **所有会碰真实世界的依赖都从参数进来**：`spawnImpl`（起进程）、`probe` / `probeKeyFn`
 * （问端口）、`portFreeFn` / `pickPortImpl`（挑端口）、`findBinaryFn`（找可执行文件）。
 * 守卫里一个真进程都不许起，也不许因为这台机器正好装没装 magpie 而改变结论 —— 这是原实现
 * 踩过两次的坑，别丢。
 *
 * @param {object}   [options]
 * @param {object}   [options.env]           注入的环境（默认 `process.env`）
 * @param {Function} [options.spawnImpl]     与 `node:child_process.spawn` 同形
 * @param {Function} [options.probe]         `(port, timeoutMs) => Promise<boolean>`
 * @param {Function} [options.probeKeyFn]    `(port, key, timeoutMs) => Promise<boolean>`
 * @param {Function} [options.portFreeFn]    `(port) => Promise<boolean>`
 * @param {Function} [options.pickPortImpl]  `(env, portFreeFn) => Promise<number|null>`，挑空端口
 * @param {Function} [options.findBinaryFn]  `(env) => string|null`
 * @param {number}   [options.startTimeoutMs]
 * @returns {Promise<{ available: true, port: number, key: string }
 *                 | { available: false, reason: string, port?: number }>}
 */
export async function ensureWeb({
  env = process.env,
  spawnImpl: spawnChild = spawnImpl,
  probe = probeWeb,
  probeKeyFn = probeKey,
  portFreeFn = portFree,
  pickPortImpl = pickFreePort,
  findBinaryFn = findBinary,
  startTimeoutMs = START_TIMEOUT_MS,
} = {}) {
  const base = preferredPort(env)
  const key = resolveKey(env)

  // 一、先看有没有「认得出来是我们的」在跑：本进程记得的、或稳定 key 探得通的，都认领。
  for (let offset = 0; offset < 10; offset += 1) {
    const port = base + offset
    if (startedKeys.get(port) === key) {
      return { available: true, port, key }
    }
    if (!(await probe(port, 500))) continue
    if (await probeKeyFn(port, key, 800)) {
      startedKeys.set(port, key)
      return { available: true, port, key }
    }
  }

  // 正在起的那一个：搭它的车，别再起第二个。
  if (starting) {
    return starting
  }

  // 二、挑一个空端口起我们自己的。
  const port = await pickPortImpl(env, portFreeFn)
  if (port == null) return { available: false, reason: 'no-free-port' }

  const lastFailure = failures.get(port)
  if (lastFailure && Date.now() - lastFailure.at < START_COOLDOWN_MS) {
    return { available: false, reason: lastFailure.reason, port }
  }

  const bin = findBinaryFn(env)
  if (!bin) return { available: false, reason: 'no-magpie' }

  starting = (async () => {
    try {
      const child = spawnChild(bin, ['web', '--addr', `127.0.0.1:${port}`, '--no-open'], {
        env: { ...env, MAGPIE_WEB_KEY: key },
        // 脱离父进程：插件重载 / 宿主重启不该把它带走，用户下次点开还能直接连上。
        // stdout/stderr 丢掉：那是 magpie 自己的日志，插件不替它收（收着不读会堵住管道）。
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    } catch {
      failures.set(port, { at: Date.now(), reason: 'spawn-failed' })
      return { available: false, reason: 'spawn-failed', port }
    }
    const ok = await waitForWeb(port, Date.now() + startTimeoutMs, probe)
    if (!ok) {
      failures.set(port, { at: Date.now(), reason: 'start-timeout' })
      return { available: false, reason: 'start-timeout', port }
    }
    failures.delete(port)
    startedKeys.set(port, key)
    return { available: true, port, key }
  })().finally(() => { starting = null })
  return starting
}

/**
 * 建 `GET /api/dsh-magpie/web` 的 handler。
 *
 * `deps` 原样透给 `ensureWeb`（或换成 `deps.ensureWebFn`）：路由层要能把「起进程 / 探端口」整套换掉（守卫里一个真进程都不
 * 许起，也不许因为跑测试那台机器上正好开着 magpie 而让结论变来变去）。
 *
 * 回 `{ ok: true, available, port, key, reason }`。**key 只在这里出现一次**：页面拿它拼
 * `http://127.0.0.1:3430/?k=…`，那一跳 magpie 会换成 cookie，地址栏里的 key 不会跟着页面
 * 里的链接到处跑。
 *
 * 起不来也是 200：这是能力探测，不是错误 —— 手机那边要的是「能不能开、为什么不能」，
 * 而不是一个 5xx 让页面显示「网络错误」。
 */
export function createWebHandler(deps = {}) {
  const ensure = deps.ensureWebFn ?? ensureWeb
  return async function handleMagpieWeb(_ctx, _req, res) {
    let entry
    try {
      entry = await ensure(deps)
    } catch {
      entry = { available: false, reason: 'unexpected' }
    }
    await sendJson(res, 200, { ok: true, ...entry })
  }
}

/** 与宿主装配时直接用那一条（依赖全用默认实现）。 */
export const handleMagpieWeb = createWebHandler()
