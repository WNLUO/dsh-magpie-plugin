/**
 * magpie 网页版前端（本目录）的来源与改法说明。
 *
 * ## 这一份是什么
 *
 * 上游 <https://github.com/yetone/magpie> 仓库里 `internal/gui/assets/` 那一整套，原样拷过来：
 * `index.html` + 数十个文件（手写的 vanilla JS / CSS，不是打包产物，注释全在）。它由 `magpie web`
 * 那个独立进程端出来（默认 `127.0.0.1:3430`），是 magpie 自己的网页界面：Agents / Providers /
 * Routing / Usage / Settings 全在里面。
 *
 * 取的是上游 commit `3441035`（2026-11-07）。原来放在 DSH-mobile 的 `app/vendor/magpie-web/`，
 * 抽成独立插件时整份搬到这里。
 *
 * 这一份只当**源码**用：`node scripts/build-extension.mjs` 把它产成 `extensions/magpie/`，
 * 随插件发给手机。本目录里的东西不会直接进扩展包（见下面「不进包的文件」）。
 *
 * ## 跑起来（开发服务器 = DV）
 *
 * ```sh
 * node web/serve.mjs          # http://127.0.0.1:5273/
 * PORT=5300 node web/serve.mjs
 * ```
 *
 * `serve.mjs` 只补三样上游由 Go 宿主提供的东西：
 *  1. **本地文件**：本目录里的 `index.html` 与它引用的全部 `.js` / `.css` / 图标；
 *  2. **`boot.js`**：上游是 `GET /boot.js` 现生成的（语言 / 主题 / 是不是网页版），这里给一份
 *     等价的静态版。**这是本目录唯一一个我们自己写的页面文件**，形状必须与上游一致；
 *  3. **`/api/*` 与其余资源**：反代给本机正在跑的 magpie，并替页面备好登录 cookie
 *     （`/?k=<key>` 换的那一个）。key 的来处与插件相同：`$MAGPIE_WEB_KEY` → `~/.dsh/magpie-web-key`。
 *
 * 于是这个 DV 里看到的就是**你电脑上那个真 magpie**，数据是真的、写操作也真的会写。
 * 注意 DV 是直接跑页面源码的，**没有**产包时注入的那段路径改写（下面第 6 条），所以它反代的
 * 仍是裸 `/api/*` —— 与在手机上走 `host.data` 的那条路是两回事。
 *
 * ## 本地改动清单（与上游的差异）
 *
 * 上游这份前端是原样拷来的，**只有下面这几处是我们改的**。改之前先看这里，别把改动散开：
 *
 * 1. `boot.js` —— 新增文件（上游由 Go 运行时生成，仓库里没有）。
 * 2. `serve.mjs` —— 新增文件（本地开发服务器，上游没有）。
 * 3. `app.js` —— 砍掉 Sessions / Library / Gateway 三张页：文件顶部加了 `REMOVED_VIEWS`
 *    常量（`app.js` 第 ~52 行），并在 `applyFeatures` 里把它们始终算作「关」。**用的是上游
 *    自己的 `featuresOff` 开关机制，没删任何页面代码**：`data-feature~="<id>"` 的元素
 *    （导航按钮、设置里相关的行）自动隐藏，`?view=sessions|library|gateway` 这类地址落到
 *    Agents，点击相关链接同理。想恢复某一张，把它从 `REMOVED_VIEWS` 里去掉即可。
 *    `index.html` 一个字没动（那三个导航按钮还在，靠 `data-feature` 的样式隐藏）。
 * 4. `SOURCE.md` —— 新增文件（本说明）。原文件名是 `README.md`，改名是为了不与插件根目录那份
 *    README 混在一起，也免得被当成本目录的入口文档。
 * 5. `app.css` —— **两处顶部安全区改成读 App 给的变量**：`body.web .top` 与
 *    `body.web .modal` 原来按 `env(safe-area-inset-top)` 留白，改成
 *    `var(--dsh-safe-top, env(safe-area-inset-top))`。原因：这一页在 App 里挂在它自己的顶栏
 *    底下，状态栏那一截外层已经让过了；页面若还按 `env()` 再留一次，安卓边到边下顶上就多出
 *    一条空白带。在 App 外面（浏览器 / 主屏）跑时那个变量不存在，回落到 `env()`，行为与上游
 *    一致。改界面时照这个写法走，别直接读 `env(safe-area-inset-top)`。
 * 6. **路径改写** —— 不在这里改代码，由 `scripts/build-extension.mjs` 产包时往 `index.html`
 *    的 `<head>` 最前面注入一段脚本，把 `fetch('/api/…')` 改成 `fetch('/api/dsh-magpie/api/…')`。
 *    原因与规则写在那份脚本的注释里：App 的 `hostData` 通道按清单里的 `match` 前缀认请求、
 *    不改写路径，所以裸的 `/api/*` 到不了本插件的路由前缀。这一条**只在产物里**，所以改了
 *    源码不用管它；反过来，别把这段手工塞进 `index.html`，否则每次产包都会多一层。
 *
 * ## 不进扩展包的文件
 *
 * `serve.mjs`（DV）、`SOURCE.md`（本说明）、`_probe*.html`（调界面用的探针页）、顶层其它 `.md`。
 * 判据在产包脚本的 `DEV_ONLY` 里，守卫会核对它们没混进 `extensions/magpie/`。
 *
 * ## 改的时候要记住
 *
 * - **别动 `boot.js` 的形状**：前端在绘制之前读 `window.bootPrefs`，字段少一个就是首帧语言 /
 *   主题跳一下。
 * - **上游更新会覆盖这里**：这一份是快照，不是 fork。将来要么定期重新拷（然后重放我们的改动），
 *   要么把改动收进一个单独的 patch 脚本。真开始改之前先定这一条。
 * - **改完不用重启**：`serve.mjs` 对本地文件一律 `no-store`，浏览器刷新即生效。
 * - **改完要重跑产包**：`node scripts/build-extension.mjs`；`--check` 会告诉你产物是不是旧的。
 */
