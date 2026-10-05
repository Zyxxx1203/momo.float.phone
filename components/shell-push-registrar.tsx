"use client";

// 安卓壳推送订阅的兜底注册。
//
// 壳自身会在 PushService 里注册 shell:<账号 id> 的合成订阅，但那段代码把异常
// 全部吞掉，失败时没有任何痕迹——实测中会出现「通知栏显示已连接、订阅表却是
// 空的」，随后所有离线推送都因查不到接收方而发不出去。
//
// 网页侧在这里再注册一次：能拿到账号 id、能看到返回码，幂等且可自愈。壳原生
// 那次成功时这里只是一次覆盖写，无副作用。

import { useEffect } from "react";

import { ensureShellSubscription, isShellEnvironment } from "@/lib/push-client";

export function ShellPushRegistrar() {
  useEffect(() => {
    if (!isShellEnvironment()) return;
    void ensureShellSubscription();
  }, []);

  return null;
}
