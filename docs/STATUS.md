# 当前进度与下一步

这份是交接备忘，给下一个人（或下个对话）接手用。新对话第一轮照这份往下接，不用重新翻代码。

## 一句话

**宿主那一侧验通了**：能装、能挂路由、扩展能被宿主发现，`npm test` 53 条全绿 0 跳过；把它的
路由在本机单独架起来真跑过一遍，magpie 网页版在 3430 起得来、`/api/dsh-magpie/api/state` 返回
真数据。**手机那一侧没验过** —— 装到手机上的那一版怎么取数，端到端一次都没在设备上试过。

卡在两件只有用户能做的事上：**发 npm**（本机没登录）与**真机验证**（设备要用户点名）。
另外 App 侧那套硬编码入口、以及移动端插件里那份过渡副本都已经删了（比原计划早，
见 `app-teardown.md`）—— 所以现在这台机器以外拿不到 magpie。

## 已完成（本地 git + 已推 GitHub 公开仓，9 版提交；**未发 npm**）

- 远程仓：<https://github.com/WNLUO/dsh-magpie-plugin>（`origin`，master 已推，9 个提交）
- 注意：参考对象 `dsh-canvas-plugin` 那个仓**没有远程**，只在本地 —— 「跟画布做成一样」这一步它自己也没做，别照着它以为只要本地仓。

- 宿主半身：`lib/`（进程管理、透明代取、路由、热重载）、`index.js`、`cordis.patch.yml`
- 手机扩展：`web/`（上游快照）、`scripts/build-extension.mjs`、`extensions/magpie/`（270 文件 / 10.61MB）
- 开发流程：`scripts/`（dev-install、dev-watch、reload-dev、update-check）、`lib/update/`
- 守卫：`test/` 六份（47 条全绿）+ `README.md` + `docs/decisions.md` + `docs/app-teardown.md` + 本文件
- **打包产物已实测**：`npm pack` 出来的 tgz 解包后入口能导入、路由前缀与服务名对得上、扩展清单能被 App 的真实解析器读出入口（`{name:'magpie', slot:'normal', icon:'icon.png'}`）

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
3. 真机：设置 → 扩展里装 magpie（可安装段那条，装的时候会问一次「读宿主数据」，要同意），
   然后右栏该多出一格 `magpie`、点开有数据。
4. 第 3 步过了再动 App 侧拆除。

## 已做：App 侧拆除（2026-11-12，早于真机验证）

App 里那套硬编码的 magpie 入口已经拆掉了：`MagpieLogo.tsx`、`app/src/i18n/messages/magpie.ts`、
`app/vendor/magpie-web/`、App 侧那个产包脚本与它的守卫整份删除，`RightRail.tsx` 的保留名表里
也没有 `magpie` 了。移动端插件那份内置副本（`extensions/magpie/`、`lib/mobile/magpie-web.js`、
`extension-data.js` 的静态 `SERVICES.magpie`）连同 `/api/mobile/v1/magpie/web` 一起在同一次
提交里删掉 —— 按 `app-teardown.md` 的原计划，这最后一样本该等新插件铺开几版再清。

后果如实记着：老版本 App 上 magpie 的入口与取数都没了，而新插件还没发 npm。

## 本仓 git 操作约定

`git add` 只加本仓路径（这是独立仓，不影响 DSH-mobile）；提交信息三段式、中文标题、英文摘要。
不推远端、不发 npm，什么时候发由用户定。

## 停在这里的原因（连续多轮同一个卡点）

新插件这一段**开发者能自己验的都验过了**：53 条守卫全绿、打包产物解包实测可用、宿主侧端到端
在本机真跑出过数据、本地与 GitHub 都在。剩下的一环验不了：**手机那一侧**（装上去之后怎么取数），
而它恰恰是最容易出问题的一环。往下的每一步都**必须由用户参与**，不是我能自己推进的：

1. `npm publish` —— 本机 `npm whoami` 连续返回 401（没登录），且发布上线本身要用户点头；
2. 真机验证 —— 仓规写明设备要用户点名才能碰。

（原先这里的第 3 条是「拆 App 侧那格，依赖 1、2 先完成」—— 那一步在 2026-11-12 已经做了，
顺序与原计划相反，见 `app-teardown.md`。）

所以「跑通」在目标定义里包含真机验证那一环，目前只能说到「代码、打包与宿主侧端到端验过」。
用户一旦给出 npm 凭据或点名设备验收，从这里继续即可。

## 本机实装进度（已做，2026-11-11）

用户放开「先不发布、先把该做的做掉」之后，做完了下面这些：

- `node scripts/reload-dev.mjs` 实跑成功：包已装进本机 profile（`desktop`），285 个文件逐字节对上，
  依赖声明指向 `dsh-magpie-plugin-dev-1794409042778.tgz`。
- profile 的 `dsh.profile.bundles` 原本没有本插件（没这一项重启也不会加载它）。**这一步已经补进
  脚本**：`lib/update/profile.js` 的 `registerBundle`，`scripts/reload-dev.mjs` 装完自动调用
  （幂等）。原先手改 profile 的那次已经还原，现在 profile 是脚本装出来的，不是手拼的。
  见 `docs/decisions.md` 与 `test/bundles.test.mjs`。
- 已在**真实 profile** 里验证发现链路（不是假目录）：移动端插件扫到了
  `slug=dsh-magpie-plugin.magpie`、`service=dsh-magpie`，入口页与 `icon.png` 都在。
- 宿主还没重启时的现场：**随便一条不存在的 `/api/…` 回 401（统一鉴权），但 `/api/dsh-magpie/…`
  整段回的是空正文的 400** —— 这个前缀已经被启动列表占住、路由还没挂。所以看状态码就能分辨：
  「400 = 装了没重启」，重启之后这个前缀由插件自己处理。别再拿 401 当「没挂」的证据：它对
  未知路径同样成立，分不出是哪一种。
- 宿主日志在**桌面 App** 启动时不落盘（它的标准输出接在 Electron 的管道上），所以 `[dsh-magpie]`
  那一行看不到；要从终端起 DSH 才有。见作者文档第 9.3 节。

### 重启宿主后怎么验（用户要求自己挑时间重启）

1. 重启 DSH 宿主（当前 GUI 那次重启会短暂断开，刷新页面即可）。
2. 状态码先看一眼：重启前 `/api/dsh-magpie/…` 回的是空正文 400（前缀已占、路由未挂），
   重启之后这个前缀交给插件处理，不再是 400。
3. 手机连上这台电脑：设置 → 扩展的可安装段里装 magpie，装的时候同意「读宿主数据」。装完右栏
   多出一格 `magpie`（名字来自扩展包的 `entry`）—— App 侧那格硬编码与保留名已经拆掉了
   （见下面的「已做：App 侧拆除」），所以不会再被过滤。
4. 点开若数据为空，先看 magpie 网页版进程有没有起来（`magpie web`，端口 3430）；宿主日志
   那行只在从终端起 DSH 时看得见。

## 已补：reload-dev 现在会登记 bundles

原来少的那一步已经补上（见 `docs/decisions.md`），并且用脚本重装了一遍验证过：
`✔ 已登记进启动列表`，第二次跑显示 `· 启动列表里本来就有，跳过`。

## 2026-11-17 追记

- **启动列表被摘掉之后又登记回来了**：11-17 01:16 那次操作把本插件（与画布一起）从
  `dsh.profile.bundles` 里摘了，宿主日志里是 `enabled:false`。当天重新跑 `reload-dev` 登记回来。
  注意「包装没装」与「在不在启动列表」是两件事：摘掉之后手机照样扫得到扩展（发现链路读的是
  `node_modules`），但宿主那一半不会挂路由。
- **扩展 1.0.1：复制复到手机上**。上游页面的「复制」第一步是请 magpie 把文本放进**运行 magpie
  那台电脑**的剪贴板 —— 在手机上这一发成了也没用，用户在自己手机上粘不出来，页面还报「已复制」。
  产包注入的改写里把 `POST /api/copy` 挡成失败响应，页面于是走自己的手机剪贴板路径。见
  `web/SOURCE.md` 第 7 条，守卫 `test/extension.test.mjs` 里真跑那段注入脚本。
- **首装不再报「重载失败」**：启动列表里刚加进插件、宿主还没重启时，宿主对 `/api/dsh-magpie/…`
  回的是空正文 400；判词原来把它当失败（还让人「修好原因再跑」）。现在 400 分两种：空正文＝
  还没重启，带 JSON＝插件那条闸真的拒了。见 `test/reload-verdict.test.mjs`。
- **过期的本地开发拷贝挪走了**：`~/.dsh/extension-dev/magpie/`（11-11 那份）缺 `entry` 声明，
  留着会让手机自动装出第二个没有右栏入口的 magpie —— 正好是「后补声明对已装的那台不生效」
  那个坑。要再用开发路，先跑 `dev-install` 重新铺一份。
- 手机那一侧仍然没验过。这一轮把「在这台电脑上能验的」都验到了：手机装扩展走的那条路
  （整包下发 → 270 个文件逐个核对 → 落盘 → 记录里的入口 / 取数声明 / 三项能力）在内存盘上
  真跑了一遍。
