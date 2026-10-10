"use client";

// 截屏的配置存储。
//
// 与设备动作、系统日历同一取向：这是**写/看权限里最敏感的一类**——
// 截屏拿到的是用户整个屏幕，可能是银行页、私聊、密码框。
// 所以默认关，并且只提供「用户点一下才截一张」的路径。
//
// 走 kv-db（IndexedDB），不落服务端。图片本体另有媒体库（见 media-cache-storage），
// 这里只存配置和一小段记录索引，避免把几 MB 的 base64 塞进 KV。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import type { ScreenshotRecord } from "./types";

const CONFIG_KEY = "ai_phone_screenshot_config_v1";
const RECORDS_KEY = "ai_phone_screenshot_records_v1";
registerKvMigration(CONFIG_KEY);
registerKvMigration(RECORDS_KEY);

export type ScreenshotConfig = {
  /**
   * 总开关：是否允许截屏。默认关。
   *
   * 关掉时角色完全看不到这个能力，网页的截屏入口也应拦住。
   */
  enabled: boolean;
  /**
   * 截完是否发一条系统通知。默认开。
   *
   * 与设备动作同样的道理：这是**反馈**不是动作。截图这种「看到你屏幕」的事，
   * 用户事后必须在通知栏有据可查，否则就成了「它到底看我什么了」。
   */
  notifyOnCapture: boolean;
  /**
   * 最近记录保留多少条。默认 10。
   *
   * 作用是「让你能回头看它到底截了什么」——不是长期存档。
   * 超出后最旧的会被删（连媒体库里的图一起删），避免悄悄占满存储。
   */
  keepRecent: number;
};

export const SCREENSHOT_DEFAULTS: ScreenshotConfig = {
  enabled: false,
  notifyOnCapture: true,
  keepRecent: 10,
};

/** 读配置。任何字段缺失都按默认（默认 = 关）处理，绝不因为读失败而放开权限。 */
export function loadScreenshotConfig(): ScreenshotConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...SCREENSHOT_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<ScreenshotConfig>;
    const keep = Number(parsed.keepRecent);
    return {
      // 必须显式 true 才算开
      enabled: parsed.enabled === true,
      // 反馈默认开：仅显式 false 才关（与开关的取向相反）
      notifyOnCapture: parsed.notifyOnCapture !== false,
      keepRecent: Number.isFinite(keep) ? Math.max(1, Math.min(50, Math.floor(keep))) : SCREENSHOT_DEFAULTS.keepRecent,
    };
  } catch {
    return { ...SCREENSHOT_DEFAULTS };
  }
}

export function saveScreenshotConfig(config: ScreenshotConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("screenshot-config-changed"));
  }
}

/** 读最近截屏记录（最新在前）。 */
export function loadScreenshotRecords(): ScreenshotRecord[] {
  try {
    const raw = kvGet(RECORDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ScreenshotRecord => (
      !!item
      && typeof item === "object"
      && typeof (item as ScreenshotRecord).ref === "string"
    ));
  } catch {
    return [];
  }
}

export function saveScreenshotRecords(records: ScreenshotRecord[]): void {
  kvSet(RECORDS_KEY, JSON.stringify(records));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("screenshot-records-changed"));
  }
}
