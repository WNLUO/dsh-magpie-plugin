/**
 * 守卫：这个包**能被宿主装上、能被手机看见**的那几条判据。
 *
 * 都是「分发能不能成立」的事，坏掉时的症状是「装上了但什么都没发生」，从界面上完全看不出
 * 原因。所以逐条钉住：
 *
 *  一、`package.json` 里必须有 `dshMobileExtensions` 声明，它指的目录真在包里，`files`
 *     白名单把 `lib/**` 与扩展目录都带进 npm 包 —— 少一行，发出去的包里就没有代码；
 *  二、`cordis.patch.yml` 里的 `name` 与包名逐字一致（写歪不报错，只是插件永远不出现）；
 *  三、`dshMobileDataServices` 的服务名与 `lib/paths.js` 的 `SERVICE_NAME` 一致，
 *     `allow` 前缀盖住 `ROUTE_PREFIX` —— 否则扩展页里每一个 fetch 都会被宿主挡掉；
 *  四、扩展清单的 `hostData` 与包声明的服务名、路由前缀对得上，且申请了 `host.data`；
 *  五、`index.js` 挂的是前缀路由，且装载失败不抛。
 *
 * 运行：node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

/** 声明那一格指到哪儿（`true` 等于默认的 `extensions`）。 */
const declared = pkg.dshMobileExtensions === true ? 'extensions' : pkg.dshMobileExtensions

test('package.json 声明了 dshMobileExtensions，且指向包里真有的目录', () => {
  assert.equal(typeof declared, 'string', 'dshMobileExtensions 必须是字符串（或 true）')
  assert.ok(declared && !path.isAbsolute(declared), '声明必须是包内相对路径')
  assert.ok(fs.existsSync(path.join(ROOT, declared)), `声明指向的目录不存在：${declared}`)
})

test('files 白名单把 lib/、扩展目录、入口与挂载行带进 npm 包', () => {
  const files = pkg.files || []
  assert.ok(files.includes('index.js'), 'files 里没有 index.js，宿主半身进不了包')
  assert.ok(files.includes('cordis.patch.yml'), 'files 里没有 cordis.patch.yml，插件装了也不会被挂载')
  assert.ok(
    files.some((entry) => entry === 'lib/**/*.js' || entry === 'lib' || entry === 'lib/**'),
    `files 里没有 lib/ 的通配，宿主半身进不了包：${files.join(', ')}`,
  )
  assert.ok(
    files.some((entry) => entry === `${declared}/**` || entry === `${declared}/**/*` || entry === declared),
    `files 里没有 ${declared}/**，发出去的包里不会有扩展`,
  )
})

test('cordis.patch.yml 的 name 与包名逐字一致', () => {
  const yml = read('cordis.patch.yml')
  const names = [...yml.matchAll(/^\s*name:\s*'([^']+)'/gm)].map((m) => m[1])
  assert.ok(names.includes(pkg.name), `挂载行里的 name 与包名对不上：${names.join(', ')}`)
})

test('数据服务的服务名与 allow 与路由前缀对上（否则扩展页的 fetch 全被挡）', () => {
  const declaredServices = pkg.dshMobileDataServices || []
  assert.equal(Array.isArray(declaredServices) && declaredServices.length > 0, true,
    'package.json 没声明 dshMobileDataServices，扩展页读不到宿主数据')

  const paths = read('lib', 'paths.js')
  const serviceName = /export const SERVICE_NAME = '([^']+)'/.exec(paths)?.[1] ?? ''
  const routePrefix = /export const ROUTE_PREFIX = '([^']+)'/.exec(paths)?.[1] ?? ''
  assert.ok(serviceName !== '', 'lib/paths.js 里找不到 SERVICE_NAME')
  assert.ok(routePrefix !== '', 'lib/paths.js 里找不到 ROUTE_PREFIX')

  const hit = declaredServices.find((row) => row.service === serviceName)
  assert.ok(hit, `dshMobileDataServices 里没有服务 ${serviceName}`)
  for (const prefix of hit.allow) {
    assert.ok(prefix.startsWith('/api/'), `allow 前缀必须是以 /api/ 开头的本源路径：${prefix}`)
  }
  assert.ok(hit.allow.some((prefix) => `${routePrefix}/`.startsWith(prefix)),
    `allow ${hit.allow.join(',')} 盖不住路由前缀 ${routePrefix}`)
})

test('lib/paths.js 钉住的那几个名字没被人顺手改掉（换一个都等于换一份身份）', () => {
  const paths = read('lib', 'paths.js')
  assert.equal(/export const SERVICE_NAME = '([^']+)'/.exec(paths)?.[1], 'dsh-magpie',
    'SERVICE_NAME 必须与扩展清单、数据服务登记同名')
  assert.equal(/export const ROUTE_PREFIX = '([^']+)'/.exec(paths)?.[1], '/api/dsh-magpie',
    'ROUTE_PREFIX 是整条链路的锚点，别改')
  assert.equal(/export const EXTENSION_DIR = '([^']+)'/.exec(paths)?.[1], 'extensions',
    'EXTENSION_DIR 必须与 package.json 的 dshMobileExtensions 一致')
  assert.equal(/export const EXTENSION_SLUG = '([^']+)'/.exec(paths)?.[1], 'magpie',
    'EXTENSION_SLUG 是手机侧的包身份，改了等于换一个扩展')
})

test('宿主半身挂前缀路由，且注册失败只记日志不抛', () => {
  const index = read('index.js')
  assert.ok(index.includes("export const inject = ['webServer']"), '没声明 inject webServer')
  assert.ok(index.includes("kind: 'prefix'"), '注册的不是前缀路由')
  assert.ok(index.includes('ROUTE_PREFIX'), '注册路径没走 ROUTE_PREFIX')
  assert.ok(/catch \(error\)/.test(index), '注册失败没有兜住')
  assert.ok(!/throw /.test(index), '入口里出现了 throw：装载失败会把整台宿主拖下水')
})

test('依赖版本不带 ^ / ~（仓规：直接依赖写死）', () => {
  const deps = pkg.dependencies || {}
  for (const [name, range] of Object.entries(deps)) {
    assert.ok(!/[\^~]/.test(range), `${name} 的版本范围 ${range} 带了 ^ 或 ~`)
  }
})

test('扩展清单的 hostData 与包声明的服务名、路由前缀对得上', () => {
  // 这条是「装了但同步不动」的根因面：插件那侧登记的服务名 / allow 前缀，与扩展清单里
  // 声明的 service / match 必须逐字对得上。写歪任何一处，扩展页里的 fetch 都会被宿主
  // 按 403 挡回去 —— 而两侧各自的测试都绿，真机上只是「什么都不发生」。
  const manifest = JSON.parse(read(declared, 'magpie', 'manifest.json'))
  const paths = read('lib', 'paths.js')
  const serviceName = /export const SERVICE_NAME = '([^']+)'/.exec(paths)?.[1]
  const routePrefix = /export const ROUTE_PREFIX = '([^']+)'/.exec(paths)?.[1]
  assert.ok(serviceName, 'lib/paths.js 里读不到 SERVICE_NAME')
  assert.ok(routePrefix, 'lib/paths.js 里读不到 ROUTE_PREFIX')

  assert.equal(manifest.hostData?.service, serviceName,
    `扩展清单声明的是 ${manifest.hostData?.service}，插件登记的是 ${serviceName}`)
  const match = manifest.hostData?.match || []
  assert.ok(match.some((prefix) => `${routePrefix}/`.startsWith(prefix)),
    `match ${match.join(',')} 盖不住路由前缀 ${routePrefix}`)
  assert.ok((manifest.capabilities || []).includes('host.data'),
    '声明了 hostData 却没申请 host.data 能力')
})
