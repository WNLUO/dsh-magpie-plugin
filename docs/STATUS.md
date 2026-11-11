# 当前进度与下一步

这份是交接备忘，给下一个人（或下个对话）接手用。

## 已完成（新仓 `dsh-magpie-plugin`，本地 git，两版提交，未推远端、未发 npm）

- 宿主半身：`lib/`（进程管理、透明代取、路由、热重载）、`index.js`、`cordis.patch.yml`
- 手机扩展：`web/`（上游快照）、`scripts/build-extension.mjs`、`extensions/magpie/`（269 文件 / 10.57MB）
- 开发流程：`scripts/`（dev-install、dev-watch、reload-dev、update-check）、`lib/update/`
- 守卫：`test/`（43 条全绿）+ `README.md` + `docs/decisions.md`

验证过的：`node --test test/` 43/43、`build-extension.mjs --check` 绿、`npm pack --dry-run` 内容齐（挂载行/文档/扩展都在）、dev-install / dev-watch --once / reload-dev --dry-run / update-check 都能跑。

## 卡点（需要用户参与，不是技术问题）

1. **发 npm**：需要 npm 发布凭据。本地没资格、也没配置，不能替用户发。
2. **真机验证**：按仓规设备要用户点名才能碰。真机验过才算「跑通」。

## 下一步最小验证（用户放行后）

1. `npm publish`（public，包名 `dsh-magpie-plugin`），确认 registry 上能查到。
2. 在目标机器 profile 里装一份：`node scripts/reload-dev.mjs`（它自己会 npm pack + 装进 profile + 就地重载）。
3. 手机上：设置 → 扩展市场装「magpie」，或本地开发那档导入；确认扩展组出现一格、点开有数据（日志里 `[dsh-magpie]` 有挂载记录）。
4. 真机确认后，才动 App 侧拆除（见下）。

## 未做：App 侧拆除（刻意押后）

原因：新插件没铺开就删 App 入口，会让所有人的 magpie 当场打不开。必须等第 2、3 步真机验过、且新版铺开几版之后再动。

要改的地方（DSH-mobile 仓，动手前先重读这些文件，因为别的对话也在改）：
- `app/src/components/RightRail.tsx` 的 magpie 那格
- `app/src/components/MagpieLogo.tsx`、`app/src/i18n/messages/magpie.ts`
- `app/src/services/edge-rail-openers.ts` 的 `openMagpieExtensionPage` / slug
- `app/src/hooks/useEdgeRailPages.ts`、`app/src/services/viewmodels/edge-rail-stack.ts` 的 magpie 档
- `app/src/components/RightRail.tsx` 的 `reservedNames` 里 `magpie.rail`
- `app/scripts/build-magpie-extension.mjs`、`app/scripts/test-magpie-extension.js`
- `app/vendor/magpie-web/`、`app/src/App.tsx:2366` 的 canvas/magpie slug 判断
- 各守卫里钉着 magpie 的断言

移动端插件那份内置的 magpie（`dsh-mobile-plugin/extensions/magpie/`、`lib/mobile/magpie-web.js`、`extension-data.js` 的静态 `SERVICES.magpie`）**过渡期先留着**，等新版铺开几版再清。
