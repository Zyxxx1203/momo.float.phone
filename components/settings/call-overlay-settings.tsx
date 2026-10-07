"use client";

// 通话浮窗外观设置。
//
// 两层结构：
//   · 选预设 —— 一键换整套配色（6 套）；
//   · 逐项自定义 —— 想单独调某一级颜色（条身/文字/占位/发送键/发送文字/次要文字），
//     改动叠加在预设之上，没动到的项仍跟随预设。
// 两边渲染共用同一份配色：壳里由原生绘制（CallOverlayService.ReplyTheme），
// 小手机内由网页绘制（components/chat/call-mini-window.tsx），改一次两边都变。

import { useEffect, useState } from "react";
import { Check } from "lucide-react";

import {
    CALL_OVERLAY_THEMES,
    type CallOverlayColors,
    loadCallOverlayColors,
    loadCallOverlayCustomColors,
    loadCallOverlayTheme,
    saveCallOverlayCustomColors,
    saveCallOverlayTheme,
    subscribeCallOverlayTheme,
} from "@/lib/call-overlay-theme";
import {
    isShellEnvironment,
    openAccessibilitySettings,
    readShellOverlayTrace,
    requestOverlayPermission,
    supportsOverlayCustomColors,
    useShellOverlayStatus,
} from "@/lib/shell-call-overlay";

/** 可逐项自定义的颜色字段（不含 barAlpha，它单独用滑杆） */
const COLOR_FIELDS: Array<{ key: keyof Omit<CallOverlayColors, "barAlpha">; label: string; hint: string }> = [
    { key: "bar", label: "条身底色", hint: "回复条背景" },
    { key: "text", label: "输入文字", hint: "你打进去的字" },
    { key: "hint", label: "占位文字", hint: "「说点什么…」" },
    { key: "accent", label: "发送键底色", hint: "发送按钮背景" },
    { key: "sendText", label: "发送键文字", hint: "「发送」二字" },
    { key: "muted", label: "次要文字", hint: "「收起」" },
];

export function CallOverlaySettings({ onNotice }: { onNotice: (msg: string) => void }) {
    const [themeKey, setThemeKey] = useState(() => loadCallOverlayTheme());
    const [colors, setColors] = useState<CallOverlayColors>(() => loadCallOverlayColors());
    const [custom, setCustom] = useState<Partial<CallOverlayColors> | null>(() => loadCallOverlayCustomColors());
    const [inShell, setInShell] = useState(false);
    const [supportsCustom, setSupportsCustom] = useState(true);
    const [status, refreshStatus] = useShellOverlayStatus();
    const [trace, setTrace] = useState(() => readShellOverlayTrace());

    useEffect(() => {
        setInShell(isShellEnvironment());
        setSupportsCustom(supportsOverlayCustomColors());
    }, []);

    // 别处改了配色（原生侧或另一页面）也跟着刷新
    useEffect(() => subscribeCallOverlayTheme(key => {
        setThemeKey(key);
        setColors(loadCallOverlayColors());
        setCustom(loadCallOverlayCustomColors());
    }), []);

    // 诊断区随权限状态刷新一起拉最新留痕：用户从系统设置授权后回来，
    // 一眼能看到权限变了没、原生事件有没有到过。
    useEffect(() => { setTrace(readShellOverlayTrace()); }, [status]);

    const choose = (key: string) => {
        // 换预设 = 回到该预设原样，清掉之前的逐项改动（否则会串味，用户会困惑）
        const saved = saveCallOverlayTheme(key);
        setThemeKey(saved);
        setCustom(null);
        setColors(loadCallOverlayColors());
        onNotice(`通话浮窗已切换为「${CALL_OVERLAY_THEMES.find(t => t.key === saved)?.label ?? saved}」`);
    };

    const changeColor = (key: keyof Omit<CallOverlayColors, "barAlpha">, value: string) => {
        const next = { ...(custom ?? {}), [key]: value };
        setCustom(next);
        saveCallOverlayCustomColors(next);
        setColors(loadCallOverlayColors());
    };

    const changeAlpha = (value: number) => {
        const next = { ...(custom ?? {}), barAlpha: value };
        setCustom(next);
        saveCallOverlayCustomColors(next);
        setColors(loadCallOverlayColors());
    };

    const resetCustom = () => {
        setCustom(null);
        saveCallOverlayCustomColors(null);
        setColors(loadCallOverlayColors());
        onNotice("已回到预设原样");
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="app-card p-4 flex flex-col gap-3">
                <div>
                    <div className="ts-14 font-semibold">预设配色</div>
                    <div className="ts-12 mt-1" style={{ color: "var(--c-text)", opacity: 0.75 }}>
                        选一套打底。想单独调某一级颜色，用下面的「逐项颜色」。
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
                                        background: theme.colors.bar,
                                    }}
                                >
                                    <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: theme.colors.hint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                        说点什么…
                                    </span>
                                    <span
                                        style={{
                                            flexShrink: 0, fontSize: 10.5, fontWeight: 600,
                                            color: theme.colors.sendText, background: theme.colors.accent,
                                            borderRadius: 6, padding: "3px 7px",
                                        }}
                                    >
                                        发送
                                    </span>
                                    <span style={{ flexShrink: 0, fontSize: 10.5, color: theme.colors.muted }}>收起</span>
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
            </div>

            <div className="app-card p-4 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <div className="ts-14 font-semibold">逐项颜色</div>
                        <div className="ts-12 mt-1" style={{ color: "var(--c-text)", opacity: 0.75 }}>
                            单改某一级颜色。没改的项仍跟随上面的预设。
                        </div>
                    </div>
                    {custom && (
                        <button
                            type="button"
                            className="ts-12"
                            onClick={resetCustom}
                            style={{ flexShrink: 0, border: "1px solid rgba(128,128,128,0.3)", borderRadius: 10, padding: "5px 10px", background: "transparent", color: "var(--c-text)", cursor: "pointer" }}
                        >
                            恢复预设
                        </button>
                    )}
                </div>

                {/* 实时预览：改完立即看到整条的样子 */}
                <div
                    style={{
                        display: "flex", alignItems: "center", gap: 6,
                        borderRadius: 12, padding: "8px 9px",
                        background: `rgba(${hexToRgbTriplet(colors.bar)}, ${colors.barAlpha})`,
                    }}
                >
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: colors.hint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        说点什么…
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, color: colors.sendText, background: colors.accent, borderRadius: 8, padding: "4px 10px" }}>
                        发送
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 12, color: colors.muted }}>收起</span>
                </div>

                {COLOR_FIELDS.map(field => (
                    <div key={field.key} className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <div className="ts-13">{field.label}</div>
                            <div className="ts-12" style={{ color: "var(--c-text)", opacity: 0.6 }}>{field.hint}</div>
                        </div>
                        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
                            <span className="ts-12" style={{ color: "var(--c-text)", opacity: 0.7, fontFamily: "monospace" }}>
                                {colors[field.key]}
                            </span>
                            <input
                                type="color"
                                value={normalizeForPicker(colors[field.key])}
                                onChange={(event) => changeColor(field.key, event.target.value.toUpperCase())}
                                aria-label={field.label}
                                style={{ width: 34, height: 28, border: "1px solid rgba(128,128,128,0.3)", borderRadius: 8, background: "transparent", cursor: "pointer", padding: 2 }}
                            />
                        </div>
                    </div>
                ))}

                {/* 条身透明度单独一项：原生把底色存成 #RRGGBB + alpha，
                    网页侧拼 rgba，两边同一个值。 */}
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <div className="ts-13">条身不透明度</div>
                        <div className="ts-12" style={{ color: "var(--c-text)", opacity: 0.6 }}>
                            太低会透出后面的内容
                        </div>
                    </div>
                    <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
                        <input
                            type="range"
                            min={0.3}
                            max={1}
                            step={0.01}
                            value={colors.barAlpha}
                            onChange={(event) => changeAlpha(Number(event.target.value))}
                            aria-label="条身不透明度"
                            style={{ width: 110 }}
                        />
                        <span className="ts-12" style={{ color: "var(--c-text)", opacity: 0.7, width: 34, textAlign: "right" }}>
                            {Math.round(colors.barAlpha * 100)}%
                        </span>
                    </div>
                </div>

                {inShell && !supportsCustom && (
                    <div className="ts-12" style={{ color: "var(--c-warning, #E5A03B)" }}>
                        当前 APK 版本较旧，桌面浮窗那条暂不支持逐项颜色（仍可用预设）。更新 APK 后生效。
                    </div>
                )}
                {!inShell && (
                    <div className="ts-12" style={{ color: "var(--c-text)", opacity: 0.7 }}>
                        当前不在安卓壳里，所以只影响小手机内的小窗回复条；在壳里打开时会同时换掉桌面浮窗那条。
                    </div>
                )}
            </div>

            <div className="app-card p-4 flex flex-col gap-3">
                <div>
                    <div className="ts-14 font-semibold">诊断</div>
                    <div className="ts-12 mt-1" style={{ color: "var(--c-text)", opacity: 0.75 }}>
                        浮窗不出现时先看这里：权限没开会标红；切出去再回来，事件列表里应能看到原生推来的消息。
                    </div>
                </div>

                <div className="flex flex-col gap-1 ts-12" style={{ color: "var(--c-text)" }}>
                    <span>壳环境：{status.inShell ? `是（v${status.version || "?"}）` : "否（普通浏览器）"}</span>
                    <span>支持浮窗：{status.supported ? "是" : "否（壳版本过旧）"}</span>
                    <span>
                        浮窗权限：
                        <strong style={{ color: status.canDraw ? "var(--c-success, #30A46C)" : "var(--c-danger, #E5484D)" }}>
                            {status.canDraw ? "已开启" : "未开启"}
                        </strong>
                    </span>
                    <span>
                        无障碍：
                        <strong style={{ color: status.accessibility ? "var(--c-success, #30A46C)" : "var(--c-text)" }}>
                            {status.accessibility ? "已开启" : "未开启"}
                        </strong>
                    </span>
                </div>

                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        className="ts-12"
                        onClick={() => { requestOverlayPermission(); }}
                        style={{ border: "1px solid rgba(128,128,128,0.3)", borderRadius: 10, padding: "6px 12px", background: "transparent", color: "var(--c-text-title)", cursor: "pointer" }}
                    >
                        去开浮窗权限
                    </button>
                    <button
                        type="button"
                        className="ts-12"
                        onClick={() => { openAccessibilitySettings(); }}
                        style={{ border: "1px solid rgba(128,128,128,0.3)", borderRadius: 10, padding: "6px 12px", background: "transparent", color: "var(--c-text-title)", cursor: "pointer" }}
                    >
                        去开无障碍
                    </button>
                    <button
                        type="button"
                        className="ts-12"
                        onClick={() => { refreshStatus(); setTrace(readShellOverlayTrace()); }}
                        style={{ border: "1px solid rgba(128,128,128,0.3)", borderRadius: 10, padding: "6px 12px", background: "transparent", color: "var(--c-text-title)", cursor: "pointer" }}
                    >
                        重新检测
                    </button>
                </div>

                <div className="flex flex-col gap-1">
                    <div className="ts-12" style={{ color: "var(--c-text)", opacity: 0.75 }}>
                        最近的浮窗事件（{trace.length} 条）
                    </div>
                    {trace.length === 0 ? (
                        <div className="ts-12" style={{ color: "var(--c-text)", opacity: 0.6 }}>
                            还没有收到过原生事件。通话时切出去再回来，这里应该会出现 tick / restore 之类的记录。
                        </div>
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 190, overflowY: "auto" }}>
                            {[...trace].reverse().map((item, index) => (
                                <div key={`${item.at}-${index}`} className="ts-12" style={{ display: "flex", gap: 8, color: "var(--c-text)" }}>
                                    <span style={{ opacity: 0.6, flexShrink: 0 }}>
                                        {new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false })}
                                    </span>
                                    <span style={{ fontWeight: 600, flexShrink: 0 }}>{item.event.action}</span>
                                    <span style={{ opacity: 0.8, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        {item.event.text ? `「${item.event.text}」` : ""}
                                        {typeof item.event.seconds === "number" ? ` ${item.event.seconds}s` : ""}
                                        {item.event.package ? ` ${item.event.package}` : ""}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
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

/** #RRGGBB → "R, G, B"（拼 rgba 用）；非法值给白，保证预览不崩 */
function hexToRgbTriplet(hex: string): string {
    const value = hex.replace("#", "");
    if (value.length !== 6) return "255, 255, 255";
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    if ([r, g, b].some(Number.isNaN)) return "255, 255, 255";
    return `${r}, ${g}, ${b}`;
}

/** <input type="color"> 只认小写 #rrggbb；大写会让它回落到 #000000 */
function normalizeForPicker(hex: string): string {
    return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : "#000000";
}
