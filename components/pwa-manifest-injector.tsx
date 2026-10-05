"use client";

import { useEffect } from "react";

import { getRuntimePwaDisplayMode, readPwaDisplayPreference, PWA_DISPLAY_MODE_CHANGED_EVENT } from "@/lib/pwa-display-mode";

/**
 * 壳环境不再做「状态栏占位上移」补位。
 *
 * 早期壳在隐藏系统状态栏后画不进挖孔区，页面顶部会露出一条黑边，于是用壳实测的
 * 状态栏高度去顶 --status-bar-drop、把整块画面上移。现在壳侧已用
 * decorFitsSystemWindows=false + 挖孔区 shortEdges 让 WebView 真正铺满整屏，
 * 视口就从物理屏幕顶边开始，再上移只会裁掉虚拟状态栏、底部露白。
 * --status-bar-drop 交回给「主题 → 状态栏」的手动微调（默认 0）。
 */

export function PWAManifestInjector() {
  useEffect(() => {
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
      document.removeEventListener("fullscreenchange", syncRuntimeDisplayMode);
      window.removeEventListener("pageshow", syncRuntimeDisplayMode);
      window.removeEventListener(PWA_DISPLAY_MODE_CHANGED_EVENT, handleSettingsChanged);
      displayModeQueries.forEach(query => query.removeEventListener("change", syncRuntimeDisplayMode));
      delete root.dataset.pwaDisplayMode;
    };
  }, []);

  return null;
}
