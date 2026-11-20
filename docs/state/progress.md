# 进度

- 2026-10-14 11:55 | #001 | 插件 | 初始版本：把 Meoo（秒悟）的建站 Agent 接成 magpie provider，在 auth.loader 返回的自定义 fetch 里把 OpenAI chat completion 翻译成「Agent Run + SSE」再翻译回来；不占端口、不起独立进程 | deepseek-v4.1-flash
- 2026-10-14 12:20 | #002 | 档位 | 把 speed_tier 做成模型变体（`<id>@fast` / `@standard` / `@deep`），从模型下拉框直接选，不再依赖环境变量；模型数由 14 变 42。起 Run 前剥掉 `@档位` 后缀再发给 Meoo，响应里保留完整变体名 | deepseek-v4.1-flash
- 2026-10-14 12:28 | #003 | 文档 | README 改为中英双语（英文在前 + 顶部语言切换链接），补齐档位变体、GitHub 发现安装、六个已知限制、授权提醒；纯文档改动，不动代码、不发新 tag | deepseek-v4.1-flash
- 2026-10-14 12:36 | #004 | 文档 | README 按语言拆成两个文件：`README.md`（英文，GitHub 默认渲染）+ `README.zh-CN.md`（中文），顶部放互切链接，不再同页堆两种语言 | deepseek-v4.1-flash
- 2026-11-20 10:35 | #005 | 余额 | 新增 `auth.usage`：用 `X-Meoo-Client: cli` 调 `GET https://meoo.com/api/mc/entitlement/get` 上报积分余额（availableBalance/totalGranted）与逐份到期（activeGrants.grantDetails），顶层报 plan/until；逐份行带 `aside: true` 以免参与 429 拦截 | deepseek-v4.1-flash
- 2026-11-20 10:52 | #006 | 有效期 | 新增 `auth.methods[0].authorize`：登录期校验 key 并写 `expires` + `expiresAt`（取最晚 grant expiresDate，退回 currentPeriodEnd），让网关「有效期」列显示真实日期；随即把账号名刷成 Meoo 显示名（原先被 uid 覆盖） | deepseek-v4.1-flash
- 2026-11-20 11:10 | #007 | 修正 | 逐份到期的日期改塞进窗口名（`· MM-DD 到期`）并补 `resetsAt`：宿主 reports.mjs 的 label/window 都取 `row.name`，弹层只渲染 `resetsAt`；同时 `limit` 与 `balance` 同值 + `used: 0`，避免前端把整格降级成「部分读数未知」 | deepseek-v4.1-flash
- 2026-11-20 11:16 | #008 | 修正 | 时区：Meoo 的时间串不带时区（北京本地时间），网关跑在 UTC 容器里，直接 `Date.parse` 会把每个到期日整体推后 8 小时、`23:59:59` 的几份跨日。改为解析前补 `+08:00`、标签按同一偏移格式化，与宿主及用户看到的中文时间一致 | deepseek-v4.1-flash
- 2026-11-20 11:55 | #009 | Logo | 声明官方 logo（`assets/meoo.png` = meoo.com favicon 原图，184×184）。https 地址在本网关下永远取不到图：容器 DNS 是 fake-ip，公网域名全解析到 198.18.0.0/15 保留段，被宿主 `icons/download.rs` 的 `public_ip()` 拒收，`/api/session` 的 providerIcons 一直为空。改为内嵌 `data:image/png;base64`（64×64，11.8KB），走 `icons/formats.rs` 的 `inline()`（解 base64 + 验魔数），完全不碰 DNS；`auth.icon` 与 `package.json` 的 `magpie.icon` 同步，新增 `icon.mjs` 承载内嵌串 | deepseek-v4.1-flash
