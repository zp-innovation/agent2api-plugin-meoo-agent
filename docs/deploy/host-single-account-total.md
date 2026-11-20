# 宿主补丁：单账号组也显示「可用合计」

> 这个补丁**不在本仓库代码里**：它改的是网关镜像内的前端产物，并且由 host 上的一个
> systemd 定时器守护（镜像升级后自动重打）。记录在此是为了可复现、可回滚、可交接。

## 为什么要打

账号页分组带上的「可用合计」徽标由宿主前端决定要不要画，两处都要求**整组超过 1 个账号**：

- 源码 `desktop-tauri/ui-islands/src/islands/accounts-panels.tsx` 的 `GroupBandRow`：
  `const worthSumming = group.members.length > 1 && members.length > 0`
  （注释：一个账号的组，合计与下面那行读数逐字重复）
- 打包产物 `/app/ui/islands/ui.js`（v3.5.0-beta.10 版）里对应两处：

```js
// ① 客户端算出来的分组合计（groupBalanceOf）
x = e.members.length > 1 && g.length > 0,
// ② 服务端 summary.balance 的渲染条件
b && (e.summary?.total ?? e.members.length) > 1 ? r.jsx(WTe, { balance: b }) : null
```

于是所有「只有 1 个账号」的提供商（Meoo 秒悟、Antigravity、ZCode 国际、KukuAI、Accio、
Accio 国内、OpenCode Zen、移动云 MoMA、WorkBuddy 国内版…）那一行永远是空的，
看起来像功能没做完。

## 打了什么

只放宽这两处「值不值得画」的判据（`-60` 字节），统计口径与徽标组件一个字都没动：

```diff
- x=e.members.length>1&&g.length>0
+ x=g.length>0

- b&&(e.summary?.total??e.members.length)>1?r.jsx(WTe,{balance:b})
+ b?r.jsx(WTe,{balance:b})
```

结果：单账号组也会显示 `可用合计 <绝对值>`；只报比例的组显示 `可用最低 <百分比>`；
一个都统计不了时显示 `可用合计 — 计入 0/N`（与多账号组同一套分支，见
`accounts-usage-group.tsx` 的 `GroupBalanceBadge`）。

## 怎么打（幂等）

脚本：`/data/projects/agent2api/patches/reapply-ui-total.sh`（在 host 上，不在容器里）

```sh
sudo systemctl start agent2api-ui-total.service    # 手动触发一次
cat /data/projects/agent2api/patches/reapply.log   # 只有真正改写时才会追加一行
```

脚本做四件事：把容器里的 `ui.js` 拷出来 → 两处守卫若还在就替换（都不在则静默退出）→
首次备份成 `ui.js.orig` → 拷回去。**已经打过就什么都不做**，所以可以随便重跑。

## 怎么自动重打

镜像升级/重建容器会把 `/app/ui` 换回官方产物（容器只把 `/data` 挂成 bind，
`/app` 属于镜像层）。守护用的是 host 上的 systemd timer：

- `/etc/systemd/system/agent2api-ui-total.service` → `ExecStart=` 上面那个脚本
- `/etc/systemd/system/agent2api-ui-total.timer` → `OnBootSec=45s` + `OnUnitActiveSec=2min`

```sh
systemctl list-timers agent2api-ui-total.timer
sudo systemctl disable --now agent2api-ui-total.timer   # 不想要守护时
```

实测：把 `ui.js.orig` 换回容器（模拟一次升级），再 `systemctl start`，2 秒内两处守卫
重新打上，`reapply.log` 记一行。

## 怎么回滚

```sh
docker cp agent2api:/app/ui/islands/ui.js.orig /tmp/ui.js.orig && \
  docker cp /tmp/ui.js.orig agent2api:/app/ui/islands/ui.js
sudo systemctl disable --now agent2api-ui-total.timer    # 否则 2 分钟后又被重打
```

## 验证

```sh
curl -s http://127.0.0.1:3065/islands/ui.js | grep -c 'x=g.length>0'                 # 1
curl -s http://127.0.0.1:3065/islands/ui.js | grep -c 'x=e.members.length>1&&g.length>0'  # 0
```

产物响应头是 `cache-control: no-cache` + 内容相关的 ETag，改完 ETag 必变，
浏览器普通刷新即可拿到；还看到旧界面就强制刷新一次。

## 注意

- 与插件无关：插件的责任是把**绝对积分总数**放进 `usage.balance`（v0.6.1 起已做，
  线上 meoo 现在是 `available 7668`），否则连多账号组也只能算「可用最低（百分比）」。
- 上游若把 `worthSumming` 改成单账号也画，这两处字符串就消失了，脚本会自动变成空操作
  （静默退出），届时可以卸掉定时器。
- 真正的修法是把这条规则提给上游；补丁只是让本机的面板不再看起来像「功能没做完」。
