import { describe, it, expect } from "vitest";
import { bearerToken, looksLikeJwt, resolveAuth, PLACEHOLDER_API_KEY } from "../src/auth-state.js";
import { decodeJwtPayload } from "../src/jwt.js";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
const JWT = `h.${b64url({ tenantId: "t", uid: "u" })}.s`;

describe("bearerToken", () => {
  it("从 HeadersInit（数组/对象/Headers）提取 Bearer", () => {
    expect(bearerToken({ Authorization: `Bearer ${JWT}` })).toBe(JWT);
    expect(bearerToken([["Authorization", `bearer ${JWT}`]] as HeadersInit)).toBe(JWT);
    expect(bearerToken(new Headers({ Authorization: `Bearer ${JWT}` }))).toBe(JWT);
  });
  it("缺失或非 Bearer 返回 null", () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken({})).toBeNull();
    expect(bearerToken({ Authorization: "Basic abc" })).toBeNull();
  });
});

describe("looksLikeJwt", () => {
  it("三段且 payload 可解码 → true", () => {
    expect(looksLikeJwt(JWT, decodeJwtPayload)).toBe(true);
  });
  it("ck_ key / 两段 / payload 非 JSON → false", () => {
    expect(looksLikeJwt("ck_xxx", decodeJwtPayload)).toBe(false);
    expect(looksLikeJwt("a.b", decodeJwtPayload)).toBe(false);
    expect(looksLikeJwt("a.###.c", decodeJwtPayload)).toBe(false);
  });
});

describe("resolveAuth", () => {
  it("占位符 / 缺头 → null（未认证）", () => {
    expect(resolveAuth({ Authorization: `Bearer ${PLACEHOLDER_API_KEY}` }, { auth: "auto", apiKey: "" }, decodeJwtPayload)).toBeNull();
    expect(resolveAuth(undefined, { auth: "auto", apiKey: "" }, decodeJwtPayload)).toBeNull();
  });
  it("env api key（auto 模式）→ api", () => {
    expect(resolveAuth({ Authorization: `Bearer ${JWT}` }, { auth: "auto", apiKey: "ck_env" }, decodeJwtPayload))
      .toEqual({ type: "api", key: "ck_env" });
  });
  it("auth=api 无 key → null", () => {
    expect(resolveAuth({ Authorization: `Bearer ${JWT}` }, { auth: "api", apiKey: "" }, decodeJwtPayload)).toBeNull();
  });
  it("JWT bearer → oauth", () => {
    expect(resolveAuth({ Authorization: `Bearer ${JWT}` }, { auth: "auto", apiKey: "" }, decodeJwtPayload))
      .toEqual({ type: "oauth", access: JWT });
  });
  it("非 JWT bearer（Pi auth.json 存的 ck_ key）→ api", () => {
    expect(resolveAuth({ Authorization: "Bearer ck_stored" }, { auth: "auto", apiKey: "" }, decodeJwtPayload))
      .toEqual({ type: "api", key: "ck_stored" });
  });
  it("auth=oauth 强制按 oauth 处理", () => {
    expect(resolveAuth({ Authorization: "Bearer ck_forced" }, { auth: "oauth", apiKey: "" }, decodeJwtPayload))
      .toEqual({ type: "oauth", access: "ck_forced" });
  });
});
