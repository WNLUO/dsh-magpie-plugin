/**
 * 守卫：插件页「自包含」那一份（`lib/plugin-page.js` + `/__pluginpage`）。
 *
 * 钉的是一件真机上撞到的事：插件页放在站点绝对路径下、由电脑上的 magpie 现场生成，扩展页从
 * 手机本地文件打开，帧里加载不了它 —— 光有代理只解决「取得到」，解决不了「画在哪」。这一条把
 * 它解决在扩展自己内部：宿主把那一页抓下来、把它的资源一起内联，页面侧塞进 `srcdoc`。
 *
 * 三条口径：**只认 /_magpie/ 这棵子树**、**取不到的资源跳过而不是整页失败**、**有界**。
 *
 * 运行：node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createPluginPageHandler } from '../lib/plugin-page.js'

function fakeRes() {
  const res = { status: 0, headers: {}, body: '' }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers || {} }
  res.end = (payload) => { res.body = String(payload ?? '') }
  return res
}

const req = (url) => ({ method: 'GET', url })

const available = async () => ({ available: true, port: 1234, key: 'k' })

test('只认 /_magpie/ 下面的页面：别的路径一律 400，不当通用抓取器', async () => {
  const handler = createPluginPageHandler({ ensureWebFn: available, cookieFn: async () => '', proxyFn: async () => ({ status: 200, body: Buffer.from('') }) })
  const res = fakeRes()
  await handler(undefined, req('/__pluginpage?url=%2Fapi%2Fstate'), res)
  assert.equal(res.status, 400)
  assert.match(res.body, /bad-target/)
})

test('magpie 没跑起来时回 503 并带上原因', async () => {
  const handler = createPluginPageHandler({
    ensureWebFn: async () => ({ available: false, reason: 'not-running' }),
    cookieFn: async () => '',
    proxyFn: async () => ({ status: 200, body: Buffer.from('') }),
  })
  const res = fakeRes()
  await handler(undefined, req('/__pluginpage?url=%2F_magpie%2Fplugin%2Fh%2Findex.html'), res)
  assert.equal(res.status, 503)
  assert.match(res.body, /not-running/)
})

test('把页面上的本地引用内联掉：脚本变成 <script> 正文，页面回来时不再有外链', async () => {
  const pageUrl = '/_magpie/plugin/h/index.html'
  const html = '<!doctype html><head><script src="a.js"></script><link rel="stylesheet" href="b.css"></head><body><img src="c.png"></body>'
  const fetched = []
  const handler = createPluginPageHandler({
    ensureWebFn: available,
    cookieFn: async () => '',
    proxyFn: async (port, cookie, method, path) => {
      fetched.push(path)
      if (path === pageUrl) return { status: 200, body: Buffer.from(html) }
      if (path === '/_magpie/plugin/h/a.js') return { status: 200, body: Buffer.from('console.log(1)') }
      if (path === '/_magpie/plugin/h/b.css') return { status: 200, body: Buffer.from('body{color:red}') }
      if (path === '/_magpie/plugin/h/c.png') return { status: 200, body: Buffer.from([1, 2, 3]) }
      return { status: 404, body: null }
    },
  })
  const res = fakeRes()
  await handler(undefined, req(`/__pluginpage?url=${encodeURIComponent(pageUrl)}`), res)
  assert.equal(res.status, 200)
  const out = res.body
  assert.ok(!out.includes('src="a.js"'), '脚本引用要换掉')
  assert.match(out, /<script>console\.log\(1\)<\/script>/, '脚本正文要内联进来')
  assert.match(out, /<style>body\{color:red\}<\/style>/, '样式正文要内联进来')
  assert.match(out, /data:image\/png;base64,/, '图片走 data:（帧里没有地址可加载）')
  assert.deepEqual(fetched, [pageUrl, '/_magpie/plugin/h/a.js', '/_magpie/plugin/h/b.css', '/_magpie/plugin/h/c.png'],
    '相对引用按页面自己那个目录解析')
})

test('取不到的资源跳过，整页照样回来（上游自己缺文件是常态）', async () => {
  const pageUrl = '/_magpie/plugin/h/index.html'
  const html = '<!doctype html><head><script src="a.js"></script></head><body>ok</body>'
  const handler = createPluginPageHandler({
    ensureWebFn: available,
    cookieFn: async () => '',
    proxyFn: async (port, cookie, method, path) => (path === pageUrl
      ? { status: 200, body: Buffer.from(html) }
      : { status: 404, body: null }),
  })
  const res = fakeRes()
  await handler(undefined, req(`/__pluginpage?url=${encodeURIComponent(pageUrl)}`), res)
  assert.equal(res.status, 200)
  assert.match(res.body, /ok/)
  assert.match(res.body, /src="a\.js"/, '取不到的引用原样留着，不去打断页面')
})
