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
 * 这个脚本只做四件事，页面逻辑一律不动：整份拷贝、把 magpie 自己的 PWA `manifest.json`
 * 与扩展字段合并成一份、在 `index.html` 最前面注入一段路径改写（见下），以及同一段里把
 * 「请 magpie 复制」那条请求挡掉（见「为什么挡掉 /api/copy」）。
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
import { execFileSync } from 'node:child_process'
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
const EXTENSION_VERSION = '1.0.3'

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
 * 右栏入口声明：装了本插件，手机右侧栏里就多出这一格。
 *
 * 不给这一项时扩展照样能装、能从「设置 → 扩展」里打开，但**右栏不会出现** —— 用户装完
 * 看不到任何入口，会以为没装上。这就是为什么它是必须的一项，不是装饰。
 *
 * `icon: true` 表示包里带一张 `icon.png`（产包时从 `web/icons/icon-512.png` 拷一份）：
 * App 只认这个固定文件名，且只认包里自带的图，不给网络地址。
 */
const ENTRY = { name: 'magpie', slot: 'normal', icon: true }

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

/**
 * 为什么挡掉 `/api/copy`。
 *
 * 页面的「复制」（网关的 base URL / key / 模型号那几段）第一步是 `POST /api/copy`，请 magpie
 * 把文本放进**运行 magpie 那台电脑**的剪贴板 —— 上游就是这么写的（注释里写着「App 窗口里
 * 页面自己的剪贴板 API 会被拒」），对着的是「在电脑上用网页版」那一档。手机上这条能成，于是
 * 页面报「已复制」，而文本进了 Mac 的剪贴板，用户在自己手机上粘不出来。
 *
 * 所以这一发在扩展包里直接回一个失败响应（不发出去），页面就会按它自己的顺序往下走：
 * `navigator.clipboard` → 复制命令 → 都不行就把文本显示出来让人手动选。三档都是**手机上**
 * 的剪贴板，这才是用户按那颗按钮时要的东西。
 *
 * 只挡这一个路径、只在产物里挡：`web/` 源码与 `serve.mjs` 那条开发路照旧，电脑浏览器里复制
 * 到本机剪贴板本来就是对的。
 */
const COPY_PATH = `${API_PREFIX}/api/copy`

function rewriteShimScript() {
  return `<script>
// 页面自己的取数都是裸路径（/api/state 这类），而这个插件把接口挂在 ${API_PREFIX} 下
// （裸的 /api/* 会和 DSH 宿主自己的撞车）。App 那一侧的 hostData 通道按清单里的 match 前缀
// 认请求、不改写路径，所以这里先把 /api/ 挪到前缀下；宿主那一侧再把前缀剥掉转给 magpie。
// 只包 window.fetch，只动本源绝对路径，其余原样放行。
//
// 另外把「请 magpie 复制」那一发挡掉：它写的是电脑的剪贴板，手机上用户要的是这台手机的。
(function () {
  var prefix = ${JSON.stringify(API_PREFIX)};
  var copyPath = ${JSON.stringify(COPY_PATH)};
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
  // 取数通道的两件保险。
  //
  // 一、**首屏那几发要等桥**。宿主那段拦截是 App 在页面加载后注入的，页面自己的首屏请求
  //     可能比它早 —— 那时 __dshHostFetch 还没有，几发请求就会打到 file:// 上，手机上只剩
  //     一句 "failed to fetch"，而页面看起来完全正常。所以命中前缀的请求先等一下（最多
  //     BRIDGE_WAIT_MS），等到了就跟它走。
  // 二、**顺序可能反过来**。App 的拦截会包在 window.fetch 外面；如果它比我们晚装，它包的
  //     就是我们这一层 —— 那种情况下必须把改写过之后的地址交给「当前最外层」那个 fetch，
  //     否则它按没改写过的前缀去匹配，永远匹配不上。所以这里每次都现看样子，不缓存结论。
  // 全程不往页面上画任何东西：这是给开发者的现场信息，不是给用户的提示。
  var BRIDGE_WAIT_MS = 1500;
  function bridgeReady() {
    return typeof window.__dshHostFetch === 'function';
  }
  function outermostFetch() {
    return window.fetch && window.fetch !== wrapped ? window.fetch : nativeFetch;
  }
  function waitForBridge(deadline) {
    return new Promise(function (resolve) {
      (function poll() {
        if (bridgeReady()) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(poll, 40);
      })();
    });
  }
  var nativeFetch = original;
  var wrapped = function (input, init) {
    if (typeof input === 'string') {
      var next = moved(input);
      if (next === copyPath) return Promise.resolve(new Response('', { status: 501 }));
      if (next !== input) {
        return waitForBridge(Date.now() + BRIDGE_WAIT_MS).then(function (ok) {
          if (!ok) {
            // 等不到就如实失败，并且把原因留给现场（控制台 + 一个属性），不画在用户脸上。
            var reason = '取数通道没装上（HostFetch 不在）';
            try {
              document.documentElement.setAttribute('data-dsh-host-missing', reason);
              if (window.console && console.error) console.error('[dsh] ' + reason + '：' + next);
            } catch (e) { /* 留不下现场也不能影响页面 */ }
            return new Response(
              JSON.stringify({ code: 'host-channel-missing', message: reason }),
              { status: 503, headers: { 'content-type': 'application/json' } },
            );
          }
          return outermostFetch().call(this, next, init);
        });
      }
      return nativeFetch.call(this, input, init);
    }
    return nativeFetch.call(this, input, init);
  };
  window.fetch = wrapped;
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
    entry: ENTRY,
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
  // 右栏入口那格画的图：App 只认包里这张固定文件名的 `icon.png`（见 ENTRY 的注释）。
  // 复用页面自带的那张 512 图，不额外造一份。
  out.set('icon.png', fs.readFileSync(path.join(SRC_DIR, 'icons', 'icon-512.png')))
  return out
}

/** 产包：整份拷进 OUT，覆盖写入合并后的 manifest 与注入过改写的 index.html。 */
/**
 * 整包 zip 的落点：与 slug 目录**平级**（`extensions/magpie.zip`）。
 *
 * 位置由宿主决定，不是我们挑的：`mobile/extension-catalog.js` 的整包接口读的就是
 * `<扩展根>/<slug>.zip`。手机装扩展只下这一个包、本地解包 —— 逐文件那条回退已经封了
 * （用户在 2026-11-11 明确要求），所以这个 zip 是**装得上**的前提，不是优化。
 */
const ARCHIVE_FILE = path.join(ROOT, 'extensions', 'magpie.zip')

/** 把产物目录打成 zip（用系统 `zip`，三个桌面系统都有，不引第三方库）。 */
function packArchive() {
  fs.rmSync(ARCHIVE_FILE, { force: true })
  execFileSync('zip', ['-r', '-q', '-X', ARCHIVE_FILE, '.'], { cwd: OUT_DIR })
  return ARCHIVE_FILE
}

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
    // 整包：手机装扩展只下它（逐文件那条路已封，见 ARCHIVE_FILE 的注释）。
    const archive = packArchive()
    console.log(`整包：${path.relative(ROOT, archive)}（${(fs.statSync(archive).size / 1024 / 1024).toFixed(2)} MB）`)
  }
}
