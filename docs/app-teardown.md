# App 侧拆除清单（magpie 硬编码入口）

新插件 `dsh-magpie-plugin` 已经能装能跑，但 App 里还硬编码着 magpie 的一整套东西。
只要这些还在，新插件带来的扩展就**显示不出来**：右栏的保留名过滤会把名字叫 `magpie`
的那一格丢掉（见 `app/src/components/RightRail.tsx` 的 `reservedNames`）。

所以拆除不是收尾，是新扩展露脸的前提。但**要等新插件真机验过、且新版铺开几版之后**再动：
老版本 App 上 magpie 走的还是移动端插件那条老路，删早了老用户当场打不开。

## 一、删掉整个文件

| 文件 | 说明 |
| --- | --- |
| `app/src/components/MagpieLogo.tsx` | magpie 品牌图标，只给右栏那格用 |
| `app/src/i18n/messages/magpie.ts` | 只剩 `magpie.rail` 一个键，十门语言 |
| `app/scripts/build-magpie-extension.mjs` | 产包脚本，已迁到新仓 |
| `app/scripts/test-magpie-extension.js` | 那个产包的守卫，一并迁走 |
| `app/vendor/magpie-web/` | 11MB 页面源码快照，已整份搬到新仓 `web/` |

## 二、改这几处源码

- `app/src/components/RightRail.tsx`
  - 删掉 magpie 那格 `Pressable`（含注释）
  - `reservedNames` 里去掉 `t('magpie.rail')`
  - 顶部 import 里的 `MAGPIE_EXTENSION_SLUG` / `openMagpieExtensionPage` / `MagpieLogo`
- `app/src/services/edge-rail-openers.ts`
  - 删 `MAGPIE_EXTENSION_SLUG` 与 `openMagpieExtensionPage`
- `app/src/hooks/useEdgeRailPages.ts`
  - 删 `magpie` 那一档登记（`magpie: 'magpie.rail'` 与 `KEYS` 里的 `'magpie'`）
- `app/src/services/viewmodels/edge-rail-stack.ts`
  - `EdgeRailEntryKey` 联合类型里删 `'magpie'`
- `app/src/hooks/useEdgeRail.ts`、`app/src/components/edge-rail/EdgeRail.tsx`
  - 删 magpie 那格（侧轨默认条目表里那一条）
- `app/src/i18n/messages/edge-rail.ts`、`app/src/i18n/messages/index.ts`
  - 去掉 `magpie` 字典的挂载与 `magpie.rail` 的引用
- `app/App.tsx`
  - 扫一遍 magpie 相关的 slug 判断（`'canvas' || 'dsh-canvas-plugin.canvas'` 那处附近还带 magpie）
- `app/src/services/extensions/dev-catalog.ts`、`install.ts`、`plugin-catalog.ts`、`bridge.ts`、`host-data.ts`、`page-layers.ts`、`ExtensionScreen.tsx`、`TabletLayout.tsx`、`useTabletSwipeGesture.ts`、`DeepSeekLogo.tsx`
  - 这些文件里 magpie 只出现在**注释与举例**里，多数只需改文字，不用动逻辑。
  - 逐一确认：`grep -n magpie` 看是注释还是代码。

## 三、守卫里钉着 magpie 的断言

`app/scripts/` 下这些提到 magpie：`test-edge-rail.js`、`test-error-surfaces.js`、
`test-extension-data.js`、`test-extension-dev.js`、`test-extension-plugin-catalog.js`、
`test-extensions-bridge.js`、`test-magpie-web.js`、`test-modal-back-key.js`、
`test-navigation.js`、`test-page-layers.js`、`test-preview-targets.js`。

处理原则：
- **改断言，不是放宽实现**（仓规「守卫即规格」）。
- `test-magpie-web.js` 与 `test-magpie-extension.js` 这一对是搬走的那部分，跟着一起删。
- `test-page-layers.js` 里有一条「旧那条 magpie 整页浮层不许长回来」，删 magpie 之后这条仍该保留（它钉的是历史教训），只把注释里 magpie 的说法改掉。
- `test-extension-data.js` 里 magpie 是「内置服务」的例子，改成别的内置服务或改成纯描述。

## 四、移动端插件那边（过渡期先不动）

`dsh-mobile-plugin/extensions/magpie/`、`dsh-mobile-plugin/extensions/magpie.zip`、
`dsh-mobile-plugin/extensions/catalog.json` 里那条、`lib/mobile/magpie-web.js`、
`lib/mobile/extension-data.js` 里 `SERVICES.magpie`。

**这几样要留着**：老版本 App 装的是移动端插件，走 `/api/mobile/v1/magpie/web` 与
`extension/data` 那条老路；删了老用户当场打不开。等新插件+新 App 铺开几版再一起清。

## 五、顺序

1. 新插件真机验过（扩展组出现 magpie、点开有数据）。
2. 发 npm、铺开几版。
3. 按上面一到三拆 App 侧，跑守卫。
4. 再等一版，最后清移动端插件那份。

## 六、拆完要验的

- `node scripts/test-plugin-rail.js`（右栏入口）
- `node scripts/test-edge-rail.js`（侧轨）
- `node scripts/test-preview-targets.js`（右栏与侧轨的那些字面断言）
- `node scripts/test-navigation.js`、`node scripts/test-page-layers.js`
- `npm run affected -- --files <本轮动过的>` + `npm run map:check`
- 真机：右栏没有写死的 magpie；装了新插件之后扩展组里出现 magpie 并能打开
