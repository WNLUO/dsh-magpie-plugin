/**
 * 守卫：这个插件**被宿主装载之后**真的能把接口挂上，并且在被装载的那一刻就可用。
 *
 * 前面几份守卫验的是「包对不对」「链路通不通」，都绕过了 `index.js`——但真机上装进去的
 * 是 `apply(ctx)` 这一条路。这里用一个最小假宿主（就是 cordis 那两样：`inject` 等某个服务、
 * `effect` 登记一个可回收的副作用）把入口跑一遍，钉住一件真机上最难查的事：
 *
 *   **插件先于 `webServer` 加载**。真实 composition 里 get 不到 `webServer`，靠 `inject`
 *   等它发布；如果哪天有人把 `ctx.inject(['webServer'], cb)` 改成装载时直接 `ctx.get`，
 *   手机上就会「插件装着、接口一个都没有」，而所有静态断言都还是绿的。
 *
 * 不真起 magpie 进程：`ensureWebFn` 换成直接回假端口（与 integration.test 同一口径）。
 *
 * 运行：node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { apply, inject, name } from '../index.js'
import { ROUTE_PREFIX } from '../lib/paths.js'

/**
 * 一个最小假宿主。
 *
 * 只实现入口真正会用到的三样：
 *  - `logger`：收下日志，测试可以断言「装了有没有说一声」；
 *  - `inject(deps, cb)`：**记下来**，等 `publishWebServer` 时才回调 —— 这就是「插件先于
 *    webServer 加载」的真实处境；
 *  - `effect(fn, label)`：立刻执行 fn 并收下它的返回值（真实宿主用它做回收）。
 *
 * @returns {{ ctx: object, logs: string[], publishWebServer: (server: object) => void, injected: string[][] }}
 */
function fakeHost() {
  const logs = []
  const pending = []
  const injected = []
  const effects = []
  const ctx = {
    logger: {
      info: (m) => logs.push(`info:${m}`),
      error: (m) => logs.push(`error:${m}`),
    },
    inject(deps, cb) {
      injected.push(deps)
      pending.push({ deps, cb })
    },
    effect(fn, label) {
      effects.push({ label, dispose: fn() })
    },
  }
  return {
    ctx,
    logs,
    injected,
    effects,
    /** 把 webServer 发布出去，之前等着的 inject 回调在这时才跑。 */
    publishWebServer(server) {
      const scoped = { ...ctx, webServer: server, effect: ctx.effect }
      for (const item of pending.splice(0)) item.cb(scoped)
    },
  }
}

/** 一个记账用的假 webServer：收下 registration，并把它真当路由用起来。 */
function fakeWebServer() {
  const registrations = []
  return {
    registrations,
    register(options) {
      registrations.push(options)
      return { dispose() {} }
    },
  }
}

function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('入口身份与包名一致（宿主按包名解析挂载行）', () => {
  assert.equal(name, 'dsh-magpie-plugin')
  assert.deepEqual(inject, ['webServer'], '入口必须声明 inject webServer，否则拿不到宿主端口')
})

test('插件先于 webServer 装载也不丢路由：inject 回调发布后才注册', () => {
  const host = fakeHost()
  apply(host.ctx)
  // 刚 apply 完：还没有 webServer，一个字都不该注册（也不该抛）。
  assert.equal(host.injected.length, 1, '应当只声明一次 inject webServer')
  assert.deepEqual(host.injected[0], ['webServer'])

  const server = fakeWebServer()
  host.publishWebServer(server)
  assert.equal(server.registrations.length, 1, 'webServer 发布后应当注册一条路由')
  assert.equal(server.registrations[0].kind, 'prefix', '注册的必须是前缀路由')
  assert.equal(server.registrations[0].path, ROUTE_PREFIX, `注册路径必须走 ROUTE_PREFIX：${server.registrations[0].path}`)
  assert.equal(typeof server.registrations[0].handler, 'function', '注册的 handler 不是函数')
  assert.ok(host.logs.some((line) => line.startsWith('info:')), '装上之后应当留一条 info 日志')
})

test('装载失败只记日志、不抛（导入失败不能拖垮整台宿主）', () => {
  const logs = []
  // 宿主的 inject 当场抛：入口必须自己兜住，把话记进日志、不往上扔 —— 否则一次插件装载
  // 失败会让整台 DSH 起不来。
  const boom = {
    logger: { info: (m) => logs.push(`info:${m}`), error: (m) => logs.push(`error:${m}`) },
    inject() { throw new Error('宿主 inject 炸了') },
    effect() {},
  }
  assert.doesNotThrow(() => apply(boom))
  assert.ok(logs.some((line) => line.startsWith('error:')), '装载失败必须留一条 error 日志，否则现场无从查起')
})

test('装载后 handler 真的能穿：注册的那条 handler 走完整链路把请求转给 magpie', async () => {
  // 假 magpie：回显它看到什么，好断言前缀被剥干净了。
  const magpie = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ seenPath: req.url }))
  })
  await new Promise((r) => magpie.listen(0, '127.0.0.1', r))
  const magpiePort = magpie.address().port

  // 一个真监听着的宿主服务，把请求交给注册进来的 handler。
  let registered = null
  const hostServer = http.createServer((req, res) => registered(undefined, req, res))
  await new Promise((r) => hostServer.listen(0, '127.0.0.1', r))

  const host = fakeHost()
  const { createReloadable } = await import('../lib/reload.js')
  const app = createReloadable({
    deps: {
      ensureWebFn: async () => ({ available: true, port: magpiePort, key: 'k' }),
      cookieFn: async () => '',
    },
  })
  registered = app.handler

  try {
    const res = await request(hostServer.address().port, `${ROUTE_PREFIX}/api/state`)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.seenPath, '/api/state', `magpie 应当看到剥掉前缀后的 /api/state，实际 ${body.seenPath}`)
  } finally {
    magpie.close(); hostServer.close()
  }
})
