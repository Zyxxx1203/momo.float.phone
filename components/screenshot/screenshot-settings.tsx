"use client";

// 截屏设置面板：总开关 + 无障碍引导 + 测试截屏 + 最近记录回查。
//
// 设计要点（这是全项目**最敏感**的一项能力，比设备动作更需要用户掌控）：
//  · 它读到的是你**整个屏幕**——银行余额、私聊、密码框都可能在画面里。
//    所以默认关，且界面上必须把这句话说在前面，不能藏在说明里。
//  · 状态分三层显示：系统支不支持 / 无障碍开没开 / 你开了没。
//    卡在哪一环要一眼可见——「不支持」和「没授权」是两回事。
//  · 最近记录可回查：让用户能亲眼看到「它到底截了什么」，
//    而不是只能凭信任。这也是记录列表存在的全部理由。
//
// 挂载方式与 PerceptionSettings / SystemCalendarSettings 一致：
// 直接渲染内容，不套 PageShell、不收 onBack。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, Loader2, ShieldCheck, Smartphone, Trash2 } from "lucide-react";

import { Toggle } from "@/components/ui/form";
import { loadMediaObjectUrl } from "@/lib/media-cache-storage";
import { isShellEnvironment as isShell, openAccessibilitySettings } from "@/lib/shell-call-overlay";
import {
  captureAndStoreScreenshot,
  clearAllScreenshots,
  hasScreenshotBridge,
  loadScreenshotConfig,
  loadScreenshotRecords,
  readScreenshotCapabilities,
  saveScreenshotConfig,
  type ScreenshotConfig,
  type ScreenshotRecord,
} from "@/lib/screenshot";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(at: number): string {
  try {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}

export function ScreenshotSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [config, setConfig] = useState<ScreenshotConfig>(() => loadScreenshotConfig());
  const [caps, setCaps] = useState(() => readScreenshotCapabilities());
  const [records, setRecords] = useState<ScreenshotRecord[]>(() => loadScreenshotRecords());
  const [busy, setBusy] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    setConfig(loadScreenshotConfig());
    setCaps(readScreenshotCapabilities());
    setRecords(loadScreenshotRecords());
  }, []);

  // 无障碍与系统权限都是「去系统设置改完、回来才变」的，切回前台时刷一次
  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("screenshot-config-changed", onChange);
    window.addEventListener("screenshot-records-changed", onChange);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("screenshot-config-changed", onChange);
      window.removeEventListener("screenshot-records-changed", onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // 缩略图：媒体库里存的是 Blob，这里换成 object URL 显示。
  // 记录变化或卸载时逐个撤销，否则每刷新一次就泄漏一批。
  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    void (async () => {
      const next: Record<string, string> = {};
      for (const item of records) {
        const url = await loadMediaObjectUrl(item.ref);
        if (!url) continue;
        urls.push(url);
        next[item.id] = url;
      }
      if (cancelled) {
        urls.forEach((u) => URL.revokeObjectURL(u));
        return;
      }
      setThumbs(next);
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [records]);

  const inShell = useMemo(() => isShell(), []);
  const bridgeOk = useMemo(() => hasScreenshotBridge(), []);
  const supported = caps.supported === true;
  const accessibilityOn = caps.accessibilityOn === true;
  const ready = supported && accessibilityOn && bridgeOk;

  const update = useCallback((patch: Partial<ScreenshotConfig>) => {
    const next = { ...loadScreenshotConfig(), ...patch };
    saveScreenshotConfig(next);
    setConfig(next);
  }, []);

  const toggleEnabled = useCallback((on: boolean) => {
    update({ enabled: on });
    if (!on) return;
    if (!bridgeOk) {
      onNotice?.("当前 App 版本不支持截屏，需要更新安卓壳");
      return;
    }
    if (!supported) {
      onNotice?.("系统版本太低，截屏需要 Android 11 及以上");
      return;
    }
    if (!accessibilityOn) {
      onNotice?.("还需要开启无障碍服务，截屏才能真正工作");
    }
  }, [update, onNotice, bridgeOk, supported, accessibilityOn]);

  const doTest = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // silent：用户正盯着这个页面看结果，再弹一条系统通知纯属打扰
      const result = await captureAndStoreScreenshot({ silent: true });
      if (result.ok) {
        onNotice?.(`截到了 ${result.record.width}×${result.record.height}（${formatBytes(result.record.bytes)}）`);
        refresh();
      } else {
        onNotice?.(result.reason);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, onNotice, refresh]);

  const doClear = useCallback(async () => {
    await clearAllScreenshots();
    setThumbs({});
    refresh();
    onNotice?.("已清空全部截屏记录");
  }, [onNotice, refresh]);

  return (
    <div className="per-shell">
      <div className="per-hero">
        <div className="per-hero-head">
          <span className="per-hero-title">看一眼我的屏幕</span>
          <span className="per-state" data-tone={config.enabled && ready ? "on" : ""}>
            <i className="per-dot is-pulse" />
            {config.enabled && ready ? "可用" : "未启用"}
          </span>
        </div>

        {!inShell && (
          <div className="per-note is-warn">
            当前不在小手机 App 内（浏览器/PWA）。截屏需要安卓壳，这里只能预览界面。
          </div>
        )}
        {inShell && !bridgeOk && (
          <div className="per-note is-warn">
            当前 App 版本还没有截屏桥，请更新到最新版安卓壳后使用。
          </div>
        )}

        <div className="per-note is-warn">
          <div style={{ fontWeight: 600 }}>这一项看到的是你整个屏幕</div>
          <div style={{ marginTop: 6, lineHeight: 1.65 }}>
            截下来的画面里可能有银行余额、私聊、密码框——比调音量敏感得多，所以默认关闭，
            而且要你<b>点一下才截一张</b>。没有定时截屏、没有后台截屏、没有监听屏幕，
            图片只存在本机，不会自己上传任何地方。
          </div>
        </div>
      </div>

      <div className="page-menu" style={{ paddingBottom: 40, gap: 16 }}>
        {/* 总开关 */}
        <div>
          <div className="settings-menu-section-title">总开关</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                <Camera size={17} strokeWidth={1.8} />
              </div>
              <div className="menu-label-group">
                <span className="menu-label">允许截屏</span>
                <span className="menu-desc">默认关闭。打开后仍然是你手动触发才会截，角色不会自己乱截</span>
              </div>
              <Toggle checked={config.enabled} onChange={toggleEnabled} />
            </div>
          </div>
        </div>

        {/* 无障碍：截屏的真正前提 */}
        <div>
          <div className="settings-menu-section-title">无障碍服务</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                <ShieldCheck size={17} strokeWidth={1.8} />
              </div>
              <div className="menu-label-group">
                <span className="menu-label">截屏权限来源</span>
                <span className="menu-desc">
                  {accessibilityOn
                    ? "无障碍服务已开启，截屏可以工作"
                    : "需要开启无障碍服务。截屏用的是系统给无障碍的能力，不会因此多要一个录屏授权框"}
                </span>
              </div>
              {!accessibilityOn && (
                <button
                  type="button"
                  className="ui-btn ui-btn-outline"
                  onClick={() => {
                    openAccessibilitySettings();
                    onNotice?.("在系统页面里找到「小手机」并开启无障碍，回来即可生效");
                  }}
                >
                  去开启
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 反馈 */}
        <div>
          <div className="settings-menu-section-title">反馈</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">截屏后通知我</span>
                <span className="menu-desc">
                  默认开启。你不在这个页面时，截屏后系统通知栏会留一条记录，
                  免得你不知道它刚看过你的屏幕。
                </span>
              </div>
              <Toggle
                checked={config.notifyOnCapture !== false}
                onChange={(v: boolean) => update({ notifyOnCapture: v })}
              />
            </div>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">保留最近 {config.keepRecent} 张</span>
                <span className="menu-desc">
                  超出后最旧的会被删掉（图片一起删除，不会悄悄占满存储）
                </span>
              </div>
              <div className="menu-right">
                {[5, 10, 20].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="ui-btn ui-btn-outline"
                    style={{ marginLeft: 6, opacity: config.keepRecent === n ? 1 : 0.6 }}
                    onClick={() => update({ keepRecent: n })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 本机实测 */}
        <div>
          <div className="settings-menu-section-title">本机实测</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                <Smartphone size={17} strokeWidth={1.8} />
              </div>
              <div className="menu-label-group">
                <span className="menu-label">系统支持</span>
                <span className="menu-desc">
                  {supported ? "系统版本支持截屏（Android 11+）" : "系统版本太低，截屏需要 Android 11 及以上"}
                </span>
              </div>
            </div>
          </div>
          <div className="per-actions">
            <button
              type="button"
              className="ui-btn ui-btn-outline"
              onClick={() => void doTest()}
              disabled={busy}
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : "测试截屏"}
            </button>
            <button type="button" className="ui-btn ui-btn-outline" onClick={refresh} disabled={busy}>
              重新检测
            </button>
          </div>
        </div>

        {/* 最近记录：让用户能亲眼回查 */}
        <div>
          <div className="settings-menu-section-title">最近截屏</div>
          {records.length === 0 ? (
            <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
              还没有截屏记录。截过的图会出现在这里，方便你回头核对它到底看到了什么。
            </div>
          ) : (
            <div className="page-menu" style={{ gap: 10, marginTop: 10 }}>
              {records.map((item) => (
                <div className="menu-item" key={item.id} style={{ cursor: "default", alignItems: "center" }}>
                  <div
                    className="menu-icon"
                    style={{ overflow: "hidden", padding: 0, background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}
                  >
                    {thumbs[item.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumbs[item.id]} alt="截屏缩略图" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <Camera size={17} strokeWidth={1.8} />
                    )}
                  </div>
                  <div className="menu-label-group">
                    <span className="menu-label">{formatTime(item.at)}</span>
                    <span className="menu-desc">
                      {item.width}×{item.height} · {formatBytes(item.bytes)}
                    </span>
                  </div>
                </div>
              ))}
              <div className="per-actions">
                <button type="button" className="ui-btn ui-btn-outline" onClick={() => void doClear()}>
                  <Trash2 size={16} />
                  清空全部
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
          后续还会加一个悬浮触点：点一下就截屏，截完能直接发给角色看。
          角色要用这项能力，还要单独开能力：工具箱 → 内置能力。
        </div>
      </div>
    </div>
  );
}
