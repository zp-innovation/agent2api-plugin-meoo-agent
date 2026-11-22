
// Meoo 的 API Key 只对「CLI 身份」开放网页控制面接口。缺这个头时
// /api/mc/* 与 /api/v1/* 一律 401 API_KEY_CLIENT_REQUIRED；写成
// X-Client-Type、User-Agent: meoo-cli 之类都无效（实测）。加上它不影
// 响 /open/v1（同一把 key 仍能建项目、起 Run）。
const CLIENT_HEADER = { "X-Meoo-Client": "cli" };

// Browser OAuth (PKCE) is only used to verify the account and refresh web login state.
// Meoo Agent Run still needs a meoo_ak_ API Key: no public endpoint exchanges OAuth
// tokens for that key, and project service AKs are not proven for /agent/runs.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const OAUTH_CLIENT_ID = "meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh";
const OAUTH_SCOPE = "cli.compat";
const OAUTH_CALLBACK_PATH = "/oauth/callback";
const OAUTH_TIMEOUT_MS = 10 * 60 * 1000;
const OAUTH_CLI_HEADERS = { ...CLIENT_HEADER, "x-meoo-cli-version": "0.5.6" };
const REFRESH_LEAD_MS = 5 * 60 * 1000;
const TOKEN_EARLY_MS = 60 * 1000;
const tokenRenewals = new Map();
const tokenCache = new Map();

const ID = "meoo-agent";
const SITE = "https://meoo.com";
const API = `${SITE}/open/v1`;
const WEB = SITE;
const CHAT = "@ai-sdk/openai-compatible";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

async function tokenRequest(params, { signal } = {}) {
  const res = await fetch(`${SITE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...OAUTH_CLI_HEADERS },
    body: new URLSearchParams(params),
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok || json?.error) {
    const e = new Error(json?.error_description || json?.error || text.slice(0, 200) || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  if (typeof json?.access_token !== "string" || !json.access_token) throw new Error("Meoo OAuth 响应没有 access_token");
  return json;
}

async function renewOAuth(auth, { force = false, signal } = {}) {
  const refresh = typeof auth?.refresh === "string" ? auth.refresh : "";
  if (!refresh) {
    if (!force && typeof auth?.access === "string" && auth.access
      && Number.isFinite(auth.expires) && auth.expires > Date.now() + TOKEN_EARLY_MS) return auth;
    const e = new Error("Meoo 登录态已过期且没有 refresh token，请重新登录");
    e.signIn = "expired";
    throw e;
  }
  if (!force && Number.isFinite(auth.expires) && auth.expires > Date.now() + TOKEN_EARLY_MS) return auth;
  const hit = tokenCache.get(refresh);
  if (!force && hit && Date.now() - hit.at < TOKEN_EARLY_MS) return { ...auth, ...hit.next };
  let pending = tokenRenewals.get(refresh);
  if (!pending) {
    pending = (async () => {
      const token = await tokenRequest({ grant_type: "refresh_token", client_id: OAUTH_CLIENT_ID, refresh_token: refresh }, { signal });
      const next = {
        access: token.access_token,
        refresh: token.refresh_token || refresh,
        expires: Date.now() + (Number(token.expires_in) || 3600) * 1000,
        ...(token.scope ? { scope: token.scope } : {}),
        ...(token.openid ? { openid: token.openid } : {}),
      };
      tokenCache.set(refresh, { at: Date.now(), next });
      tokenCache.set(next.refresh, { at: Date.now(), next });
      return next;
    })().finally(() => tokenRenewals.delete(refresh));
    tokenRenewals.set(refresh, pending);
  }
  const next = await pending;
  return { ...auth, ...next };
}

async function controlCall(auth, path, { signal } = {}) {
  let current = await renewOAuth(auth, { signal });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(SITE + path, {
      headers: { Authorization: `Bearer ${current.access}`, ...OAUTH_CLI_HEADERS, Accept: "application/json" },
      signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (res.status === 401 && attempt === 0) { current = await renewOAuth(current, { force: true, signal }); continue; }
    if (!res.ok) {
      const e = new Error(json?.error?.message || json?.message || `Meoo ${path} -> ${res.status}`);
      e.status = res.status;
      throw e;
    }
    if (json?.success === false) throw new Error(json?.error?.message || "Meoo 控制面拒绝请求");
    return json?.data ?? json ?? {};
  }
  throw new Error("Meoo 控制面登录态失效，请重新登录");
}

async function oauthIdentity(access, signal) {
  try {
    const res = await fetch(SITE + "/open/v1/cli-compat/account/identity", {
      headers: { Authorization: `Bearer ${access}`, ...OAUTH_CLI_HEADERS, Accept: "application/json" },
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    if (!res.ok) return {};
    const json = await res.json();
    const d = json?.data ?? json ?? {};
    const name = d.name ?? d.username ?? "";
    const uid = d.user_id ?? d.userId ?? d.id ?? d.openid ?? "";
    return { ...(uid ? { uid: String(uid) } : {}), ...(d.email ? { email: d.email } : {}), ...(name ? { name } : {}) };
  } catch { return {}; }
}

// Browser authorization uses a loopback server. The host opens the browser and relays the
// callback URL back to the plugin; credentials are never written to a plugin-owned file.
async function browserOAuth(inputs, { signal } = {}) {
  const apiKey = typeof inputs?.key === "string" ? inputs.key.trim() : "";
  if (!apiKey) return { type: "failed", error: "请同时填写 Meoo API Key（meoo_ak_…），Agent Run 仍需要它" };
  try {
    await web(apiKey, "/api/mc/entitlement/get", { signal });
  } catch (e) {
    if (e?.status === 401 || e?.status === 403) return { type: "failed", error: `API Key 无效：${rejectText(e)}` };
  }
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  let resolveCode;
  let rejectCode;
  let done = false;
  let server = null;
  let origin = "";
  const completion = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
  const cleanup = () => { try { server?.close(); } catch {} };
  const fail = (err) => { if (done) return; done = true; cleanup(); rejectCode(err); };
  server = createServer((req, res) => {
    let url;
    try { url = new URL(req.url, origin); } catch { res.writeHead(400).end(); return; }
    if (url.pathname !== OAUTH_CALLBACK_PATH || url.searchParams.get("state") !== state) {
      res.writeHead(400).end("Invalid OAuth callback");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("Meoo 授权完成，可以关闭本窗口。");
    if (!done) { done = true; resolveCode(url.searchParams.get("code") || ""); }
  });
  await new Promise((res, rej) => server.once("error", rej).listen(0, "127.0.0.1", res));
  const address = server.address();
  if (!address || typeof address === "string") { cleanup(); throw new Error("无法启动 OAuth 本机回调服务"); }
  origin = `http://127.0.0.1:${address.port}`;
  const redirectUri = origin + OAUTH_CALLBACK_PATH;
  const timer = setTimeout(() => fail(new Error("Meoo 登录超时，请重新登录")), OAUTH_TIMEOUT_MS);
  signal?.addEventListener("abort", () => fail(new Error("已取消 Meoo 浏览器授权")), { once: true });
  const authorizeUrl = new URL("/oauth/authorize", SITE);
  authorizeUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", OAUTH_SCOPE);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  return {
    url: authorizeUrl.href,
    method: "auto",
    instructions: "在浏览器完成 Meoo 登录授权；随后仍需保存你填写的 meoo_ak_ API Key，才能调用建站 Agent。浏览器登录会触发「每天登录送积分」，插件不代签。",
    async callback(raw, options) {
      try {
        let code = "";
        if (typeof raw === "string" && raw) {
          try {
            const u = new URL(raw);
            code = u.searchParams.get("code") || "";
            const gotState = u.searchParams.get("state") || "";
            if (gotState && gotState !== state) throw new Error("回调地址与当前登录任务不匹配");
          } catch (e) {
            if (e?.message === "回调地址与当前登录任务不匹配") throw e;
            code = raw;
          }
        } else code = await completion;
        if (!code) throw new Error("Meoo 浏览器授权没有返回 code");
        const token = await tokenRequest({
          grant_type: "authorization_code",
          client_id: OAUTH_CLIENT_ID,
          redirect_uri: redirectUri,
          code,
          code_verifier: verifier,
        }, { signal: options?.signal });
        const access = token.access_token;
        const who = await oauthIdentity(access, options?.signal);
        return {
          type: "success",
          access,
          refresh: token.refresh_token || "",
          expires: Date.now() + (Number(token.expires_in) || 3600) * 1000,
          key: apiKey,
          ...who,
          scope: token.scope || OAUTH_SCOPE,
          ...(token.openid ? { openid: token.openid } : {}),
          ...(token.id_token ? { idToken: token.id_token } : {}),
        };
      } finally { clearTimeout(timer); cleanup(); }
    },
  };
}

// 官方 logo（内嵌 data:image/png;base64，原因与尺寸约束见 icon.mjs 顶部注释）。
// 用 https 地址在这台网关上永远不会成功：容器 DNS 是 fake-ip，公网域名一律
// 解析到 198.18.0.0/15 保留段，会被 icons/download.rs 的 public_ip() 拒收。
import { ICON } from "./icon.mjs";

// 档位做成模型变体（<model>@fast / @standard / @deep），从模型下拉框里选，
// 不依赖环境变量。MEOO_SPEED_TIER 只作为「模型 ID 没带 @档位」时的兜底。
const TIERS = ["fast", "standard", "deep"];
const TIER_LABEL = { fast: "快速", standard: "标准", deep: "深度" };
const FALLBACK_TIER = process.env.MEOO_SPEED_TIER || "fast";

const PROJECT_NAME = process.env.MEOO_PROJECT_NAME || "Magpie Bridge";
const TIMEOUT_MS   = Number(process.env.MEOO_TIMEOUT_MS || 10 * 60 * 1000);
const AUTO_ANSWER  = process.env.MEOO_AUTO_ANSWER ??
  "请自行选择最合理的方案并直接继续执行，不要向我提问。";
const VERBOSE      = process.env.MEOO_VERBOSE === "1";

const log = (...a) => { if (VERBOSE) console.log("[meoo-agent]", ...a); };

// ---- 模型 ---------------------------------------------------------------------
//
// 「能力同步」在这里只可能有两半，必须分清：
//
//   ① 模型清单 —— 真的能同步。provider.models() 调
//      GET /open/v1/projects/{id}/agent/capabilities 拿到当前可用的模型列表
//      与档位，上游加/删模型这里立刻跟着变。
//
//   ② 上下文窗口 / 输出上限 —— **同步不了**。那个接口只返回 {id, name}，
//      没有 context、没有 max_output、没有模态、没有 tools；/open/v1/models、
//      /agent/models、/models?detail=1、/me、/account、/entitlement 全是 404
//      （2026-11-20 实测）。所以这两个数只能由本文件声明。
//
// 早先的写法是 known.get(m.id) 精确匹配，上游把 deepseek-v4.1-flash 改名成
// deepseek-v4.1-flash-1017、把 kimi-k3 加了个 kimi-k3.1-pro 之后，新 ID 全
// 落空 → 0 → 模型管理页整列「上游未声明」。现在改成按**归一化 ID** 查规格表：
// 去 vendor 前缀（moonshot/、bigmodel/、MiniMax/、DeepSeek/）、折叠大小写与
// 分隔符、去尾部 4 位日期戳（-1017 / -0813 / -0731）。以后同类改名不用改代码。
//
// 数值口径：家族默认（同门模型同一个窗口），不是上游声明。DeepSeek-V4-Pro 的
// 1M/384K 来自官方文档；其余按各家公开的 200K/64K 档。要改单个模型，用环境变量
//   MEOO_MODEL_SPECS='{"deepseek-v4.1-flash-1017":{"context":1000000,"output":384000}}'
// 或直接在面板「模型能力」弹窗里覆盖（那里是本插件声明之上的覆盖层）。
const MODELS = [
  { id: "auto",                        name: "自动选择" },
  { id: "qwen4-max",                   name: "Qwen4-Max" },
  { id: "qwen3.8-max",                 name: "Qwen3.8-Max" },
  { id: "qwen3.8-flash",               name: "Qwen3.8-Flash" },
  { id: "qwen3.7-max",                 name: "Qwen3.7-Max" },
  { id: "qwen3.7-plus",                name: "Qwen3.7-Plus" },
  { id: "deepseek-v4.1-flash-1017",    name: "DeepSeek V4.1 Flash" },
  { id: "deepseek-v4-pro-0813",        name: "DeepSeek V4 Pro" },
  { id: "deepseek-v4-flash-0731",      name: "DeepSeek V4 Flash" },
  { id: "moonshot/kimi-k3.1-pro",      name: "Kimi K3.1 Pro" },
  { id: "moonshot/kimi-k3",            name: "Kimi K3" },
  { id: "MiniMax/MiniMax-M3.1-Flash",  name: "MiniMax M3.1 Flash" },
  { id: "bigmodel/glm-5.3",            name: "GLM-5.3" },
  { id: "bigmodel/glm-5.3-flash",      name: "GLM-5.3-Flash" },
  { id: "glm-5.2-fast-preview",        name: "GLM-5.2-Fast" },
  { id: "glm-5.2",                     name: "GLM-5.2" },
];

const SPEC_DEFAULT = { context: 200_000, output: 64_000 };
const SPEC = new Map(Object.entries({
  "auto":                    [200_000, 64_000],
  "qwen4-max":               [200_000, 64_000],
  "qwen3.8-max":             [200_000, 64_000],
  "qwen3.8-flash":           [200_000, 64_000],
  "qwen3.7-max":             [200_000, 64_000],
  "qwen3.7-plus":            [200_000, 64_000],
  "deepseek-v4.1-flash":     [200_000, 64_000],   // 归一化后不带 -1017
  "deepseek-v4-flash":       [200_000, 64_000],
  "deepseek-v4-pro":         [1_000_000, 384_000],
  "kimi-k3":                 [200_000, 64_000],
  "kimi-k3.1-pro":           [200_000, 64_000],
  "minimax-m3.1-flash":      [200_000, 64_000],
  "glm-5.3":                 [200_000, 64_000],
  "glm-5.3-flash":           [200_000, 64_000],
  "glm-5.2":                 [200_000, 64_000],
  "glm-5.2-fast-preview":    [200_000, 64_000],
}).map(([key, [context, output]]) => [key, { context, output }]));

// 归一化：小写 → 去 vendor 前缀 → 非 [a-z0-9.] 折叠成 - → 去尾部 4 位日期戳
function specKey(id) {
  return String(id ?? "")
    .toLowerCase()
    .replace(/^[^/]*\//, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/-\d{4}$/, "")
    .replace(/^-+|-+$/g, "");
}

// 环境变量覆盖（键可以是原 ID，也可以是归一化 ID）
const SPEC_OVERRIDE = (() => {
  try { return JSON.parse(process.env.MEOO_MODEL_SPECS || "{}") ?? {}; }
  catch { return {}; }
})();

function specOf(id) {
  const key = specKey(id);
  const hit = SPEC_OVERRIDE[id] ?? SPEC_OVERRIDE[key] ?? SPEC.get(key) ?? SPEC_DEFAULT;
  const context = Number(hit?.context);
  const output = Number(hit?.output);
  return {
    context: Number.isFinite(context) && context > 0 ? context : SPEC_DEFAULT.context,
    output: Number.isFinite(output) && output > 0 ? output : SPEC_DEFAULT.output,
  };
}

function isChatModel(id) { return !/^claude/i.test(id); }

// 把 <model>@<tier> 拆开；没带 @档位就用兜底档。
// 只认三个已知档位名，其余 @ 结尾一概当模型 ID 的一部分（Meoo 的 ID 里没有 @）。
function splitTier(modelId) {
  const m = /^(.*)@(fast|standard|deep)$/.exec(String(modelId ?? ""));
  if (m && m[1]) return { model: m[1], tier: m[2] };
  return { model: modelId || "auto", tier: FALLBACK_TIER };
}

// 给每个模型生成三个档位变体：<id>@fast / <id>@standard / <id>@deep
function variantIds(m) {
  // 上下文/输出在这里就解析好：上游只给 id+name，数值一律查规格表
  const spec = specOf(m.id);
  const context = m.context ?? spec.context;
  const output = m.output ?? spec.output;
  return TIERS.map((t) => ({
    id: `${m.id}@${t}`,
    name: `${m.name ?? m.id} · ${TIER_LABEL[t]}`,
    context,
    output,
  }));
}

function configModel(m) {
  const spec = specOf(m.id);
  return {
    name: m.name ?? m.id,
    limit: { context: m.context ?? spec.context, output: m.output ?? spec.output },
    // Meoo 协议里没有 tools，如实标 false，免得客户端以为能函数调用
    tool_call: false,
  };
}

function runtimeModel(m) {
  const spec = specOf(m.id);
  return {
    id: m.id,
    providerID: ID,
    name: m.name ?? m.id,
    api: { id: m.id, url: API, npm: CHAT },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? spec.context, output: m.output ?? spec.output },
    capabilities: {
      temperature: false,          // Meoo 不收 temperature
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
  };
}

// ---- Meoo REST ----------------------------------------------------------------

async function meoo(key, path, { method = "GET", body, headers = {}, signal } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...CLIENT_HEADER,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const detail = json?.detail || json?.message || text.slice(0, 300);
    const err = new Error(`Meoo ${method} ${path} -> ${res.status} ${json?.code ?? ""} ${detail}`.trim());
    err.status = res.status;
    err.traceId = res.headers.get("x-meoo-trace-id");
    throw err;
  }
  return json;
}

// 项目按 key 缓存：同一个 key 复用同名项目，不重复建
const projectByKey = new Map();

function ensureProject(key) {
  const hit = projectByKey.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      const list = await meoo(key, "/projects?page_size=100");
      const found = (list?.projects ?? []).find((x) => x.name === PROJECT_NAME && x.type === "web");
      if (found) { log("复用项目", found.url_id); return found.url_id; }
    } catch (e) { log("列项目失败，改为创建：", e.message); }
    const made = await meoo(key, "/projects", { method: "POST", body: { name: PROJECT_NAME, type: "web" } });
    log("已创建项目", made.url_id);
    return made.url_id;
  })();
  p.catch(() => projectByKey.delete(key));
  projectByKey.set(key, p);
  return p;
}

let capCache = { at: 0, key: "", value: null };

async function capabilities(key, projectId) {
  if (capCache.value && capCache.key === key && Date.now() - capCache.at < 5 * 60 * 1000) return capCache.value;
  const cap = await meoo(key, `/projects/${encodeURIComponent(projectId)}/agent/capabilities`);
  capCache = { at: Date.now(), key, value: cap };
  return cap;
}

// ---- SSE ----------------------------------------------------------------------

// ---- 网页控制面（积分 / 有效期）-----------------------------------------------

// entitlement/get 是 Meoo 唯一同时给出「真实积分余额」与「周期到期时刻」的接口。
// 它只接受 CLI 身份（见 CLIENT_HEADER），返回 {success,data:{...}}。
async function web(key, path, { signal } = {}) {
  const res = await fetch(WEB + path, { headers: { Authorization: `Bearer ${key}`, ...CLIENT_HEADER }, signal });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const err = new Error(json?.error?.message || json?.detail || `Meoo ${path} -> ${res.status}`);
    err.status = res.status;
    err.code = json?.error?.code || json?.code;
    throw err;
  }
  return json;
}

// Meoo 的 401 文案不总是给用户看的（写过格式不对的 key 时它回
// NEED_LOGIN /「未登录」，看起来像插件没登录，其实是 key 本身不被接受）。
// 带上错误码，至少让用户知道该去换一把 key 而不是怀疑插件。
function rejectText(e) {
  const message = e?.message || "Meoo 拒绝了这把 API Key";
  return e?.code ? `${message}（${e.code}）` : message;
}

// Meoo 给的时间是**不带时区的北京时间串**（"2026-12-19T00:00:00"）。
// 直接 Date.parse 会按「运行环境的本地时区」解释 —— 网关跑在容器里通常是
// UTC，于是 12-19 00:00 会被算成北京时间 12-19 08:00，到期日整整晚 8 小时，
// 23:59:59 那几份还会跨到第二天，和标签上的日期对不上。所以这里显式补
// +08:00，让结果与宿主、与用户看到的中文时间一致，且不依赖进程 TZ。
const CN_OFFSET = 8 * 60 * 60 * 1000;
const NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function millis(value) {
  let raw;
  if (typeof value === "string") {
    const s = value.trim();
    raw = Date.parse(NAIVE.test(s) ? `${s}+08:00` : s);
  } else raw = Number(value);
  return Number.isFinite(raw) && raw > 0 && raw <= 8.64e15 ? raw : 0;
}

// 到期时刻的取值优先级：
//   activeGrants 里最晚的 expiresDate（真正会到期的那份积分）
//   → currentPeriodEnd（本周期结束）
//   → 0（不报）
// activatedEndTime 恒为 9999-12-31（免费版不过期），永远不能拿来当有效期。
function expiryOf(data) {
  let latest = 0;
  for (const grant of data?.userPointInfo?.activeGrants ?? []) {
    for (const detail of grant?.grantDetails ?? []) {
      const at = millis(detail?.expiresDate);
      if (at > latest) latest = at;
    }
  }
  if (!latest) latest = millis(data?.currentPeriodEnd);
  return latest;
}

// WorkBuddy 式倒计时只认 credits[].expireAt（毫秒绝对时刻）。
// Meoo 的余额是 account.availableBalance，逐份积分在 activeGrants[].grantDetails[]；
// 不把总余额再复制成一条 credits 行，避免与真实批次重复计时。
function expiryCreditsOf(data) {
  const rows = [];
  for (const grant of data?.userPointInfo?.activeGrants ?? []) {
    const label = grant?.sourceTypeName || grant?.sourceType || "积分";
    for (const detail of grant?.grantDetails ?? []) {
      const remain = Number(detail?.remainingAmount);
      const expireAt = millis(detail?.expiresDate);
      if (!Number.isFinite(remain) || remain <= 0 || !expireAt) continue;
      rows.push({ name: String(label), remain, unit: "积分", expireAt });
    }
  }
  if (!rows.length) {
    const remain = Number(data?.userPointInfo?.account?.availableBalance);
    const expireAt = millis(data?.currentPeriodEnd);
    if (Number.isFinite(remain) && remain > 0 && expireAt) {
      rows.push({ name: "积分余额", remain, unit: "积分", expireAt });
    }
  }
  return rows;
}

async function identify(key, signal) {
  try {
    const me = await web(key, "/api/v1/user/me", { signal });
    const d = me?.data ?? {};
    return { uid: d.id ? String(d.id) : "", email: d.email ?? "", name: d.name ?? "" };
  } catch (e) {
    log("取用户信息失败：", e.message);
    return {};
  }
}

// 登录时用一次 entitlement 校验 key 并把到期时刻落进账号记录。
// 落在 secret 的 expiresAt（而不是 expires）是因为网关落库走
// plugin_public.rs 的白名单键名 EXPIRY_KEYS，只认 expiresAt 这一族；
// 前端「有效期」列读的正是公开形态里的 expiresAt。
async function authorize(inputs, { signal } = {}) {
  const key = typeof inputs?.key === "string" ? inputs.key.trim() : "";
  if (!key) return { type: "failed", error: "请填写 Meoo API Key" };
  let data;
  try {
    const body = await web(key, "/api/mc/entitlement/get", { signal });
    if (body?.success === false) {
      return { type: "failed", error: body?.error?.message || "Meoo 未接受这把 API Key" };
    }
    data = body?.data ?? {};
  } catch (e) {
    // 401 是「key 不对」，其余（网络、5xx）不该把用户的 key 判死：
    // 仍然允许保存，只是这次拿不到有效期。
    if (e?.status === 401 || e?.status === 403) {
      return { type: "failed", error: rejectText(e) };
    }
    log("登录期查询权益失败，先保存凭据：", e.message);
    const who = await identify(key, signal);
    return { type: "success", key, ...who };
  }
  const who = await identify(key, signal);
  const expires = expiryOf(data);
  return {
    type: "success", key, ...who,
    metadata: { planName: data?.planName ?? "" },
    ...(expires ? { expires, expiresAt: expires } : {}),
  };
}

async function* sseFrames(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = buf.match(/\r?\n\r?\n/))) {
      const frame = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
    }
  }
  if (buf.trim()) { const p = parseFrame(buf); if (p) yield p; }
}

function parseFrame(frame) {
  let event = "message";
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;      // 心跳注释帧
    const c = line.indexOf(":");
    const field = c === -1 ? line : line.slice(0, c);
    let val = c === -1 ? "" : line.slice(c + 1);
    if (val.startsWith(" ")) val = val.slice(1);
    if (field === "event") event = val;
    else if (field === "data") data.push(val);
  }
  if (!data.length) return null;
  const raw = data.join("\n");
  let json = null;
  try { json = JSON.parse(raw); } catch { json = { _raw: raw }; }
  return { event, data: json };
}

// ---- 跑一次 Run ---------------------------------------------------------------

const TERMINAL = new Set(["run.completed", "run.failed", "run.canceled", "run.interrupted"]);

async function handleAction(key, projectId, data, signal) {
  if (!AUTO_ANSWER) {
    throw new Error(`Agent 请求交互，但 MEOO_AUTO_ANSWER 为空：${data?.action?.prompt ?? ""}`);
  }
  if (!data?.action) {
    throw new Error(`Agent 阻塞在无法自动回复的交互上：${data?.detail ?? "unsupported_action"}`);
  }
  const { action_id, kind, prompt, input_schema } = data.action;
  let response;
  if (kind === "confirmation") {
    response = { confirmation: true };
  } else {
    const props = Object.keys(input_schema?.properties ?? {});
    const req = Array.isArray(input_schema?.required) ? input_schema.required : [];
    const use = (req.length ? req : props).slice(0, 4);
    if (!use.length) use.push("answer");
    response = { answers: Object.fromEntries(use.map((k) => [k, AUTO_ANSWER])) };
  }
  log(`自动回复 Action(${kind})：${prompt ?? ""}`.slice(0, 120));
  await meoo(key, `/projects/${encodeURIComponent(projectId)}/agent/action-responses`, {
    method: "POST", body: { action_id, response }, signal,
  });
}

async function drive(key, projectId, runId, signal, onDelta) {
  let text = "";        // 权威全文
  let emitted = "";     // 已经吐出去的
  const seen = new Set();
  let credits = 0n;
  let failure = null;
  let current = runId;

  for (;;) {
    const url = `${API}/projects/${encodeURIComponent(projectId)}/agent/runs/${encodeURIComponent(current)}/events`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, ...CLIENT_HEADER, Accept: "text/event-stream" }, signal,
    });

    if (res.status === 429) {
      const wait = (Number(res.headers.get("retry-after") || 60) + Math.random() * 5) * 1000;
      log(`SSE 限流，${Math.round(wait / 1000)}s 后重连`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`SSE ${res.status}: ${(await res.text()).slice(0, 200)}`);

    let next = null;
    for await (const { event, data } of sseFrames(res)) {
      if (event === "message.delta" && typeof data.delta === "string") {
        text += data.delta; emitted += data.delta; onDelta?.(data.delta);
      } else if (event === "message.snapshot" && typeof data.content === "string") {
        text = data.content;
        if (data.content.startsWith(emitted)) {
          const add = data.content.slice(emitted.length);
          if (add) { emitted = data.content; onDelta?.(add); }
        } else {
          log("snapshot 与已发送内容不一致，跳过增量修正（非流式不受影响）");
          emitted = data.content;
        }
      } else if (event === "run.usage") {
        if (data.usage_id && !seen.has(data.usage_id)) {
          seen.add(data.usage_id);
          try { credits += BigInt(data.credits_used || "0"); } catch {}
        }
      } else if (event === "run.input_required") {
        await handleAction(key, projectId, data, signal);
      } else if (event === "run.superseded") {
        if (data.current_run_id) next = data.current_run_id;
      } else if (event === "run.failed") {
        failure = data?.error?.message || data?.detail || "run failed";
      } else if (event === "run.interrupted") {
        failure = "run interrupted";
      }
      if (TERMINAL.has(event)) break;
    }
    if (next) { current = next; continue; }
    break;
  }
  if (failure) throw new Error(failure);
  return { text, credits: credits.toString() };
}

// ---- 余额 / 有效期（auth.usage 的返回形状）-------------------------------------

function usageOf(data) {
  // 只报一条胶囊（与 WorkBuddy/AutoClaw 相同口径）：顶层 balance -> 宿主
  // available，外加 credits[] 到期批次。不报 windows[]/plan —— 报了就会触发
  // UI 的「分窗口额度」分支和「额度充足/领取明细」弹层（用户 m04153 明确不要）。
  // 限流兜底照旧走上游 429（WorkBuddy/AutoClaw 同样不报 windows）。
  const account = data?.userPointInfo?.account ?? {};
  const balance = Number.isFinite(account.availableBalance) ? account.availableBalance : null;

  // 顶层 balance 才是「可用合计」的取数口：宿主 reports.mjs:37 把 value.balance 归一成
  // available（脚本插件拿不到 Rust 侧那条 totalLeft），前端 accounts-usage-group.tsx:104
  // 用 totalLeft ?? available 决定这一组是「可用合计（绝对值求和）」还是「可用最低（比例）」。
  // 主余额读不到时才退到「逐份积分剩余之和」，两者都不伪造。
  const total = balance !== null
    ? balance
    : (() => {
        let sum = 0, found = false;
        for (const grant of data?.userPointInfo?.activeGrants ?? []) {
          for (const detail of grant?.grantDetails ?? []) {
            if (Number.isFinite(detail?.remainingAmount)) { sum += detail.remainingAmount; found = true; }
          }
        }
        return found ? sum : null;
      })();

  if (total === null) {
    return { empty: true, emptyText: "Meoo 没有返回积分余额" };
  }

  const credits = expiryCreditsOf(data);
  return {
    balance: total,
    unit: "积分",
    ...(credits.length ? { credits } : {}),
  };
}

async function usage(getAuth, sync) {
  const auth = await getAuth();
  if (!auth) return { signIn: "expired", error: "meoo-agent：未登录" };
  if (auth.type === "oauth") {
    try {
      const points = await controlCall(auth, "/open/v1/cli-compat/account/points");
      const acc = points?.account ?? {};
      const left = Number(acc.availableBalance);
      const grants = Array.isArray(points?.activeGrants) ? points.activeGrants : [];
      const upcoming = grants
        .flatMap((g) => Array.isArray(g?.grantDetails) && g.grantDetails.length ? g.grantDetails : [g])
        .map((d) => millis(d?.expireTime ?? d?.expiresAt ?? d?.expiryAt ?? d?.endAt ?? d?.expiresDate))
        .filter((n) => Number.isFinite(n) && n > Date.now())
        .sort((a, b) => a - b)[0];
      const credits = [];
      for (const g of grants) {
        const label = g?.sourceTypeName || g?.sourceType || "积分";
        const details = Array.isArray(g?.grantDetails) && g.grantDetails.length ? g.grantDetails : [g];
        for (const d of details) {
          const remain = Number(d?.remainingAmount ?? d?.remain ?? d?.balance);
          const expireAt = millis(d?.expireTime ?? d?.expiresAt ?? d?.expiryAt ?? d?.endAt ?? d?.expiresDate);
          if (!Number.isFinite(remain) || remain <= 0 || !expireAt) continue;
          credits.push({ name: String(label), remain, unit: "积分", expireAt });
        }
      }
      const report = {
        ...(Number.isFinite(left) ? { balance: left, unit: "积分" } : {}),
        ...(credits.length ? { credits } : {}),
      };
      const who = await oauthIdentity(auth.access || auth.refresh || "");
      if (upcoming) await sync?.(upcoming, who);
      return { ...report, ...(who.name || who.email ? { user: who.name || who.email } : {}) };
    } catch (e) {
      if (e?.signIn === "expired" || e?.status === 401) return { signIn: "expired", error: e.message };
      return { error: `Meoo 积分查询失败：${e.message}` };
    }
  }
  if (auth.type !== "api" || !auth.key) return { signIn: "expired", error: "meoo-agent：未登录" };
  let body;
  try {
    body = await web(auth.key, "/api/mc/entitlement/get");
  } catch (e) {
    // 401 = key 被吊销/过期：让网关把账号标成「需重新登录」，而不是一条普通查询失败。
    if (e?.status === 401) return { signIn: "expired", error: rejectText(e) };
    return { error: `Meoo 权益查询失败：${e.message}` };
  }
  if (body?.success === false) return { error: body?.error?.message || "Meoo 未返回权益" };
  const data = body?.data ?? {};
  const report = usageOf(data);
  const who = await identify(auth.key);
  await sync?.(expiryOf(data), who);
  return { ...report, ...(who.name || who.email ? { user: who.name || who.email } : {}) };
}

// ---- chat completion ⇄ Meoo ----------------------------------------------------

function flatten(messages) {
  return (messages ?? []).map((m) => {
    let c = m.content;
    if (Array.isArray(c)) c = c.map((p) => (p?.type === "text" ? p.text : `[${p?.type ?? "非文本"}]`)).join("\n");
    const label = m.role === "system" ? "系统指令" : m.role === "assistant" ? "助手" : "用户";
    return `[${label}]\n${c ?? ""}`;
  }).join("\n\n");
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status, message) {
  return jsonResponse({ error: { message, type: "upstream_error" } }, status);
}

async function translate(key, chat, signal) {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  if (!messages.length) return errorResponse(400, "messages 不能为空");

  // 客户端发来的可能带 @档位：qwen3.8-flash@deep
  const requested = typeof chat.model === "string" && chat.model ? chat.model : "auto@fast";
  const { model, tier } = splitTier(requested);
  const created = Math.floor(Date.now() / 1000);
  const id = "chatcmpl-" + Math.random().toString(36).slice(2, 14);

  const projectId = await ensureProject(key);
  const started = await meoo(key, `/projects/${encodeURIComponent(projectId)}/agent/runs`, {
    method: "POST",
    headers: { "Idempotency-Key": `magpie_${Date.now()}_${Math.random().toString(36).slice(2, 10)}` },
    body: { message: flatten(messages), model, speed_tier: tier },
    signal,
  });
  const runId = started?.run_id ?? started?.id;
  if (!runId) throw new Error(`启动 Run 未返回 run_id：${JSON.stringify(started).slice(0, 200)}`);

  log(`→ run model=${model} tier=${tier} chars=${flatten(messages).length}`);

  const ac = new AbortController();
  if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  ac.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  if (chat.stream === true) {
    const enc = new TextEncoder();
    const chunk = (delta, finish = null, usage) => ({
      id, object: "chat.completion.chunk", created, model: requested,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });
    const stream = new ReadableStream({
      async start(ctl) {
        try {
          const r = await drive(key, projectId, runId, ac.signal, (d) => {
            ctl.enqueue(enc.encode("data: " + JSON.stringify(chunk({ content: d })) + "\n\n"));
          });
          ctl.enqueue(enc.encode("data: " + JSON.stringify(chunk({}, "stop", {
            prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
            meoo_credits_used: r.credits,
          })) + "\n\n"));
          ctl.enqueue(enc.encode("data: [DONE]\n\n"));
        } catch (e) {
          ctl.enqueue(enc.encode("data: " + JSON.stringify({ error: { message: e.message } }) + "\n\n"));
        }
        ctl.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  const r = await drive(key, projectId, runId, ac.signal, undefined);
  log(`← done credits=${r.credits} chars=${r.text.length}`);
  return jsonResponse({
    id, object: "chat.completion", created, model: requested,
    choices: [{ index: 0, message: { role: "assistant", content: r.text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      meoo_credits_used: r.credits,     // 非标准：Meoo 按积分结算
    },
  });
}

// ---- 插件 ---------------------------------------------------------------------

export async function MeooPlugin({ client } = {}) {
  // 只有 usage.query 这类「有账号上下文」的调用才允许把新到期时刻写回账号：
  // 登录期（account.normalize）没有账号，宿主的 setAuth 只会写进内存上下文。
  //
  // 两个键都写：网关落库（plugin_public.rs 的 EXPIRY_KEYS 白名单）只认
  // expiresAt 这一族；而宿主 JS 侧的 publicAccount() 只认 expires。
  // 少写任何一个，都会有一侧的「有效期」变成「—」。
  // name 也必须一起回写：宿主 publicAccount() 的名字取值顺序是
  // name → email → accountId → uid，凭据里没有 name 时「有效期」列旁的账号名
  // 会退化成 uid（一串数字）。回写 name 才能让它显示成 Meoo 上的昵称。
  const saveExpiry = async (expiresAt, who) => {
    if (!client?.auth?.set) return;
    const name = who?.name || "";
    const uid = who?.uid || "";
    if (!expiresAt && !name) return;
    try {
      const current = (await client.auth.get({}))?.data;
      if (!current?.key) return;
      const same = (!expiresAt || (current.expiresAt === expiresAt && current.expires === expiresAt))
        && (!name || current.name === name)
        && (!uid || current.uid === uid);
      if (same) return;
      await client.auth.set({
        // id 必须是本 provider 的 originalID：分配出的 id 可能带 -plugin 后缀。
        id: ID,
        body: {
          ...current,
          ...(expiresAt ? { expires: expiresAt, expiresAt } : {}),
          ...(name ? { name } : {}),
          ...(uid ? { uid } : {}),
        },
      });
    } catch (e) {
      log("写回账号信息失败：", e.message);
    }
  };

  return {
    auth: {
      provider: ID,
      // 让脚本宿主在 /api/session 的 accountFeatures 中下发积分明细/倒计时能力。
      credit_detail: true,
      credit_expiry: true,
      // 新镜像宿主从 accountFeatures 读取；两边都声明以兼容新旧宿主。
      accountFeatures: { creditDetail: true, creditExpiry: true },
      // 宿主的 loader.mjs:102 `icon(hooks.auth.icon)` 收下它；内嵌 data: 走
      // icons/formats.rs 的 inline()，解 base64 + 验魔数 + 按 sha256 落盘，
      // 全程不碰 DNS。前端从 /api/session 的 providerIcons 拿到
      // /plugins/script-icons/<hash>.png。
      icon: ICON,
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        // Agent Run endpoints still require the user API Key. An OAuth account carries it
        // alongside access/refresh fields so the same provider can use both credential domains.
        const key = auth.key;
        if (!key) return {};
        return {
          baseURL: API,
          apiKey: key,
          headers: { ...CLIENT_HEADER },
          // 只有 chat completions 需要改写；其余请求（如列模型）原样放过
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (!/\/chat\/completions$/.test(new URL(url).pathname)) return fetch(input, init);
            const live = (await getAuth()) ?? auth;
            if (!live?.key) return errorResponse(401, "meoo-agent：未登录");
            let chat;
            try {
              const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined);
              chat = JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b));
            } catch {
              return errorResponse(400, "meoo-agent：请求体不是 JSON");
            }
            try {
              return await translate(live.key, chat, init.signal);
            } catch (e) {
              const status = e.status >= 400 && e.status < 600 ? e.status : 502;
              return errorResponse(status, e.message);
            }
          },
        };
      },
      // 网关在 usage.query 里先 refresh（对 api key 是 no-op），再调这里；
      // 结果经 reports.mjs 归一化成余额格 / 有效期列要的形状。
      usage: (getAuth) => usage(getAuth, saveExpiry),
      // Host refreshes OAuth accounts shortly before access-token expiry. This keeps the
      // stored refresh token current and lets point reads continue after a browser login.
      refreshLead: REFRESH_LEAD_MS,
      async refresh(auth) {
        if (auth?.type !== "oauth" || !auth.refresh) return undefined;
        try {
          const next = await renewOAuth(auth, { force: true });
          return {
            access: next.access,
            refresh: next.refresh,
            expires: next.expires,
            ...(next.scope ? { scope: next.scope } : {}),
            ...(next.openid ? { openid: next.openid } : {}),
          };
        } catch (e) {
          if (e?.signIn === "expired") e.signIn = "expired";
          throw e;
        }
      },
      methods: [
        {
          type: "oauth",
          label: "浏览器授权登录（含 API key，推荐）",
          prompts: [{
            type: "password",
            key: "key",
            message: "Meoo API Key（meoo_ak_…，用于建站 Agent）",
            placeholder: "meoo_ak_…",
          }],
          authorize: browserOAuth,
        },
        {
          type: "api",
          label: "API key（meoo.com → 设置 → API 密钥）",
          // 登录即校验：key 无效当场拒绝；有效则把套餐到期时刻一起写进凭据。
          authorize,
        },
      ],
    },

    async config(config) {
      config.provider ??= {};
      const was = config.provider[ID] ?? {};
      config.provider[ID] = {
        name: "Meoo · zp",
        npm: CHAT,
        api: API,
        ...was,
        models: {
          // 每个模型挂三个档位变体：<id>@fast / <id>@standard / <id>@deep
          ...Object.fromEntries(
            MODELS.flatMap((m) => variantIds(m).map((v) => [v.id, configModel(v)])),
          ),
          ...(was.models ?? {}),
        },
      };
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const toVariants = (list) => Object.fromEntries(
          list.flatMap((m) => variantIds(m).map((v) => [v.id, runtimeModel(v)])),
        );
        const fallback = () => Object.assign(toVariants(MODELS), { [FELL_BACK]: true });
        if (!auth?.key) return fallback();
        try {
          const pid = await ensureProject(auth.key);
          const cap = await capabilities(auth.key, pid);
          const list = cap?.models ?? [];
          if (!list.length) return fallback();
          // 上游只给 {id, name}：名字用上游的（品牌写法以它为准），数值走 specOf(id)
          return toVariants(list.map((m) => ({ id: m.id, name: m.name ?? m.id })));
        } catch (e) {
          log("取模型目录失败，用兜底清单：", e.message);
          return fallback();
        }
      },
    },
  };
}

export const _internal = {
  parseFrame, flatten, splitTier, variantIds, specOf, specKey, MODELS, SPEC, TIERS, ID, API, WEB,
  expiryOf, expiryCreditsOf, millis, usageOf, CLIENT_HEADER,
};