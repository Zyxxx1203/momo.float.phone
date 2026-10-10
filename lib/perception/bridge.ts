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
    };
  } catch {
    return null;
  }
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
