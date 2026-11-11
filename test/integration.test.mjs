/**
 * 端到端集成：假 magpie 服务 + 真路由 + 真透明代理。
 *
 * 前面几份守卫分开钉零件（探测、key、路由表、包结构），这一份把「页面请求 → 插件路由 →
 * 透明代理 → magpie」整条串起来跑，钉的是一件真机上出了会「页面没数据但各处测试都绿」的事：
 * 前缀剥对没有、方法 / 正文 / content-type / cookie 透传没有、状态码与正文原样回来没有。
 *
 * 不真起 magpie 进程：ensure 换成直接回假服务端口，一个进程都不起。
 *
 * 运行：node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createRoutes } from '../lib/routes.js'
import { ROUTE_PREFIX } from '../lib/paths.js'

/** 起一个假 magpie：把收到的请求要素原样回显，方便断言上游到底看到了什么。 */
function fakeMagpie() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        // 认一条「登录那一跳」：/?k=… → 303 + set-cookie（真实 magpie 就是这么换 cookie 的）。
        if (req.url.startsWith('/?k=')) {
          res.writeHead(303, { location: '/', 'set-cookie': 'magpie_session=abc; Path=/; HttpOnly' })
          res.end()
          return
        }
        res.writeHead(207, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          seenMethod: req.method,
          seenPath: req.url,
          seenCookie: req.headers.cookie ?? null,
          seenContentType: req.headers['content-type'] ?? null,
          seenBody: body,
        }))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** 起一个跑插件路由的宿主服务：所有请求都交给 handler。 */
function hostWith(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => { handler(undefined, req, res) })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function request(port, path, { method = 'GET', body, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: contentType ? { 'content-type': contentType } : {} }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

test('整链路：GET /api/dsh-magpie/api/state 剥前缀后打到 magpie 的 /api/state，正文原样回来', async () => {
  const magpie = await fakeMagpie()
  const routes = createRoutes({ ensureWebFn: async () => ({ available: true, port: magpie.port, key: 'k' }), cookieFn: async () => 'magpie_session=abc' })
  const host = await hostWith(routes)
  try {
    const res = await request(host.port, `${ROUTE_PREFIX}/api/state`)
    assert.equal(res.status, 207, '上游状态码要原样透传，不能被包成 200')
    const echoed = JSON.parse(res.body)
    assert.equal(echoed.seenMethod, 'GET')
    assert.equal(echoed.seenPath, '/api/state', '前缀必须被剥掉：magpie 该看到 /api/state，而不是 /api/dsh-magpie/api/state')
    assert.equal(echoed.seenCookie, 'magpie_session=abc', '登录 cookie 必须带到上游')
    assert.equal(res.headers['content-type'], 'application/json', '上游 content-type 要透传')
  } finally {
    magpie.server.close(); host.server.close()
  }
})

test('整链路：POST 的正文与 content-type 原样转给 magpie', async () => {
  const magpie = await fakeMagpie()
  const routes = createRoutes({ ensureWebFn: async () => ({ available: true, port: magpie.port, key: 'k' }), cookieFn: async () => '' })
  const host = await hostWith(routes)
  try {
    const payload = JSON.stringify({ hello: 'world' })
    const res = await request(host.port, `${ROUTE_PREFIX}/api/state`, { method: 'POST', body: payload, contentType: 'application/json' })
    const echoed = JSON.parse(res.body)
    assert.equal(echoed.seenMethod, 'POST')
    assert.equal(echoed.seenPath, '/api/state')
    assert.equal(echoed.seenContentType, 'application/json')
    assert.equal(echoed.seenBody, payload, '请求正文必须原样转给上游')
  } finally {
    magpie.server.close(); host.server.close()
  }
})

test('整链路：4xx/5xx 也原样透传（页面按普通 Response 判断）', async () => {
  const server = http.createServer((req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"no"}') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const routes = createRoutes({ ensureWebFn: async () => ({ available: true, port: server.address().port, key: 'k' }), cookieFn: async () => '' })
  const host = await hostWith(routes)
  try {
    const res = await request(host.port, `${ROUTE_PREFIX}/api/state`)
    assert.equal(res.status, 401, '上游 401 必须原样透传，不能变成 200')
    assert.equal(res.body, '{"error":"no"}')
  } finally {
    server.close(); host.server.close()
  }
})

test('边界：前缀下非 /api/ 的路径不代理 —— 回 404，不给它当整站代理', async () => {
  const routes = createRoutes({ ensureWebFn: async () => ({ available: true, port: 1, key: 'k' }) })
  const host = await hostWith(routes)
  try {
    const res = await request(host.port, `${ROUTE_PREFIX}/secret`)
    assert.equal(res.status, 404)
  } finally { host.server.close() }
})

test('边界：magpie 不可用时回 503 且说明原因，不抛 500', async () => {
  const routes = createRoutes({ ensureWebFn: async () => ({ available: false, reason: 'no-magpie' }) })
  const host = await hostWith(routes)
  try {
    const res = await request(host.port, `${ROUTE_PREFIX}/api/state`)
    assert.equal(res.status, 503)
    assert.match(res.body, /no-magpie/)
  } finally { host.server.close() }
})
