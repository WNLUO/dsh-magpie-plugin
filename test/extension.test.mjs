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

test('整包 zip 在扩展根上（与 slug 目录平级），且装的就是目录里那一份', () => {
  // 位置不是我们挑的：宿主 `mobile/extension-catalog.js` 的整包接口读 `<扩展根>/<slug>.zip`。
  // 而手机装扩展**只下这一个包**（逐文件那条回退 2026-11-11 已封），所以缺了它直接装不上。
  const declared = pkg.dshMobileExtensions === true ? 'extensions' : pkg.dshMobileExtensions
  const archive = path.join(ROOT, declared, 'magpie.zip')
  assert.ok(fs.existsSync(archive), `缺整包：${path.relative(ROOT, archive)}（跑 node scripts/build-extension.mjs）`)

  // zip 里的每一条都要能在产物目录里找到、字节一致：包与目录不同源时，手机上装到的
  // 就是另一个东西，而两边各自的测试都还是绿的。
  const list = spawnSync('unzip', ['-l', archive], { encoding: 'utf8' })
  assert.equal(list.status, 0, `读不出整包：${list.stderr || ''}`)
  const names = list.stdout.split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length === 4 && /^\d+$/.test(cols[0]))
    .map((cols) => cols[3])
    .filter((name) => name && !name.endsWith('/'))
  assert.ok(names.length > 100, `整包里只有 ${names.length} 个文件，看着不像整包`)

  const dir = path.join(ROOT, declared, 'magpie')
  for (const name of names) {
    const onDisk = path.join(dir, name)
    assert.ok(fs.existsSync(onDisk), `整包里的 ${name} 在产物目录里没有（zip 与目录不同源）`)
  }
  // 反方向：目录里的每一份都得进整包，否则手机上永远少那几个文件。
  const inZip = new Set(names)
  const walk = (rel = '') => {
    const out = []
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) out.push(...walk(next))
      else out.push(next)
    }
    return out
  }
  for (const rel of walk()) {
    assert.ok(inZip.has(rel), `产物里的 ${rel} 没进整包（手机上会缺这个文件）`)
  }
})

test('「复制」那一发不出页面：请电脑复制被挡成失败，正常取数照旧挪前缀', async () => {
  // 页面的「复制」第一步是 `POST /api/copy`，请 magpie 把文本放进**电脑**的剪贴板。手机上这一发
  // 成了也没用：文本进的是电脑的剪贴板，用户在自己手机上粘不出来。产包时在注入的改写里把它挡成
  // 失败响应，页面就会按它自己的顺序走手机剪贴板。
  //
  // 这里真跑那段注入脚本（不是看源码里有没有一句话）：喂一个假 window 与假 Response，断言三个
  // 方向 —— 复制那一发不发出去、正常取数照旧挪到前缀下、外链原样放行。
  const html = read(declared, 'magpie', 'index.html')
  const injected = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(injected, 'index.html 里找不到注入的改写脚本')
  const calls = []
  const fakeWindow = {
    // 一条「健康」的记录：能力给了、宿主取数通道也装上了（`__dshHostFetch` 在）。
    __DSH_EXTENSION__: { capabilities: ['content.read', 'card.write', 'host.data'] },
    __dshHostFetch: () => Promise.resolve({ ok: true, status: 200 }),
    addEventListener() {},
    fetch: (input) => {
      calls.push(typeof input === 'string' ? input : String(input))
      return Promise.resolve({ ok: true, status: 200 })
    },
  }
  new Function('window', 'Response', injected[1])(fakeWindow, globalThis.Response)
  const pageFetch = fakeWindow.fetch

  const copied = await pageFetch('/api/copy', { method: 'POST' })
  assert.equal(copied.ok, false, '复制那一发必须回一个失败响应，页面才会走自己的剪贴板')
  assert.deepEqual(calls, [], `复制那一发被发出去了：${calls.join(', ')}`)

  await pageFetch('/api/state')
  assert.deepEqual(calls, ['/api/dsh-magpie/api/state'], '正常取数必须挪到插件前缀下')

  await pageFetch('https://example.com/x.json')
  assert.equal(calls[1], 'https://example.com/x.json', '外链必须原样放行')
})

test('首屏取数会等宿主那段拦截，等不到就如实失败——都不往页面上画东西', async () => {
  // 真机上遇到的那种：页面显示得出来、数据全取不到，屏幕上只有一句 "failed to fetch"。
  // 两个原因都在这里钉住：一是宿主那段拦截是页面加载后才注入的，页面首屏请求可能比它早；
  // 二是它可能包在我们这一层外面（顺序反过来），那时必须把改写过的地址交给最外层那个 fetch。
  // 无论哪种，都不许往用户脸上画东西 —— 现场只留在控制台与一个属性上。
  const html = read(declared, 'magpie', 'index.html')
  const injected = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(injected)

  // 一、桥晚一点才到：等到之后照常走宿主，不打 file://。
  {
    const calls = []
    const fakeWindow = {
      __DSH_EXTENSION__: { capabilities: ['content.read', 'host.data'] },
      addEventListener() {},
      fetch: (input) => { calls.push(String(input)); return Promise.resolve({ ok: true, status: 200 }); },
    }
    new Function('window', 'Response', 'document', injected[1])(fakeWindow, globalThis.Response, {
      documentElement: { setAttribute() {} },
    })
    // 页面发第一发之后，宿主那段拦截才装上（真机上就是这一拍）。
    setTimeout(() => {
      fakeWindow.__dshHostFetch = () => Promise.resolve({ ok: true, status: 200 });
      fakeWindow.fetch = (input) => { calls.push('host:' + String(input)); return Promise.resolve({ ok: true, status: 200 }); };
    }, 60)
    const res = await fakeWindow.fetch('/api/state')
    assert.equal(res.status, 200, '等到了桥就照常取数')
    assert.deepEqual(calls, ['host:/api/dsh-magpie/api/state'], '必须交给最外层（宿主那层）那个 fetch，且地址已改写')
  }

  // 二、等不到桥：回一个带 code 的失败响应，不画东西，只留现场。
  {
    const calls = []
    const attrs = {}
    const fakeWindow = {
      __DSH_EXTENSION__: { capabilities: ['content.read'] },
      addEventListener() {},
      fetch: (input) => { calls.push(String(input)); return Promise.resolve({ ok: true, status: 200 }); },
      console: { error() {} },
    }
    new Function('window', 'Response', 'document', injected[1])(fakeWindow, globalThis.Response, {
      documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
    })
    const res = await fakeWindow.fetch('/api/agents')
    assert.equal(res.status, 503)
    assert.equal((await res.json()).code, 'host-channel-missing')
    assert.deepEqual(calls, [], '别再让那一发去打一个注定失败的地址')
    assert.ok(attrs['data-dsh-host-missing'], '原因要留给现场')
    assert.equal(fakeWindow.__dshHostComplained, undefined, '不许再往页面上画条子')
  }
})

test('页面里的报错静默送到插件那条旁路，界面上什么都不出来', () => {
  // 手机上「Cannot read properties of null」只剩一句提示、没有栈 —— 作者就永远查不到。
  // 注入脚本把 `error` / `unhandledrejection` 静默报到 `/__diag`，落一行到电脑上的文件里。
  const html = read(declared, 'magpie', 'index.html')
  const injected = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(injected)
  const sent = []
  const listeners = {}
  const fakeWindow = {
    __DSH_EXTENSION__: { capabilities: ['content.read', 'host.data'] },
    __dshHostFetch: (service, url, opts) => {
      sent.push({ service, url, body: JSON.parse(opts.body) })
      return Promise.resolve({ ok: true, status: 200 })
    },
    addEventListener: (name, fn) => { listeners[name] = fn },
    fetch: () => Promise.resolve({ ok: true, status: 200 }),
  }
  new Function('window', 'Response', 'document', injected[1])(fakeWindow, globalThis.Response, {
    documentElement: { setAttribute() {} },
  })

  const err = new Error("Cannot read properties of null (reading 'length')")
  err.stack = 'TypeError: x\n    at renderQuotas (app.js:42:7)'
  listeners.error({ message: err.message, filename: 'file:///x/app.js', lineno: 42, colno: 7, error: err })
  assert.equal(sent.length, 1, '报错要送出去')
  assert.equal(sent[0].service, 'dsh-magpie')
  assert.equal(sent[0].url, '/api/dsh-magpie/__diag')
  assert.equal(sent[0].body.kind, 'error')
  assert.equal(sent[0].body.line, 42)
  assert.match(sent[0].body.stack, /renderQuotas/, '栈必须带上，否则这条通道没有意义')

  listeners.unhandledrejection({ reason: new Error('boom') })
  assert.equal(sent.length, 2)
  assert.equal(sent[1].body.kind, 'rejection')
})

test('页面自己上报给 App 的错，顺手抄一份到旁路并补上栈', () => {
  // 页面里的错误多数是页面自己 catch 住、再用一条 kind 为 error 的消息报给 App 的 —— 那种情况
  // 全局的 error 钩子不会响，而消息里只有一句话，没有栈。所以那一发也要抄一份。
  const html = read(declared, 'magpie', 'index.html')
  const injected = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(injected)
  const sent = []
  const posted = []
  const fakeWindow = {
    __DSH_EXTENSION__: { capabilities: ['content.read', 'host.data'] },
    __dshHostFetch: (service, url, opts) => {
      sent.push({ service, url, body: JSON.parse(opts.body) })
      return Promise.resolve({ ok: true, status: 200 })
    },
    ReactNativeWebView: { postMessage: (raw) => posted.push(raw) },
    addEventListener() {},
    fetch: () => Promise.resolve({ ok: true, status: 200 }),
  }
  new Function('window', 'Response', 'document', injected[1])(fakeWindow, globalThis.Response, {
    documentElement: { setAttribute() {} },
  })

  fakeWindow.ReactNativeWebView.postMessage(JSON.stringify({ kind: 'error', message: "Cannot read properties of null (reading 'length')" }))
  assert.deepEqual(posted.length, 1, '原样放行给 App，不能吞掉')
  assert.equal(sent.length, 1, '要抄一份到旁路')
  assert.equal(sent[0].url, '/api/dsh-magpie/__diag')
  assert.equal(sent[0].body.kind, 'reported')
  assert.match(sent[0].body.stack, /at /, '要补上报那一刻的栈，否则还是查不出哪一段在报')

  // 不是报错的消息不该抄（比如 ready / card 这种，抄了就是噪音）
  fakeWindow.ReactNativeWebView.postMessage(JSON.stringify({ kind: 'ready' }))
  assert.equal(sent.length, 1)
})

test('页面内核记的那一行 console.error 也抄一份，带插件名与栈', () => {
  // 页面里的小部件抛错是它自己的内核 catch 住的：一行 console.error 带插件 id、部件、钩子名和
  // 错误对象 —— 手机上这行看不到，可它最有信息。抄一份过来，栈就有了。
  const html = read(declared, 'magpie', 'index.html')
  const injected = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(injected)
  const sent = []
  const printed = []
  const fakeWindow = {
    __DSH_EXTENSION__: { capabilities: ['content.read', 'host.data'] },
    __dshHostFetch: (service, url, opts) => {
      sent.push(JSON.parse(opts.body))
      return Promise.resolve({ ok: true, status: 200 })
    },
    console: { error: (...args) => printed.push(args) },
    addEventListener() {},
    fetch: () => Promise.resolve({ ok: true, status: 200 }),
  }
  new Function('window', 'Response', 'document', injected[1])(fakeWindow, globalThis.Response, {
    documentElement: { setAttribute() {} },
  })

  const boom = new Error("Cannot read properties of null (reading 'length')")
  boom.stack = 'TypeError: x\n    at renderQuotas (plugins/usage/page.js:1200:9)'
  fakeWindow.console.error('[magpie] usage: page.mount', boom)
  assert.equal(printed.length, 1, '原来那行必须照旧打出去')
  assert.equal(sent.length, 1, '要抄一份到旁路')
  assert.equal(sent[0].kind, 'console')
  assert.match(sent[0].message, /usage: page\.mount/, '插件与部件名要在消息里')
  assert.match(sent[0].stack, /renderQuotas/, '错误对象的栈必须带上')
})
