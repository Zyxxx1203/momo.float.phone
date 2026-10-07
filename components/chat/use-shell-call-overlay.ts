"use client";

// 安卓壳「通话浮窗」的接线钩子：把某个通话屏接到原生浮窗上。
//
// 三个通话屏（语音/视频/群聊）需要的行为完全一样，抽到这里避免三份拷贝：
//   · 页面转入后台且处于壳内时，顶出原生浮窗（不依赖用户是否按了缩小键）；
//   · 浮窗事件回灌：tick 校准时长、reply 走对话轮、restore 回全屏、hangup 挂断；
//   · 页面后台期间定期把网页侧时长回灌给原生；
//   · 卸载时收掉浮窗（否则桌面留一个点不动的悬空小窗）；
//   · 未授权浮窗权限时给出引导标记。
//
// 回调与「取当前时长」都用 ref 持有：它们依赖每秒变化的通话状态，
// 若进依赖会让订阅与浮窗每秒重建一次。

import { useEffect, useRef, useState } from "react";

import {
    ensureShellOverlayListener,
    requestOverlayPermission,
    startShellCallOverlay,
    stopShellCallOverlay,
    subscribeShellOverlayEvents,
    supportsCallOverlay,
    updateShellCallOverlay,
} from "@/lib/shell-call-overlay";

type UseShellCallOverlayParams = {
    /** 通话是否已接通（CONNECTING / ENDED 之外的状态） */
    active: boolean;
    /** 浮窗上的通话类型文字，如「语音通话」「群视频通话 (4人)」 */
    label: string;
    name: string;
    avatar: string | null;
    /** 读当前已通话秒数（用 getter 而不是值：值每秒都变，进依赖会重建浮窗） */
    getDuration: () => number;
    /** 原生浮窗里的快捷回复：应与界面输入走同一条通路 */
    onReply: (text: string) => void;
    onHangup: () => void;
    onRestore?: () => void;
    /** 原生计时校准（调用方应只前进不后退） */
    onTick: (seconds: number) => void;
};

/**
 * 接入原生通话浮窗。
 *
 * 调用位置要求：放在 onReply / onHangup 所引用的函数定义之后，
 * 否则会撞上 const 的暂时性死区（渲染时直接抛错）。
 */
export function useShellCallOverlay(params: UseShellCallOverlayParams) {
    const supported = typeof window !== "undefined" && supportsCallOverlay();
    const [pageHidden, setPageHidden] = useState(false);
    const [showPermissionHint, setShowPermissionHint] = useState(false);

    // 本次通话的 id：原生事件带上它，用来确认事件属于当前这一通
    const callIdRef = useRef(`call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    // 回调与取值的 ref 快照（每次渲染刷新，effect 里读最新值）
    const handlersRef = useRef(params);
    handlersRef.current = params;

    useEffect(() => {
        if (typeof document === "undefined") return;
        const onVisibility = () => setPageHidden(document.visibilityState === "hidden");
        document.addEventListener("visibilitychange", onVisibility);
        onVisibility();
        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, []);

    // 顶出 / 收起浮窗
    useEffect(() => {
        if (!supported) return;
        if (!params.active) {
            stopShellCallOverlay();
            return;
        }
        // App 在前台不顶浮窗：界面内的通话屏已够用，省得两层叠着
        if (!pageHidden) {
            setShowPermissionHint(false);
            stopShellCallOverlay();
            return;
        }
        const allowed = startShellCallOverlay({
            name: params.name,
            avatar: params.avatar,
            // {{time}} 交给原生替换成它自己维护的计时：WebView 被冻结也不停
            meta: [params.label, "{{time}}"],
            callId: callIdRef.current,
            // 带上网页已通话秒数，否则原生从 0 起数，两边时长对不上
            elapsedSeconds: params.getDuration(),
        });
        setShowPermissionHint(!allowed);
    }, [supported, pageHidden, params.active, params.name, params.avatar, params.label]);

    // 后台期间定期回灌时长，纠正两边漂移
    useEffect(() => {
        if (!supported || !pageHidden || !params.active) return;
        const timer = window.setInterval(() => {
            const handlers = handlersRef.current;
            updateShellCallOverlay({
                name: handlers.name,
                avatar: handlers.avatar,
                meta: [handlers.label, "{{time}}"],
                elapsedSeconds: handlers.getDuration(),
            });
        }, 10000);
        return () => window.clearInterval(timer);
    }, [supported, pageHidden, params.active]);

    // 原生事件回灌
    useEffect(() => {
        if (!supported) return;
        ensureShellOverlayListener();
        return subscribeShellOverlayEvents((event) => {
            // 只认当前这一通的事件，换通话后旧事件丢弃
            if (event.callId && event.callId !== callIdRef.current) return;
            const handlers = handlersRef.current;
            switch (event.action) {
                case "reply": {
                    const text = (event.text || "").trim();
                    if (text) handlers.onReply(text);
                    return;
                }
                case "tick": {
                    if (typeof event.seconds === "number") handlers.onTick(event.seconds);
                    return;
                }
                case "restore":
                    handlers.onRestore?.();
                    return;
                case "hangup":
                    handlers.onHangup();
                    return;
                case "needPermission":
                    setShowPermissionHint(true);
                    return;
                default:
                    return;
            }
        });
    }, [supported]);

    // 卸载时收掉浮窗
    useEffect(() => {
        if (!supported) return;
        return () => { stopShellCallOverlay(); };
    }, [supported]);

    return {
        /** 壳内但浮窗权限未开：界面应给一条授权引导 */
        showPermissionHint,
        dismissPermissionHint: () => setShowPermissionHint(false),
        requestPermission: requestOverlayPermission,
        /** 壳是否支持原生浮窗（普通浏览器为 false） */
        supported,
    };
}
