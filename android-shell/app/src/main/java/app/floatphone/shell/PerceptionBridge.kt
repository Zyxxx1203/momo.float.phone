package app.floatphone.shell

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import org.json.JSONObject

/**
 * 感知桥：把手机自身的状态交给网页。
 *
 * 设计边界（重要，改这个文件前先读）：
 *  - 本类只做「读取」与「格式化」，不做任何判断、不写日志、不外传。
 *    什么时候取值、取到什么算「值得上报」、上报给谁，全部由网页侧的
 *    lib/perception/ 决定 —— 这样阈值、频率、开关都能随网页部署即时调整，
 *    不必为了调一个数字重新编译 APK。
 *  - 所有方法都不抛异常：取不到就返回空值，网页侧按「未知」处理，
 *    绝不让一个传感器拖垮整个界面或通话链路。
 *  - 只用零权限或 Manifest 已声明的权限：
 *      · 电量/充电状态 —— BatteryManager，零权限
 *      · 网络类型     —— ACCESS_NETWORK_STATE（已声明）
 *      · 应用显示名   —— QUERY_ALL_PACKAGES（已声明）
 *    需要运行时授权的定位/日历/联系人不在本类，另见后续阶段。
 */
class PerceptionBridge(private val context: Context) {

    /**
     * 电量百分比 + 是否在充电。零权限。
     *
     * 用 BatteryManager 的属性接口而不是 ACTION_BATTERY_CHANGED 粘性广播：
     * 后者要 registerReceiver(null, filter)，而 Android 14（targetSdk 34）对动态
     * 注册接收者加了 RECEIVER_EXPORTED/NOT_EXPORTED 强制要求，系统广播虽豁免，
     * 但少一个需要推敲的地方总是好的。属性接口只需 API 23（isCharging）。
     */
    fun batteryJson(): JSONObject = try {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val percent = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        JSONObject()
            .put("percent", if (percent in 0..100) percent else -1)
            .put("charging", bm.isCharging)
    } catch (e: Throwable) {
        JSONObject()
    }

    /**
     * 网络类型与是否计费网络。需 ACCESS_NETWORK_STATE（已声明）。
     * type: wifi / cellular / ethernet / vpn / other / none（未知一律 none）。
     * metered=true 表示走流量，网页侧可据此提示「省着点」。
     */
    fun networkJson(): JSONObject = try {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val type = when {
            caps == null -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            else -> "other"
        }
        val metered = caps?.let {
            !it.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        } ?: true
        JSONObject()
            .put("type", type)
            .put("metered", metered)
    } catch (e: Throwable) {
        JSONObject()
    }

    /**
     * 包名 → 应用显示名。取不到返回空串，调用方退回显示包名。
     *
     * 前台应用感知上报的是包名（com.tencent.mm 这种），直接喂给角色毫无意义。
     * 这一步是「让角色看懂你在用什么」的必要翻译。需 QUERY_ALL_PACKAGES（已声明）。
     */
    fun appLabel(packageName: String): String = try {
        if (packageName.isBlank()) "" else {
            val pm = context.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
        }
    } catch (e: Throwable) {
        ""
    }

    /**
     * 一次取全的设备快照。网页侧的采样定时器每次只跨桥一次，
     * 比分别问电量、问网络少一半调用开销。
     */
    fun snapshotJson(): String = JSONObject()
        .put("battery", batteryJson())
        .put("network", networkJson())
        .toString()

    /**
     * 本机支持哪些感知能力 —— 给「感知 → 诊断」面板用。
     *
     * 网页据此显示「已接通 / 不支持」，而不是让用户对着一个没反应的开关猜原因。
     * 这解决了这次审计暴露的老问题：Manifest 声明了一堆权限，但底下什么都没有，
     * 用户完全看不出来。以后每接通一项就来这里登记一项。
     */
    fun capabilitiesJson(): String = JSONObject()
        .put("battery", true)
        .put("network", true)
        .put("appLabel", true)
        .put("foregroundApp", true)
        .put("location", false)
        .put("calendar", false)
        .put("contacts", false)
        .put("usageStats", false)
        .toString()
}
