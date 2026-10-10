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
} from "./types";

const CONFIG_KEY = "ai_phone_perception_config_v1";
const LOG_KEY = "ai_phone_perception_log_v1";
const STATE_KEY = "ai_phone_perception_state_v1";

registerKvMigration(CONFIG_KEY);
registerKvMigration(LOG_KEY);
registerKvMigration(STATE_KEY);

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
}
