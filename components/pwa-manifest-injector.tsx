"use client";

import { useEffect } from "react";

import { getRuntimePwaDisplayMode, readPwaDisplayPreference, PWA_DISPLAY_MODE_CHANGED_EVENT } from "@/lib/pwa-display-mode";

/** android-shell 壳的 WebView UA 后缀标识（见 MainActivity.kt 的 userAgentString 拼接）。 */
const FLOAT_SHELL_UA_MARK = "FloatShell/";

type AndroidShellBridge = {
  getStatusBarHeightPx?: () => number;
};

function readAndroidShellBridge(): AndroidShellBridge | null {
  const bridge = (window as unknown as { AndroidShell?: AndroidShellBridge }).AndroidShell;
  return bridge ?? null;
}

/**
 * android-shell 的 WebView 隐藏了系统状态栏，但网页内容画不进那块物理安全区——
 * 页面自己的虚拟状态栏会被晾在屏幕最顶，与系统状态栏区域重叠/错位，表现为顶部一块异色区域。
 * 壳侧（MainActivity.kt）实测真实状态栏高度后用 JS 注入 --android-shell-status-bar-height，
 * 这里接住它并同步写成 phone-shell.css 消费的 --status-bar-drop，不依赖用户手动调参数。
 * 非 FloatShell 壳环境（普通浏览器/iOS）完全不触发，--status-bar-drop 保持默认 0px。
 */
function applyAndroidShellStatusBarDrop(): (() => void) | void {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;
  if (!navigator.userAgent.includes(FLOAT_SHELL_UA_MARK)) return;

  const root = document.documentElement;
  const setDrop = (px: number) => {
    if (px > 0) root.style.setProperty("--status-bar-drop", `${px}px`);
  };

  // 事件注入路径：壳在 onPageFinished / insets 变化时主动 dispatch，覆盖首载与旋转等场景。
  const handleStatusBarHeightEvent = (event: Event) => {
    const detail = (event as CustomEvent<number>).detail;
    if (typeof detail === "number") setDrop(detail);
  };
  window.addEventListener("floatshell-statusbarheight", handleStatusBarHeightEvent);

  // 兜底：JS bridge 可能比事件先就位，主动查一次当前值（壳未实测完时返回 0，被 setDrop 忽略）。
  const bridge = readAndroidShellBridge();
  if (bridge?.getStatusBarHeightPx) {
    try {
      setDrop(bridge.getStatusBarHeightPx());
    } catch {
      // bridge 调用异常时静默忽略，保持默认 0px，不影响非壳环境
    }
  }

  return () => window.removeEventListener("floatshell-statusbarheight", handleStatusBarHeightEvent);
}

/**
 * 临时诊断条：定位黑块根因用，确认问题后应移除。
 * 用 position:fixed + 很高的 z-index 固定在物理屏幕最顶，不受 --status-bar-drop 影响，
 * 这样不管黑块是什么原因造成的，这条诊断信息本身始终可见。
 */
function mountDebugBanner() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (!navigator.userAgent.includes(FLOAT_SHELL_UA_MARK)) return;

  const banner = document.createElement("div");
  banner.id = "__floatshell_debug_banner";
  banner.style.cssText = [
    "position:fixed", "top:0", "left:0", "right:0", "z-index:2147483647",
    "background:#ff2d55", "color:#fff", "font-size:11px", "line-height:1.4",
    "font-family:monospace", "padding:4px 6px", "white-space:pre-wrap",
    "pointer-events:none",
  ].join(";");
  document.body.appendChild(banner);

  const render = () => {
    const bridge = readAndroidShellBridge();
    const bridgeVal = bridge?.getStatusBarHeightPx ? (() => {
      try { return String(bridge.getStatusBarHeightPx!()); } catch (e) { return `err:${e}`; }
    })() : "无bridge";
    const cssVal = getComputedStyle(document.documentElement).getPropertyValue("--status-bar-drop") || "(空)";
    const inlineVal = document.documentElement.style.getPropertyValue("--status-bar-drop") || "(空)";
    banner.textContent = `UA匹配:是 | bridge值:${bridgeVal} | CSS计算值:${cssVal} | 行内设置值:${inlineVal}`;
  };

  render();
  window.addEventListener("floatshell-statusbarheight", render);
  setInterval(render, 1000);
}

export function PWAManifestInjector() {
  useEffect(() => {
    mountDebugBanner();
    const cleanupStatusBarDrop = applyAndroidShellStatusBarDrop();
    const root = document.documentElement;
    const displayModeQueries = ["fullscreen", "standalone", "minimal-ui"].map(mode => (
      window.matchMedia(`(display-mode: ${mode})`)
    ));

    const syncRuntimeDisplayMode = () => {
      // 只有用户显式选了「显示系统状态栏」才挂运行时标记。iOS 装到桌面的 PWA 永远
      // 报 standalone（不支持 fullscreen），无门控会让所有 iOS 用户静默丢失虚拟状态栏。
      if (readPwaDisplayPreference(document.cookie) === "standalone") {
        root.dataset.pwaDisplayMode = getRuntimePwaDisplayMode();
      } else {
        delete root.dataset.pwaDisplayMode;
      }
    };

    const refreshManifest = () => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
      if (!link) return;
      const base = (link.getAttribute("href") || "/manifest.webmanifest").split("?")[0];
      link.setAttribute("href", `${base}?v=${Date.now()}`);
    };

    const handleSettingsChanged = () => {
      syncRuntimeDisplayMode();
      refreshManifest();
    };

    syncRuntimeDisplayMode();
    refreshManifest();
    document.addEventListener("fullscreenchange", syncRuntimeDisplayMode);
    window.addEventListener("pageshow", syncRuntimeDisplayMode);
    window.addEventListener(PWA_DISPLAY_MODE_CHANGED_EVENT, handleSettingsChanged);
    displayModeQueries.forEach(query => query.addEventListener("change", syncRuntimeDisplayMode));

    return () => {
      cleanupStatusBarDrop?.();
      document.removeEventListener("fullscreenchange", syncRuntimeDisplayMode);
      window.removeEventListener("pageshow", syncRuntimeDisplayMode);
      window.removeEventListener(PWA_DISPLAY_MODE_CHANGED_EVENT, handleSettingsChanged);
      displayModeQueries.forEach(query => query.removeEventListener("change", syncRuntimeDisplayMode));
      delete root.dataset.pwaDisplayMode;
    };
  }, []);

  return null;
}
