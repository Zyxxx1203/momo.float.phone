// 通话浮窗「快捷回复条」的配色主题。
//
// 同一条回复条有两种渲染：
//   · 安卓壳里由原生绘制（android-shell 的 CallOverlayService.ReplyTheme）；
//   · 小手机内由网页绘制（components/chat/call-mini-window.tsx）。
// 两边共用同一批主题键，用户选一次两边都变。键名必须与原生 ReplyTheme.of()
// 认得的完全一致，写错的话原生会静默回落到默认主题。
//
// 原生侧的颜色存在壳的 SharedPreferences 里（经 AndroidShell.setOverlayTheme 下发），
// 网页侧存 localStorage；在壳内读取时以壳的记录为准，保证看到的就是实际的。

import { getShellOverlayTheme, setShellOverlayTheme } from "./shell-call-overlay";

export type CallOverlayTheme = {
    key: string;
    label: string;
    /** 条身底色 */
    bar: string;
    /** 正文与输入文字 */
    text: string;
    /** 占位文字 */
    hint: string;
    /** 发送键底色 */
    accent: string;
    /** 次要按钮（收起 / 回到通话）的文字色 */
    muted: string;
};

export const CALL_OVERLAY_THEMES: CallOverlayTheme[] = [
    { key: "dark", label: "暗夜", bar: "rgba(27,27,34,0.95)", text: "#FFFFFF", hint: "#8A93A6", accent: "#3B82F6", muted: "#C9D1E0" },
    { key: "light", label: "浅色", bar: "rgba(255,255,255,0.95)", text: "#1B1B22", hint: "#8A93A6", accent: "#3B82F6", muted: "#5A6270" },
    { key: "ocean", label: "深海", bar: "rgba(14,26,43,0.95)", text: "#FFFFFF", hint: "#7E8DA6", accent: "#4C8DFF", muted: "#9FB0C9" },
    { key: "sakura", label: "樱粉", bar: "rgba(42,27,36,0.95)", text: "#FFFFFF", hint: "#B08A9C", accent: "#E56B9A", muted: "#C9A3B3" },
    { key: "bamboo", label: "青竹", bar: "rgba(21,36,25,0.95)", text: "#FFFFFF", hint: "#8AA694", accent: "#30A46C", muted: "#A3C9B3" },
    { key: "violet", label: "夜幕", bar: "rgba(29,24,43,0.95)", text: "#FFFFFF", hint: "#938AA6", accent: "#9B6BFF", muted: "#B3A9C9" },
];

export const DEFAULT_CALL_OVERLAY_THEME = "dark";

/** 主题变更事件：已挂载的网页回复条据此即时重绘（原生侧由桥自己处理） */
export const CALL_OVERLAY_THEME_EVENT = "call-overlay-theme-changed";

/** 把任意值归一成一个合法主题（认不出就回落默认，不抛错） */
export function resolveCallOverlayTheme(key: string | null | undefined): CallOverlayTheme {
    return CALL_OVERLAY_THEMES.find(item => item.key === key)
        ?? CALL_OVERLAY_THEMES.find(item => item.key === DEFAULT_CALL_OVERLAY_THEME)
        ?? CALL_OVERLAY_THEMES[0];
}

const STORAGE_KEY = "call-overlay-theme-v1";

/**
 * 读当前主题。
 * 壳内优先用壳的记录——那是原生回复条实际画出来的颜色，
 * 两边不一致时以它为准，免得设置页显示的与实际不符。
 */
export function loadCallOverlayTheme(): string {
    if (typeof window === "undefined") return DEFAULT_CALL_OVERLAY_THEME;
    try {
        const fromShell = getShellOverlayTheme();
        if (fromShell) return resolveCallOverlayTheme(fromShell).key;
    } catch {
        /* 桥不可用就当没有 */
    }
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) return resolveCallOverlayTheme(raw).key;
    } catch {
        /* 隐私模式读不了，用默认 */
    }
    return DEFAULT_CALL_OVERLAY_THEME;
}

/**
 * 存主题并即时生效（返回归一后的键）。
 * 同时下发原生（含已弹出的那条回复条）并广播给网页侧已挂载的回复条。
 */
export function saveCallOverlayTheme(key: string): string {
    const safe = resolveCallOverlayTheme(key).key;
    if (typeof window === "undefined") return safe;
    try {
        window.localStorage.setItem(STORAGE_KEY, safe);
    } catch {
        /* 存不下就算了，本次选择照样生效 */
    }
    setShellOverlayTheme(safe);
    window.dispatchEvent(new CustomEvent(CALL_OVERLAY_THEME_EVENT, { detail: { key: safe } }));
    return safe;
}

/** 订阅主题变更（组件内用），返回取消订阅函数 */
export function subscribeCallOverlayTheme(handler: (key: string) => void): () => void {
    if (typeof window === "undefined") return () => { };
    const listener = (event: Event) => {
        const key = (event as CustomEvent).detail?.key;
        if (typeof key === "string") handler(key);
    };
    window.addEventListener(CALL_OVERLAY_THEME_EVENT, listener);
    return () => window.removeEventListener(CALL_OVERLAY_THEME_EVENT, listener);
}
