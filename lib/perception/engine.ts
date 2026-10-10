"use client";

/**
 * 感知引擎：采样 → 门控 → 投递。
 *
 * 这是整套感知系统的**唯一决策点**。原生只给原始值，本模块决定
 * 「这个变化算不算一个事件」。把决策放这里而不是原生，是为了让
 * 阈值、开关、限流都能随网页部署即时生效，不必为调一个数字重编 APK。
 *
 * 信号出口只有一个：现实桥 processBridgeItem()。复用它的规则引擎、
 * 冷却与流水，刻意不新建平行系统——否则每加一个能力都要重写一遍投递逻辑。
 *
 * 五道闸（按顺序，任一不过就不产生信号）：
 *   ① 总开关 / 逐能力开关
 *   ② 安静时段（复用推送的安静时段设置）
 *   ③ 变化阈值（电量变动够不够大、停留够不够久）
 *   ④ 去重（同一个值不变不发、同一段停留只发一次）
 *   ⑤ 每小时上限（保护 token 预算）
 */

import { isWithinPushQuietHours } from "../push-client";
import { processBridgeItem } from "../reality-bridge/engine";
import type { BridgeItem } from "../reality-bridge/types";
import { ensureShellOverlayListener, subscribeShellOverlayEvents } from "../shell-call-overlay";
import { hasPerceptionBridge, readAppLabel, readPerceptionSnapshot } from "./bridge";
import { syncPerceptionToCloud } from "./cloud-sync";
import {
  appendPerceptionLog,
  isCapabilityEnabled,
  loadPerceptionConfig,
  loadPerceptionState,
  loadPerceptionStatus,
  savePerceptionState,
  savePerceptionStatus,
  type PerceptionRuntimeState,
} from "./storage";
import type { PerceptionCapability, PerceptionSignal } from "./types";

const HOUR_MS = 60 * 60 * 1000;

let timer: number | null = null;
let unsubscribeForeground: (() => void) | null = null;
let unsubscribeVisibility: (() => void) | null = null;
let running = false;

/** 引擎是否在运行（诊断面板读） */
export function isPerceptionRunning(): boolean {
  return running;
}

// ── 限流窗口 ──

function takeRateLimitSlot(state: PerceptionRuntimeState, limit: number): boolean {
  const now = Date.now();
  if (!state.hourWindowStart || now - state.hourWindowStart >= HOUR_MS) {
    state.hourWindowStart = now;
    state.hourCount = 0;
  }
  if (state.hourCount >= limit) return false;
  state.hourCount += 1;
  return true;
}

// ── 投递 ──

/**
 * 统一的信号投递口。所有门控都在这里，各能力的采样代码只管构造信号。
 *
 * 返回值是「门控结论」或投递结果摘要，写进流水供诊断面板展示——
 * 用户能看到「信号有，但被哪道闸拦下了」，而不是对着没反应的面板猜。
 */
async function emitSignal(
  signal: PerceptionSignal,
  state: PerceptionRuntimeState,
): Promise<boolean> {
  const config = loadPerceptionConfig();

  const record = (outcome: string, skipped?: string) => {
    appendPerceptionLog({
      id: `per_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
      capability: signal.capability,
      type: signal.type,
      payload: signal.payload,
      outcome,
      skipped,
    });
  };

  // ① 总开关 + 逐能力开关
  if (!config.enabled) return false;
  if (!isCapabilityEnabled(config, signal.capability)) {
    record("未投递", "该能力已关闭");
    return false;
  }
  // ② 安静时段
  if (config.respectQuietHours && isWithinPushQuietHours(Date.now())) {
    record("未投递", "处于安静时段");
    return false;
  }
  // ⑤ 每小时上限
  if (!takeRateLimitSlot(state, config.hourlyLimit)) {
    record("未投递", `已达每小时上限（${config.hourlyLimit} 条）`);
    return false;
  }

  // 投递给现实桥：复用它的规则匹配、加工、动作、冷却与流水。
  // 用 void 而不是 await：规则动作可能触发 LLM 生成（几秒到几十秒），
  // 不能让采样循环被它拖住。
  const item: BridgeItem = {
    id: `perception_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type: signal.type,
    payload: signal.payload,
    createdAt: new Date().toISOString(),
  };
  void processBridgeItem(item)
    .then(entry => {
      const outcome = entry.actions.length ? entry.actions.join("、") : "已处理";
      // 「仅存档（无匹配规则）」是最常见的困惑来源：信号确实产生了，
      // 只是用户还没在现实桥里配规则。单独计数，面板里给一条引导。
      if (entry.actions.some(action => action.includes("无匹配规则"))) {
        state.unmatchedSignals += 1;
        savePerceptionState(state);
      }
      record(outcome, entry.error);
    })
    .catch(err => {
      record("投递失败", err instanceof Error ? err.message : String(err));
    });
  return true;
}

// ── 采样 ──

async function sampleOnce(): Promise<void> {
  const config = loadPerceptionConfig();
  if (!config.enabled || !hasPerceptionBridge()) return;

  const state = loadPerceptionState();
  const snapshot = readPerceptionSnapshot();
  if (!snapshot) return;

  state.lastSampleAt = new Date().toISOString();
  state.lastSnapshot = JSON.stringify(snapshot);

  // ── 电量 ──
  // 首次只建立基准，不产生信号——否则一装好就报一堆「电量变化」。
  const percent = snapshot.battery.percent;
  const charging = snapshot.battery.charging;
  const batteryReady = state.lastBatteryPercent >= 0;

  if (batteryReady) {
    if (charging !== state.lastCharging) {
      await emitSignal({
        capability: "battery",
        type: charging ? "充电开始" : "充电结束",
        payload: percent >= 0 ? `${percent}%` : "",
      }, state);
    }
    // 电量跌破阈值：只在「往下掉」且跨度够大时报，避免充电时来回跳也发
    if (percent >= 0 && percent < state.lastBatteryPercent) {
      const drop = state.lastBatteryPercent - percent;
      if (drop >= config.batteryStepPercent) {
        await emitSignal({
          capability: "battery",
          // 阈值来自配置（默认 20），不再是硬编码——用户想改成 30% 提前提醒不用重编 APK
          type: percent <= config.batteryLowPercent ? "电量偏低" : "电量变化",
          payload: `${percent}%`,
        }, state);
      }
    }
  }
  if (percent >= 0) state.lastBatteryPercent = percent;
  state.lastCharging = charging;

  // ── 网络 ──
  // 值不变不发。首次静默建立基准。
  const netType = snapshot.network.type;
  if (state.lastNetworkType && netType && netType !== state.lastNetworkType) {
    await emitSignal({
      capability: "network",
      type: netType === "wifi" ? "连接到 WiFi" : `网络切换到${netType === "cellular" ? "移动网络" : netType}`,
      payload: netType === "cellular" && snapshot.network.metered ? "计费网络" : "",
    }, state);
  }
  if (netType) state.lastNetworkType = netType;

  // ── 前台应用停留 ──
  // 事件只更新「当前在用哪个应用」，真正的判断放在采样里：
  // 因为用户可能一直停在同一个应用、不再产生新事件，靠事件驱动会永远等不到。
  await checkDwell(config.appDwellMinutes, state);

  // ── 设备状态缓存 ──
  // 供三处读取：聊天时的按需注入、角色主动调用「查看TA的手机」、云端同步。
  // 存在这里而不是各消费方自己去原生取，是为了让它们读到同一份「此刻一致」的状态，
  // 也避免每个功能各写一遍降级逻辑。
  const dwellLabel = state.dwellPackage
    ? (readAppLabel(state.dwellPackage) || state.dwellPackage)
    : "";
  savePerceptionStatus({
    at: new Date().toISOString(),
    batteryPercent: percent,
    charging,
    networkType: netType || "",
    metered: snapshot.network.metered,
    foregroundApp: dwellLabel,
    foregroundMinutes: state.dwellSince > 0
      ? Math.max(0, Math.floor((Date.now() - state.dwellSince) / 60000))
      : 0,
    steps: snapshot.steps,
  });

  // ── 云端同步（默认关）──
  // 必须排在状态缓存**之后**：它上传的就是这份刚写好的成品。
  // 放前面会推上一轮的旧值（差一个采样周期）。
  // 用 void 不 await：上传可能耗时，不能让采样循环等它。
  void syncPerceptionToCloud();

  savePerceptionState(state);
}

/** 停留够久且本段未上报过 → 产生信号。 */
async function checkDwell(thresholdMinutes: number, state: PerceptionRuntimeState): Promise<void> {
  const pkg = state.dwellPackage;
  if (!pkg || !state.dwellSince) return;
  if (state.dwellReported === pkg) return;
  const minutes = Math.floor((Date.now() - state.dwellSince) / 60000);
  if (minutes < thresholdMinutes) return;

  const label = readAppLabel(pkg) || pkg;
  const delivered = await emitSignal({
    capability: "foregroundApp",
    type: "长时间使用",
    payload: `${label} 已连续使用 ${minutes} 分钟`,
  }, state);
  // 只有真投递出去才标记本段已上报。被开关/安静时段/限流拦下时保持未标记，
  // 等条件恢复后还能补上——否则用户白天关了、晚上打开，这段停留就永远丢了。
  if (delivered) state.dwellReported = pkg;
}

/** 前台应用变化：只更新基准，不在这里上报（判断统一在 checkDwell）。 */
function onForegroundApp(pkg: string): void {
  if (!pkg) return;
  const state = loadPerceptionState();
  if (state.dwellPackage === pkg) return;
  state.dwellPackage = pkg;
  state.dwellSince = Date.now();
  state.dwellReported = "";
  savePerceptionState(state);
}

// ── 回到手机（回归信号）──
//
// 需求：用户离开小手机一段时间再回来，角色应该能察觉到「TA 回来了」。
// 这是纯网页实现（visibilitychange + 计时），不需要任何原生权限，
// 因此普通浏览器、老 APK 上一样能用。
//
// 两道闸，缺一不可：
//   ① 离开够久（returnAwayMinutes）：切一下微信回来不算「离开」。
//   ② 回归信号本身有冷却（returnCooldownMinutes）：反复切前后台不刷屏。
// 最终是否打扰由现实桥规则决定（要不要写进聊天、要不要让角色回应）。

/** 记录「离开小手机」的时刻。重复调用只取最早一次。 */
export function markAwayFromPhone(): void {
  if (typeof window === "undefined") return;
  const state = loadPerceptionState();
  if (state.awaySince > 0) return;
  state.awaySince = Date.now();
  savePerceptionState(state);
}

/**
 * 处理「回到小手机」。
 *
 * @returns 产生的信号类型；没达到阈值或冷却中时为 null。
 */
export async function markReturnedToPhone(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const config = loadPerceptionConfig();
  const state = loadPerceptionState();

  const awaySince = state.awaySince;
  // 归位：不管这次算不算「离开过」，都要清掉离开标记，否则下次判断拿的是旧时间
  state.awaySince = 0;

  if (!config.enabled || !config.returnSignalEnabled) {
    savePerceptionState(state);
    return null;
  }
  if (!isCapabilityEnabled(config, "returnToPhone")) {
    savePerceptionState(state);
    return null;
  }
  if (awaySince <= 0) {
    savePerceptionState(state);
    return null;
  }

  const awayMinutes = Math.floor((Date.now() - awaySince) / 60000);
  if (awayMinutes < config.returnAwayMinutes) {
    savePerceptionState(state);
    return null;
  }

  // 冷却：用独立的 lastReturnSignalAt 而不是现实桥规则的 cooldownMinutes。
  // 规则冷却拦下时信号已经被 markBridgeRuleRun 记过时间，且流水里只留一句「只存档」，
  // 用户看不出是「太频繁」还是「没配规则」；在这里拦，诊断面板能明确写原因。
  const cooldownMs = config.returnCooldownMinutes * 60000;
  if (cooldownMs > 0 && Date.now() - state.lastReturnSignalAt < cooldownMs) {
    savePerceptionState(state);
    return null;
  }

  const type = "回到手机";
  const delivered = await emitSignal({
    capability: "returnToPhone",
    type,
    payload: `离开了 ${awayMinutes} 分钟`,
  }, state);
  // 只有真投递出去才记冷却。被开关/安静时段/限流拦下时保持原值，
  // 下次回来还能补上——与停留上报同一套「被拦下不算发生过」的约定。
  if (delivered) state.lastReturnSignalAt = Date.now();
  savePerceptionState(state);
  return delivered ? type : null;
}

// ── 查询冷却 ──

/**
 * 角色调用「查看TA的手机」前的冷却检查。
 *
 * 同一角色在 queryCooldownMinutes 内重复查询会被拦下（返回剩余秒数），
 * 避免角色一句话里连查三次、既费 token 又显得神经质。
 * 冷却为 0 时视为不限制。
 */
export function checkQueryCooldown(characterId: string): { allowed: boolean; remainingSeconds: number } {
  const config = loadPerceptionConfig();
  if (config.queryCooldownMinutes <= 0) return { allowed: true, remainingSeconds: 0 };
  const state = loadPerceptionState();
  const last = state.lastQueryAt?.[characterId] ?? 0;
  const elapsed = Date.now() - last;
  const limitMs = config.queryCooldownMinutes * 60000;
  if (last > 0 && elapsed < limitMs) {
    return { allowed: false, remainingSeconds: Math.ceil((limitMs - elapsed) / 1000) };
  }
  return { allowed: true, remainingSeconds: 0 };
}

/** 记录某角色刚查询过（查询成功投递后调用）。 */
export function markQueryPerformed(characterId: string): void {
  if (!characterId) return;
  const state = loadPerceptionState();
  state.lastQueryAt = { ...(state.lastQueryAt ?? {}), [characterId]: Date.now() };
  savePerceptionState(state);
}

// ── 生命周期 ──

/** 启动引擎。幂等：重复调用不会起第二个定时器。 */
export async function startPerception(): Promise<void> {
  if (typeof window === "undefined") return;
  if (running) return;
  running = true;

  // 前台应用事件来自无障碍服务，经壳的 shell-call-overlay 通道过来。
  // 与通话浮窗共用同一条通道（ensureShellOverlayListener 幂等）。
  ensureShellOverlayListener();
  unsubscribeForeground = subscribeShellOverlayEvents(event => {
    if (event.action === "foregroundApp" && event.package) onForegroundApp(event.package);
  });

  // 前后台切换 → 「回到手机」信号。与页面可见性绑定而非 focus 事件：
  // 在安卓 WebView 里切走/切回只稳定触发 visibilitychange，focus 不一定来。
  if (typeof document !== "undefined") {
    unsubscribeVisibility = () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  const tick = () => { void sampleOnce(); };
  tick();
  timer = window.setInterval(() => {
    const config = loadPerceptionConfig();
    if (!config.enabled) return;
    tick();
  }, Math.max(20, loadPerceptionConfig().sampleSeconds) * 1000);
}

function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    markAwayFromPhone();
  } else {
    void markReturnedToPhone();
  }
}

/** 停止引擎（关掉总开关时调用）。 */
export function stopPerception(): void {
  running = false;
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
  if (unsubscribeForeground) {
    unsubscribeForeground();
    unsubscribeForeground = null;
  }
  if (unsubscribeVisibility) {
    unsubscribeVisibility();
    unsubscribeVisibility = null;
  }
}

/**
 * 配置变化后重启引擎（采样间隔可能变了，定时器要重建）。
 * 设置页保存时调用。
 */
export async function restartPerception(): Promise<void> {
  stopPerception();
  const config = loadPerceptionConfig();
  if (config.enabled) await startPerception();
}
