# 宿主补丁：单账号组也显示「可用合计」

> 这份补丁**不在本仓库代码里**，它改的是网关镜像内的前端产物。记录在此是为了可复现、可回滚。

## 为什么要打

账号页分组带上的「可用合计」徽标由宿主前端决定要不要画：

- 源码：`desktop-tauri/ui-islands/src/islands/accounts-panels.tsx:206`
  `const worthSumming = group.members.length > 1 && members.length > 0`
  （注释：一个账号的组，合计与下面那行读数逐字重复）
- 线上产物：`/app/ui/islands/ui.js` 里对应
  `f=e.members.length>1&&u.length>0&&u.some(Ai)?d1e(u,l?"filtered":"group",s):null`

于是所有「只有 1 个账号」的提供商（Meoo 秒悟、Antigravity、ZCode 国际、KukuAI、Accio、
Accio 国内、OpenCode Zen、移动云 MoMA、WorkBuddy 国内版…）那一行永远是空的，
看起来像功能没做完。

## 打了什么

只删掉 `e.members.length>1&&` 这一个条件（`-20` 字节）：

```
- f=e.members.length>1&&u.length>0&&u.some(Ai)?d1e(u,l?"filtered":"group",s):null
+ f=u.length>0&&u.some(Ai)?d1e(u,l?"filtered":"group",s):null
```

语义不变，只是把「值不值得画」的判据从「整组 >1 个账号」放宽成「这一组有账号且至少
一个报了余额」。单一账号的组现在会显示 `可用合计 <绝对值>`，只报比例的组显示
`可用最低 <百分比>`，一个都统计不了时显示 `可用合计 — 计入 0/N`（与多账号组同一套
分支，见 `accounts-usage-group.tsx` 的 `GroupBalanceBadge`）。

## 怎么打 / 怎么回滚

```sh
# 备份（只在第一次生效）
docker exec agent2api cp -n /app/ui/islands/ui.js /app/ui/islands/ui.js.orig
# 打入补丁后的产物
docker cp ui.patched.js agent2api:/app/ui/islands/ui.js
# 回滚
docker cp agent2api:/app/ui/islands/ui.js.orig /tmp/ui.js.orig && \
  docker cp /tmp/ui.js.orig agent2api:/app/ui/islands/ui.js
```

验证：

```sh
curl -s http://127.0.0.1:3065/islands/ui.js | grep -c 'u.length>0&&u.some(Ai)?d1e('   # 1
curl -s http://127.0.0.1:3065/islands/ui.js | grep -c 'e.members.length>1&&u.length>0' # 0
```

产物响应头是 `cache-control: no-cache` + `etag: W/"<版本>-<长度hex>-<mtime>"`，
改完长度变了 etag 就变，浏览器普通刷新即可；若还看到旧界面，强制刷新一次。

## 注意

- `/app/ui` 是**镜像内**的静态目录（容器只把 `/data` 挂成 bind），所以重新拉镜像/重建容器后
  补丁会消失，需要重打。真正的修法是把 `worthSumming` 这一行提给上游。
- 与插件无关：插件的责任是把**绝对积分总数**放进 `usage.balance`（v0.6.1 起已做），
  否则多账号组也只能算「可用最低（百分比）」。
