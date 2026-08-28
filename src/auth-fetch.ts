// src/auth-fetch.ts — 平移自 opencode-codebuddy-oauth，改造为 Pi 版：
// 1. 删除 SSE 缓冲（pi-ai 原生解析 SSE，无 opencode UI 碎片化问题）
// 2. 删除预刷新（Pi resolveStoredOAuth 原生 5min skew 预刷新 + 双检锁）
// 3. 401/403 刷新经 refreshAndPersist 回调落地到 Pi CredentialStore（由 index.ts 接线）
// 4. 11133 瞬时 400 退避重发保留
import type { AuthState } from "./auth-state.js";
import type { CodeBuddyConfig } from "./config.js";
import type { Logger } from "./log.js";
import type { TokenPair } from "./auth-flow.js";

export type AuthFetchDeps = {
  getAuth: () => Promise<AuthState | null>;
  server: { url: string; domain: string };
  buildAuthHeaders: (auth: AuthState, identity: { tenantId:string; enterpriseId:string; userId:string }) => Record<string,string>;
  resolveIdentity: (payload: unknown, cfg: unknown) => { tenantId:string; enterpriseId:string; userId:string };
  decodeJwtPayload: (token:string) => unknown;
  refreshAndPersist: (oauthAuth: AuthState & { type:"oauth" }) => Promise<AuthState | null>;
  cfg: CodeBuddyConfig;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  chatCompletionsPath: string;
};

export function createAuthFetch(deps: AuthFetchDeps) {
  const { getAuth, server, buildAuthHeaders, resolveIdentity, decodeJwtPayload, refreshAndPersist, cfg, fetchImpl, chatCompletionsPath } = deps;
  const doFetch = () => fetchImpl ?? globalThis.fetch;
  let lastRefreshFailedAt = 0;
  const COOLDOWN_MS = 15_000;
  const inCooldown = () => Date.now() - lastRefreshFailedAt < COOLDOWN_MS;

  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();
    if (!urlStr.includes(chatCompletionsPath)) return doFetch()(url, init);
    const auth = await getAuth();
    if (!auth) {
      // 不抛异常：OpenAI SDK 会把 fetch 抛错包装成 "Connection error" 丢失信息；
      // 返回 401 Response 走 SDK 标准错误路径，message 保留我们的指引
      return new Response(JSON.stringify({ error: { message: "codebuddy: not authenticated — run `/login codebuddy` (oauth) or set CODEBUDDY_API_KEY" } }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    if (!init?.body) return new Response(JSON.stringify({ error: "Missing request body" }), { status: 400, headers: { "Content-Type": "application/json" } });

    const doRequest = async (a: AuthState) => {
      const headers = new Headers(init.headers as HeadersInit);
      const identity = a.type === "oauth" ? resolveIdentity(decodeJwtPayload(a.access), cfg) : { tenantId:"", enterpriseId:"", userId:"" };
      for (const [k,v] of Object.entries(buildAuthHeaders(a, identity))) headers.set(k, v);
      let body: BodyInit | null | undefined = init.body as BodyInit;
      // 仅处理字符串 JSON body；其他类型（Stream/FormData/Blob）跳过解析直接透传
      if (typeof body === "string") {
        try {
          const parsed = JSON.parse(body);
          if (parsed.stream === true && !parsed.stream_options) { parsed.stream_options = { include_usage: true }; body = JSON.stringify(parsed); }
        } catch {}
      }
      return doFetch()(`${server.url}${chatCompletionsPath}`, { method: "POST", headers, body: body as BodyInit, signal: init.signal });
    };

    let activeAuth: AuthState = auth;
    let response = await doRequest(activeAuth);
    if (activeAuth.type === "oauth" && (response.status === 401 || response.status === 403) && activeAuth.refresh && !inCooldown()) {
      const next = await refreshAndPersist(activeAuth);
      if (next) {
        activeAuth = next;
        response = await doRequest(activeAuth);
      }
    }
    // 瞬时 400（code 11133）重试：CodeBuddy 网关偶发把上游厂商的瞬时校验失败包装成 11133 返回
    // （服务端侧故障窗口，同构请求稍后重发即成功）。body 为字符串 JSON 可幂等重发；400 到达即流未开始。
    const TRANSIENT_400_RETRIES = 4;
    const RETRY_DELAYS_MS = [1000, 4000, 10000, 25000];
    for (let attempt = 0; response.status === 400 && attempt < TRANSIENT_400_RETRIES; attempt++) {
      const text = await response.text();
      let code: unknown;
      try { code = (JSON.parse(text) as any)?.code; } catch {}
      if (code !== 11133) {
        const h = new Headers(response.headers);
        h.set("Content-Type", "application/json");
        return new Response(text, { status: 400, headers: h });
      }
      if (init.signal?.aborted) break;
      deps.logger?.warn(`upstream transient 400 (11133), retry ${attempt + 1}/${TRANSIENT_400_RETRIES}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]));
      if (init.signal?.aborted) break;
      response = await doRequest(activeAuth);
    }
    if (!response.ok) {
      const text = await response.text();
      const h = new Headers(response.headers);
      h.set("Content-Type", "application/json");
      return new Response(text, { status: response.status, headers: h });
    }
    return response;
  };
}
