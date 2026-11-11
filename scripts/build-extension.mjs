#!/usr/bin/env node
/**
 * 把 `web/`（magpie 网页版前端源码快照）产成随插件走的手机扩展包，落到
 * `extensions/magpie/`。
 *
 * 扩展随本插件一起发：插件装进电脑的 profile、`package.json` 用 `dshMobileExtensions`
 * 声明了 `extensions/`，手机就能在扩展清单里看到它并装上，不必再走分发系统、也不用打 zip。
 * 页面从手机本地 `file://` 加载，数据请求走「扩展页 → App → 宿主 → magpie」这条通用通道
 * （能力 `host.data`）。
 *
 * 这个脚本只做三件事，页面逻辑一律不动：整份拷贝、把 magpie 自己的 PWA `manifest.json`
 * 与扩展字段合并成一份、在 `index.html` 最前面注入一段路径改写（见下）。
 *
 * ## 为什么要注入 `/api/` → `/api/dsh-magpie/api/` 的改写
 *
 * 上游页面的每一个取数都是裸路径（`fetch('/api/state')`、`fetch("/api/" + path)`），因为它
 * 本来由 magpie 自己的进程端在站点根上。而这个插件的路由挂在 `/api/dsh-magpie` 前缀下
 * （见 `lib/paths.js`）：裸的 `/api/state` 直接挂宿主端口会和 DSH 自己的 `/api/*` 撞车。
 *
 * App 那一侧的 `hostData` 拦截**不改写路径**：`hostDataShimScript()` 把命中的 URL 取
 * `pathname` 原样塞进 `{ service, path }` 发给宿主（`services/extensions/bridge.ts`），
 * 宿主再按该服务登记的前缀判放行（`lib/mobile/extension-data.js` 里
 * `spec.allow.some(prefix => pathname.startsWith(prefix))`）。所以扩展清单里 `match` 写
 * `/api/dsh-magpie/` 时，页面原样发 `/api/state` 只会被判 `path-not-allowed` —— 前缀对不上，
 * 没有任何一层会替我们把它挪过去。
 *
 * 结论：这一段必须由扩展自己补。改写放在页面最前面（`<head>` 里的内联脚本，抢在 `boot.js`
 * 与 `app.js` 之前），因为页面一加载就发首批请求；只改 `window.fetch` 里的路径，不动上游
 * 那几十个 js 文件，所以上游更新时重新拷一份源码、重跑本脚本即可。
 *
 * 改完之后的链路是：页面 `fetch('/api/state')` → 本脚本改成 `/api/dsh-magpie/api/state`
 * → App 按 `match` 交给宿主 → 宿主转给插件路由 `/api/dsh-magpie/api/state` → 插件剥掉前缀、
 * 把 `/api/state` 原样转给 magpie。每一跳都只做一件事（搬路径 / 认前缀 / 剥前缀）。
 *
 * 用法：
 *   node scripts/build-extension.mjs           # 产包到 extensions/magpie
 *   node scripts/build-extension.mjs --check   # 只校验产物与源一致（守卫用，不写盘）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(ROOT, 'web')
const OUT_DIR = path.join(ROOT, 'extensions', 'magpie')

/** 扩展身份。`slug` 目录名由本插件的 `dshMobileExtensions` 声明带出去。 */
export const EXTENSION_NAME = 'magpie'
export const EXTENSION_ID = 'com.dsh.magpie.extension'
/** 扩展接口版本：只在「App 给扩展的东西变了」时抬（与 App RUNTIME_VERSION 无关）。 */
export const EXTENSION_API_VERSION = '1'
/** 扩展自己的版本号，不跟插件版本走：只有扩展包内容变了才抬。 */
const EXTENSION_VERSION = '1.0.0'

/**
 * 这个扩展声明要哪几项能力。
 *  - content.read / card.write：基础两项，整页应用其实用不上，但装的时候不问；
 *  - host.data：**关键** —— 页面里的 `fetch('/api/…')` 靠它走宿主去取 magpie 的数据。
 */
const CAPABILITIES = ['content.read', 'card.write', 'host.data']

/**
 * `hostData` 声明：页面里以 `/api/dsh-magpie/` 开头的请求交给宿主登记的服务 `dsh-magpie`
 * 去取。`service` 与 `match` 两个值都必须与 `lib/paths.js` 的 `SERVICE_NAME` /
 * `ROUTE_PREFIX` 对得上（守卫会核对）。
 */
const HOST_DATA = { service: 'dsh-magpie', match: ['/api/dsh-magpie/'] }

/**
 * 只该留在 `web/` 的本地开发文件，不进扩展包。
 *  - `serve.mjs`：本地开发服务器（DV），上游没有；
 *  - `SOURCE.md`：这份源码快照的来源与改法说明；
 *  - `_probe*.html`：调界面时用的探针页，拷进包里就是调试垃圾。
 * 顶层任何 `.md` 也一并跳过（说明性文档不属于扩展页面）。
 */
const DEV_ONLY = new Set(['serve.mjs', 'SOURCE.md', '_probe2.html', '_probe3.html', '_probe4.html', '_probe5.html'])

/**
 * 页面路径改写：把本源内以 `/api/` 开头的请求挪到 `/api/dsh-magpie` 前缀下。
 *
 * 规则收得很窄 —— 只认「以单个 `/` 开头的本源绝对路径」，且已经带前缀的、外链（`http(s)://`、
 * `//host`）、`data:` / `blob:`、相对路径一律原样放行。页面里所有取数都是这种裸路径，这样就
 * 够；不解析 Request 对象之外的花样，也不碰 `XMLHttpRequest`（这一页只用 `fetch`）。
 *
 * 为什么必须内联在 `<head>` 最前面：`app.js` 一执行就发首批 `/api/*`，晚一步安装拦截，
 * 那几发就会真的按 `file:///api/...` 打出去、全部落空。
 */
const API_PREFIX = '/api/dsh-magpie'

function rewriteShimScript() {
  return `<script>
// 页面自己的取数都是裸路径（/api/state 这类），而这个插件把接口挂在 ${API_PREFIX} 下
// （裸的 /api/* 会和 DSH 宿主自己的撞车）。App 那一侧的 hostData 通道按清单里的 match 前缀
// 认请求、不改写路径，所以这里先把 /api/ 挪到前缀下；宿主那一侧再把前缀剥掉转给 magpie。
// 只包 window.fetch，只动本源绝对路径，其余原样放行。
(function () {
  var prefix = ${JSON.stringify(API_PREFIX)};
  var original = window.fetch;
  if (typeof original !== 'function') return;
  function isApiPath(p) {
    return p === '/api' || p.indexOf('/api/') === 0;
  }
  function moved(p) {
    if (typeof p !== 'string' || p.charAt(0) !== '/') return p;
    if (p.indexOf('//') === 0) return p;
    if (p.indexOf(prefix + '/') === 0 || p === prefix) return p;
    return isApiPath(p) ? prefix + p : p;
  }
  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      var next = moved(input);
      return next === input ? original.call(this, input, init) : original.call(this, next, init);
    }
    return original.call(this, input, init);
  };
})();
</script>`

}

/** 递归列出源目录里要进扩展包的文件（POSIX 相对路径），跳过本地开发用的那几个。 */
export function sourceFiles() {
  const out = []
  const walk = (rel) => {
    const full = path.join(SRC_DIR, rel)
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) { walk(next); continue }
      if (!entry.isFile()) continue
      if (!rel) {
        if (DEV_ONLY.has(entry.name)) continue
        if (entry.name.toLowerCase().endsWith('.md')) continue
        if (/^_probe.*\.html$/.test(entry.name)) continue
      }
      out.push(next)
    }
  }
  walk('')
  return out.sort()
}

/**
 * 把 magpie 自己的 PWA manifest 与扩展字段合并成一个 `manifest.json`。
 *
 * 为什么非要合并：`index.html` 用 `<link rel="manifest">` 指这一份当 PWA 清单，而扩展安装器
 * 也从同名文件读 `capabilities` / `hostData` / `version` —— 两个用途只能共用一份文件。
 * PWA 原有字段（名字、图标、主题色）保留，扩展字段并进去，安装器只挑它要的那几个。
 * 入口页固定是包目录下那一层 `index.html`，`main` 只是写给自己看的说明。
 */
export function buildManifest() {
  let pwa = {}
  try {
    pwa = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'manifest.json'), 'utf8'))
  } catch { pwa = {} }
  return {
    // —— PWA 字段（沿用 magpie 原样）——
    name: pwa.name ?? EXTENSION_NAME,
    short_name: pwa.short_name ?? EXTENSION_NAME,
    start_url: pwa.start_url ?? './',
    scope: pwa.scope ?? './',
    display: pwa.display ?? 'standalone',
    background_color: pwa.background_color,
    theme_color: pwa.theme_color,
    icons: pwa.icons,
    // —— 扩展字段 ——
    id: EXTENSION_ID,
    version: EXTENSION_VERSION,
    apiVersion: EXTENSION_API_VERSION,
    main: 'index.html',
    description: '在手机上打开 magpie 的完整界面（Agents / Providers / Routing / Usage / Settings）。数据经宿主取。',
    capabilities: CAPABILITIES,
    hostData: HOST_DATA,
  }
}

/** 产出的 `index.html`：在 `<head>` 的 charset 之后插入改写脚本，其余一字不动。 */
export function buildIndexHtml() {
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8')
  const anchor = '<meta charset="utf-8">'
  const at = html.indexOf(anchor)
  if (at < 0) throw new Error('index.html 里找不到 `<meta charset="utf-8">`，页面结构变了 —— 改写脚本该插哪儿要重新确认')
  const insertAt = at + anchor.length
  return `${html.slice(0, insertAt)}\n${rewriteShimScript()}\n${html.slice(insertAt)}`
}

/** 产物应有的一张表：相对路径 → 内容（Buffer 或字符串）。 */
export function expectedFiles() {
  const out = new Map()
  for (const rel of sourceFiles()) {
    out.set(rel, rel === 'index.html' ? buildIndexHtml() : fs.readFileSync(path.join(SRC_DIR, rel)))
  }
  out.set('manifest.json', `${JSON.stringify(buildManifest(), null, 2)}\n`)
  return out
}

/** 产包：整份拷进 OUT，覆盖写入合并后的 manifest 与注入过改写的 index.html。 */
function build() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  for (const [rel, content] of expectedFiles()) {
    const to = path.join(OUT_DIR, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, content)
  }
  return OUT_DIR
}

/** 递归列出产物目录里的文件（POSIX 相对路径）。 */
function builtFiles() {
  const out = []
  const walk = (rel) => {
    const full = path.join(OUT_DIR, rel)
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) { walk(next); continue }
      if (entry.isFile()) out.push(next)
    }
  }
  walk('')
  return out.sort()
}

/** 校验产物与源逐字节一致；不一致时打印第一处差异并返回 false。 */
function check() {
  if (!fs.existsSync(OUT_DIR)) {
    console.error('extensions/magpie 不存在：跑 node scripts/build-extension.mjs 生成')
    return false
  }
  const want = expectedFiles()
  const got = new Set(builtFiles())
  let ok = true
  for (const [rel, content] of want) {
    const full = path.join(OUT_DIR, rel)
    if (!got.has(rel)) {
      console.error(`产物缺文件：${rel}`)
      ok = false
      continue
    }
    const actual = fs.readFileSync(full)
    const expected = Buffer.isBuffer(content) ? content : Buffer.from(content)
    if (!actual.equals(expected)) {
      console.error(`产物里的 ${rel} 与源不一致：重跑产包`)
      ok = false
    }
    got.delete(rel)
  }
  for (const extra of got) {
    console.error(`产物里多出文件：${extra}（不该进扩展包）`)
    ok = false
  }
  return ok
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.slice(2).includes('--check')) {
    if (!check()) process.exit(1)
    console.log('extensions/magpie 与 web/ 一致')
  } else {
    const dir = build()
    const files = builtFiles()
    const bytes = files.reduce((sum, rel) => sum + fs.statSync(path.join(dir, rel)).size, 0)
    console.log(`产物：${path.relative(ROOT, dir)}`)
    console.log(`文件数：${files.length}　大小：${(bytes / 1024 / 1024).toFixed(2)} MB`)
  }
}
