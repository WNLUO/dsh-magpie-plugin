# dsh-magpie-plugin

magpie 的独立插件。两半拼起来才完整：

- **宿主半身**（`lib/`、`index.js`）：在电脑上的 DSH 宿主里注册 magpie 的接口
  （前缀 `/api/dsh-magpie`），按需把本机的 magpie 网页版进程拉起来，并替扩展页取它那份数据。
- **手机扩展**（`extensions/magpie/`）：随插件下发给手机的扩展页，就是 magpie 自己的界面。

页面源码来自上游 magpie 的网页版前端（`web/`，整份快照搬进来的，不是 fork），界面的样子、
设置项都由 magpie 自己决定 —— 这边只负责把它打进包、经由宿主递数据，不改页面逻辑。

## 目录

```
web/                    magpie 网页版前端源码（上游快照 + 本地开发服务器）
extensions/magpie/      扩展产物：manifest.json 清单 + 整页文件（进库，随包下发）
lib/                    宿主半身：路径与命名空间、网页进程管理、代取、路由
index.js                插件入口
cordis.patch.yml        把插件挂进 profile 的挂载行
scripts/                构建、开发、更新脚本
  build-extension.mjs   web/ → extensions/magpie/ 的产包脚本（--check 校验产物与源一致）
  dev-install.mjs       产包并铺到本地开发目录
  dev-watch.mjs         盯源码 → 产包 → 铺到本地开发目录
  reload-dev.mjs        打包 + 装进 profile + 就地热重载（改宿主半身用）
  update-check.mjs      查最新版（--install 才真装）
```

`web/node_modules/` 之类的构建中间产物不进库；`extensions/magpie/` 是产物，**要进库**，
装机的人不必装前端依赖。

## 安装

这个插件以 profile 的 bundle 形式装进 DSH：

```sh
git clone <这个仓库>
cd dsh-magpie-plugin
npm pack                                    # 打成 tgz
# 解压到 <profile>/node_modules/dsh-magpie-plugin/
# 在 <profile>/package.json 的 dsh.profile.bundles 里加 "dsh-magpie-plugin"
```

`<profile>` 是 DSH 正在用的那个（`~/.dsh/profiles/<名字>`，默认 `desktop`）。**加一个 bundle
必须重启 DSH** —— 它换的是进程启动时装配的那张表，没有热重载这一说。

装好之后，手机上的扩展页里会多出 `magpie` 这一格；扩展页的 `fetch('/api/…')` 由宿主转到
本机 magpie 的网页服务上。

已经装过的版本，用自更新脚本升级：

```sh
node scripts/update-check.mjs            # 查注册表上的最新版，只报告不落盘
node scripts/update-check.mjs --install  # 核对版本后真的装
```

## 开发

这里有**两条不同的路**，别混：

### 一、只改扩展页面（大多数时候是这个）

页面改完要能在手机上看，走「本地开发包」那条：

```sh
node scripts/build-extension.mjs   # web/ → extensions/magpie/
node scripts/dev-install.mjs       # 另拷一份到 $DSH_HOME/extension-dev/magpie/
```

然后在手机上：设置 → 扩展 → **开发者模式**（打开）→ 扩展页末尾「本地开发」→ 刷新 → 导入。
之后页面每 1.5 秒自查一次内容哈希，电脑上再改再跑，手机上自己重装重开。也可以
`node scripts/dev-watch.mjs` 一条命令盯着改。

想在手机上看页面本身的热更新（不必反复导入），在 `web/` 那份额外写一格
`devServer` 指向你电脑的局域网地址（只认私网 / 回环 + http），手机那一页就直接加载它；
正式装进来的那份永远跑包里这一份，不会被远程内容顶掉。

**这条路不需要装插件本体**：它只读 `$DSH_HOME/extension-dev/` 那个目录。

### 二、改宿主半身（`lib/`、`index.js`）

宿主半身是电脑上的插件代码，手机那侧碰不到。改完让它生效：

```sh
node scripts/reload-dev.mjs
```

它打包、装进当前 profile、就地热替换已经加载的模块体。**第一次装**（profile 里还没有这个
bundle）仍需按「安装」那一节加 bundle 并重启 DSH —— 热重载换不掉「多出一个 bundle」这件事。

### 守卫

```sh
npm test        # node --test test/
```

改了 `web/` 记得重新产包，否则 `extension.test.mjs` 的 `--check` 会红。

## 与 DSH-mobile 里那份内置 magpie 的关系

DSH-mobile 仓的 `dsh-mobile-plugin` 里也带了一份 magpie（页面源码、把网页进程拉起来的
逻辑、代取通道都在里面）。这个仓库是**把它抽出来独立维护**的那一份：同一套页面、同一个
宿主半身，单独成为可以独立发版的 npm 插件。

**过渡期两半并存**：

- 旧版 App / 还没切换的用户，仍指向 `dsh-mobile-plugin` 里那份内置的 magpie，它暂时保留。
- 这个独立插件另起一个服务名与路由前缀（`dsh-magpie` / `/api/dsh-magpie`），和内置那份的
  路径不重叠，同时装着不会互相抢路由。
- 两边**共用同一条登录钥匙**（`~/.dsh/magpie-web-key`）：谁先把 magpie 网页进程拉起来，另一边
  都能用它认领，不会出现「一边认领得上、一边认领不上」。
- 等这个插件在手机上稳定可用、老用户都切过来之后，DSH-mobile 里那半份内置实现会退役。

## 许可

MIT，见 `LICENSE`。页面源码来自上游 magpie 的网页版前端，版权归原作者。
