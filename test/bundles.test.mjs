/**
 * 守卫：装进 profile 之后必须**成为宿主的启动项**。
 *
 * 这条钉的是一个真机上查不出来的坑：`pnpm install` 只把包装进 `node_modules`、把依赖写进
 * `dependencies`，**不会**让宿主加载它 —— 决定加载的是 profile `package.json` 的
 * `dsh.profile.bundles`。少这一步的现场是「装好了、逐字节都对上了、重启还是不生效」，而
 * 包本身一个字节都没错，只能靠人想起这一项。
 *
 * 判据落在 `lib/update/profile.js` 的 `registerBundle` 上（脚本装完就调它），并且钉住
 * 它**幂等**：跑第二遍不许把名字写两遍。
 *
 * 运行：node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerBundle, DEFAULT_NAME } from '../lib/update/profile.js'

/** 造一个最小 profile 目录：只要有 package.json。 */
function fakeProfile(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-magpie-bundles-'))
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(initial, null, 2)}\n`)
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function readProfile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
}

test('启动列表里没有时补进去', () => {
  const { dir, cleanup } = fakeProfile({ name: 'profile', dsh: { profile: { bundles: ['dsh-canvas-plugin'] } } })
  try {
    const result = registerBundle(dir)
    assert.ok(result, '应当读得到 profile 的声明')
    assert.equal(result.changed, true, '第一次应当真的改动')
    const bundles = readProfile(dir).dsh.profile.bundles
    assert.ok(bundles.includes(DEFAULT_NAME), `启动列表里没有 ${DEFAULT_NAME}：${bundles.join(',')}`)
    assert.ok(bundles.includes('dsh-canvas-plugin'), '别的插件一项都不许动')
  } finally { cleanup() }
})

test('已经在列表里时不重复写、也不动别的字段（幂等）', () => {
  const initial = {
    name: 'profile',
    dependencies: { [DEFAULT_NAME]: 'file:x.tgz' },
    dsh: { profile: { bundles: ['dsh-canvas-plugin', DEFAULT_NAME] } },
  }
  const { dir, cleanup } = fakeProfile(initial)
  try {
    const result = registerBundle(dir)
    assert.equal(result?.changed, false, '已经在了就不该改')
    const after = readProfile(dir)
    assert.deepEqual(after.dsh.profile.bundles, initial.dsh.profile.bundles, '列表被写坏了')
    assert.deepEqual(after.dependencies, initial.dependencies, '依赖声明被动了')
    assert.equal(after.name, 'profile')
  } finally { cleanup() }
})

test('profile 没有 dsh.profile 那两格时也能补出来，而不是报错', () => {
  const { dir, cleanup } = fakeProfile({ name: 'profile' })
  try {
    const result = registerBundle(dir)
    assert.equal(result?.changed, true)
    assert.deepEqual(readProfile(dir).dsh.profile.bundles, [DEFAULT_NAME])
  } finally { cleanup() }
})

test('读不出 package.json 时如实回 null（调用方据此提示，而不是假装成功）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-magpie-bundles-empty-'))
  try {
    assert.equal(registerBundle(dir), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('reload-dev 装完确实会调这一步（脚本里少了它就退回「重启也不加载」的老毛病）', () => {
  const script = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'reload-dev.mjs'), 'utf8')
  assert.match(script, /registerBundle/, 'reload-dev 没有引用 registerBundle')
  assert.match(script, /registerBundle\(target, PKG_NAME\)/, 'reload-dev 没有真的调它')
  assert.match(script, /dsh\.profile\.bundles/, '脚本里没有解释这一步的理由')
})
