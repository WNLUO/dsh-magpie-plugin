/**
 * 守卫：随包下发的手机扩展（`extensions/magpie/`）本身对不对。
 *
 * 这一半的坏法都很安静 —— 装到手机上才发现，界面上看不出是哪一步出的错。逐条钉住：
 *
 *  一、**产物在、入口在**：manifest.json 能解析，index.html 在，且不是个残页；
 *  二、**清单对得上**：服务名 `dsh-magpie`、`match` 盖住 `/api/dsh-magpie/`、申请了
 *     `host.data` —— 少一样，页面里的 fetch 就到不了宿主；
 *  三、**自包含无外链**：页面加载时不发任何外部请求，且它引用的每一个本地文件都在包里
 *     （缺一个就是「页面出来了，某些东西是坏的」）；
 *  四、**本地开发文件不进包**：`serve.mjs` / `README.md` / `_probe*.html` 这些只该留在
 *     `web/` 里，混进扩展包就是往用户手机上塞调试垃圾；
 *  五、**产物与源一致**：`scripts/build-extension.mjs --check` 必须为绿（改了 `web/` 却忘了
 *     重新产包，是这一摊最常见的回归）。
 *
 * 运行：node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.join(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const declared = pkg.dshMobileExtensions === true ? 'extensions' : pkg.dshMobileExtensions
const EXT_DIR = path.join(ROOT, declared, 'magpie')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

/** 只该留在 `web/` 的本地开发文件，混进扩展包就是垃圾。 */
const DEV_ONLY = ['serve.mjs', 'README.md', 'README-source.md', 'SOURCE.md', '_probe2.html', '_probe3.html', '_probe4.html', '_probe5.html']

test('扩展产物在：manifest.json 与 index.html 都在，且入口不是残页', () => {
  assert.ok(fs.existsSync(EXT_DIR), `扩展目录不存在：${path.relative(ROOT, EXT_DIR)}`)
  assert.ok(fs.existsSync(path.join(EXT_DIR, 'manifest.json')), '扩展缺 manifest.json，手机不会把它列进清单')
  const html = read(declared, 'magpie', 'index.html')
  assert.ok(html.length > 1024, 'index.html 太小，可能没产完整')
})

test('扩展清单的核心字段齐全，apiVersion 与 main 是扩展要的那两个值', () => {
  const manifest = JSON.parse(read(declared, 'magpie', 'manifest.json'))
  assert.equal(typeof manifest.name, 'string', 'manifest.name 必须是字符串')
  assert.ok(manifest.name.length > 0, 'manifest.name 不能是空的')
  assert.equal(typeof manifest.version, 'string', 'manifest.version 必须是字符串')
  assert.ok(manifest.version.length > 0, 'manifest.version 不能是空的')
  assert.equal(manifest.apiVersion, '1', `apiVersion 必须是 "1"：${manifest.apiVersion}`)
  assert.equal(manifest.main, 'index.html', `main 必须指向 index.html：${manifest.main}`)
})

test('扩展清单的 hostData 指向 dsh-magpie，且申请了 host.data 能力', () => {
  const manifest = JSON.parse(read(declared, 'magpie', 'manifest.json'))
  const paths = read('lib', 'paths.js')
  const serviceName = /export const SERVICE_NAME = '([^']+)'/.exec(paths)?.[1]
  const routePrefix = /export const ROUTE_PREFIX = '([^']+)'/.exec(paths)?.[1]
  assert.ok(serviceName, 'lib/paths.js 里读不到 SERVICE_NAME')
  assert.ok(routePrefix, 'lib/paths.js 里读不到 ROUTE_PREFIX')

  assert.equal(manifest.hostData?.service, serviceName,
    `清单里的服务名 ${manifest.hostData?.service} 与插件登记的 ${serviceName} 对不上`)
  const match = manifest.hostData?.match || []
  assert.ok(match.some((prefix) => `${routePrefix}/`.startsWith(prefix)),
    `match ${match.join(',')} 盖不住路由前缀 ${routePrefix}`)
  assert.ok((manifest.capabilities || []).includes('host.data'),
    '声明了 hostData 却没申请 host.data 能力，fetch 到不了宿主')
})

test('扩展声明了右栏入口，且图标真在包里（没这一项，装了在手机上看不到任何入口）', () => {
  const manifest = JSON.parse(read(declared, 'magpie', 'manifest.json'))
  const entry = manifest.entry
  assert.ok(entry && typeof entry === 'object', '清单缺 entry：装完右栏不会出现这一格，用户会以为没装上')
  assert.equal(typeof entry.name, 'string', 'entry.name 必须是字符串')
  assert.ok(entry.name.trim().length > 0 && entry.name.trim().length <= 10,
    `入口名字要在 1~10 个字符之内（右栏每格 60 宽）：${entry.name}`)
  assert.ok(['first', 'normal', 'last'].includes(entry.slot), `slot 只认三档：${entry.slot}`)
  assert.equal(entry.icon, true, 'entry.icon 要写真（包里带 icon.png）')
  assert.ok(fs.existsSync(path.join(EXT_DIR, 'icon.png')),
    '声明了 icon: true 但包里没有 icon.png —— 右栏那一格会画成空的')
})

test('扩展产物自包含：不发外部请求，且引用的本地文件都在包里', () => {
  const html = read(declared, 'magpie', 'index.html')
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1])

  for (const ref of refs) {
    if (!ref) continue
    assert.ok(!/^(?:https?:)?\/\//.test(ref), `产物里有外链（加载时会被 CSP 挡掉）：${ref}`)
  }

  // 本地引用必须逐个落在包里 —— 缺一个就是真机上「页面出来了，某些东西是坏的」。
  const missing = []
  for (const ref of new Set(refs)) {
    if (!ref || /^(?:data:|#|mailto:|javascript:|https?:|\/\/)/.test(ref)) continue
    const rel = ref.split('#')[0].split('?')[0]
    if (!rel) continue
    if (!fs.existsSync(path.join(EXT_DIR, rel))) missing.push(rel)
  }
  assert.deepEqual(missing, [], `产物引用了包里没有的文件：${missing.join(', ')}`)
})

test('本地开发文件不进扩展包（serve.mjs / README.md / _probe*.html）', () => {
  assert.ok(fs.existsSync(EXT_DIR), `扩展目录不存在，无从谈「不进包」：${path.relative(ROOT, EXT_DIR)}`)
  for (const name of DEV_ONLY) {
    assert.ok(!fs.existsSync(path.join(EXT_DIR, name)),
      `本地开发文件混进了扩展包：${name}（它只该留在 web/）`)
  }
  // 源码说明那类顶层 md 一律不进包（扩展包只该有页面与清单）。
  const mdFiles = fs.readdirSync(EXT_DIR).filter((name) => name.toLowerCase().endsWith('.md'))
  assert.deepEqual(mdFiles, [], `扩展包里混进了说明文档：${mdFiles.join(', ')}`)
})

test('产物与源一致：build-extension.mjs --check 为绿', () => {
  const script = path.join(ROOT, 'scripts', 'build-extension.mjs')
  assert.ok(fs.existsSync(script), 'scripts/build-extension.mjs 不存在，产不出扩展包')
  const result = spawnSync(process.execPath, [script, '--check'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0,
    `产物与源不一致（改了 web/ 却没重新产包？）：\n${result.stderr || result.stdout || result.error || ''}`)
})
