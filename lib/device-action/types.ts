/**
 * 设备动作：让角色能在真实手机上做一件小事。
 *
 * 与「感知」互补：感知只读（电量、网络、应用名、步数），这里只写
 * （手电筒、音量、屏幕亮度、勿扰模式）。
 *
 * 产品边界（改代码前先读）：
 *  - **默认全部关闭**。这是写操作，与只读的感知相反——感知缺省开，
 *    这里必须用户逐个打开。抄感知的默认值就等于默认允许角色动用户的设备。
 *  - 只接「能回答出为什么角色需要它」的动作。音量/亮度/勿扰/手电筒
 *    各有明确场景；「打开应用」答不上来（还会把用户踢出小手机），已剔除。
 *  - 刻意不做：发短信、打电话、读通讯录、装应用、改其他 App 的数据。
 *    这些会与「小手机里仿真聊天」的边界打架。
 *  - 失败必须说清原因：角色以为灯开了其实没开，比拒绝执行更糟。
 */

/** 可执行的设备动作标识。与原生 capabilitiesJson() 的键一一对应。 */
export type DeviceActionId =
  | "torch"
  | "volume"
  | "brightness"
  | "brightnessGranted"
  | "dnd"
  | "dndGranted"
  | "openApp";

/** 壳如实上报的设备动作支持表。 */
export type DeviceActionCapabilities = Partial<Record<DeviceActionId, boolean>>;

/**
 * 一次设备动作的结果。
 *
 * needPermission 有值时，说明「有能力但还没授权」，网页应引导用户去授权
 * （用 openSystemSettings）——这与「硬件根本没有」是两回事，不能混为一谈。
 */
export type DeviceActionResult =
  | { ok: true; on?: boolean; level?: number; current?: number; max?: number; package?: string }
  | { ok: false; reason: string; needPermission?: string };

/** 音量流类型（与原生 streamFor 对应）。 */
export type VolumeStream = "media" | "ring" | "alarm" | "notification";

/** 音量操作。 */
export type VolumeAction = "up" | "down" | "set" | "mute";

/** 本机（壳）是否支持某个动作。 */
export function isActionSupported(
  capabilities: DeviceActionCapabilities,
  id: DeviceActionId,
): boolean {
  return capabilities[id] === true;
}
