"use client";

// 设备动作的配置存储。
// 与感知一致走 kv-db（IndexedDB），不落服务端。
//
// 与感知（只读）的关键差异：这里是**写**操作，会真的改变用户手机状态。
// 所以默认值一律为「关」——总开关关、每个动作也关，全部要用户主动开。
// 感知那边「缺失视为开启」的约定绝不能抄过来：只读抄了没事，
// 写操作抄了等于默认允许角色动用户的设备。
//
// 为什么每个动作都要独立开关：用户可能想让角色帮忙开灯，但绝不接受
// 它半夜把屏幕调暗或改勿扰。一个「总开关」管不住这种差异，
// 所以粒度到单个动作。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import type { DeviceActionId } from "./types";

const CONFIG_KEY = "ai_phone_device_action_config_v1";
registerKvMigration(CONFIG_KEY);

/**
 * 可在设置里单独开关的动作（授权状态类的不算）。
 *
 * 每一项都必须能回答「角色为什么需要做这个」——答不上来的不接。
 * 「打开应用」被剔除：角色打开别的 App 会把用户从小手机里踢出去，
 * 与「沉浸聊天」这个核心体验直接冲突，而它本身又想不出合理场景。
 * 原生桥里保留了这个能力（将来若有明确用途可以再开放），只是不暴露给角色。
 */
export const TOGGLEABLE_ACTIONS: DeviceActionId[] = [
  "torch",
  "volume",
  "brightness",
  "dnd",
];

export const DEVICE_ACTION_LABEL: Record<DeviceActionId, string> = {
  torch: "手电筒",
  volume: "音量",
  brightness: "屏幕亮度",
  brightnessGranted: "屏幕亮度授权",
  dnd: "勿扰模式",
  dndGranted: "勿扰模式授权",
  openApp: "打开应用",
};

/**
 * 每个动作的说明。括号里写了「典型场景」——这是取舍的依据，不是装饰：
 * 答不上场景的动作就不该接。
 */
export const DEVICE_ACTION_DESC: Record<DeviceActionId, string> = {
  torch: "开关手电筒。场景：起夜、找东西时角色顺手替你开一下。",
  volume: "调节媒体/铃声/闹钟/通知的音量。场景：替你调小外放声音。注意它改的是系统音量，不会自己变回来。",
  brightness: "调节屏幕亮度。场景：夜里替你调暗。需要「修改系统设置」权限，且改动是持久的、不会自动恢复。",
  brightnessGranted: "是否已授予「修改系统设置」权限。",
  dnd: "开关勿扰模式。场景：陪你睡时帮你静音。需要勿扰访问权限；开着的时候你会漏接电话，所以请留意角色有没有帮你关回来。",
  dndGranted: "是否已授予勿扰模式访问权限。",
  openApp: "在手机上打开某个应用（当前未开放给角色）。",
};

export type DeviceActionConfig = {
  /** 总开关：关掉后角色完全看不到这个能力。默认关（写操作必须主动开）。 */
  enabled: boolean;
  /**
   * 逐动作开关。**只有显式 true 才算开启**（缺失 = 关）。
   * 与感知相反——那边只读，缺省开；这边会改用户设备，缺省必须关。
   */
  actions: Partial<Record<DeviceActionId, boolean>>;
};

export const DEVICE_ACTION_DEFAULTS: DeviceActionConfig = {
  enabled: false,
  actions: {},
};

/** 读配置。 */
export function loadDeviceActionConfig(): DeviceActionConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...DEVICE_ACTION_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<DeviceActionConfig>;
    return {
      enabled: parsed.enabled === true,
      actions: (parsed.actions && typeof parsed.actions === "object") ? parsed.actions : {},
    };
  } catch {
    return { ...DEVICE_ACTION_DEFAULTS };
  }
}

export function saveDeviceActionConfig(config: DeviceActionConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("device-action-config-changed"));
  }
}

/** 某个动作是否被允许。必须显式开启过才算允许（缺失 = 关）。 */
export function isActionEnabled(config: DeviceActionConfig, id: DeviceActionId): boolean {
  return config.actions[id] === true;
}
