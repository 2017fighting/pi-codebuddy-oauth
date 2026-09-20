import { describe, it, expect, afterEach } from "vitest";
import { getConfig, resolveServerUrl, SERVER_CN, SERVER_INTL } from "../src/config.js";

const ENV_KEYS = [
  "CODEBUDDY_ENDPOINT", "CODEBUDDY_AUTH", "CODEBUDDY_API_KEY", "CODEBUDDY_MODEL",
  "CODEBUDDY_STABLE_CONVERSATION", "CODEBUDDY_CONVERSATION_MAP_MAX",
  "CODEBUDDY_TENANT_ID", "CODEBUDDY_ENTERPRISE_ID", "CODEBUDDY_USER_ID",
  "CODEBUDDY_INTL_ENDPOINT", "CODEBUDDY_INTL_AUTH", "CODEBUDDY_INTL_API_KEY", "CODEBUDDY_INTL_MODEL",
] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("getConfig（双前缀）", () => {
  it("默认值", () => {
    const cfg = getConfig("CODEBUDDY");
    expect(cfg.endpoint).toBe("");
    expect(cfg.auth).toBe("auto");
    expect(cfg.stableConversationId).toBe(true);
    expect(cfg.conversationMapMax).toBe(1000);
  });
  it("CN 前缀只读 CODEBUDDY_*", () => {
    process.env.CODEBUDDY_API_KEY = "ck_cn";
    process.env.CODEBUDDY_INTL_API_KEY = "ck_intl";
    const cn = getConfig("CODEBUDDY");
    const intl = getConfig("CODEBUDDY_INTL");
    expect(cn.apiKey).toBe("ck_cn");
    expect(intl.apiKey).toBe("ck_intl");
  });
  it("auth 大小写不敏感", () => {
    process.env.CODEBUDDY_INTL_AUTH = "API";
    expect(getConfig("CODEBUDDY_INTL").auth).toBe("api");
  });
  it("stable_conversation=0 关闭；非法数字回落默认", () => {
    process.env.CODEBUDDY_STABLE_CONVERSATION = "0";
    process.env.CODEBUDDY_CONVERSATION_MAP_MAX = "abc";
    const cfg = getConfig("CODEBUDDY");
    expect(cfg.stableConversationId).toBe(false);
    expect(cfg.conversationMapMax).toBe(1000);
  });
});

describe("resolveServerUrl", () => {
  it("无 endpoint → provider 默认 server", () => {
    expect(resolveServerUrl("", SERVER_CN)).toEqual(SERVER_CN);
    expect(resolveServerUrl("", SERVER_INTL)).toEqual(SERVER_INTL);
  });
  it("endpoint 覆盖（去尾斜杠 + 按 host 推导 domain）", () => {
    expect(resolveServerUrl("https://proxy.example.com/v2///", SERVER_CN)).toEqual({
      url: "https://proxy.example.com/v2",
      domain: "www.codebuddy.cn",
    });
    expect(resolveServerUrl("https://mirror.codebuddy.ai", SERVER_CN)).toEqual({
      url: "https://mirror.codebuddy.ai",
      domain: "www.codebuddy.ai",
    });
  });
});
