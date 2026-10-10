"use client";

// 设备动作的执行入口与门控。
//
// 这是设备动作的唯一决策点：是否允许这个动作、参数是否合法、如何措辞结果。
// 原生（DeviceActionBridge.kt）只负责真的去做那件事。
//
// 门控（任一不过就不执行，且都给出明确原因）：
//   ① 能力总开关（工具箱 → 内置能力 → 操作TA的设备）
//   ② 逐动作开关（设置 → 操作TA的设备）
//   ③ 动作本身的前置条件（该授权的授权了没）
//
// 设计原则：**失败必须说清楚**。角色以为灯开了其实没开，比拒绝执行更糟——
// 所以每个失败分支都带一句人话原因，绝不静默吞掉。

import {
  hasDeviceActionBridge,
  readDeviceActionCapabilities,
  setBrightness,
  setDnd,
  setTorch,
  setVolume,
} from "./bridge";
import { DEVICE_ACTION_LABEL, isActionEnabled, loadDeviceActionConfig } from "./storage";

/** 一次设备动作的结论。ok=false 时 reason 一定是给人看的整句。 */
export type DeviceActionOutcome = {
  ok: boolean;
  /** 成功时的结果描述（给角色看的） */
  message?: string;
  /** 失败原因 */
  reason?: string;
};

/** 动作是否可用（开关 + 壳支持）。设置面板用它显示三态。 */
export function checkActionAvailability(actionId: string): {
  configEnabled: boolean;
  userEnabled: boolean;
  bridgeAvailable: boolean;
  supported: boolean;
  granted: boolean;
  available: boolean;
} {
  const config = loadDeviceActionConfig();
  const caps = readDeviceActionCapabilities();
  const bridgeAvailable = hasDeviceActionBridge();
  const id = actionId as keyof typeof caps;
  const supported = caps[id] === true;
  // 亮度/勿扰有独立的授权状态：有能力但没授权，与「根本不支持」是两回事
  const granted = actionId === "brightness" ? caps.brightnessGranted !== false
    : actionId === "dnd" ? caps.dndGranted !== false
    : true;
  const configEnabled = config.enabled;
  const userEnabled = isActionEnabled(config, actionId as never);
  return {
    configEnabled,
    userEnabled,
    bridgeAvailable,
    supported,
    granted,
    available: configEnabled && userEnabled && bridgeAvailable && supported && granted,
  };
}

/** 取壳上报的授权状态（设置面板给「去授权」按钮用）。 */
export function readGrantStatus(): { brightness: boolean; dnd: boolean } {
  const caps = readDeviceActionCapabilities();
  return {
    brightness: caps.brightnessGranted === true,
    dnd: caps.dndGranted === true,
  };
}

/**
 * 执行一次设备动作。
 *
 * 参数用宽松解析：模型可能传 `on`、`on_off`、把数字写成字符串，
 * 与其报「参数错误」让它重试，不如尽量理解意图——但**范围一定要夹紧**
 * （亮度 1-100、音量 0-100），不能把奇怪的值直接透传给原生。
 */
export function runDeviceAction(args: Record<string, unknown>): DeviceActionOutcome {
  const config = loadDeviceActionConfig();
  if (!config.enabled) {
    return { ok: false, reason: "TA 还没有开启设备操作功能（设置 → 操作设备）" };
  }
  if (!hasDeviceActionBridge()) {
    return { ok: false, reason: "当前 App 版本不支持设备动作，需要更新安卓壳" };
  }

  const action = String(args.action ?? "").trim();
  if (!action) return { ok: false, reason: "缺少 action 参数" };

  // 逐动作开关：没开启的动作必须给出明确拒绝——
  // 否则模型会以为「调用了但没反应」，反复重试或干脆谎报成功。
  // 默认状态下全部未开启，所以首次使用时角色几乎一定会撞到这里，
  // 这句提示就是引导它（和用户）去开关里打开需要的那个。
  const allowed = (id: keyof typeof DEVICE_ACTION_LABEL): DeviceActionOutcome | null => {
    if (!isActionEnabled(config, id)) {
      return {
        ok: false,
        reason: `TA 还没有开启「${DEVICE_ACTION_LABEL[id]}」这个动作（设置 → 操作设备）`,
      };
    }
    return null;
  };

  const caps = readDeviceActionCapabilities();

  // 注意：下面的 per-action 检查用的是 isActionEnabled（显式 true 才算开），
  // 所以默认状态下每个动作都会被拦下——这是刻意的，不是 bug。
  switch (action) {
    case "torch": {
      const blocked = allowed("torch");
      if (blocked) return blocked;
      if (caps.torch !== true) return { ok: false, reason: "这台设备没有可用的闪光灯" };
      const on = args.on === true || args.on === "true" || args.on === 1;
      const result = setTorch(on);
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, message: on ? "手电筒已打开" : "手电筒已关闭" };
    }

    case "volume": {
      const blocked = allowed("volume");
      if (blocked) return blocked;
      const stream = String(args.stream ?? "media");
      const mode = String(args.mode ?? "up");
      const level = Number(args.level);
      const result = setVolume(stream, mode, Number.isFinite(level) ? level : 0);
      if (!result.ok) return { ok: false, reason: result.reason };
      const pct = result.max && result.current !== undefined
        ? Math.round((result.current / result.max) * 100)
        : undefined;
      return { ok: true, message: pct !== undefined ? `音量已调整（当前约 ${pct}%）` : "音量已调整" };
    }

    case "brightness": {
      const blocked = allowed("brightness");
      if (blocked) return blocked;
      const level = Number(args.level);
      if (!Number.isFinite(level)) return { ok: false, reason: "缺少 level 参数（屏幕亮度百分比 1-100）" };
      const result = setBrightness(level);
      if (!result.ok) {
        // 需要授权时把原因说清楚，让角色能转告用户去开权限
        return { ok: false, reason: result.needPermission ? "还没有「修改系统设置」权限，需要 TA 去设置里授权" : result.reason };
      }
      return { ok: true, message: `屏幕亮度已调到约 ${Math.round(level)}%` };
    }

    case "dnd": {
      const blocked = allowed("dnd");
      if (blocked) return blocked;
      const on = args.on === true || args.on === "true" || args.on === 1;
      const result = setDnd(on);
      if (!result.ok) {
        return { ok: false, reason: result.needPermission ? "还没有「勿扰模式」访问权限，需要 TA 去设置里授权" : result.reason };
      }
      return { ok: true, message: on ? "已打开勿扰模式" : "已关闭勿扰模式" };
    }

    // 「打开应用」刻意不对角色开放：角色打开别的 App 会把用户从小手机里踢出去，
    // 与「沉浸聊天」这个核心体验直接冲突，而且想不出正当场景。
    // 原生桥里保留了这个能力，将来若有明确用途（比如「帮我打开相机」）再开放，
    // 现在返回一句明确的拒绝，避免模型反复尝试。
    case "openApp":
      return { ok: false, reason: "打开应用不对角色开放" };

    default:
      return { ok: false, reason: `不认识的动作：${action}` };
  }
}
