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
  findPackageByLabel,
  hasDeviceActionBridge,
  mediaControl,
  openApp,
  openUrl,
  readDeviceActionCapabilities,
  setAlarm,
  setBrightness,
  setDnd,
  setTimer,
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
  /**
   * 实际执行的动作 id（成功时才有）。
   * 调用方据此挑反馈文案——用入参里的 action 字符串不安全：
   * 模型可能拼错大小写或写中文，那样反馈会退化成「调整了你的设备」。
   */
  action?: string;
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
  // 亮度/勿扰/使用情况访问有独立的授权状态：有能力但没授权，与「根本不支持」是两回事。
  // 全用 `=== true` 而不是 `!== false`：这些授权默认就是没有的，
  // 老壳不上报该字段时（undefined）必须算「未授权」，否则会显示成已授权、
  // 用户点了却发现功能不工作。
  const granted = actionId === "brightness" ? caps.brightnessGranted === true
    : actionId === "dnd" ? caps.dndGranted === true
    : actionId === "usageStats" ? caps.usageStatsGranted === true
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

/** 取壳上报的授权状态（设置面板给「去授权」按钮用，也给感知读取用）。 */
export function readGrantStatus(): { brightness: boolean; dnd: boolean; usageStats: boolean } {
  const caps = readDeviceActionCapabilities();
  return {
    usageStats: caps.usageStatsGranted === true,
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
      return { ok: true, action: "torch", message: on ? "手电筒已打开" : "手电筒已关闭" };
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
      return { ok: true, action: "volume", message: pct !== undefined ? `音量已调整（当前约 ${pct}%）` : "音量已调整" };
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
      return { ok: true, action: "brightness", message: `屏幕亮度已调到约 ${Math.round(level)}%` };
    }

    case "dnd": {
      const blocked = allowed("dnd");
      if (blocked) return blocked;
      const on = args.on === true || args.on === "true" || args.on === 1;
      const result = setDnd(on);
      if (!result.ok) {
        return { ok: false, reason: result.needPermission ? "还没有「勿扰模式」访问权限，需要 TA 去设置里授权" : result.reason };
      }
      return { ok: true, action: "dnd", message: on ? "已打开勿扰模式" : "已关闭勿扰模式" };
    }

    // 「打开应用」：会把用户的屏幕切走，所以是这批动作里**侵略性最强**的一个，
    // 默认关闭、需要用户主动开。但场景成立（陪它→打开小手机、
    // 学习→专注应用、吃饭→外卖应用），所以开放而不是砍掉。
    case "openApp": {
      const blocked = allowed("openApp");
      if (blocked) return blocked;
      const raw = String(args.app ?? "").trim();
      if (!raw) return { ok: false, reason: "缺少 app 参数（应用名或包名）" };
      // 先当包名试，再当显示名找——角色多半只知道「微信」，不知道 com.tencent.mm
      let pkg = raw;
      let label = raw;
      if (!raw.includes(".")) {
        const found = findPackageByLabel(raw);
        if (!found) return { ok: false, reason: `没找到叫「${raw}」的应用` };
        pkg = found;
      }
      const result = openApp(pkg);
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, action: "openApp", message: `已打开「${label}」` };
    }

    // ── 闹钟：带系统界面，用户自己确认时间 ──
    case "alarm": {
      const blocked = allowed("alarm");
      if (blocked) return blocked;
      const hour = Number(args.hour);
      const minute = Number(args.minute ?? 0);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return { ok: false, reason: "需要 hour 参数（0-23）" };
      }
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        return { ok: false, reason: "minute 需要在 0-59 之间" };
      }
      const note = String(args.message ?? "").trim();
      const result = setAlarm(hour, minute, note);
      if (!result.ok) return { ok: false, reason: result.reason };
      const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      // needsConfirm 时系统界面已弹出，结果以用户确认为准，措辞不能说得太满
      return { ok: true, action: "alarm", message: `闹钟 ${hhmm} 已交给系统时钟（请在时钟里确认）` };
    }

    case "timer": {
      const blocked = allowed("timer");
      if (blocked) return blocked;
      // 允许模型传 minutes 或 seconds，优先 minutes（更符合说话的粒度）
      const minutes = Number(args.minutes);
      const secondsArg = Number(args.seconds);
      const seconds = Number.isFinite(minutes) && minutes > 0
        ? Math.round(minutes * 60)
        : Math.round(secondsArg);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86_400) {
        return { ok: false, reason: "需要 minutes 或 seconds 参数（最长 24 小时）" };
      }
      const note = String(args.message ?? "").trim();
      const result = setTimer(seconds, note);
      if (!result.ok) return { ok: false, reason: result.reason };
      const human = seconds >= 60 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`;
      return { ok: true, action: "timer", message: `倒计时已开始（${human}）` };
    }

    case "media": {
      const blocked = allowed("media");
      if (blocked) return blocked;
      const op = String(args.mode ?? args.op ?? "toggle");
      const result = mediaControl(op);
      if (!result.ok) return { ok: false, reason: result.reason };
      const label: Record<string, string> = {
        play: "已继续播放",
        pause: "已暂停",
        toggle: "已切换播放状态",
        next: "已切到下一首",
        prev: "已切到上一首",
        stop: "已停止播放",
      };
      return { ok: true, action: "media", message: label[op] ?? "已发送播放控制" };
    }

    case "openUrl": {
      const blocked = allowed("openUrl");
      if (blocked) return blocked;
      const url = String(args.url ?? "").trim();
      if (!url) return { ok: false, reason: "缺少 url 参数" };
      const result = openUrl(url);
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, action: "openUrl", message: "已在浏览器里打开" };
    }

    default:
      return { ok: false, reason: `不认识的动作：${action}` };
  }
}
