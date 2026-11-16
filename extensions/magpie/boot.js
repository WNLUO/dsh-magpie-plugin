// magpie 网页版启动时由 Go 侧动态生成的那一段（原产在 internal/gui/api.go 的 `GET /boot.js`）。
//
// 上游仓库里没有这个文件：它是宿主在运行时拼出来的，内容是**页面开始绘制之前**要拿到的那
// 几项（语言、主题、字号、是不是网页版、这个版本号、内置插件被关掉的那几张页、以及插件那格
// 配置）。我们这套是本地跑的原版前端，宿主换成我们自己，所以按同样的形状在这里静态给一份 ——
// 少了它，`bootPrefs` 是 undefined，页面会按英文与浅色画第一帧，之后设置回来了再跳一次；
// 少了几格（比如 `pluginConfig`），页面读 `bootPrefs.pluginConfig.gateway.*` 就会当场抛错。
//
// 形状必须与上游一致（`window.bootPrefs = {...}` 一行），**上游加了新格子这里要跟着加**：
// 对照真身最省事的办法是把 `magpie web` 跑起来、取一次 `/boot.js`。
// 想改哪一项就改下面这张表，别再往页面里塞第二份。
window.bootPrefs = {
  // 页面语言。上游取的是用户在 magpie 里存的那门；这里给中文，与两边界面一致。
  lang: 'zh',
  // 'light' / 'dark' / '' 跟随系统
  theme: '',
  // 外观变体。上游在这一格没得选时也会给一个值，页面按逗号拆——给空串会让它拆出空项。
  look: ',',
  // 100 = 正常大小；上游是用户在设置里调的那个百分比
  textSize: 100,
  // true = 这一页由 `magpie web` 端出来（没有 App 窗口那一层）。原版前端靠它决定
  // 「链接自己开、属于桌面的那几张页不画」，我们正是这个形态。
  web: true,
  // 端出这一页的那个 magpie 的版本。前端用它判断「是不是换了一个进程在答」。
  // 真值由本地代理盖掉（见 scripts/serve.mjs），这里是兜底。
  version: '',
  // 服务端关掉的那几张内置页。我们另外砍了 Sessions / Library / Gateway，
  // 但那是 `app.js` 里的 REMOVED_VIEWS 在管（见 SOURCE.md 第 3 条），不靠这一格。
  featuresOff: [],
  // 插件那格配置（上游把内置插件的页配置塞在这里）。整格不能少：页面会直接往下读。
  pluginConfig: { gateway: { callsPage: 20 } },
};
