/**
 * magpie 网页版原版的**本地开发服务器**（DV）。
 *
 * 这一份是「把上游的前端原样跑起来」，不是二次开发：`index.html` 与它引用的每一个
 * `.js` / `.css` / 图标都在本目录下，直接就是 magpie 仓库 `internal/gui/assets/` 那一套。
 *
 * 为什么需要一个服务器而不是双击 `index.html`：上游这一页不是静态站，它靠三样在运行时
 * 才有的东西 ——
 *   1. `boot.js`：宿主在页面绘制前拼出来的一段（语言 / 主题 / 是不是网页版）。上游由 Go
 *      的 `GET /boot.js` 现生成，我们这里给了一份等价的静态版（见同目录 `boot.js`）。
 *   2. `/api/*`：页面的每一个数字都从 magpie 自己那几个接口来。
 *   3. 登录 cookie：`magpie` 的网页版要 `/?k=<key>` 换一个 cookie 才认 `/api/*`。
 * 所以这个服务器做三件事：**本地文件优先**、**其余全部反代给本机 magpie**、**替页面把 cookie 备好**。
 *
 * 用法：
 *   node web/serve.mjs                           # 默认 5273
 *   PORT=5300 node web/serve.mjs
 *   MAGPIE_WEB_URL=http://127.0.0.1:3430 ...     # 指一台别的 magpie 网页版
 *
 * key 的来处与本仓插件一致：`$MAGPIE_WEB_KEY` → `~/.dsh/magpie-web-key`。也就是说这里跑的就是
 * 你电脑上那个真 magpie 的界面，改的是真数据（只读页面除外 —— 这个前端本来就有写操作）。
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 5273)
const MAGPIE_WEB_URL = process.env.MAGPIE_WEB_URL || 'http://127.0.0.1:3430'

/** magpie 认的几种静态类型。缺了它浏览器会按二进制猜，脚本直接不执行。 */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

const upstream = new URL(MAGPIE_WEB_URL)
/** 这次会话用的 key（拿到了就一直用；magpie 重启换了 key 时这里会失效，重启本进程即可）。 */
let cookie = ''

/** 与插件同一处：用户设的优先，其次是我们/插件上次留下的那份。 */
function readKey() {
  const given = String(process.env.MAGPIE_WEB_KEY || '').trim()
  if (given) return given
  try {
    return fs.readFileSync(path.join(os.homedir(), '.dsh', 'magpie-web-key'), 'utf8').trim()
  } catch {
    return ''
  }
}

/** 一次最简 HTTP 请求（不跟随跳转：换 cookie 那一跳正是要看的状态码）。 */
function request(url, { path: p, headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: url.hostname,
      port: url.port || 80,
      path: p,
      method,
      timeout: 15000,
      headers: { 'user-agent': 'magpie-web-dev', ...headers },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }) })
    req.on('error', () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }))
    req.end()
  })
}


/**
 * 把回包头里写死成上游地址的那些值换成浏览器实际用的来源。
 *
 * 现在只处理 `content-security-policy`：它是唯一一处会「指名道姓说某个源可以跑脚本」的头，
 * 换错了插件页直接白屏。别的头（`location` 之类）暂时没动 —— 上游的跳转本来就相对路径。
 */
function rewriteUpstreamOrigin(headers, hostHeader) {
  const csp = headers['content-security-policy']
  if (!csp || !hostHeader) return
  const here = `http://${hostHeader}`
  // 上游同一份政策里 http 与 https 两种写法都有，两个都换：只换一个的话，另一种仍指回
  // 它自己的端口，线上不致命但读起来像没改干净。
  let policy = String(csp)
  for (const scheme of ['http', 'https']) {
    policy = policy.split(`${scheme}://${upstream.host.replace(/^\/\//, '')}`).join(here)
  }
  headers['content-security-policy'] = policy
}

/**
 * 拿 key 换 cookie。
 *
 * 换不到就按 magpie 的 cookie 名直接拼一个（`magpie_web_<port>`，值就是 key）—— 那一跳
 * 只是把 key 换个形式存下来。两条都走不通才留空（页面自己会跳登录页）。
 */
async function login() {
  const key = readKey()
  if (!key) return
  const hop = await request(upstream, { path: `/?k=${encodeURIComponent(key)}` })
  const raw = hop.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  for (const line of list) {
    const pair = String(line).split(';', 1)[0]
    if (pair.startsWith('magpie_web_')) { cookie = pair.trim(); return }
  }
  const port = upstream.port || '80'
  cookie = `magpie_web_${port}=${key}`
}

/** 这个路径在本目录下有没有真文件（只认目录里的，别让 `..` 跑出去）。 */
function localFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?', 1)[0])
  if (clean.includes('\0')) return ''
  const full = path.join(ROOT, clean === '/' ? 'index.html' : clean)
  const rel = path.relative(ROOT, full)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''
  try {
    return fs.statSync(full).isFile() ? full : ''
  } catch {
    return ''
  }
}

/** 反代一条请求给上游，带上 cookie，把回包原样交回去。 */
async function proxy(req, res) {
  const target = `http://${upstream.host}${req.url}`
  const headers = { ...req.headers, host: upstream.host }
  if (cookie) headers.cookie = cookie
  delete headers['accept-encoding'] // 不接压缩：回包原样转，少一层解压
  return new Promise((resolve) => {
    const out = http.request(target, { method: req.method, headers, timeout: 30000 }, (up) => {
      const clean = { ...up.headers }
      delete clean['content-encoding']
      delete clean['content-length']
      // 上游的 cookie 不往下传：这一层的 cookie 由本服务器统一管
      delete clean['set-cookie']
      // ★ 本地改动：把上游写死成 `scheme://<它自己>:<端口>` 的那些地址改成**浏览器实际访问的
      // 那个来源**。最要紧的是插件页的 CSP —— magpie 给插件的沙箱页签发的
      // `Content-Security-Policy` 里 `script-src` / `style-src` 只放行它自己那个源
      // （`http://127.0.0.1:3430/_magpie/plugin/<token>/`），而我们这一层是从
      // `127.0.0.1:5273` 端出去的：不换掉，页面里每一个插件脚本都会被 CSP 拦成
      // 「violates the following Content Security Policy directive: script-src ... 3430」，
      // 界面上就是插件页一直「读取中」加一片红。
      rewriteUpstreamOrigin(clean, req.headers.host)
      res.writeHead(up.statusCode || 502, clean)
      up.pipe(res)
      up.on('end', resolve)
    })
    out.on('timeout', () => { out.destroy(); if (!res.headersSent) res.writeHead(504); res.end(); resolve() })
    out.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('上游 magpie 网页版没有应答。确认它开着：magpie web --addr 127.0.0.1:3430 --no-open')
      resolve()
    })
    req.pipe(out)
  })
}

const server = http.createServer(async (req, res) => {
  // 先看是不是本目录里的文件：前端整份都在这里，服务器只补页面缺的那三样。
  const file = localFile(req.url || '/')
  if (file) {
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      // 开发期一律不缓存：改完刷新就要看到
      'cache-control': 'no-store',
    })
    fs.createReadStream(file).pipe(res)
    return
  }
  // 其余（`/api/*`、上游的图标与字体）一律交给本机 magpie。
  await proxy(req, res)
})

await login()
server.listen(PORT, '127.0.0.1', () => {
  const key = readKey()
  console.log(`magpie 网页版（原版前端）: http://127.0.0.1:${PORT}/`)
  console.log(`上游: ${MAGPIE_WEB_URL}   凭据: ${cookie ? '已拿到' : key ? '有 key 但没换到 cookie' : '没找到 key（见 ~/.dsh/magpie-web-key）'}`)
})
