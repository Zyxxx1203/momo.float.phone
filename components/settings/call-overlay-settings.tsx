"use client";

// 通话浮窗外观设置。
//
// 目前只一项：长按浮窗弹出的快捷回复条的配色。颜色在壳里由原生绘制
//（CallOverlayService.ReplyTheme），网页侧小窗的回复条也读同一套键，
// 所以选一次两边都变。
//
// 非壳环境（普通浏览器 / PWA）下没有原生回复条，但网页侧的小窗回复条
// 照样吃这套主题，所以这里不禁用，只是加一句说明。

import { useEffect, useState } from "react";
import { Check } from "lucide-react";

import {
    CALL_OVERLAY_THEMES,
    loadCallOverlayTheme,
    saveCallOverlayTheme,
    subscribeCallOverlayTheme,
} from "@/lib/call-overlay-theme";
import { isShellEnvironment } from "@/lib/shell-call-overlay";

export function CallOverlaySettings({ onNotice }: { onNotice: (msg: string) => void }) {
    const [themeKey, setThemeKey] = useState(() => loadCallOverlayTheme());
    const [inShell, setInShell] = useState(false);

    useEffect(() => {
        setInShell(isShellEnvironment());
    }, []);

    // 别处改了主题（例如另一个页面）也跟着刷新选中项
    useEffect(() => subscribeCallOverlayTheme(key => setThemeKey(key)), []);

    const choose = (key: string) => {
        const saved = saveCallOverlayTheme(key);
        setThemeKey(saved);
        onNotice(`通话浮窗已切换为「${CALL_OVERLAY_THEMES.find(t => t.key === saved)?.label ?? saved}」`);
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="app-card p-4 flex flex-col gap-3">
                <div>
                    <div className="ts-14 font-semibold">快捷回复条配色</div>
                    <div className="ts-12 mt-1" style={{ color: "var(--c-text)", opacity: 0.75 }}>
                        长按通话浮窗弹出的那条输入框。选一套，立刻生效，下次通话沿用。
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    {CALL_OVERLAY_THEMES.map(theme => {
                        const active = theme.key === themeKey;
                        return (
                            <button
                                key={theme.key}
                                type="button"
                                onClick={() => choose(theme.key)}
                                aria-pressed={active}
                                style={{
                                    position: "relative",
                                    border: active ? "2px solid var(--c-accent)" : "1px solid rgba(128,128,128,0.28)",
                                    borderRadius: 12,
                                    padding: 8,
                                    background: "transparent",
                                    cursor: "pointer",
                                    textAlign: "left",
                                }}
                            >
                                {/* 迷你预览：与真实回复条同构，所见即所得 */}
                                <div
                                    style={{
                                        display: "flex", alignItems: "center", gap: 5,
                                        borderRadius: 9, padding: "6px 7px",
                                        background: theme.bar,
                                    }}
                                >
                                    <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: theme.hint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                        说点什么…
                                    </span>
                                    <span
                                        style={{
                                            flexShrink: 0, fontSize: 10.5, fontWeight: 600,
                                            color: "#fff", background: theme.accent,
                                            borderRadius: 6, padding: "3px 7px",
                                        }}
                                    >
                                        发送
                                    </span>
                                    <span style={{ flexShrink: 0, fontSize: 10.5, color: theme.muted }}>收起</span>
                                </div>
                                <div className="flex items-center gap-1" style={{ marginTop: 6 }}>
                                    <span className="ts-12 font-semibold" style={{ color: active ? "var(--c-accent)" : "var(--c-text-title)" }}>
                                        {theme.label}
                                    </span>
                                    {active && <Check size={13} style={{ color: "var(--c-accent)" }} />}
                                </div>
                            </button>
                        );
                    })}
                </div>

                {!inShell && (
                    <div className="ts-12" style={{ color: "var(--c-text)", opacity: 0.7 }}>
                        当前不在安卓壳里，所以只影响小手机内的小窗回复条；在壳里打开时会同时换掉桌面浮窗那条。
                    </div>
                )}
            </div>

            <div className="app-card p-4 flex flex-col gap-2">
                <div className="ts-14 font-semibold">手势说明</div>
                <div className="ts-12 flex flex-col gap-1" style={{ color: "var(--c-text)" }}>
                    <span>· 轻点浮窗：回到全屏通话</span>
                    <span>· 按住拖动：挪位置（右下角拖拽缩放）</span>
                    <span>· 长按浮窗：就地弹出回复条，不跳回通话界面</span>
                </div>
            </div>
        </div>
    );
}
