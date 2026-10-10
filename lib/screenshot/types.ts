/**
 * 截屏：让角色能看见用户此刻真实屏幕上的画面。
 *
 * 与其它能力的最大不同：**它读的是用户全部屏幕内容**——银行余额、私聊、
 * 密码框都可能在画面里。所以这里的默认值比设备动作还保守，
 * 而且从设计上就要求「用户点一下才截一张」，不做任何自动、定时、监听。
 *
 * 产品边界（改代码前先读）：
 *  - 默认全部关闭（缺失 = 关）。
 *  - 只做「调一次截一张」，没有任何持续/后台/定时的截屏路径。
 *  - 截屏需要无障碍服务（Android 11+ 的 AccessibilityService.takeScreenshot），
 *    所以状态要分三层报：系统支不支持 / 无障碍开没开 / 现在能不能截。
 *  - 失败必须如实说原因，绝不返回一张空白图冒充成功。
 */

/** 壳如实上报的截屏状态。 */
export type ScreenshotCapabilities = {
  /** 系统版本够不够（Android 11+） */
  supported?: boolean;
  /** 无障碍服务是否已开启（截屏的前提） */
  accessibilityOn?: boolean;
  /** 现在是否真的可以截（supported && accessibilityOn） */
  ready?: boolean;
};

/** 原生推回的一张截屏。成功时带 PNG base64 与尺寸。 */
export type ScreenshotCaptureResult =
  | {
      ok: true;
      /** 缩放后的宽度（原生上限 720） */
      width: number;
      height: number;
      /** PNG 字节数，用于展示与排查 */
      bytes: number;
      /** PNG base64（不含 data: 前缀） */
      base64: string;
    }
  | { ok: false; reason: string };

/** 一条截屏记录：图片本体存在媒体库，这里只留引用与元信息。 */
export type ScreenshotRecord = {
  id: string;
  /** media-store:// 引用，可直接给 <img src> */
  ref: string;
  width: number;
  height: number;
  bytes: number;
  /** 截取时间戳 */
  at: number;
};
