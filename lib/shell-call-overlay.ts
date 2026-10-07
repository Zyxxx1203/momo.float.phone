// lib/shell-call-overlay.ts
//
// 网页 ↔ 安卓壳「通话浮窗」桥。
//
// 背景：网页里的小窗出不了浏览器窗口，切到别的 App 就看不见了。壳侧新增了
// CallOverlayService（WindowManager + TYPE_APPLICATION_OVERLAY），能把通话
// 做成真正浮在其他 App 上层的原生小窗。本模块是它在网页侧的对接层。
//
// 四个方向：
//   1. 网页 → 原生：start/update/stop（window.AndroidShell）；
//   2. 原生 → 网页：window 上的 'shell-call-overlay' CustomEvent；
//   3. 权限引导：浮窗权限、无障碍未开时给出跳转入口；
//   4. 测试链路：debug 面板可查看最近事件，排查用。
//
// 全部 API 在非壳环境（普通浏览器）下安全降级为 no-op，调用方无需分支判断。

import { useEffect, useState } from "react";

type ShellBridgeLike = {
    getVersion?: () => string;
    canDrawOverlay?: () => boolean;
    requestOverlayPermission?: () => void;
    startCallOverlay?: (name: string, avatar: string, meta: string, callId: string, elapsedSeconds: number) => boolean;
    updateCallOverlay?: (name: string, avatar: string, meta: string, elapsedSeconds: number) => void;
    stopCallOverlay?: () => void;
    isAccessibilityConnected?: () => boolean;
    openAccessibilitySettings?: () => void;
};

/** 原生浮窗事件 */
export type ShellOverlayAction = "restore" | "hangup" | "reply" | "tick" | "needPermission" | "accessibility" | "foregroundApp";

export type ShellOverlayEvent = {
    action: ShellOverlayAction;
    /** action='reply' 时的文本 */
    text?: string;
    /** action='tick' 时的通话秒数（原生计时，后台也走） */
    seconds?: number;
    /** 本次通话 id，用于校验事件属于哪一通 */
    callId?: string;
    /** action='foregroundApp' 时的前台包名 */
    package?: string;
};

/** 原生事件到达时触发（跨页面/跨组件订阅用） */
export const SHELL_OVERLAY_EVENT = "shell-call-overlay";

function bridge(): ShellBridgeLike | null {
    if (typeof window === "undefined") return null;
    const candidate = (window as unknown as { AndroidShell?: ShellBridgeLike }).AndroidShell;
    return candidate && typeof candidate === "object" ? candidate : null;
}

/** 是否运行在安卓壳里（普通浏览器 / PWA 返回 false） */
export function isShellEnvironment(): boolean {
    return bridge() !== null;
}

/** 壳是否支持通话浮窗（老版本 APK 没有这些方法） */
export function supportsCallOverlay(): boolean {
    const b = bridge();
    return !!b && typeof b.startCallOverlay === "function";
}

/** 浮窗权限是否已授予（非壳环境恒为 false） */
export function canDrawOverlay(): boolean {
    return !!bridge()?.canDrawOverlay?.();
}

/** 跳到系统「显示在其他应用上层」授权页 */
export function requestOverlayPermission(): void {
    bridge()?.requestOverlayPermission?.();
}

/** 无障碍服务是否已开启 */
export function isAccessibilityConnected(): boolean {
    return !!bridge()?.isAccessibilityConnected?.();
}

/** 跳到系统「无障碍」设置页 */
export function openAccessibilitySettings(): void {
    bridge()?.openAccessibilitySettings?.();
}

/** 让原生开一个通话浮窗。返回 false 表示没有浮窗权限（需要引导授权）。 */
export function startShellCallOverlay(params: {
    name: string;
    avatar?: string | null;
    meta?: string[];
    callId: string;
    /** 网页侧已通话秒数。浮窗是切到后台才建的，必须带上基准，
     *  否则原生从 0 起数，和网页计时两套并行、时长对不上。 */
    elapsedSeconds?: number;
}): boolean {
    const b = bridge();
    if (!b?.startCallOverlay) return false;
    try {
        return !!b.startCallOverlay(
            params.name,
            params.avatar || "",
            (params.meta ?? []).join("\n"),
            params.callId,
            Math.max(0, Math.floor(params.elapsedSeconds ?? 0)),
        );
    } catch {
        return false;
    }
}

/** 更新浮窗内容（名称/头像/时长），不重建窗口 */
export function updateShellCallOverlay(params: {
    name: string;
    avatar?: string | null;
    meta?: string[];
    elapsedSeconds?: number;
}): void {
    const b = bridge();
    if (!b?.updateCallOverlay) return;
    try {
        b.updateCallOverlay(
            params.name,
            params.avatar || "",
            (params.meta ?? []).join("\n"),
            Math.max(0, Math.floor(params.elapsedSeconds ?? 0)),
        );
    } catch {
        /* 浮窗不在或 WebView 已销毁，忽略 */
    }
}

/** 收掉原生浮窗 */
export function stopShellCallOverlay(): void {
    const b = bridge();
    if (!b?.stopCallOverlay) return;
    try {
        b.stopCallOverlay();
    } catch {
        /* 忽略 */
    }
}

// ── 事件订阅 ──

type Listener = (event: ShellOverlayEvent) => void;
const listeners = new Set<Listener>();

/**
 * 订阅原生浮窗事件。返回取消订阅函数。
 * 用模块级 Set 而不是每次 addEventListener：多个组件（通话屏、全局层、调试面板）
 * 同时监听时，window 上只挂一个真正的监听器，退出时也不容易漏删。
 */
export function subscribeShellOverlayEvents(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

let domListenerInstalled = false;

/** 把 window 上的 CustomEvent 转成模块内订阅（只装一次） */
export function ensureShellOverlayListener(): void {
    if (typeof window === "undefined" || domListenerInstalled) return;
    domListenerInstalled = true;
    window.addEventListener(SHELL_OVERLAY_EVENT, (event) => {
        const detail = (event as CustomEvent).detail as ShellOverlayEvent | undefined;
        if (!detail || typeof detail.action !== "string") return;
        recordOverlayTrace(detail);
        listeners.forEach((listener) => {
            try {
                listener(detail);
            } catch (error) {
                console.warn("[shell-call-overlay] 监听器异常", error);
            }
        });
    });
}

// ── 测试链路：最近事件留痕 ──
//
// 浮窗出问题时最难查的是「事件到底有没有从原生过来」。这里在模块级留一小段
// 环形缓冲，设置页/调试面板可以直接读，不必连 USB 调试。

const TRACE_LIMIT = 40;
const traceBuffer: Array<{ at: number; event: ShellOverlayEvent }> = [];

function recordOverlayTrace(event: ShellOverlayEvent): void {
    traceBuffer.push({ at: Date.now(), event });
    if (traceBuffer.length > TRACE_LIMIT) traceBuffer.splice(0, traceBuffer.length - TRACE_LIMIT);
    // 挂到 window 上一份，方便在远程调试控制台直接看
    if (typeof window !== "undefined") {
        (window as unknown as { __shellOverlayTrace?: unknown }).__shellOverlayTrace = traceBuffer;
    }
}

/** 读取最近的原生浮窗事件（调试用） */
export function readShellOverlayTrace(): Array<{ at: number; event: ShellOverlayEvent }> {
    return [...traceBuffer];
}

/** 清空事件留痕 */
export function clearShellOverlayTrace(): void {
    traceBuffer.length = 0;
}

/**
 * 环境自检：一次性返回壳/权限/无障碍状态，用于「浮窗设置」页展示与排障。
 * 每次调用都重新问原生，不做缓存——用户在系统设置里授权后回来要能立刻看到变化。
 */
export function inspectShellOverlay(): {
    inShell: boolean;
    supported: boolean;
    canDraw: boolean;
    accessibility: boolean;
    version: string;
} {
    const b = bridge();
    return {
        inShell: !!b,
        supported: supportsCallOverlay(),
        canDraw: canDrawOverlay(),
        accessibility: isAccessibilityConnected(),
        version: b?.getVersion?.() ?? "",
    };
}

// ── React 便捷钩子 ──

/** 订阅原生浮窗事件（组件内用）。handler 变化不会重装监听。 */
export function useShellOverlayEvents(handler: (event: ShellOverlayEvent) => void): void {
    useEffect(() => {
        ensureShellOverlayListener();
        const unsubscribe = subscribeShellOverlayEvents(handler);
        return unsubscribe;
        // handler 走 ref 语义：这里只订阅一次，避免每次渲染重装
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
}

/** 环境与权限状态（进设置页时刷新一次；提供 refresh 供用户授权后手动重查） */
export function useShellOverlayStatus(): [ReturnType<typeof inspectShellOverlay>, () => void] {
    const [status, setStatus] = useState<ReturnType<typeof inspectShellOverlay>>(() => inspectShellOverlay());
    const refresh = () => setStatus(inspectShellOverlay());
    useEffect(() => {
        ensureShellOverlayListener();
        // 从系统设置页返回时（页面重新可见）自动刷新一次权限状态
        const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
    }, []);
    return [status, refresh];
}
