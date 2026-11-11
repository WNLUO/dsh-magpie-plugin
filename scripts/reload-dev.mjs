#!/usr/bin/env node
/**
 * 开发机：把仓库里的插件改动**装进 profile**，再让它**就地重新装载**（不重启 DSH）。
 *
 * ## 为什么不能只拷文件
 *
 * 宿主加载的是 profile 里装着的那一份，而 profile 的依赖声明写的是一个 `file:` 指向的 tgz。
 * 逐份拷文件虽然能让就地重载生效，但**那份安装不是声明的产物**：重启时宿主按声明重装一遍，
 * 装回来又是冻结的旧 tgz —— 表现就是「热重载过了、重启又是旧版」。所以这里走正规安装：
 * `npm pack` → 放进 profile → 声明指过去 → 用运行时自带的 pnpm 装一遍 → 就地重载。
 * 装完盘上那份就是声明的那一份。
 *
 * 中途任何一步失败都把依赖声明退回原文，别留一个指向半份东西的安装表 —— 下次启动会被它拖住。
 *
 * ## 就地重载走哪条路
 *
 * 本插件自己开一条本机调试路由 `POST /api/dsh-magpie/dev/reload`（只在插件里那条 dev 路由
 * 实现时才有）。脚本先探它：
 *
 *  · 答 200 且 `ok: true` —— 就地换掉了，不用重启；
 *  · 答 404 / 401 / 403 —— 这个进程里**还没有**这条路由（跑着的还是旧的那一份）。这不算
 *    失败：新的一份已经装进去了，重启一次 DSH 就从这一版起；退出码 2，与「装失败」分开；
 *  · 连不上任何宿主 —— 同上，只是多一句「这次没找到在跑的 DSH」。
 *
 * 那条路由要求带请求头 `x-dsh-dev-reload`（任意非空值）：手机上经 `host.data` 转来的请求
 * 落点也是宿主回环地址，只看回环分辨不出本机运维与手机页面。脚本每次调都带上。
 *
 * 用法：
 *   node scripts/reload-dev.mjs            # 打包 + 装进 profile + 就地重载
 *   node scripts/reload-dev.mjs --dry-run  # 只看会做什么
 *   node scripts/reload-dev.mjs --profile mobile
 *   node scripts/reload-dev.mjs --port 60215
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { driftedFrom, packTarball, packedFiles, syntaxProblems, tempDir } from '../lib/update/pack.js'
import {
  declaredSpec,
  installedDir,
  installedLink,
  packageVersion,
  profileDir,
  profileName,
  registerBundle,
  runCommand,
  runtimePnpm,
} from '../lib/update/profile.js'
import { RELOAD_PATH, reloadInPlace } from '../lib/update/host.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const PKG_NAME = PKG.name
const SLUG = 'magpie'

/** 开发包名带时间戳：保证装的是「刚打出来这一份」，而不是 pnpm 认出来的同名旧包。 */
const DEV_PREFIX = `${PKG_NAME}-dev-`
/** profile 里留几份开发包与几份安装目录备份：回滚只要最近那几份。 */
const DEV_TARBALL_KEEP = 2
const DEV_BACKUP_KEEP = 3
const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(`--${name}`)
const flagValue = (name) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && at + 1 < args.length ? args[at + 1] : null
}

const DRY_RUN = hasFlag('dry-run')

const say = (message) => process.stdout.write(`${message}\n`)
const warn = (message) => process.stderr.write(`${message}\n`)

function fail(message) {
  warn(`✖ ${message}`)
  process.exit(1)
}

/** 要装进去的那个 profile 目录。 */
const profile = profileName(process.env, flagValue('profile'))
const target = profileDir({ env: process.env, profile })

/** 装之前把盘上那一份整个备份下来（装坏了还能拷回去）。失败不挡安装。 */
function backupInstalled(dir) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const root = path.join(target, '.plugin-backups')
    const dest = path.join(root, `${PKG_NAME}-dev-${packageVersion(dir) ?? 'unknown'}-${stamp}`)
    fs.mkdirSync(root, { recursive: true })
    fs.cpSync(dir, dest, { recursive: true })
    const mine = fs
      .readdirSync(root)
      .filter((name) => name.startsWith(`${PKG_NAME}-dev-`))
      .sort()
    for (const name of mine.slice(0, Math.max(0, mine.length - DEV_BACKUP_KEEP))) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
    }
    return dest
  } catch (error) {
    warn(`（备份这次没做成，不影响安装：${error?.message || error}）`)
    return null
  }
}

/** 旧开发包只留最近几份，别让 profile 里堆一辈子 tgz。 */
function pruneDevTarballs(keepName) {
  let names
  try {
    names = fs.readdirSync(target)
  } catch {
    return
  }
  const mine = names.filter((name) => name.startsWith(DEV_PREFIX) && name.endsWith('.tgz') && name !== keepName).sort()
  for (const name of mine.slice(0, Math.max(0, mine.length - (DEV_TARBALL_KEEP - 1)))) {
    fs.rmSync(path.join(target, name), { force: true })
  }
}

/** 把 profile 的依赖声明改成指向某个 spec（其余字段原样保留），返回改动前原文。 */
function pointDeclarationAt(spec) {
  const file = path.join(target, 'package.json')
  const before = fs.readFileSync(file, 'utf8')
  const manifest = JSON.parse(before)
  manifest.dependencies = { ...(manifest.dependencies ?? {}), [PKG_NAME]: spec }
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return before
}

/** 前端产物是不是比 `web/` 源码旧：旧就先构建，别把上一版页面当成这一版装进去。 */
function newestMtime(entry) {
  let stat
  try {
    stat = fs.statSync(entry)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = stat.mtimeMs
  for (const name of fs.readdirSync(entry)) newest = Math.max(newest, newestMtime(path.join(entry, name)))
  return newest
}

function extensionIsStale() {
  let artifact
  try {
    artifact = fs.statSync(path.join(ROOT, 'extensions', SLUG, 'index.html')).mtimeMs
  } catch {
    return true
  }
  return newestMtime(path.join(ROOT, 'web')) > artifact
}

/**
 * 构建一次扩展包。构建脚本还没到位（包的另一半在写）时**不挡路**：这条路装的是宿主半身，
 * 扩展那半没构建只是手机那边看到的还是上一次的包，不等于这次改动不能装。
 */
function ensureExtensionBuilt() {
  const build = path.join(ROOT, 'scripts', 'build-extension.mjs')
  if (!fs.existsSync(build)) {
    say('· 还没看到 scripts/build-extension.mjs，跳过扩展构建（这次只装宿主那半）')
    return
  }
  if (!extensionIsStale()) {
    say('· 扩展产物比 web/ 新，跳过构建')
    return
  }
  if (DRY_RUN) {
    say('· （演练）会先跑 node scripts/build-extension.mjs')
    return
  }
  say('· 扩展产物落后于 web/ 源码，先构建…')
  try {
    execFileSync(process.execPath, [build], { cwd: ROOT, stdio: 'inherit' })
  } catch (error) {
    fail(`扩展构建失败，什么都没装：${String(error?.message || error).trim()}`)
  }
}

async function main() {
  say(`仓库：${ROOT}`)
  say(`profile：${profile}（${target}）`)
  if (!fs.existsSync(path.join(target, 'package.json'))) {
    fail(`这个 profile 还没初始化（没有 ${path.join(target, 'package.json')}）：先装一次这个插件，这条路之后才有意义。`)
  }
  const pnpm = runtimePnpm()
  if (!fs.existsSync(pnpm)) {
    fail(`找不到运行时自带的 pnpm：${pnpm}。profile 的依赖布局是它装出来的，别用系统里那个（store 版本对不上会装失败）。`)
  }

  const before = installedDir(target, PKG_NAME)
  say(before ? `· 当前装着：${packageVersion(before) ?? '未知'}（${before}）` : '· 这个 profile 里还没装过，这次会装第一份')

  ensureExtensionBuilt()

  // 语法先过一遍再打包：一个坏文件装进 profile，装载失败、回滚旧代，现场表现成
  // 「同步完了但什么都没变」—— 比在这里停下难查得多。
  let files
  try {
    files = packedFiles(ROOT)
  } catch (error) {
    fail(`读不出包内容（npm pack --dry-run 失败）：${String(error?.message || error).trim()}`)
  }
  const bad = syntaxProblems(ROOT, files)
  if (bad.length) {
    for (const item of bad) warn(`✖ ${item.rel} 语法不过：\n${item.message}`)
    fail(`有 ${bad.length} 个文件语法不过，什么都没装、也没有重载。修好再跑一次。`)
  }
  say(`· 包内 ${files.length} 个文件（按 package.json 的 files 白名单）`)

  if (DRY_RUN) {
    say(`· （演练）会打出 ${DEV_PREFIX}<时间戳>.tgz → 放进 profile → 依赖声明指过去 → 运行时 pnpm install → 调 ${RELOAD_PATH}`)
    return
  }

  // 备份只在真有东西要换的时候做：第一次装还要备份的话，只是白堆一份空目录。
  const backup = before ? backupInstalled(before) : null
  if (backup) say(`· 备份：${path.basename(backup)}`)

  // 打包：产物先进临时目录，再改名搬进 profile —— 别把 tgz 留在仓库树里。
  const devName = `${DEV_PREFIX}${Date.now()}.tgz`
  const tmp = tempDir()
  try {
    const packed = packTarball(ROOT, tmp)
    fs.copyFileSync(packed.path, path.join(target, devName))
  } catch (error) {
    fail(`打包失败：${String(error?.message || error).trim()}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  say(`· 打包：${devName}（${(fs.statSync(path.join(target, devName)).size / 1024).toFixed(0)} KB）`)

  // 依赖声明指过去；锁文件交给 pnpm 自己更新（手改会与它记的完整性字段对不上）。
  const manifestBefore = pointDeclarationAt(`file:${devName}`)
  const install = await runCommand(process.execPath, [pnpm, 'install', '--no-frozen-lockfile'], {
    cwd: target,
    env: { ...process.env, CI: process.env.CI || '1' },
    timeoutMs: 10 * 60 * 1000,
  })
  if (!install.ok) {
    // 装不上：声明退回去，别留一个指向半份东西的安装表。
    fs.writeFileSync(path.join(target, 'package.json'), manifestBefore)
    try {
      await runCommand(process.execPath, [pnpm, 'install', '--frozen-lockfile'], { cwd: target, timeoutMs: 5 * 60 * 1000 })
    } catch {
      /* 退不回去也要把原因说出来 */
    }
    fs.rmSync(path.join(target, devName), { force: true })
    const tail = (install.output || install.error || '').trim().split('\n').slice(-10).join('\n')
    fail(`安装失败（依赖声明已经退回去了）：\n${tail}`)
  }
  pruneDevTarballs(devName)

  const after = installedDir(target, PKG_NAME)
  if (!after) fail(`装完找不到 ${installedLink(target, PKG_NAME)}：这份安装不完整。`)
  if (packageVersion(after) !== PKG.version) {
    fail(`装完盘上是 ${packageVersion(after) ?? '读不到'}、仓库是 ${PKG.version}：这次装的东西不对，别当成功。`)
  }
  // 版本号相同不代表内容相同（同号重打、缓存里的同名旧包）：逐字节对一遍才算数。
  const drifted = driftedFrom(ROOT, after, files)
  if (drifted.length) {
    fail(
      `装完盘上仍有 ${drifted.length} 个文件与仓库不一致（${drifted.slice(0, 5).join('、')}${drifted.length > 5 ? ' …' : ''}）：这次装的东西不对，别当成功。`,
    )
  }
  if (declaredSpec(target, PKG_NAME) !== `file:${devName}`) {
    fail(`profile 的依赖声明没指到 ${devName}：重启会退回旧的一份，这一轮白做。`)
  }
  say(`✔ 已装进 profile：${PKG.version}（${files.length} 个文件逐字节对上，声明指向 ${devName}）`)

  // 让它成为宿主的启动项 —— `pnpm install` 只进 node_modules 与依赖表，**不进**启动列表。
  // 少了这一步的现场是「装好了、也逐字节对上了、重启还是没加载」，从包本身查不出来。
  const registered = registerBundle(target, PKG_NAME)
  if (registered === null) {
    warn(`△ 读不出 profile 的 ${path.join(target, 'package.json')}，没法自动登记启动项；`)
    warn('  重启宿主前请确认 dsh.profile.bundles 里有这一项，否则它不会被加载。')
  } else if (registered.changed) {
    say(`✔ 已登记进启动列表（dsh.profile.bundles），重启后会被加载`)
  } else {
    say('· 启动列表里本来就有，跳过')
  }

  const reload = await reloadInPlace({ explicitPort: Number(flagValue('port')) || null })
  if (reload.status === 'reloaded') {
    say(`✔ 已就地重新装载（${reload.detail}）—— 不用重启 DSH，手机那边刷新一下就能看到。`)
    return
  }
  if (reload.status === 'failed') {
    fail(`重载失败：${reload.detail}\n  盘上文件已经换了，但**运行中的还是旧代码**。修好原因再跑一次这个脚本。`)
  }
  // 「这条路在这个进程里还不存在」不是安装失败：装已经成功了，两件事分开报。
  warn(`△ ${reload.detail || '没找到在跑的 DSH 宿主（这条调试路由只在宿主开着时可达）'}`)
  warn('  新的一份已经装进 profile 了，但这次没能就地换掉。重启一次 DSH 就从这一版起；')
  warn('  之后这条路一直在，改完代码只需要再跑这个脚本，不用重启。')
  process.exit(2)
}

main().catch((error) => fail(String(error?.stack || error)))
