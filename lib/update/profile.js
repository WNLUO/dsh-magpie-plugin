/**
 * 这台机器上「这个插件装在哪儿、是怎么装的、用哪个包管理器装」——自更新与热重载共用的一份。
 *
 * 三条口径，都是从移动端插件那份自更新里照搬的**判据**（不是照搬实现）：
 *
 *  1. **只在注册表来源上自动更新**。`link:` / `file:` / `workspace:` 是有人明确安排的装法
 *     （开发机就是 `file:` 指向刚打出来的 tgz），装一次注册表版会把那个指向悄悄换掉 ——
 *     表现是「明明改了代码却没生效」，所以非注册表来源连试都不试。
 *  2. **包管理器用运行时自带的那个**。profile 的依赖布局是它装出来的，PATH 上那个大版本
 *     常常对不上（store 版本不同会 ERR_PNPM_UNEXPECTED_STORE），别赌。
 *  3. **装没装上以盘上版本变了为准**，不以退出码为准：`pnpm add` 退出 0 但版本没动
 *     （本机缓存、同名旧包、被别的东西写回）是真实发生过的。
 *
 * 本模块只读盘 + 跑包管理器；不写自己那份账、不改 profile 的依赖声明。
 *
 * @module lib/update/profile.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

/** 本插件的 npm 包名（`package.json` 的 name）。 */
export const DEFAULT_NAME = 'dsh-magpie-plugin'

/** 一次安装的上限：拉一个包 + 它的依赖，给足但别无限等。 */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/** 命令输出留多少字符：报错里给个人看得懂的尾巴就够。 */
export const OUTPUT_TAIL = 4000

/** `$DSH_HOME`：与宿主自己那套一致，默认 `~/.dsh`。 */
export function dshHome(env = process.env, home = os.homedir()) {
  const explicit = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return explicit ? path.resolve(explicit) : path.join(home, '.dsh')
}

/** profile 名：`DSH_PROFILE` 可覆盖，本机缺省就是 desktop。 */
export function profileName(env = process.env, explicit = null) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  const fromEnv = typeof env?.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : ''
  return fromEnv || 'desktop'
}

/** profile 根目录：读它的依赖声明，也把开发包放进去。 */
export function profileDir({ env = process.env, profile = null } = {}) {
  return path.join(dshHome(env), 'profiles', profileName(env, profile))
}

/** profile 的 `node_modules/<插件>`：实体目录或链接都指到这里。 */
export function installedLink(dir, name = DEFAULT_NAME) {
  return path.join(dir, 'node_modules', name)
}

/**
 * profile 里装着的那一份的**真实路径**。
 *
 * 必须走 realpath：pnpm 可能把包放在 store 里、`node_modules/<插件>` 只是个链接，而宿主
 * 装载与模块缓存都按真实路径算。往链接那一层看，看到的是另一份东西。
 */
export function installedDir(dir, name = DEFAULT_NAME) {
  try {
    return fs.realpathSync(installedLink(dir, name))
  } catch {
    return null
  }
}

/** 读某个目录里那份 package.json 的版本号，读不到回 null。 */
export function packageVersion(dir) {
  if (!dir) return null
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return typeof raw?.version === 'string' && raw.version ? raw.version : null
  } catch {
    return null
  }
}

/** profile 里那份依赖声明原文（`file:` / `link:` 那种 spec）。 */
export function declaredSpec(dir, name = DEFAULT_NAME) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const spec = raw?.dependencies?.[name] ?? raw?.devDependencies?.[name]
    return typeof spec === 'string' ? spec : ''
  } catch {
    return ''
  }
}

/**
 * profile 里这个包是怎么装的（`npm` / `file` / `linked` / `workspace`，读不到回 null）。
 *
 * 读不到来源不算已知来源：那种现场通常意味着包压根不是从 profile 装的，装一次反而是修复。
 */
export function declaredSource(dir, name = DEFAULT_NAME) {
  const spec = declaredSpec(dir, name)
  if (!spec) {
    try {
      JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    } catch {
      return null
    }
    return null
  }
  if (spec.startsWith('link:')) return 'linked'
  if (spec.startsWith('file:')) return 'file'
  if (spec.startsWith('workspace:')) return 'workspace'
  return 'npm'
}

/** 「只有从注册表装的，才由注册表来更新」——其余装法一律不碰盘。 */
const REGISTRY_SOURCES = new Set(['npm'])

/**
 * 一次安装请求能不能动盘。
 *
 * 判据是 profile 里**声明的来源**，不是「装没装得上」：开发机那份是 `file:`（刚打出来的
 * tgz），装一次注册表版会把那个指向换掉，改代码的人最不想遇到的就是这件事。
 */
export function installAllowedFor(source) {
  if (source === null || REGISTRY_SOURCES.has(source)) return { ok: true }
  const how =
    source === 'linked'
      ? 'link: 一个本地目录'
      : source === 'file'
        ? 'file: 一个本机打出来的包'
        : source === 'workspace'
          ? 'workspace: 本仓库里的包'
          : `来源 ${source}`
  return {
    ok: false,
    code: 'LOCAL_SOURCE',
    message:
      `这个插件在 profile 里是 ${how}（${source}）装的，是有意为之：改成注册表版会把那个指向换掉，` +
      '本地的改动就再也不生效了。所以这里既不检查也不安装 —— 这一台的插件更新由改代码的人来做' +
      '（同步文件后让宿主就地重载）；要换回按版号安装，先在插件市场里按包名重装一次。',
  }
}

/** 运行时自带的 pnpm 入口（`pnpm.cjs`）：profile 的依赖布局就是它装出来的。 */
export function runtimePnpm(env = process.env) {
  return path.join(
    dshHome(env),
    'dsh-runtimes',
    'dsh-primary-runtime',
    'dependencies',
    'pnpm',
    'bin',
    'pnpm.cjs',
  )
}

/**
 * 找包管理器：运行时 pnpm 优先，其次 PATH 上的 pnpm / npm。
 *
 * Windows 上 pnpm 是 `.cmd`，那不是可执行文件、是给 cmd 解释的批处理 —— 直接 spawn 必然
 * EINVAL。所以那边只认运行时 pnpm（`.cjs`，由 node 自己跑），找不到就如实说找不到。
 */
export function resolveManager({ env = process.env, platform = process.platform } = {}) {
  const runtime = runtimePnpm(env)
  if (fs.existsSync(runtime)) return { command: process.execPath, prefix: [runtime], kind: 'runtime', label: `运行时 pnpm（${runtime}）` }
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean)
  const names = platform === 'win32' ? [] : ['pnpm', 'npm']
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (fs.statSync(candidate).isFile()) return { command: candidate, prefix: [], kind: 'path', label: `PATH 上的 ${name}（${candidate}）` }
      } catch {
        // 不存在就下一个
      }
    }
  }
  return null
}

/** 跑一条命令，收回 stdout+stderr 的尾巴。超时或非零退出码都如实带出来。 */
export function runCommand(command, args, { cwd, env = process.env, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(command, args, { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`
        if (!error) {
          resolve({ ok: true, code: 0, output, error: null })
          return
        }
        resolve({
          ok: false,
          code: typeof error.code === 'number' ? error.code : null,
          output,
          error: String(error?.message || error),
        })
      })
      child.on?.('error', () => {})
    } catch (error) {
      resolve({ ok: false, code: null, output: '', error: String(error?.message || error) })
    }
  })
}

/**
 * 这台机器的包管理器**真正在用**的那个注册表（问它自己，不读文件猜）。
 *
 * 为什么要问：registry 可能来自 profile 的 `.npmrc`、用户级 rc，或者镜像环境变量。查更新用
 * A、装用 B，就会出现「查得到、装不上」—— 镜像机器上这条尤其常见。问不到就回 null，调用方
 * 退回官方源：多一次探测不该把「检查更新」变成不可用。
 */
export async function managerRegistry({ env = process.env, platform = process.platform, cwd = null, timeoutMs = 20000 } = {}) {
  const manager = resolveManager({ env, platform })
  if (!manager) return null
  const result = await runCommand(manager.command, [...manager.prefix, 'config', 'get', 'registry'], {
    cwd: cwd ?? process.cwd(),
    env,
    timeoutMs,
  })
  if (!result.ok) return null
  const lines = String(result.output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^https?:\/\/\S+$/.test(lines[i])) return lines[i].replace(/\/+$/, '')
  }
  return null
}

/**
 * 给一句失败结论附上包管理器自己说的原因。
 *
 * 只写「跑过的命令 + 退出码」时，排错的人拿着一张只有命令的截图一点办法都没有。`ERR_PNPM_*`
 * / `ERROR` 那几行才是答案；一行都没有就退回最后一行有内容的输出。完整输出不塞进这一句里。
 */
export function withReason(message, output) {
  const lines = String(output || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !/^Progress:/.test(line.trim()))
  if (lines.length === 0) return message
  const marked = lines.filter((line) => /ERR_PNPM|ERROR|E404|ETARGET/.test(line))
  const reason = (marked.length > 0 ? marked : lines.slice(-1)).slice(0, 3).join('\n').slice(0, 600)
  return reason === '' ? message : `${message}\n${reason}`
}

/**
 * 在 profile 里把本插件装到指定版本（`pnpm add <name>@<version>`）。
 *
 * 两个细节是刻意的：
 *  - **晾置期（minimum-release-age）在那一条命令上关掉**：自更新就是「现在就要」，让它在
 *    这一步被自己的策略挡一次、再靠失败重试绕过来没有意义。我们**不把这个开关写进**
 *    profile 的配置文件 —— 那是这台机器自己的策略，插件不替人改。
 *  - **`--config.xxx` 之外再给一份环境变量**：pnpm 12 会静默忽略部分 `--config.*`（同一个
 *    键走 `PNPM_CONFIG_*` 它照读），两边各带一份，换大版本也不用重新猜。
 *
 * @returns {Promise<{installed: boolean, beforeVersion: string|null, installedVersion: string|null,
 *   command: string|null, output: string, failure: {code: string, message: string}|null}>}
 */
export async function installVersion({
  dir,
  version,
  name = DEFAULT_NAME,
  env = process.env,
  platform = process.platform,
  timeoutMs = INSTALL_TIMEOUT_MS,
  registry = null,
}) {
  const beforeVersion = packageVersion(installedDir(dir, name))
  const manager = resolveManager({ env, platform })
  if (!manager) {
    return {
      installed: false,
      beforeVersion,
      installedVersion: beforeVersion,
      command: null,
      output: '',
      failure: {
        code: 'PACKAGE_MANAGER_MISSING',
        message:
          `找不到能用的包管理器（没有 ${runtimePnpm(env)}，PATH 上也没有 pnpm / npm），装不了新版。` +
          '插件不会自己去下载解包 —— 那等于把包管理器的活抄一遍，抄漏一处就是装出半个包。',
      },
    }
  }

  const spec = `${name}@${version}`
  const policyArgs = ['--config.minimum-release-age=0', '--config.auto-install-peers=false']
  // 查与装用同一个源：镜像机器上查得到、装不上，就是这两步各问了一处。
  const registryArgs = typeof registry === 'string' && registry ? [`--registry=${registry}`] : []
  const args = [...manager.prefix, 'add', spec, ...policyArgs, ...registryArgs]
  const command = `${manager.kind === 'runtime' ? 'pnpm' : path.basename(manager.command)} add ${spec}`

  const result = await runCommand(manager.command, args, {
    cwd: dir,
    env: { ...env, CI: env.CI || '1', PNPM_CONFIG_MINIMUM_RELEASE_AGE: '0', PNPM_CONFIG_AUTO_INSTALL_PEERS: 'false' },
    timeoutMs,
  })

  const after = packageVersion(installedDir(dir, name))
  // 退出码 0 不算数：**盘上版本真的变了**才算装上。
  const changed = after !== null && after !== beforeVersion && after === version
  if (!result.ok) {
    return {
      installed: false,
      beforeVersion,
      installedVersion: after,
      command,
      output: result.output,
      failure: {
        code: result.code === null ? 'INSTALL_ABORTED' : 'INSTALL_FAILED',
        message: withReason(
          `${command} ${result.code === null ? '没能跑完' : `退出码 ${result.code}`}${result.error ? `：${result.error}` : ''}`,
          result.output,
        ),
      },
    }
  }
  return {
    installed: changed,
    beforeVersion,
    installedVersion: after,
    command,
    output: result.output,
    failure: changed
      ? null
      : {
          code: 'VERSION_UNCHANGED',
          message: withReason(`${command} 跑完了，但盘上还是 ${after ?? '读不到版本'}，这一次不算数`, result.output),
        },
  }
}
