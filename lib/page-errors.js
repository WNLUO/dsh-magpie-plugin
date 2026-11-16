/**
 * 页面自己报上来的错（`POST /api/dsh-magpie/__diag`）。
 *
 * **为什么要有这条**：扩展页里的报错（`Cannot read properties of null (reading 'length')` 这类）
 * 在手机上只剩 App 的一句提示 —— 没有栈、没有位置，页面自己的控制台在手机上根本看不到。
 * 于是构建脚本在页面里挂了两个钩子（`error` 与 `unhandledrejection`），把它们**静默**送到
 * 这里，落一行到 `~/.dsh/magpie-page-errors.log`。作者那边一条命令就能看到栈。
 *
 * 三条口径，都是刻意的：
 *  1. **用户看不到任何东西**：这条通道只写文件，页面上不出现提示条 —— 诊断是给开发者的。
 *  2. **有界**：一行一条，超过 1 MiB 滚一份；正文上限 32 KiB，超了只留前一段。这是现场记录，
 *     不是审计账。
 *  3. **永远不会让页面失败**：读不出正文、写不进文件都照旧回 `{ok:true}` —— 上报失败不该变成
 *     页面的另一个错误。
 */

import fs from 'node:fs'
import path from 'node:path'

import { dshHome } from './update/profile.js'

/** 一条上报正文的上限。栈再长也就几 KB，32 KiB 已经很宽松。 */
export const MAX_BODY_BYTES = 32 * 1024
/** 这份日志的上限：超了滚一份。 */
const LOG_LIMIT_BYTES = 1024 * 1024

/** 这份文件的位置（`DSH_HOME` 可覆盖，测试据此指到临时目录）。 */
export function pageErrorLogFile(env = process.env, home = undefined) {
  return path.join(dshHome(env, home), 'magpie-page-errors.log')
}

/** 把正文读成字符串：读不全或超限就只留前一段，不抛。 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        try { req.destroy() } catch { /* 已经断了 */ }
        finish(Buffer.concat(chunks).toString('utf8').slice(0, MAX_BODY_BYTES))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('timeout', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(Buffer.concat(chunks).toString('utf8')))
  })
}

/** 从正文里挑出要留的那几格：认不出的形状也照收，只把长串截短。 */
function entryOf(raw) {
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  const pick = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '')
  const source = parsed && typeof parsed === 'object' ? parsed : {}
  return {
    at: new Date().toISOString(),
    kind: pick(source.kind, 40) || 'error',
    message: pick(source.message, 400),
    source: pick(source.source, 300),
    line: Number.isFinite(source.line) ? source.line : null,
    column: Number.isFinite(source.column) ? source.column : null,
    stack: pick(source.stack, 4000),
    // 认不出形状时把原样的前一段留着：总比什么都没有强。
    raw: parsed === null ? pick(raw, 400) : null,
  }
}

/** 落一行；写不进去也当成功（见文件头第 3 条）。 */
function appendLine(file, entry) {
  try {
    try {
      if (fs.statSync(file).size > LOG_LIMIT_BYTES) fs.renameSync(file, `${file}.1`)
    } catch {
      /* 还没有这个文件 */
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch {
    /* 记不下来不该变成页面的另一个错误 */
  }
}

/**
 * `POST /api/dsh-magpie/__diag`：收一条页面报错，落一行。
 *
 * 永远回 200，永远不长在页面的关键路径上 —— 它是旁路。
 */
export async function recordPageError(req, res, options = {}) {
  const raw = await readBody(req)
  appendLine(options.file ?? pageErrorLogFile(), entryOf(raw))
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ ok: true }))
}
