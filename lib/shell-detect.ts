// lib/shell-detect.ts
//
// 「是否运行在安卓壳（FloatShell App）的 WebView 里」——单独成模块，
// 避免循环依赖：push-client 已经依赖 personal-push-cloud，若后者反过来
// 从 push-client 取这个判断就会形成环（实际表现为运行时
// ReferenceError: isShellEnvironment is not defined）。

export function isShellEnvironment(): boolean {
    return typeof navigator !== "undefined" && navigator.userAgent.includes("FloatShell/");
}
