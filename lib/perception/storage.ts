"use client";

// 感知配置与流水的本地存储。
// 与其余模块一致走 kv-db（IndexedDB），不落服务端——感知数据只留在本机。

import { kvGet, kvRemove, kvSet, registerKvMigration } from "../kv-db";
import {
  PERCEPTION_DEFAULTS,
  PERCEPTION_LIMITS,
  type PerceptionCapability,
  type PerceptionConfig,
  type PerceptionLogEntry,
  type PerceptionStatusSnapshot,
} from "./types";

const CONFIG_KEY = "ai_phone_perception_config_v1";
const LOG_KEY = "ai_phone_perception_log_v1";
const STATE_KEY = "ai_phone_perception_state_v1";
const STATUS_KEY = "ai_phone_perception_status_v1";

registerKvMigration(CONFIG_KEY);
registerKvMigration(LOG_KEY);
registerKvMigration(STATE_KEY);
registerKvMigration(STATUS_KEY);

const LOG_LIMIT = 60;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** 读配置。逐项做范围钳制，避免手改存储写出离谱的值。 */
export function loadPerceptionConfig(): PerceptionConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...PERCEPTION_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PerceptionConfig>;
    return {
      enabled: parsed.enabled !== false,
      capabilities: (parsed.capabilities && typeof parsed.capabilities === "object") ? parsed.capabilities : {},
      sampleSeconds: clamp(parsed.sampleSeconds, PERCEPTION_LIMITS.sampleSeconds.min, PERCEPTION_LIMITS.sampleSeconds.max, PERCEPTION_DEFAULTS.sampleSeconds),
      batteryStepPercent: clamp(parsed.batteryStepPercent, PERCEPTION_LIMITS.batteryStepPercent.min, PERCEPTION_LIMITS.batteryStepPercent.max, PERCEPTION_DEFAULTS.batteryStepPercent),
      appDwellMinutes: clamp(parsed.appDwellMinutes, PERCEPTION_LIMITS.appDwellMinutes.min, PERCEPTION_LIMITS.appDwellMinutes.max, PERCEPTION_DEFAULTS.appDwellMinutes),
      hourlyLimit: clamp(parsed.hourlyLimit, PERCEPTION_LIMITS.hourlyLimit.min, PERCEPTION_LIMITS.hourlyLimit.max, PERCEPTION_DEFAULTS.hourlyLimit),
      respectQuietHours: parsed.respectQuietHours !== false,
      batteryLowPercent: clamp(parsed.batteryLowPercent, PERCEPTION_LIMITS.batteryLowPercent.min, PERCEPTION_LIMITS.batteryLowPercent.max, PERCEPTION_DEFAULTS.batteryLowPercent),
      returnSignalEnabled: parsed.returnSignalEnabled !== false,
      returnAwayMinutes: clamp(parsed.returnAwayMinutes, PERCEPTION_LIMITS.returnAwayMinutes.min, PERCEPTION_LIMITS.returnAwayMinutes.max, PERCEPTION_DEFAULTS.returnAwayMinutes),
      returnCooldownMinutes: clamp(parsed.returnCooldownMinutes, PERCEPTION_LIMITS.returnCooldownMinutes.min, PERCEPTION_LIMITS.returnCooldownMinutes.max, PERCEPTION_DEFAULTS.returnCooldownMinutes),
      injectStatus: parsed.injectStatus === true,
      queryCooldownMinutes: clamp(parsed.queryCooldownMinutes, PERCEPTION_LIMITS.queryCooldownMinutes.min, PERCEPTION_LIMITS.queryCooldownMinutes.max, PERCEPTION_DEFAULTS.queryCooldownMinutes),
      cloudSyncEnabled: parsed.cloudSyncEnabled === true,
    };
  } catch {
    return { ...PERCEPTION_DEFAULTS };
  }
}

export function savePerceptionConfig(config: PerceptionConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("perception-config-changed"));
  }
}

/** 某个能力是否开启（缺省视为开启）。 */
export function isCapabilityEnabled(config: PerceptionConfig, capability: PerceptionCapability): boolean {
  return config.capabilities[capability] !== false;
}

// ── 流水 ──

export function loadPerceptionLog(): PerceptionLogEntry[] {
  try {
    const raw = kvGet(LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PerceptionLogEntry[]) : [];
  } catch {
    return [];
  }
}

/** 追加一条流水，超限丢最旧的。 */
export function appendPerceptionLog(entry: PerceptionLogEntry): void {
  const list = loadPerceptionLog();
  list.unshift(entry);
  if (list.length > LOG_LIMIT) list.length = LOG_LIMIT;
  kvSet(LOG_KEY, JSON.stringify(list));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("perception-log-changed"));
  }
}

export function clearPerceptionLog(): void {
  kvRemove(LOG_KEY);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("perception-log-changed"));
  }
}

// ── 运行态（采样基准 + 限流窗口）──
// 与其他模块一致：持久化，重载后不丢，避免刷新页面就把限流计数清零。

export type PerceptionRuntimeState = {
  /** 上次电量（用于阈值比较） */
  lastBatteryPercent: number;
  /** 上次充电状态 */
  lastCharging: boolean;
  /** 上次网络类型 */
  lastNetworkType: string;
  /** 当前停留的应用包名与起始时间 */
  dwellPackage: string;
  dwellSince: number;
  /** 已上报过停留的应用包名（同一段停留只报一次） */
  dwellReported: string;
  /** 本小时信号窗口：起始毫秒 + 条数 */
  hourWindowStart: number;
  hourCount: number;
  /** 最近采样时间 */
  lastSampleAt: string;
  /** 最近一次取值快照原文 */
  lastSnapshot: string;
  /** 无匹配规则的信号计数 */
  unmatchedSignals: number;
  /** 进入后台（离开小手机）的时刻；0 = 当前在前台 */
  awaySince: number;
  /** 上次发「回到手机」信号的时刻，用于回归冷却 */
  lastReturnSignalAt: number;
  /** 每个角色上次调用「查看TA的手机」的时刻：characterId → 毫秒 */
  lastQueryAt: Record<string, number>;
};

const EMPTY_STATE: PerceptionRuntimeState = {
  lastBatteryPercent: -1,
  lastCharging: false,
  lastNetworkType: "",
  dwellPackage: "",
  dwellSince: 0,
  dwellReported: "",
  hourWindowStart: 0,
  hourCount: 0,
  lastSampleAt: "",
  lastSnapshot: "",
  unmatchedSignals: 0,
  awaySince: 0,
  lastReturnSignalAt: 0,
  lastQueryAt: {},
};

export function loadPerceptionState(): PerceptionRuntimeState {
  try {
    const raw = kvGet(STATE_KEY);
    if (!raw) return { ...EMPTY_STATE };
    const parsed = JSON.parse(raw) as Partial<PerceptionRuntimeState>;
    return { ...EMPTY_STATE, ...parsed };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function savePerceptionState(state: PerceptionRuntimeState): void {
  kvSet(STATE_KEY, JSON.stringify(state));
}

/** 重置运行态（清空流水时一并调用，让引擎从干净状态重新开始）。 */
export function resetPerceptionState(): void {
  kvSet(STATE_KEY, JSON.stringify(EMPTY_STATE));
  kvRemove(STATUS_KEY);
}

// ── 设备状态缓存 ──
// 引擎每次采样后把「人类可读的当前状态」存这里。三个消费者：
//   ① 聊天时按需注入给角色（injectStatus）
//   ② 角色主动调用「查看TA的手机」
//   ③ 云端同步（cloudSyncEnabled，默认关）
// 与运行态分开存：运行态是引擎自己的基准，这里是给外部读的成品，随时可清。

const EMPTY_STATUS: PerceptionStatusSnapshot = {
  at: "",
  batteryPercent: -1,
  charging: false,
  networkType: "",
  metered: false,
  foregroundApp: "",
  foregroundMinutes: 0,
  steps: -1,
};

/** 读最近一次采样的设备状态。从未采样过时 at 为空串。 */
export function loadPerceptionStatus(): PerceptionStatusSnapshot {
  try {
    const raw = kvGet(STATUS_KEY);
    if (!raw) return { ...EMPTY_STATUS };
    const parsed = JSON.parse(raw) as Partial<PerceptionStatusSnapshot>;
    return { ...EMPTY_STATUS, ...parsed };
  } catch {
    return { ...EMPTY_STATUS };
  }
}

/** 写入设备状态缓存（引擎采样时调用）。 */
export function savePerceptionStatus(status: PerceptionStatusSnapshot): void {
  kvSet(STATUS_KEY, JSON.stringify(status));
}
