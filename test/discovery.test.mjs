/**
 * 守卫：这个包装进 profile 之后，**移动端插件能不能发现它**。
 *
 * 前面几份守卫验的是「包本身对不对」；这一份验的是那之后真会出问题的一步 —— 包做对了、
 * 但宿主扫不到，症状就是「插件装了，手机上什么都没有」，而两边的测试都绿。
 *
 * 判据全部来自移动端插件真实实现（`dsh-mobile-plugin/lib/mobile/third-party-extensions.js`
 * 的 `discoverPackages` / `discoverDataServices`）：直接调它，不照着它的规则重写一份。
 * 找不到那个模块时（本仓单独检出、没 DSH-mobile 在旁边）跳过并说明，不假装验过。
 *
 * 运行：node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.join(import.meta.dirname, '..')

/** 移动端插件那份实现：与本仓同级 checkout 时才在。 */
const DISCOVER = path.join(ROOT, '..', 'DSH-mobile', 'dsh-mobile-plugin', 'lib', 'mobile', 'third-party-extensions.js')
const available = fs.existsSync(DISCOVER)

/**
 * 把一个包铺成「装进 profile 之后」的样子：`node_modules/<name>/` 下放 package.json
 * 与它声明的扩展目录（只拷声明的那一份，别的都不需要）。
 *
 * @returns {{ root: string, cleanup: () => void }}
 */
function fakeProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-magpie-discover-'))
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const target = path.join(root, 'node_modules', pkg.name)
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2))
  const declared = pkg.dshMobileExtensions === true ? 'extensions' : pkg.dshMobileExtensions
  fs.cpSync(path.join(ROOT, declared), path.join(target, declared), { recursive: true })
  return { root: path.join(root, 'node_modules'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('移动端插件能发现本包的扩展（slug 拼成「插件名.目录名」）', { skip: available ? false : `本仓旁边没有 DSH-mobile：${DISCOVER}` }, () => {
  const mod = createRequire(import.meta.url)(DISCOVER)
  const { root, cleanup } = fakeProfile()
  try {
    const pkgs = mod.discoverPackages(root)
    assert.equal(pkgs.length, 1, `应该正好发现一个扩展，实际 ${pkgs.length} 个`)
    assert.equal(pkgs[0].slug, 'dsh-magpie-plugin.magpie', `slug 拼错了：${pkgs[0].slug}`)
    assert.equal(pkgs[0].packageName, 'dsh-magpie-plugin')
    // 发现的那一份目录要真的是扩展包（入口页在），否则手机上会显示一格点了没反应。
    assert.ok(fs.existsSync(path.join(pkgs[0].directory, 'index.html')), '发现的目录里没有入口页')
  } finally { cleanup() }
})

test('移动端插件能发现本包声明的数据服务，且 allow 盖住路由前缀', { skip: available ? false : '本仓旁边没有 DSH-mobile' }, async () => {
  const mod = createRequire(import.meta.url)(DISCOVER)
  const paths = await import('../lib/paths.js')
  const { root, cleanup } = fakeProfile()
  try {
    const services = mod.discoverDataServices(root)
    assert.equal(services.length, 1, `应该正好发现一个服务，实际 ${services.length} 个`)
    assert.equal(services[0].service, paths.SERVICE_NAME, '发现的服务名与 lib/paths.js 对不上')
    assert.ok(
      services[0].allow.some((prefix) => `${paths.ROUTE_PREFIX}/`.startsWith(prefix)),
      `allow ${services[0].allow.join(',')} 盖不住路由前缀 ${paths.ROUTE_PREFIX}`,
    )
  } finally { cleanup() }
})

test('扩展清单与包声明是同一套名字（发现得到、页面也就取得到数据）', { skip: available ? false : '本仓旁边没有 DSH-mobile' }, () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extensions', 'magpie', 'manifest.json'), 'utf8'))
  const declared = pkg.dshMobileDataServices.find((row) => row.service === manifest.hostData.service)
  assert.ok(declared, `扩展清单的 service ${manifest.hostData.service} 在 package.json 里没有声明：页面会被 404`)
  for (const match of manifest.hostData.match) {
    assert.ok(declared.allow.some((prefix) => match.startsWith(prefix)),
      `扩展 match ${match} 不在声明的 allow ${declared.allow.join(',')} 里`)
  }
})
