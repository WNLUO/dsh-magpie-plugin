/**
 * HTTP 小工具：写 JSON 响应、读原始请求体。
 *
 * 只用这个插件真用到的两条，口径照 `dsh-canvas-plugin/lib/http-util.js`：
 *  - `sendJson` 给这一层自己的回包（能力探测、开发路由、失败），连接已关时静默；
 *  - `readRawBody` 给代取用 —— 那条要原样转交上游，不能先 JSON 解析再拼回去。
 *
 * 纯 Node / ESM，无 cordis 依赖，测试可以直接 import。
 *
 * @module lib/http-util.js
 */

/**
 * 写 JSON 响应（UTF-8）。连接已关闭时静默忽略。
 *
 * @param {object} res    node:http ServerResponse
 * @param {number} status HTTP 状态码
 * @param {object} body   响应体
 */
export async function sendJson(res, status, body) {
  let text
  try {
    text = JSON.stringify(body)
  } catch {
    /* 序列化不了就当连接已关闭，一个字节都不写 */
    return
  }
  const raw = Buffer.from(text == null ? '' : text)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(raw)
  } catch {
    /* 连接已关闭 */
  }
}

/**
 * 读原始请求体（不解析）。
 *
 * 为什么单独一条：代取的语义是「原样转交」，上游收的可能是表单 / 二进制 / 任何
 * content-type，先 JSON.parse 再拼回去等于改写用户的数据。所以这里只管字节与上限。
 *
 * 回 `{ ok, body }` 而不是 `null`：空请求体（GET）与「超限」是两回事 —— 前者照常转发，
 * 后者如实回一个「太大」。
 *
 * @param {object} req      node:http IncomingMessage
 * @param {number} maxBytes 上限（字节）
 * @returns {Promise<{ ok: boolean, body: Buffer }>}
 */
export function readRawBody(req, maxBytes) {
  if (req && Buffer.isBuffer(req.body)) {
    if (req.body.length > maxBytes) return Promise.resolve({ ok: false, body: Buffer.alloc(0) })
    return Promise.resolve({ ok: true, body: req.body })
  }
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      resolve({ ok, body: ok ? Buffer.concat(chunks) : Buffer.alloc(0) })
    }
    req.on('data', (chunk) => {
      if (done) return
      total += chunk.length
      if (total > maxBytes) {
        // 超限就别再往内存里收：把连接断掉，如实回「太大」。
        try { req.destroy() } catch { /* 已经断了 */ }
        finish(false)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(true))
    req.on('error', () => finish(false))
  })
}
