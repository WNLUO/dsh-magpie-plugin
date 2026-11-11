/**
 * 打包与「包内容」的判据：开发机装进 profile 的必须是**真正会发出去的那一份**。
 *
 * 判据取包自己的 `files` 白名单（`npm pack --dry-run --json` 说了一算），不在这里另抄一份
 * 规则 —— 另抄一份的下场是「开发机装得进去、发出去少一个文件」，而那种漏是不报错的。
 *
 * @module lib/update/pack.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** npm 的调用方式：Windows 上是 `npm.cmd`，Unix 上就是 `npm`。 */
function npmCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** 跑一次 npm，失败时把 stderr 带出来。 */
function runNpm(args, { cwd, platform = process.platform, encoding = 'utf8' }) {
  return execFileSync(npmCommand(platform), args, {
    cwd,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * 要进包的那批文件（相对包根的 POSIX 路径）。
 *
 * 这就是 `files` 白名单的实际效果，也是开发机这条路唯一认的清单。
 */
export function packedFiles(root, { platform = process.platform, npmRunner = runNpm } = {}) {
  const raw = npmRunner(['pack', '--dry-run', '--json'], { cwd: root, platform })
  const parsed = JSON.parse(raw)
  const list = Array.isArray(parsed) ? parsed[0]?.files : parsed?.files
  if (!Array.isArray(list)) throw new Error('npm pack --dry-run 没给出文件清单：这个 npm 版本不支持 --json？')
  return list.map((item) => String(item.path))
}

/**
 * 打一份 tgz 到指定目录，返回它的绝对路径与文件名。
 *
 * 产物先进临时目录、再改名搬进 profile —— 别把 tgz 留在仓库树里。
 */
export function packTarball(root, destination, { platform = process.platform, npmRunner = runNpm } = {}) {
  const raw = npmRunner(['pack', '--pack-destination', destination, '--json'], { cwd: root, platform })
  const parsed = JSON.parse(raw)
  const info = Array.isArray(parsed) ? parsed[0] : parsed
  const filename = info?.filename
  if (!filename) throw new Error('npm pack 没给出文件名')
  const packed = path.join(destination, String(filename))
  if (!fs.existsSync(packed)) throw new Error(`打包产物没找到：${packed}`)
  return { path: packed, filename: String(filename), bytes: fs.statSync(packed).size }
}

/** 一个临时目录（调用方负责删）。 */
export function tempDir(prefix = 'dsh-magpie-pack-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * 要推进 profile 的 js 类文件**能不能被 Node 加载**。
 *
 * 判据只给 js 类：一个语法错误推进 profile，下一次装载就会失败、外壳回滚到旧代，现场表现
 * 成「同步完了但什么都没变」；而 `node --check` 一秒就能说清是哪一行。非 js（产物、json、
 * 图片）不在这里管。
 */
export function syntaxProblems(root, files, { nodePath = process.execPath } = {}) {
  const bad = []
  for (const rel of files) {
    if (!/\.(js|cjs|mjs)$/.test(rel)) continue
    try {
      execFileSync(nodePath, ['--check', rel], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      const message = String(error?.stderr || error?.message || error).trim().split('\n').slice(0, 3).join('\n')
      bad.push({ rel, message })
    }
  }
  return bad
}

/** 比较两份文件逐字节是否相同（任一侧读不到算不同）。 */
export function sameFile(left, right) {
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right))
  } catch {
    return false
  }
}

/**
 * 装完之后逐文件对账：范围是包清单里那批文件。
 *
 * 版本号相同不代表内容相同（同号重打，或者 pnpm 拿缓存里的同名旧包顶回来），只有逐字节比
 * 一遍才能回答「盘上这份是不是仓库里这份」。
 */
export function driftedFrom(root, target, files) {
  return files.filter((rel) => !sameFile(path.join(root, rel), path.join(target, rel)))
}
