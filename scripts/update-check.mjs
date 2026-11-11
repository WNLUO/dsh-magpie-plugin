#!/usr/bin/env node
/**
 * 自更新：查 npm 注册表上是不是有新的一版，`--install` 才真装。
 *
 * 照着移动端插件那份自更新的**判据**来（`lib/update-registry.cjs` 与 `lib/update-install.cjs`），
 * 不照抄实现：
 *
 *  · **查不碰盘**：默认这条路只发一个 `GET <registry>/<name>/latest`，不写任何文件、不动
 *    profile 的依赖声明。`--install` 才在 profile 里跑包管理器。
 *  · **判据是「线上严格大于盘上」**：线上更旧（发错了、镜像落后）一律报没有新版 ——
 *    一次更新会降级这件事必须由版本比较判定。
 *  · **只在注册表来源上装**：`link:` / `file:` / `workspace:` 是有人明确安排的装法（开发机
 *    就是 `file:`），装一次注册表版会把那个指向悄悄换掉。
 *  · **包管理器用运行时自带的那个**，别用 PATH 上版本对不上的（store 不同会装失败）。
 *  · **失败要带出包管理器自己的报错正文**，只回一句「更新失败」等于没说。
 *  · **装没装上以盘上版本变了为准**，不以退出码为准。
 *
 * 用法：
 *   node scripts/update-check.mjs              # 只查
 *   node scripts/update-check.mjs --install    # 有新版就装
 *   node scripts/update-check.mjs --install --force   # 不管有没有新版都装一遍（按线上最新）
 *   node scripts/update-check.mjs --profile mobile
 *
 * 退出码：0 正常（有新版 / 已是最新 / 装好了），1 出错（连不上、装失败），
 * 3 这台是本地来源装的、按设计不自动更新。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkForUpdate, RegistryError, registryBase } from '../lib/update/registry.js'
import {
  declaredSource,
  DEFAULT_NAME,
  installAllowedFor,
  installVersion,
  installedDir,
  managerRegistry,
  packageVersion,
  profileDir,
  profileName,
} from '../lib/update/profile.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name || DEFAULT_NAME

const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(`--${name}`)
const flagValue = (name) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && at + 1 < args.length ? args[at + 1] : null
}

const INSTALL = hasFlag('install')
const FORCE = hasFlag('force')

const say = (message) => process.stdout.write(`${message}\n`)
const warn = (message) => process.stderr.write(`${message}\n`)

function fail(message) {
  warn(`✖ ${message}`)
  process.exit(1)
}

async function main() {
  const profile = profileName(process.env, flagValue('profile'))
  const dir = profileDir({ env: process.env, profile })
  const installed = installedDir(dir, PKG_NAME)
  const installedVersion = packageVersion(installed)

  const source = declaredSource(dir, PKG_NAME)
  const gate = installAllowedFor(source)
  if (!gate.ok) {
    // 这台是开发版（或者有人明确 link 过来的）：连「线上最新是几」都不用问。
    warn(`△ ${gate.message}`)
    say('\n这台按本地来源装的，检查更新对它没有意义 —— 改代码的人自己推（scripts/reload-dev.mjs）。')
    process.exit(3)
  }

  say(`包名：${PKG_NAME}`)
  say(`profile：${profile}（${dir}）`)
  say(installed ? `盘上：${installedVersion ?? '读不到版本'}（${installed}）` : '盘上：这个 profile 里没装（会按 npm 最新装一份）')

  // 查与装用同一个源：问的是这台机器上包管理器自己会用的那个注册表（问不到才退回官方源）。
  // 显式设了 `DSH_MAGPIE_NPM_REGISTRY` 就不探 —— 那是给人排查 / 私有部署用的最高优先级。
  const explicitRegistry = typeof process.env.DSH_MAGPIE_NPM_REGISTRY === 'string' && process.env.DSH_MAGPIE_NPM_REGISTRY.trim() !== ''
  const registry = explicitRegistry ? registryBase() : (await managerRegistry({ cwd: dir })) ?? registryBase()

  let check
  try {
    check = await checkForUpdate({
      installedVersion,
      source,
      name: PKG_NAME,
      base: registry,
    })
  } catch (error) {
    if (error instanceof RegistryError) fail(`${error.message}（${error.code}）`)
    fail(`查更新失败：${error?.message || error}`)
  }

  const latest = check.latestVersion
  say(`注册表：${registry} → latest ${latest}`)

  if (!FORCE && !check.updateAvailable) {
    if (installedVersion === null) {
      // 盘上没有可比版本：这不叫「已是最新」，如实说是比不出来。
      warn('△ 盘上读不到版本号，没法判断有没有新版。装一次之后这条才有意义。')
      return
    }
    say(`✔ 已是最新（盘上 ${installedVersion}）。`)
    return
  }
  if (!INSTALL) {
    if (check.updateAvailable) {
      say(`有新版：${installedVersion} → ${latest}`)
      say('想现在就装：node scripts/update-check.mjs --install')
    } else if (FORCE) {
      say(`盘上 ${installedVersion ?? '读不到'}，线上 ${latest}（--force 会照装一遍）`)
    }
    return
  }

  say(installedVersion === latest ? `盘上已经是 ${latest}，按 --force 再装一遍` : `开始安装：${installedVersion ?? '(未装)'} → ${latest}`)
  const result = await installVersion({ dir, version: latest, name: PKG_NAME, env: process.env, registry })
  if (!result.installed) {
    const code = result.failure?.code || 'install-failed'
    fail(`安装失败 [${code}]：${result.failure?.message || '（包管理器没有给出原因）'}`)
  }
  say(`✔ 装好了：${result.installedVersion}（${result.command}）`)
  if (result.output.trim()) {
    // 包管理器的输出只挑最后几行 —— 完整内容上面已经按需给过，这里不灌满终端。
    const tail = result.output.trim().split('\n').slice(-5).join('\n')
    say(tail)
  }
  warn('\n⚠ 装的是盘上的文件；跑着的宿主进程里还是旧代码。重启一次 DSH 才生效。')
}

main().catch((error) => fail(String(error?.stack || error)))
