/**
 * 守卫：reload-dev 最后那句「这一次到底换掉了没有」的判词（`lib/update/host.js`）。
 *
 * 判错一次就要人多做一件错的事，而且方向相反：明明只是「还没重启」，却让人去查「为什么重载
 * 失败」。四档各自钉住，重点是最容易判反的那一档 —— **启动列表里刚加进去、宿主还没重启**：
 * 那一刻插件前缀已经被占住，宿主对 `/api/<前缀>/…` 统一回**空正文的 400**，可路由还没挂；
 * 而插件那条闸拒请求时回的是**带 JSON 的 400**。两种必须分开：前者重启就好，后者才是真失败。
 *
 * 真跑的是 `reloadInPlace` 本身（`fetchImpl` 由守卫注入），端口用显式值，只测判词。
 *
 * 运行：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { RELOAD_PATH, reloadInPlace } from '../lib/update/host.js'

/** 一个够用的假响应：`json` 由调用方给，抛错就等价于正文读不出来（空正文）。 */
const answer = (status, body) => async (url) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
  url,
})

/** 打一次判词，同时把请求打到哪个地址记下来（判词之外还得确认它问的是那条路径）。 */
async function verdict(fetchImpl) {
  const asked = []
  const wrapped = async (url, init) => {
    asked.push(String(url))
    return fetchImpl(url, init)
  }
  const result = await reloadInPlace({ explicitPort: 49952, fetchImpl: wrapped })
  return { result, asked }
}

test('换掉了：200 且 ok:true 就是 reloaded', async () => {
  const { result, asked } = await verdict(answer(200, { ok: true }))
  assert.equal(result.status, 'reloaded')
  assert.equal(asked.length, 1)
  assert.ok(asked[0].endsWith(RELOAD_PATH), `问的不是那条调试路由：${asked[0]}`)
})

test('还没重启（首装必撞）：空正文的 400 是 no-route，不是失败', async () => {
  // 这一档就是「profile 里刚登记、宿主没重启」的现场。判成 failed 会让人去查一个不存在的毛病。
  const { result } = await verdict(answer(400, null))
  assert.equal(result.status, 'no-route', `首装那一档被判成了 ${result.status}：${result.detail}`)
  assert.match(result.detail, /HTTP 400/)
})

test('真失败：带 JSON 的 400 仍是 failed（插件的闸认出了这条请求但拒了）', async () => {
  const { result } = await verdict(answer(400, { ok: false, error: { code: 'bad-request', message: 'missing header' } }))
  assert.equal(result.status, 'failed')
  assert.match(result.detail, /missing header/)
})

test('跑着的进程里没有这条路由：401 / 403 / 404 都是 no-route', async () => {
  for (const status of [401, 403, 404]) {
    const { result } = await verdict(answer(status, null))
    assert.equal(result.status, 'no-route', `HTTP ${status} 被判成了 ${result.status}`)
  }
})

test('路由在、但它说换不了：200 且 ok:false 是 failed', async () => {
  const { result } = await verdict(answer(200, { ok: false, error: { code: 'reload-failed', message: 'import 失败' } }))
  assert.equal(result.status, 'failed')
  assert.match(result.detail, /import 失败/)
})

test('一台宿主都没在跑：调不到就是 no-host', async () => {
  const { result } = await verdict(async () => { throw new TypeError('connect ECONNREFUSED') })
  assert.equal(result.status, 'no-host')
})
