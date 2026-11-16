/**
 * 守卫：页面报错那条旁路（`lib/page-errors.js` + `lib/routes.js` 的 `/__diag` 分派）。
 *
 * 钉的是一件真会踩到的事：扩展页在手机上出一句 `Cannot read properties of null (reading
 * 'length')`，没有栈、没有位置，作者除了那一句什么都拿不到。这条旁路把页面里的错误静默送到
 * 电脑上一个文件里，才有得查。三条口径都要钉住：**留得下现场**、**用户看不见**（这条通道除了
 * 写文件什么都不做）、**有界**（正文与文件都有上限）。
 *
 * 运行：node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { recordPageError, pageErrorLogFile, MAX_BODY_BYTES } from '../lib/page-errors.js'
import { createRoutes } from '../lib/routes.js'
import { ROUTE_PREFIX } from '../lib/paths.js'

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-page-errors-'))
}

/** 一条假的请求：带上 Readable 的 `on/destroy`，够 `readBody` 用。 */
function fakeReq(body, { method = 'POST', url = `${ROUTE_PREFIX}/__diag` } = {}) {
  const stream = Readable.from([Buffer.from(body, 'utf8')])
  stream.method = method
  stream.url = url
  return stream
}

function fakeRes() {
  const res = { status: 0, body: '' }
  res.writeHead = (status) => { res.status = status }
  res.end = (payload) => { res.body = String(payload ?? '') }
  return res
}

function readLines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function withHome(env, run) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = env
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

test('一条页面报错落一行：消息、栈、位置都在，用户那边什么都没发生', async () => {
  const home = makeHome()
  try {
    await withHome(home, async () => {
      const res = fakeRes()
      await recordPageError(fakeReq(JSON.stringify({
        kind: 'error',
        message: "Cannot read properties of null (reading 'length')",
        source: 'file:///x/app.js',
        line: 42,
        column: 7,
        stack: 'TypeError: x\n    at renderQuotas (app.js:42:7)',
      })), res)
      assert.equal(res.status, 200, '旁路永远回 200：上报失败不该变成页面的另一个错误')
      assert.deepEqual(JSON.parse(res.body), { ok: true })
      const lines = readLines(pageErrorLogFile())
      assert.equal(lines.length, 1)
      assert.equal(lines[0].kind, 'error')
      assert.match(lines[0].message, /reading 'length'/)
      assert.equal(lines[0].line, 42)
      assert.equal(lines[0].column, 7)
      assert.match(lines[0].stack, /renderQuotas/, '没有栈这条通道就没有意义')
      assert.ok(lines[0].at, '要带时间，才知道是哪一次')
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('形状认不出也照收（留原文前一段），长串截短', async () => {
  const home = makeHome()
  try {
    await withHome(home, async () => {
      await recordPageError(fakeReq('这不是 JSON'), fakeRes())
      await recordPageError(fakeReq(JSON.stringify({ message: 'x'.repeat(2000), stack: 'y'.repeat(9000) })), fakeRes())
      const lines = readLines(pageErrorLogFile())
      assert.equal(lines.length, 2)
      assert.equal(lines[0].raw, '这不是 JSON', '认不出形状时留原文，别丢了')
      assert.equal(lines[1].message.length, 400, '消息截到 400')
      assert.equal(lines[1].stack.length, 4000, '栈截到 4000')
      assert.equal(lines[1].kind, 'error', '没写 kind 时按 error 记')
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('超长正文只留前一段，仍然回 200', async () => {
  const home = makeHome()
  try {
    await withHome(home, async () => {
      const huge = JSON.stringify({ message: 'z'.repeat(MAX_BODY_BYTES + 5000) })
      const res = fakeRes()
      await recordPageError(fakeReq(huge), res)
      assert.equal(res.status, 200)
      const lines = readLines(pageErrorLogFile())
      assert.equal(lines.length, 1)
      assert.ok(lines[0].message.length <= 400, '截短之后不该超过 400')
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('路由真的把 POST /__diag 分给这条旁路，别的写法回 405', async () => {
  const home = makeHome()
  try {
    await withHome(home, async () => {
      const handler = createRoutes({})
      const res = fakeRes()
      await handler(undefined, fakeReq(JSON.stringify({ message: 'boom' })), res)
      assert.equal(res.status, 200)
      assert.equal(readLines(pageErrorLogFile()).length, 1, '要走那条旁路，不能落到代理上')

      const wrong = fakeRes()
      await handler(undefined, fakeReq('', { method: 'GET' }), wrong)
      assert.equal(wrong.status, 405)
      assert.equal(readLines(pageErrorLogFile()).length, 1, '方法不对不记日志')
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
