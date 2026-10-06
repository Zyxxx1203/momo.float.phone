"use client";

// 通话悬浮小窗：可拖动、可缩放，点一下回到全屏通话。
//
// 原先三个通话屏各自渲染一个位置写死的小窗（.call-mini-window）：固定在角落、
// 尺寸固定，挡着别的界面时只能忍着。这里统一成一个组件——按住拖动移动，
// 右下角拖拽缩放，位置与尺寸记在本地，下一次通话还是这个样子。
//
// 只负责「显示」：通话本身（识别 / 播放 / 计时）在各通话屏里继续跑，
// 这里是回到全屏的入口，不碰任何通话逻辑。
//
// 用 portal 挂到 body：手机壳内部有 overflow / transform 布局，
// 直接挂在里面时 fixed 定位可能被裁剪或算错参照点。

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type CallMiniWindowProps = {
    /** 小窗背景图（角色头像 / 通话背景），没有就用纯色底 */
    imageUrl?: string | null;
    title: string;
    subtitle?: string;
    ariaLabel: string;
    /** 点一下小窗（没有拖动）时回到全屏通话 */
    onRestore?: () => void;
};

const MIN_W = 88;
const MIN_H = 120;
const MAX_W = 320;
const MAX_H = 460;
const DEFAULT_W = 108;
const DEFAULT_H = 150;
/** 距屏幕边缘留白 */
const EDGE = 14;
/** 拖动判定阈值：位移超过它才算拖动，否则算点击 */
const DRAG_SLOP = 5;
const STORAGE_KEY = "call-mini-window-geometry-v1";

type Geometry = { x: number; y: number; w: number; h: number };

function viewport() {
    if (typeof window === "undefined") return { w: 390, h: 844 };
    return { w: window.innerWidth, h: window.innerHeight };
}

function clampGeometry(input: Geometry): Geometry {
    const vp = viewport();
    const maxW = Math.min(MAX_W, Math.max(MIN_W, vp.w - EDGE * 2));
    const maxH = Math.min(MAX_H, Math.max(MIN_H, vp.h - EDGE * 2));
    const w = Math.min(Math.max(input.w, MIN_W), maxW);
    const h = Math.min(Math.max(input.h, MIN_H), maxH);
    const maxX = Math.max(EDGE, vp.w - w - EDGE);
    const maxY = Math.max(EDGE, vp.h - h - EDGE);
    const x = Math.min(Math.max(input.x, EDGE), maxX);
    const y = Math.min(Math.max(input.y, EDGE), maxY);
    return { x, y, w, h };
}

/** 默认位置：右侧靠下，避开大多数 App 的底部操作栏 */
function defaultGeometry(): Geometry {
    const vp = viewport();
    return clampGeometry({
        w: DEFAULT_W,
        h: DEFAULT_H,
        x: vp.w - DEFAULT_W - EDGE,
        y: vp.h - DEFAULT_H - 150,
    });
}

function readStoredGeometry(): Geometry | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<Geometry>;
        if (typeof parsed.x !== "number" || typeof parsed.y !== "number"
            || typeof parsed.w !== "number" || typeof parsed.h !== "number") {
            return null;
        }
        if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)
            || !Number.isFinite(parsed.w) || !Number.isFinite(parsed.h)) {
            return null;
        }
        return { x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h };
    } catch {
        return null;
    }
}

export function CallMiniWindow({ imageUrl, title, subtitle, ariaLabel, onRestore }: CallMiniWindowProps) {
    const [geo, setGeo] = useState<Geometry>(() => defaultGeometry());
    const [mounted, setMounted] = useState(false);
    const geoRef = useRef(geo);
    const dragRef = useRef<{ id: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
    const resizeRef = useRef<{ id: number; startX: number; startY: number; originW: number; originH: number; moved: boolean } | null>(null);

    useEffect(() => { geoRef.current = geo; }, [geo]);
    useEffect(() => { setMounted(true); }, []);

    // 首次挂载：用记住的位置尺寸；没有（或越界）则回落默认位
    useEffect(() => {
        const stored = readStoredGeometry();
        if (stored) setGeo(clampGeometry(stored));
    }, []);

    // 旋转 / 键盘弹出导致视口变化时，把小窗拉回可见范围
    useEffect(() => {
        const onResize = () => setGeo(prev => clampGeometry(prev));
        window.addEventListener("resize", onResize);
        window.addEventListener("orientationchange", onResize);
        return () => {
            window.removeEventListener("resize", onResize);
            window.removeEventListener("orientationchange", onResize);
        };
    }, []);

    // 记位置（拖动/缩放停下来再写，省得每帧都碰 localStorage）
    useEffect(() => {
        const id = window.setTimeout(() => {
            try {
                window.localStorage.setItem(STORAGE_KEY, JSON.stringify(geo));
            } catch {
                /* 隐私模式写不了就算了，不影响这次拖动 */
            }
        }, 260);
        return () => window.clearTimeout(id);
    }, [geo]);

    const handleDragDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        // 右下角缩放柄自己处理指针，不参与拖动
        if ((event.target as HTMLElement).closest("[data-call-mini-resize]")) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: geoRef.current.x,
            originY: geoRef.current.y,
            moved: false,
        };
    }, []);

    const handleDragMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) drag.moved = true;
        if (!drag.moved) return;
        setGeo(prev => clampGeometry({ ...prev, x: drag.originX + dx, y: drag.originY + dy }));
    }, []);

    const handleDragUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        dragRef.current = null;
        // 没移动 = 点击：回全屏。拖动过就不触发，免得手一抖就跳回通话界面
        if (!drag.moved) onRestore?.();
    }, [onRestore]);

    const handleResizeDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        resizeRef.current = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originW: geoRef.current.w,
            originH: geoRef.current.h,
            moved: false,
        };
    }, []);

    const handleResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const resize = resizeRef.current;
        if (!resize || resize.id !== event.pointerId) return;
        const dx = event.clientX - resize.startX;
        const dy = event.clientY - resize.startY;
        if (!resize.moved && Math.abs(dx) + Math.abs(dy) > 2) resize.moved = true;
        setGeo(prev => clampGeometry({ ...prev, w: resize.originW + dx, h: resize.originH + dy }));
    }, []);

    const handleResizeUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const resize = resizeRef.current;
        if (!resize || resize.id !== event.pointerId) return;
        resizeRef.current = null;
    }, []);

    if (!mounted) return null;

    const node = (
        <div
            className="call-mini-window"
            style={{
                position: "fixed",
                left: geo.x,
                top: geo.y,
                right: "auto",
                bottom: "auto",
                width: geo.w,
                height: geo.h,
                margin: 0,
                padding: 0,
                border: "none",
                borderRadius: 16,
                overflow: "hidden",
                boxSizing: "border-box",
                zIndex: 9000,
                touchAction: "none",
                cursor: "grab",
                background: "#1b1b22",
                backgroundSize: "cover",
                backgroundPosition: "center",
                boxShadow: "0 10px 30px rgba(0,0,0,0.42)",
                ...(imageUrl ? { backgroundImage: `url(${imageUrl})` } : {}),
            }}
            onPointerDown={handleDragDown}
            onPointerMove={handleDragMove}
            onPointerUp={handleDragUp}
            onPointerCancel={handleDragUp}
            role="button"
            tabIndex={0}
            aria-label={ariaLabel}
            title="拖动可移动 · 右下角可缩放 · 点一下回到通话"
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onRestore?.();
                }
            }}
        >
            <span
                className="call-mini-window-overlay"
                style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,0.05) 30%, rgba(0,0,0,0.62) 100%)", pointerEvents: "none" }}
            />
            <span
                className="call-mini-window-name"
                style={{ position: "absolute", left: 0, right: 0, bottom: subtitle ? 22 : 8, textAlign: "center", fontSize: 12, fontWeight: 600, color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,0.6)", pointerEvents: "none", padding: "0 6px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            >
                {title}
            </span>
            {subtitle ? (
                <span
                    style={{ position: "absolute", left: 0, right: 0, bottom: 7, textAlign: "center", fontSize: 10.5, lineHeight: 1.1, color: "rgba(255,255,255,0.86)", textShadow: "0 1px 4px rgba(0,0,0,0.6)", pointerEvents: "none" }}
                >
                    {subtitle}
                </span>
            ) : null}
            {/* 右下角缩放柄：拖它改小窗大小 */}
            <span
                data-call-mini-resize=""
                onPointerDown={handleResizeDown}
                onPointerMove={handleResizeMove}
                onPointerUp={handleResizeUp}
                onPointerCancel={handleResizeUp}
                style={{
                    position: "absolute",
                    right: 0,
                    bottom: 0,
                    width: 28,
                    height: 28,
                    display: "flex",
                    alignItems: "flex-end",
                    justifyContent: "flex-end",
                    padding: 4,
                    cursor: "nwse-resize",
                    touchAction: "none",
                    zIndex: 3,
                    color: "rgba(255,255,255,0.9)",
                }}
                aria-hidden
            >
                <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M11 4L4 11" />
                    <path d="M11 8L8 11" />
                </svg>
            </span>
        </div>
    );

    return createPortal(node, document.body);
}
