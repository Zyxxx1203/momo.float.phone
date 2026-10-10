package app.floatphone.shell

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject

/**
 * 设备动作桥：让网页（进而让角色）能在真实手机上做一件小事。
 *
 * 与 PerceptionBridge 的分工：
 *   PerceptionBridge 只「读」——电量、网络、应用名、步数；
 *   DeviceActionBridge 只「写」——手电筒、音量、亮度、勿扰、打开应用。
 *
 * 设计边界（重要，改这个文件前先读）：
 *  - 每个动作都是**一次性、立即可见、可撤销**的。刻意不做任何持续性、
 *    后台性、隐蔽性的行为——角色不该能悄悄改用户手机的状态。
 *  - 每个动作都必须能把结果说清楚（成功/失败原因），绝不静默失败：
 *    角色以为灯开了、其实没开，比拒绝执行更糟。
 *  - 需要特殊权限的动作（改系统亮度、勿扰），先在 canXxx() 里如实回答
 *    「现在能不能做」，不能做时由网页引导用户去授权，而不是在这里弹窗或抛错。
 *  - 绝不执行：发短信、打电话、读通讯录、装应用、改动其他 App 的数据。
 *    这些会与「小手机里仿真聊天」的产品边界打架。
 */
class DeviceActionBridge(private val context: Context) {

    companion object {
        /**
         * 手电筒状态。系统没有「查当前开没开」的接口，只能自己记。
         * 进程被杀后这个值会重置为 false，而灯可能还亮着——所以实际上
         * 每次 setTorch 都用显式开关参数，不依赖这个缓存做判断。
         */
        @Volatile
        private var torchOn = false

        @Volatile
        private var torchCameraId: String? = null
    }

    /** 找一个带闪光灯的摄像头 id。找不到返回 null（设备没有闪光灯）。 */
    private fun findTorchCameraId(): String? {
        torchCameraId?.let { return it }
        return try {
            val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val id = cm.cameraIdList.firstOrNull { cameraId ->
                val chars = cm.getCameraCharacteristics(cameraId)
                chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            }
            id?.also { torchCameraId = it }
        } catch (e: Throwable) {
            null
        }
    }

    /** 设备有没有可用的手电筒。 */
    fun canTorch(): Boolean = findTorchCameraId() != null

    /**
     * 开关手电筒。
     *
     * 用显式 on/off 而不是「切换」：网页与角色的意图可能因为重试而重复送达，
     * 「切换」语义下重试一次就把灯又关回去了（用户看到灯闪一下）。
     */
    fun setTorch(on: Boolean): JSONObject {
        // 用块函数体而不是 `= try { ... }`：表达式体里禁止 return，
        // 而这里有提前返回的分支（没闪光灯时直接给原因）。
        val cameraId = findTorchCameraId()
            ?: return JSONObject().put("ok", false).put("reason", "这台设备没有可用的闪光灯")
        return try {
            val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            cm.setTorchMode(cameraId, on)
            torchOn = on
            JSONObject().put("ok", true).put("on", on)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "手电筒不可用")
        }
    }

    /** 当前是不是开着（仅本进程内的记忆，见 companion 注释）。 */
    fun isTorchOn(): Boolean = torchOn

    // ── 音量 ──

    /** 可调的音频流。名字与网页侧一一对应。 */
    private fun streamFor(name: String): Int? = when (name) {
        "media" -> AudioManager.STREAM_MUSIC
        "ring" -> AudioManager.STREAM_RING
        "alarm" -> AudioManager.STREAM_ALARM
        "notification" -> AudioManager.STREAM_NOTIFICATION
        else -> null
    }

    /**
     * 改音量。action: up / down / set / mute；set 用 level（0-100 百分比）。
     * 零权限，任何时候都能做。
     */
    fun setVolume(streamName: String, action: String, level: Int): JSONObject {
        val stream = streamFor(streamName)
            ?: return JSONObject().put("ok", false).put("reason", "未知的音量类型：$streamName")
        return try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val max = am.getStreamMaxVolume(stream)
            when (action) {
                "up" -> am.adjustStreamVolume(stream, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI)
                "down" -> am.adjustStreamVolume(stream, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI)
                "mute" -> am.adjustStreamVolume(stream, AudioManager.ADJUST_MUTE, AudioManager.FLAG_SHOW_UI)
                "set" -> {
                    val target = (max * level.coerceIn(0, 100) / 100.0).toInt().coerceIn(0, max)
                    am.setStreamVolume(stream, target, AudioManager.FLAG_SHOW_UI)
                }
                else -> return JSONObject().put("ok", false).put("reason", "未知的操作：$action")
            }
            JSONObject()
                .put("ok", true)
                .put("current", am.getStreamVolume(stream))
                .put("max", max)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "音量不可用")
        }
    }

    // ── 屏幕亮度 ──

    /**
     * 改屏幕亮度需要 WRITE_SETTINGS（特殊权限，必须用户手动在系统设置里授予）。
     * 这里只如实回答能不能做，不做任何引导弹窗。
     */
    fun canSetBrightness(): Boolean = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.System.canWrite(context)
        else true
    } catch (e: Throwable) {
        false
    }

    /** 设屏幕亮度，level 为 0-100 百分比。 */
    fun setBrightness(level: Int): JSONObject {
        if (!canSetBrightness()) {
            return JSONObject().put("ok", false)
                .put("reason", "还没有「修改系统设置」权限")
                .put("needPermission", "write_settings")
        }
        return try {
            // 系统的亮度值是 0-255；这里刻意不碰 SCREEN_BRIGHTNESS_MODE（自动亮度），
            // 改模式会让用户「明明没动过自动亮度却关了」而困惑。
            val value = (255 * level.coerceIn(1, 100) / 100.0).toInt().coerceIn(1, 255)
            Settings.System.putInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS, value)
            JSONObject().put("ok", true).put("level", level)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "亮度不可用")
        }
    }

    // ── 勿扰模式 ──

    /** 改勿扰需要 ACCESS_NOTIFICATION_POLICY（系统设置页手动授予）。 */
    fun canSetDnd(): Boolean = try {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.isNotificationPolicyAccessGranted
    } catch (e: Throwable) {
        false
    }

    /**
     * 开关勿扰。on=true → 全部静音（INTERRUPTION_FILTER_NONE 之外的最严档），
     * on=false → 恢复正常（INTERRUPTION_FILTER_ALL）。
     *
     * 用 NONE/ALL 这两个最明确的档位，不用 PRIORITY（它依赖用户自己配的
     * 允许名单，行为不可预测，角色说不清到底静音了什么）。
     */
    fun setDnd(on: Boolean): JSONObject {
        if (!canSetDnd()) {
            return JSONObject().put("ok", false)
                .put("reason", "还没有「勿扰模式」访问权限")
                .put("needPermission", "dnd")
        }
        return try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.setInterruptionFilter(
                if (on) NotificationManager.INTERRUPTION_FILTER_NONE
                else NotificationManager.INTERRUPTION_FILTER_ALL,
            )
            JSONObject().put("ok", true).put("on", on)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "勿扰模式不可用")
        }
    }

    // ── 打开应用 ──

    /**
     * 用包名打开另一个 App。需 QUERY_ALL_PACKAGES（已声明）。
     *
     * 从后端栈启动（NEW_TASK）：本桥被 WebView 里的 JS 调用时没有 Activity 栈，
     * 不带这个 flag 会直接抛 ActivityNotFoundException。
     */
    fun openApp(packageName: String): JSONObject {
        if (packageName.isBlank()) {
            return JSONObject().put("ok", false).put("reason", "包名不能为空")
        }
        val pm = context.packageManager
        val intent = pm.getLaunchIntentForPackage(packageName)
            ?: return JSONObject().put("ok", false)
                .put("reason", "找不到可启动的应用（包名不对，或它没有启动界面）")
        return try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            JSONObject().put("ok", true).put("package", packageName)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "无法打开应用")
        }
    }

    /**
     * 包名 → 应用显示名。给「用名字找应用」的兜底路径用：
     * 角色多半说「打开微信」，而不知道 com.tencent.mm。
     * 返回空串表示没找到（调用方如实说找不到，不要猜一个包名去启动）。
     */
    fun findPackageByLabel(label: String): String {
        if (label.isBlank()) return ""
        return try {
            val pm = context.packageManager
            val target = label.trim()
            val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
            // 先精确匹配，再退化到包含匹配——避免「微信」误命中「微信读书」。
            val exact = apps.firstOrNull { pm.getApplicationLabel(it).toString() == target }
            if (exact != null) return exact.packageName
            val fuzzy = apps.firstOrNull {
                val name = pm.getApplicationLabel(it).toString()
                name.contains(target, ignoreCase = true)
            }
            fuzzy?.packageName ?: ""
        } catch (e: Throwable) {
            ""
        }
    }

    // ── 打开系统设置页（引导用户授权用）──

    /**
     * 跳系统的授权页。由网页在用户点「去授权」时调用，壳不主动跳。
     * 返回是否成功跳转（跳不动时网页可给一句手动路径提示）。
     */
    fun openSystemSettings(which: String): Boolean {
        val intent = when (which) {
            "write_settings" -> Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS)
                .setData(Uri.parse("package:${context.packageName}"))
            "dnd" -> Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
            "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            "app_details" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:${context.packageName}"))
            else -> return false
        }
        return try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        } catch (e: Throwable) {
            false
        }
    }

    /**
     * 本机支持哪些设备动作 —— 给设置面板与角色工具用。
     *
     * 注意区分两种「不支持」：
     *   · 硬件/系统层面根本没这能力（没有闪光灯）→ 这里报 false；
     *   · 有能力但用户还没授权（亮度、勿扰）→ 这里照实报 true，
     *     由网页显示「需要授权」并提供跳转。混为一谈会让用户以为
     *     自己的手机不支持，从而放弃。
     */
    fun capabilitiesJson(): String = JSONObject()
        .put("torch", canTorch())
        .put("volume", true)
        .put("brightness", true)
        .put("brightnessGranted", canSetBrightness())
        .put("dnd", true)
        .put("dndGranted", canSetDnd())
        .put("openApp", true)
        .toString()
}
