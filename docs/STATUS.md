# 当前进度与下一步

这份是交接备忘，给下一个人（或下个对话）接手用。新对话第一轮照这份往下接，不用重新翻代码。

## 一句话

新插件（本仓）**技术活已做完**：能装、能挂路由、扩展能被宿主发现、47 条守卫全绿。
卡在两件只有用户能做的事上：**发 npm**（本机没登录）与**真机验证**（设备要用户点名）。

## 已完成（本地 git + 已推 GitHub 公开仓，9 版提交；**未发 npm**）

- 远程仓：<https://github.com/WNLUO/dsh-magpie-plugin>（`origin`，master 已推，9 个提交）
- 注意：参考对象 `dsh-canvas-plugin` 那个仓**没有远程**，只在本地 —— 「跟画布做成一样」这一步它自己也没做，别照着它以为只要本地仓。

- 宿主半身：`lib/`（进程管理、透明代取、路由、热重载）、`index.js`、`cordis.patch.yml`
- 手机扩展：`web/`（上游快照）、`scripts/build-extension.mjs`、`extensions/magpie/`（270 文件 / 10.61MB）
- 开发流程：`scripts/`（dev-install、dev-watch、reload-dev、update-check）、`lib/update/`
- 守卫：`test/` 五份（47 条全绿）+ `README.md` + `docs/decisions.md` + 本文件

守卫分四层，缺一层都曾有「真机不对、测试全绿」的病：
1. `package.test.mjs` —— 包结构（声明、files 白名单、挂载行、名字对齐）
2. `extension.test.mjs` —— 扩展产物（自包含、入口声明与 icon、与源一致）
3. `magpie-web.test.mjs` —— 进程管理零件（探测、key、认领、不发真进程）
4. `integration.test.mjs` —— 整链路（假 magpie + 真路由 + 真代理，前缀剥离/透传）
5. `discovery.test.mjs` —— 装进 profile 后宿主扫不扫得到（**真调**移动端插件的发现实现）
6. `apply.test.mjs` —— 走 `index.js` 的 `apply(ctx)` 真装载路径（假宿主复现 inject/effect）

## 已排除的坑（都验过，别再踩一遍）

- **页面必须自己改写 `/api/` 前缀**：App 的 host.data 通道按 `pathname+search` 原样转给宿主，
  全链路不改写；magpie 页面写的是裸 `/api/state`，所以产包时注入 fetch 包装把它挪到
  `/api/dsh-magpie/api/*`，宿主再剥前缀。已经验证：注入顺序是 App shim 先装、页面改写在其后
  包一层，链路成立。
- **入口名撞 App 保留名**：把扩展入口名字设成 `magpie` 会被 App 右栏的 `reservedNames` 过滤掉，
  因为 App 现在硬编码了 magpie 那格。**所以「拆 App 侧那格」不是收尾，是新扩展能在手机上露脸的
  前提**。已在扩展清单里补了 `entry`，拆 App 之后就能显示。
- **不带 `entry` 的扩展不会出现在右栏**：能装、能从设置里打开，但用户装完看不到入口。
- **服务名故意不复用内置的 `magpie`**：内置服务优先于第三方声明，复用会被永久压住。

## 卡点（需要用户参与，不是技术问题）

1. **发 npm**：本机 `npm whoami` 返回 401（没登录/没凭据），不能替用户发。
2. **真机验证**：按仓规设备要用户点名才能碰。

## 用户放行后的最小验证顺序

1. `npm publish`（public，包名 `dsh-magpie-plugin`），确认 registry 能查到。
2. 装进 profile：`node scripts/reload-dev.mjs`（自己 npm pack + 装 + 就地重载；探不到 dev 路由
   会退化成「装好、重启一次」并退出码 2，那是正常路径）。
3. 真机：设置 → 扩展市场装 magpie（或本地开发那档导入），确认**扩展组出现一格 magpie**、
   点开有数据（宿主日志里 `[dsh-magpie]` 有挂载记录）。
4. 第 3 步过了再动 App 侧拆除。

## 未做：App 侧拆除（刻意押后，但现在知道它是必需的）

原因：新插件没铺开就删 App 入口，会让所有人的 magpie 当场打不开。必须等第 2、3 步真机验过。

要改的地方（DSH-mobile 仓，动手前先重读，别的对话也在改）：
- `app/src/components/RightRail.tsx` 的 magpie 那格 + `reservedNames` 里 `magpie.rail`
- `app/src/components/MagpieLogo.tsx`、`app/src/i18n/messages/magpie.ts`
- `app/src/services/edge-rail-openers.ts` 的 `MAGPIE_EXTENSION_SLUG` / `openMagpieExtensionPage`
- `app/src/hooks/useEdgeRailPages.ts`、`app/src/services/viewmodels/edge-rail-stack.ts` 的 magpie 档
- `app/scripts/build-magpie-extension.mjs`、`app/scripts/test-magpie-extension.js`
- `app/vendor/magpie-web/`、`app/src/App.tsx` 里 canvas/magpie 的 slug 判断
- 各守卫里钉着 magpie 的断言

移动端插件那份内置的（`dsh-mobile-plugin/extensions/magpie/`、`lib/mobile/magpie-web.js`、
`extension-data.js` 的静态 `SERVICES.magpie`）**过渡期先留着** —— 老版本 App 走的是它。

## 本仓 git 操作约定

`git add` 只加本仓路径（这是独立仓，不影响 DSH-mobile）；提交信息三段式、中文标题、英文摘要。
不推远端、不发 npm，什么时候发由用户定。
