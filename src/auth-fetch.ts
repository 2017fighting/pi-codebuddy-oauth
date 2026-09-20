// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/auth-fetch.ts — 平移自 opencode-codebuddy-oauth，改造为 Pi 版：
// 1. 删除 SSE 缓冲（pi-ai 原生解析 SSE，无 opencode UI 碎片化问题）
// 2. 删除本地 token 快照与流中 401 兜底刷新：token 每流由 Pi host 注入
//    （options.apiKey → Authorization 头），过期预刷新由 Pi 原生托管
//    （auth-storage 带锁刷新，5 分钟 skew）；流中途过期直接透传错误，
//    Pi 在下一流前自动刷新自愈
// 3. 11133 瞬时 400 退避重发保留
// 4. 首次观察到有效凭据时触发懒模型发现（替代原先基于快照的启动 eager 发现）
import type { AuthState } from "./auth-state.js";
import type { CodeBuddyConfig } from "./config.js";
import type { Logger } from "./log.js";

export type AuthFetchDeps = {
  /** 从 host 注入的请求头解析鉴权；null = 未认证 */
  resolveAuth: (headers: HeadersInit | undefined) => AuthState | null;
  server: { url: string; domain: string };
  buildAuthHeaders: (auth: AuthState, identity: { tenantId:string; enterpriseId:string; userId:string }) => Record<string,string>;
  resolveIdentity: (payload: unknown, cfg: unknown) => { tenantId:string; enterpriseId:string; userId:string };
  decodeJwtPayload: (token:string) => unknown;
  cfg: CodeBuddyConfig;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  chatCompletionsPath: string;
  /** 未认证 401 的指引文案（含 provider id 与对应 env 变量名） */
  authHint: string;
  /** 观察到新 token 时回调（触发懒模型发现）；同一 token 至多回调一次 */
  onAuth?: (auth: AuthState) => void;
};

export function createAuthFetch(deps: AuthFetchDeps) {
  const { resolveAuth, server, buildAuthHeaders, resolveIdentity, decodeJwtPayload, cfg, fetchImpl, chatCompletionsPath } = deps;
  const doFetch = () => fetchImpl ?? globalThis.fetch;
  let lastNotifiedToken = "";

  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();
    if (!urlStr.includes(chatCompletionsPath)) return doFetch()(url, init);
    const auth = resolveAuth(init?.headers);
    if (!auth) {
      // 不抛异常：OpenAI SDK 会把 fetch 抛错包装成 "Connection error" 丢失信息；
      // 返回 401 Response 走 SDK 标准错误路径，message 保留我们的指引
      return new Response(JSON.stringify({ error: { message: `codebuddy: not authenticated — ${deps.authHint}` } }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    if (!init?.body) return new Response(JSON.stringify({ error: "Missing request body" }), { status: 400, headers: { "Content-Type": "application/json" } });

    const token = auth.type === "oauth" ? auth.access : auth.key;
    if (token !== lastNotifiedToken) {
      lastNotifiedToken = token;
      deps.onAuth?.(auth);
    }

    const doRequest = async (a: AuthState): Promise<Response> => {
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

    let response = await doRequest(auth);
    // 流中途 401/403 不再本地刷新：错误透传，Pi 在下一流前对 auth.json 带锁预刷新自愈
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
      response = await doRequest(auth);
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
