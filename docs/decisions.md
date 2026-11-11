# 设计决策

这篇记「为什么这么做」，不是做了什么（做了什么看 README 与各文件头注释）。

## 为什么是一个独立插件，不是塞回移动端插件

magpie 原来作为「移动端插件里的一个扩展包」发布。抽出来做成独立 npm 插件（与
`dsh-canvas-plugin` 同构）之后：页面源码、进程管理、代取接口全在这个包里，装不装它由用户
一条命令决定，移动端插件不再为单个应用背代码。

## 三个写死的命名（改一个都等于换一份身份）

- 包名 `dsh-magpie-plugin`
- `host.data` 服务名 `dsh-magpie`
- 路由前缀 `/api/dsh-magpie`

服务名**故意不沿用**移动端插件里那个内置的 `magpie`：内置服务优先于任何第三方声明，沿用
就会被老那份永久压住。换一个名字，两半可以并存、互不干扰。

## 为什么页面要自己改写 `/api/` 前缀

App 的通用取数通道（`host.data`）拿到页面请求后按 `pathname+search` **原样**转给宿主，
整条链路不做任何前缀转换；落点判据是宿主登记表里 `allow` 前缀的 `startsWith`。而 magpie
页面源码里写的是裸 `/api/state`（上游页面，改不得它的调用点）。所以产包时在 `index.html`
最前面注入一小段 `window.fetch` 包装，把裸 `/api/*` 挪到 `/api/dsh-magpie/api/*`；宿主路由
再剥掉前缀转给 magpie。这一层是「页面原样跑」与「路由不撞 DSH 自己的 /api」两者同时成立的
唯一接法。

注入顺序是正确性前提：App 的 `hostDataShimScript` 由 `injectedJavaScriptBeforeContentLoaded`
先装 `window.fetch`，页面的内联改写脚本在其后包一层 —— 于是最外层是改写、内层是 App 的拦截，
`/api/state` 先被加前缀、再命中 match 交给宿主。顺序反了（改写装在里层）会导致 App 拦截看到
的是裸路径、匹配不上而直连失败。

## 代取为什么是「透明代理」而不是自定义 POST 接口

手机那条通道是「宿主自己端口 + 页面原路径」转发到插件路由，因此插件必须回**真实的**
status / content-type / 正文，不能包成 `{ok,status,body}` 信封 —— 否则页面读到的是外壳而不是
magpie 的响应。4xx/5xx 也照原样透传，让页面按普通 Response 判断。

## 登录 key 共用移动端插件那一个文件

`~/.dsh/magpie-web-key`。过渡期两半同时装着，共用一把 key 才不会「一边认领得上、一边认领
不上」。两半起的是同一个 magpie web 进程。

## 热重载的边界（照实说）

`POST /api/dsh-magpie/dev/reload`（要带 `x-dsh-dev-reload` 头，因为手机那条通道的落点也是回环
地址，只认回环分辨不出来）能换掉 `routes/magpie-web/proxy` 三个实现模块；换不掉 `index.js`
本身与 `paths.js`（ESM 导入缓存 + 身份契约）。探测不到就退化成「已装进 profile、重启一次」。

## 过渡期：移动端插件里那份先不删

老版本 App 的 magpie 走的还是移动端插件那条老路，删了老用户当场打不开。所以新插件先铺、
几版之后再清移动端插件里那份。
