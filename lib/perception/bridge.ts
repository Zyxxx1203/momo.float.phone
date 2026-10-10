"use client";

// 感知系统 ↔ 安卓壳的原生桥对接层。
//
// 与 lib/shell-call-overlay.ts 同一套路：非壳环境一律安全降级为 no-op，
// 老版 APK 没有这些方法时也返回「不可用」而不是抛错，调用方无需分支判断。

import type { PerceptionCapability } from "./types";

type PerceptionBridgeLike = {
  getPerceptionSnapshot?: () => string;
  getAppLabel?: (packageName: string) => string;
  getPerceptionCapabilities?: () => string;
  hasStepPermission?: () => boolean;
  requestStepPermission?: () => boolean;
};

function bridge(): PerceptionBridgeLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { AndroidShell?: PerceptionBridgeLike }).AndroidShell;
  return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否提供感知桥（老 APK 没有 → 感知功能整体不可用）。 */
export function hasPerceptionBridge(): boolean {
  return typeof bridge()?.getPerceptionSnapshot === "function";
}

/** 壳是否支持「包名 → 应用名」翻译。 */
export function supportsAppLabel(): boolean {
  return typeof bridge()?.getAppLabel === "function";
}

export type DeviceSnapshot = {
  battery: { percent: number; charging: boolean };
  network: { type: string; metered: boolean };
  /** 当天步数；-1 = 原生不支持或未授权（老 APK / 未开活动识别权限） */
  steps: number;
};

/** 取设备快照。失败返回 null（调用方按「本轮跳过」处理）。 */
export function readPerceptionSnapshot(): DeviceSnapshot | null {
  try {
    const raw = bridge()?.getPerceptionSnapshot?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeviceSnapshot>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      battery: {
        percent: Number(parsed.battery?.percent ?? -1),
        charging: parsed.battery?.charging === true,
      },
      network: {
        type: String(parsed.network?.type ?? "none"),
        metered: parsed.network?.metered !== false,
      },
      steps: Number.isFinite(Number(parsed.steps)) ? Number(parsed.steps) : -1,
    };
  } catch {
    return null;
  }
}

/** 步数所需的「活动识别」权限是否已授予（老壳不支持该接口时返回 false）。 */
export function hasStepPermission(): boolean {
  try {
    return bridge()?.hasStepPermission?.() === true;
  } catch {
    return false;
  }
}

/**
 * 申请活动识别权限（步数）。
 *
 * 返回 true 表示「现在就可以用了」（已授权或系统不需要），false 表示弹出了系统
 * 对话框、结果要稍后由 hasStepPermission() 轮询确认——申请是异步的，
 * 不能同步拿到结果。老壳没有这个接口时同样返回 false 并提示需更新。
 */
export function requestStepPermission(): boolean {
  try {
    return bridge()?.requestStepPermission?.() === true;
  } catch {
    return false;
  }
}

/** 壳是否提供步数权限申请接口（老 APK 没有）。 */
export function supportsStepPermission(): boolean {
  return typeof bridge()?.requestStepPermission === "function";
}

/** 包名 → 应用显示名。失败返回空串，调用方退回显示包名。 */
export function readAppLabel(packageName: string): string {
  try {
    return bridge()?.getAppLabel?.(packageName) ?? "";
  } catch {
    return "";
  }
}

/**
 * 壳如实上报的可用能力表。
 *
 * 这是这次审计的直接产物：以前 Manifest 声明了一堆权限，底下什么都没有，
 * 用户完全看不出来。现在原生必须逐项回答「我真的支持吗」，
 * 设置页据此显示「已接通 / 不支持」，不再让人对着没反应的开关猜。
 */
export function readNativeCapabilities(): Partial<Record<PerceptionCapability, boolean>> {
  try {
    const raw = bridge()?.getPerceptionCapabilities?.();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Record<PerceptionCapability, boolean>>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
