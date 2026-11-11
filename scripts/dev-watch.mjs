#!/usr/bin/env node
/**
 * 边改边看：盯着 `web/`，每改一次就重新构建，并把产物同步进手机能读到的那个目录。
 *
 * ## 为什么是一条「构建 + 拷贝」的循环，而不是一个开发服务器
 *
 * 手机上的这一页是从本地文件加载的（`file://`），它够不到电脑上的 dev server —— 跨源，
 * 而且扩展沙箱只放开自己那个版本目录。所以「改完立刻看到」只能靠：电脑上把新产物写进
 * `$DSH_HOME/extension-dev/magpie/`，手机那一页发现内容变了就自己重装、自己刷新
 * （手机侧的判据在 App 的 `services/extensions/dev-watch.ts`）。
 *
 * magpie 这份页面还是上游快照、没有 vite 开发服务器，所以清单里那格 `devServer` 不写
 * ——那格是给「页面源码带 HMR」的扩展直连用的，写一个连不上的地址只会让手机白等一次超时。
 *
 * 构建本身交给 `scripts/build-extension.mjs`（产物在 `extensions/magpie/`），这里只管
 * 「盯 → 构建 → 铺过去」这条循环。
 *
 * ## 用法
 *
 *   node scripts/dev-watch.mjs          # 盯着改，Ctrl-C 结束
 *   node scripts/dev-watch.mjs --once   # 只跑一次（等同于 dev-install）
 *
 * 改的是 `web/` 与 `extensions/magpie/manifest.json`；插件宿主那半边（`lib/`、`index.js`）
 * 是 Node 代码，不经过构建，改完要跑 `scripts/reload-dev.mjs` 或重启 DSH —— 不在这里管。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { dshHome } from '../lib/update/profile.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.join(ROOT, 'web')
const SOURCE = path.join(ROOT, 'extensions', 'magpie')
const BUILD = path.join(ROOT, 'scripts', 'build-extension.mjs')
const SLUG = 'magpie'
const ONCE = process.argv.includes('--once')

/**
 * 盯这些地方：页面源码、那份改标题 / 能力要跟着一起下发的清单，以及构建脚本自己
 * （改构建规则也得重新产一遍，否则作者以为生效了、产物还是旧的）。
 */
const WATCH = [WEB, path.join(SOURCE, 'manifest.json'), BUILD]

const target = path.join(dshHome(), 'extension-dev', SLUG)

function stamp() {
  const now = new Date()
  return [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

/**
 * 构建一次并把产物铺到手机那个目录。
 *
 * 构建失败**不退出**：作者正改到一半时文件是坏的，那是常态；报一行错，等他改好下一拍再来。
 * 构建脚本还没到位时同理 —— 那是包的另一半还在写，等它出现就是。
 */
function build(label) {
  const started = Date.now()
  if (!fs.existsSync(BUILD)) {
    console.error(`[${stamp()}] 找不到构建脚本 ${path.relative(ROOT, BUILD)}，等它到位（${label}）`)
    return false
  }
  try {
    execFileSync(process.execPath, [BUILD], { cwd: ROOT, stdio: 'pipe' })
  } catch (error) {
    const detail =
      String(error?.stdout ?? '').trim() || String(error?.stderr ?? '').trim() || String(error?.message ?? error)
    console.error(`[${stamp()}] 构建失败，等下一次改动（${label}）`)
    console.error(detail.split('\n').slice(-12).join('\n'))
    return false
  }

  if (!fs.existsSync(path.join(SOURCE, 'index.html'))) {
    console.error(`[${stamp()}] 构建跑完了但没看到 ${path.relative(ROOT, SOURCE)}/index.html`)
    return false
  }

  // 先删再拷：上一次多出来的文件（改名、删掉的资源）留着就会跟着一起下发。
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  fs.cpSync(SOURCE, target, { recursive: true })

  const bytes = fs.statSync(path.join(target, 'index.html')).size
  console.log(`[${stamp()}] 已更新 ${target}（${(bytes / 1024).toFixed(0)} KB，${Date.now() - started} ms）`)
  return true
}

/** 防抖：一次保存常常连着触发好几次事件。 */
let pending = null
function schedule(label) {
  if (pending !== null) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    build(label)
  }, 120)
}

if (ONCE) {
  process.exit(build('--once') ? 0 : 1)
}

console.log(`盯着 ${WATCH.length} 个位置，改完保存就会自动构建并同步。Ctrl-C 结束。`)
build('启动时先跑一次')

for (const entry of WATCH) {
  if (!fs.existsSync(entry)) continue
  if (fs.statSync(entry).isDirectory()) {
    fs.watch(entry, { recursive: true }, (_event, file) => {
      // 编辑器会写 `.swp` / `~` 这类临时文件，也会在自己清理时触发事件；只认源码与样式。
      if (!file || !/\.(js|mjs|css|html|json|svg)$/.test(file) || path.basename(file).startsWith('.')) return
      schedule(file)
    })
  } else {
    fs.watch(entry, () => schedule(path.basename(entry)))
  }
}
