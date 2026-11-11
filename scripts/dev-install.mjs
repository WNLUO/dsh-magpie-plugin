#!/usr/bin/env node
/**
 * 把本包里那份 magpie 手机扩展拷到 `$DSH_HOME/extension-dev/magpie/`，让手机边改边看。
 *
 * 手机那条调试路的入口是电脑上的一个固定目录（移动端插件的 `lib/mobile/extension-dev.js`）：
 * 一个子目录一个包、目录名即 slug。所以这里只做「清掉旧的、拷一份新的」，不做任何打包 ——
 * 构建是 `scripts/build-extension.mjs` 的事，这一步只负责把产物铺到位。
 *
 * 拷的是 `extensions/magpie/`（构建产物），不是 `web/`（页面源码）：手机读的是扩展包，
 * 它得带 `manifest.json` 与 `hostData` 声明，源码目录里没有这些。
 *
 * 用法：
 *   node scripts/dev-install.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { dshHome } from '../lib/update/profile.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(ROOT, 'extensions', 'magpie')
const SLUG = 'magpie'

const target = path.join(dshHome(), 'extension-dev', SLUG)

if (!fs.existsSync(path.join(SOURCE, 'index.html'))) {
  console.error(`找不到入口页：${path.join(SOURCE, 'index.html')}，先跑一次 node scripts/build-extension.mjs。`)
  process.exit(1)
}

// 先删再拷：上一次多出来的文件（改名、删掉的资源）留着就会跟着一起下发。
fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(target, { recursive: true })
fs.cpSync(SOURCE, target, { recursive: true })

console.log(`已拷到 ${target}`)
console.log('手机上：设置 → 扩展 → 本地开发（要先打开开发者模式），重新打开那一页。')
