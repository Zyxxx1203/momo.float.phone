"use client";

// 感知系统的诊断与可视化数据源。
// 设置面板「感知 → 诊断」直接消费这里，不需要自己拼装。

import { isWithinPushQuietHours } from "../push-client";
import { hasPerceptionBridge, readNativeCapabilities } from "./bridge";
import { isPerceptionRunning } from "./engine";
import { isCapabilityEnabled, loadPerceptionConfig, loadPerceptionState, loadPerceptionStatus } from "./storage";
import {
  PERCEPTION_CAPABILITY_DESC,
  PERCEPTION_CAPABILITY_LABEL,
  type PerceptionCapability,
  type PerceptionDiagnostics,
} from "./types";

/** 一次取全诊断状态。面板每次打开/刷新时调，不做缓存。 */
export function readPerceptionDiagnostics(): PerceptionDiagnostics {
  let accessibility = false;
  try {
    const bridge = (window as unknown as { AndroidShell?: { isAccessibilityConnected?: () => boolean } }).AndroidShell;
    accessibility = bridge?.isAccessibilityConnected?.() === true;
  } catch {
    accessibility = false;
  }

  const state = loadPerceptionState();
  const config = loadPerceptionConfig();
  const now = Date.now();
  const windowFresh = state.hourWindowStart > 0 && now - state.hourWindowStart < 60 * 60 * 1000;

  return {
    inShell: typeof window !== "undefined" && !!(window as unknown as { AndroidShell?: unknown }).AndroidShell,
    bridgeAvailable: hasPerceptionBridge(),
    running: isPerceptionRunning(),
    nativeCapabilities: readNativeCapabilities(),
    accessibility,
    lastSampleAt: state.lastSampleAt,
    lastSnapshot: state.lastSnapshot,
    status: loadPerceptionStatus(),
    hourlyUsed: windowFresh ? state.hourCount : 0,
    hourlyLimit: config.hourlyLimit,
    unmatchedSignals: state.unmatchedSignals,
  };
}

/** 诊断面板里每个能力一行的展示模型。 */
export type CapabilityRow = {
  id: PerceptionCapability;
  label: string;
  desc: string;
  /** 用户是否开启了这个能力 */
  userEnabled: boolean;
  /** 壳是否真的支持（原生如实回答） */
  nativeSupported: boolean;
  /** 是否有额外前置条件没满足（如无障碍未开） */
  missingRequirement: string;
  /** 综合可用性：userEnabled && nativeSupported && 无缺失前置 */
  available: boolean;
};

/**
 * 组装「能力可用性」表。
 *
 * 这是本次审计的直接产物：三项分开显示（用户开了没 / 原生支持没 / 前置条件够没），
 * 用户一眼看出卡在哪一环，而不是面对一个没反应的开关。
 */
export function buildCapabilityRows(): CapabilityRow[] {
  const config = loadPerceptionConfig();
  const native = readNativeCapabilities();
  let accessibility = false;
  try {
    const bridge = (window as unknown as { AndroidShell?: { isAccessibilityConnected?: () => boolean } }).AndroidShell;
    accessibility = bridge?.isAccessibilityConnected?.() === true;
  } catch {
    accessibility = false;
  }

  const ids: PerceptionCapability[] = [
    "battery", "network", "foregroundApp", "steps", "location", "calendar", "contacts", "usageStats", "returnToPhone",
  ];

  return ids.map(id => {
    const userEnabled = isCapabilityEnabled(config, id);
    // 「回到手机」是纯网页实现（前后台切换 + 计时），不依赖原生桥，恒为支持。
    // 不特殊处理的话，非壳环境/老 APK 下会被 native[id]===true 判成「不支持」，
    // 而它其实能用——比不显示更让人迷惑。
    const nativeSupported = id === "returnToPhone" ? true : native[id] === true;
    let missingRequirement = "";
    if (id === "foregroundApp" && nativeSupported && !accessibility) {
      missingRequirement = "需要开启无障碍服务";
    }
    if (id === "steps" && !nativeSupported) {
      missingRequirement = "需要重编 APK（当前壳版本未提供步数）";
    }
    return {
      id,
      label: PERCEPTION_CAPABILITY_LABEL[id],
      desc: PERCEPTION_CAPABILITY_DESC[id],
      userEnabled,
      nativeSupported,
      missingRequirement,
      available: userEnabled && nativeSupported && !missingRequirement,
    };
  });
}

/** 安静时段是否正在生效（面板给一条轻提示）。 */
export function isQuietHoursActive(): boolean {
  const config = loadPerceptionConfig();
  return config.respectQuietHours && isWithinPushQuietHours(Date.now());
}
