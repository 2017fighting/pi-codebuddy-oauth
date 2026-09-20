// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/auth-state.ts — 请求期鉴权解析
//
// token 来源：Pi host 每流注入的 Authorization Bearer。
// 链路：modelRegistry.getApiKeyAndHeaders（读 Pi auth.json，过期时带锁刷新）
//   → streamSimple(options.apiKey) → openai-completions 转成 Authorization 头
//   → 本扩展的 fetch 拦截器从 init.headers 里读回。
// 不再维护本地 token 快照：唯一事实源是 Pi 的 auth.json（按 provider id 各存一份）。
import type { CodeBuddyConfig } from "./config.js";

export type AuthState = { type:"api"; key:string } | { type:"oauth"; access:string };

/** registerProvider 的 apiKey 占位值：未登录且无 env key 时 host 注入的就是它 */
export const PLACEHOLDER_API_KEY = "not-used";

export function bearerToken(headers: HeadersInit | undefined): string | null {
  const h = headers instanceof Headers ? headers : new Headers(headers);
  const auth = h.get("Authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  const token = m ? m[1].trim() : null;
  return token || null;
}

/** 三段 base64url 且 payload 可解码为对象 → JWT（OAuth token 是 JWT；`ck_` API key 不是） */
export function looksLikeJwt(token: string, decodeJwtPayload: (token: string) => unknown): boolean {
  if (token.split(".").length !== 3) return false;
  try { const payload = decodeJwtPayload(token); return typeof payload === "object" && payload !== null; } catch { return false; }
}

/**
 * 从 host 注入的请求头解析鉴权：
 * - CODEBUDDY*_AUTH=api 或设了 *_API_KEY → api 模式（env key 优先）
 * - Bearer 是占位符 / 缺失 → null（未认证）
 * - Bearer 是 JWT → oauth 模式；否则（如 Pi auth.json 里存的 ck_ key）→ api 模式
 */
export function resolveAuth(
  headers: HeadersInit | undefined,
  cfg: Pick<CodeBuddyConfig, "auth" | "apiKey">,
  decodeJwtPayload: (token: string) => unknown,
): AuthState | null {
  if (cfg.auth === "api") return cfg.apiKey ? { type:"api", key: cfg.apiKey } : null;
  if (cfg.apiKey) return { type:"api", key: cfg.apiKey };
  const token = bearerToken(headers);
  if (!token || token === PLACEHOLDER_API_KEY) return null;
  if (cfg.auth === "oauth") return { type:"oauth", access: token };
  return looksLikeJwt(token, decodeJwtPayload) ? { type:"oauth", access: token } : { type:"api", key: token };
}
