package app.floatphone.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.text.TextUtils
import android.util.Base64
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 通话浮窗服务：把正在进行的通话做成能浮在其他 App 上层的原生小窗。
 *
 * 为什么必须原生：网页里的悬浮元素出不了浏览器窗口，用户切到微信/视频，
 * 通话小窗随之消失。这里用 WindowManager + TYPE_APPLICATION_OVERLAY 挂到
 * 系统层级，任何 App 前台时都看得见。
 *
 * 职责边界：本服务只做「显示与交互」（绘制、拖动、缩放、按钮、快捷回复框），
 * 音频与对话逻辑仍归网页。交互经 ShellBus 以 CustomEvent 投回页面：
 *   restore —— 点浮窗回全屏；hangup —— 挂断；reply —— 快捷回复文本；
 *   tick    —— 每秒心跳，带 seconds（时长）。
 * 后台 WebView 的 setInterval 会被系统节流甚至冻结，自动搭话因此可能停摆；
 * 把计时器搬到原生、每秒戳一下页面，是「切出去也能一直聊」的关键。
 *
 * 前台服务：Android 8+ 后台服务随时可被杀，故 startForeground 常驻，
 * 顺带把进程钉住，网页的 TTS 才不至于切走后被掐。
 */
class CallOverlayService : Service() {

    companion object {
        private const val CH_OVERLAY = "shell_call_overlay"
        private const val NOTIF_ID = 3
        private const val PREFS = "call_overlay_prefs"

        const val ACTION_START = "app.floatphone.shell.OVERLAY_START"
        const val ACTION_UPDATE = "app.floatphone.shell.OVERLAY_UPDATE"
        const val ACTION_STOP = "app.floatphone.shell.OVERLAY_STOP"

        const val EXTRA_NAME = "name"
        const val EXTRA_AVATAR = "avatar"
        const val EXTRA_META = "meta"
        const val EXTRA_CALL_ID = "call_id"

        private const val MIN_W_DP = 88
        private const val MIN_H_DP = 120
        private const val MAX_W_DP = 320
        private const val MAX_H_DP = 460
        private const val DEFAULT_W_DP = 108
        private const val DEFAULT_H_DP = 150
        private const val EDGE_DP = 14

        @Volatile
        private var running = false

        fun start(context: Context, name: String, avatar: String, meta: String, callId: String) {
            val intent = Intent(context, CallOverlayService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_NAME, name)
                putExtra(EXTRA_AVATAR, avatar)
                putExtra(EXTRA_META, meta)
                putExtra(EXTRA_CALL_ID, callId)
            }
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun update(context: Context, name: String, avatar: String, meta: String) {
            if (!running) return
            runCatching {
                context.startService(Intent(context, CallOverlayService::class.java).apply {
                    action = ACTION_UPDATE
                    putExtra(EXTRA_NAME, name)
                    putExtra(EXTRA_AVATAR, avatar)
                    putExtra(EXTRA_META, meta)
                })
            }
        }

        fun stop(context: Context) {
            if (!running) return
            runCatching {
                context.startService(Intent(context, CallOverlayService::class.java).apply { action = ACTION_STOP })
            }
        }

        /** 浮窗权限是否已授予（Android 6+ 需用户在系统设置里手动开）。 */
        fun canDraw(context: Context): Boolean =
            Build.VERSION.SDK_INT < 23 || android.provider.Settings.canDrawOverlays(context)
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var windowManager: WindowManager

    private var charName = ""
    private var avatarUrl = ""
    private var metaText = ""
    private var currentCallId = ""

    private var elapsedSeconds = 0
    private var heartbeat: Thread? = null
    @Volatile private var stopped = false

    private val avatarClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    private var avatarBitmap: Bitmap? = null
    private var lastAvatarUrl = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        createChannel()
        startForeground(NOTIF_ID, buildNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                charName = intent.getStringExtra(EXTRA_NAME).orEmpty()
                avatarUrl = intent.getStringExtra(EXTRA_AVATAR).orEmpty()
                metaText = intent.getStringExtra(EXTRA_META).orEmpty()
                currentCallId = intent.getStringExtra(EXTRA_CALL_ID).orEmpty()
                running = true
                stopped = false
                elapsedSeconds = 0
                showOverlay()
                startHeartbeat()
            }
            ACTION_UPDATE -> {
                val name = intent.getStringExtra(EXTRA_NAME).orEmpty()
                val meta = intent.getStringExtra(EXTRA_META).orEmpty()
                val avatar = intent.getStringExtra(EXTRA_AVATAR).orEmpty()
                charName = name
                metaText = meta
                if (avatar != avatarUrl) {
                    avatarUrl = avatar
                    refreshAvatarAsync()
                }
                main.post { renderOverlay() }
            }
            ACTION_STOP -> {
                teardown()
                return START_NOT_STICKY
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        teardown()
        super.onDestroy()
    }

    private fun teardown() {
        stopped = true
        running = false
        heartbeat?.interrupt()
        heartbeat = null
        rootView?.let { view -> runCatching { windowManager.removeView(view) } }
        rootView = null
        stopForeground(true)
        stopSelf()
    }

    /**
     * 心跳：每秒把时长与 tick 事件推给网页。
     * 页面侧据此驱动通话计时与自动搭话，绕开后台 WebView 定时器被冻结的问题。
     * 页面已不可用（WebView 已销毁）时不再空转。
     */
    private fun startHeartbeat() {
        heartbeat = Thread {
            while (!stopped && !Thread.currentThread().isInterrupted) {
                try { Thread.sleep(1000) } catch (e: InterruptedException) { break }
                if (stopped) break
                elapsedSeconds += 1
                // 时长由原生自己维护并刷新：网页被系统冻结时也照常走秒，不依赖回调
                main.post { renderMeta() }
                if (!ShellBus.isWebAlive()) continue
                ShellBus.dispatchOverlayEvent(
                    "tick",
                    JSONObject().put("seconds", elapsedSeconds).put("callId", currentCallId),
                )
            }
        }.also { it.name = "call-overlay-heartbeat"; it.start() }
    }

    // ── 通知 ──

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        runCatching {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CH_OVERLAY, "通话浮窗", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "通话期间在其他应用上层显示小窗"
                    setShowBadge(false)
                },
            )
        }
    }

    private fun buildNotification(): android.app.Notification = buildOverlayNotification()

    private fun buildOverlayNotification(): android.app.Notification {
        val back = PendingIntent.getActivity(
            this, 71,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CH_OVERLAY)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(charName.ifBlank { "通话进行中" })
            .setContentText(if (metaText.isBlank()) "点按返回小手机" else "$metaText · 点按返回小手机")
            .setOngoing(true)
            .setContentIntent(back)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification() {
        runCatching { getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildOverlayNotification()) }
    }

    // ── 浮窗几何 ──

    private var rootView: View? = null
    private var rootLayout: FrameLayout? = null
    private var bgImage: ImageView? = null
    private var nameView: TextView? = null
    private var metaView: TextView? = null
    private var replyBox: LinearLayout? = null
    private var replyInput: EditText? = null

    private var widthPx = 0
    private var heightPx = 0
    private var posX = 0
    private var posY = 0

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun clampGeometry() {
        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels
        val minW = dp(MIN_W_DP)
        val minH = dp(MIN_H_DP)
        val maxW = maxOf(minW, minOf(dp(MAX_W_DP), screenW - dp(EDGE_DP) * 2))
        val maxH = maxOf(minH, minOf(dp(MAX_H_DP), screenH - dp(EDGE_DP) * 2))
        widthPx = widthPx.coerceIn(minW, maxW)
        heightPx = heightPx.coerceIn(minH, maxH)
        posX = posX.coerceIn(dp(EDGE_DP), maxOf(dp(EDGE_DP), screenW - widthPx - dp(EDGE_DP)))
        posY = posY.coerceIn(dp(EDGE_DP), maxOf(dp(EDGE_DP), screenH - heightPx - dp(EDGE_DP)))
    }

    private fun loadGeometry() {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels
        val savedW = prefs.getInt("w", 0)
        val savedH = prefs.getInt("h", 0)
        val savedX = prefs.getInt("x", -1)
        val savedY = prefs.getInt("y", -1)
        widthPx = if (savedW > 0) savedW else dp(DEFAULT_W_DP)
        heightPx = if (savedH > 0) savedH else dp(DEFAULT_H_DP)
        posX = if (savedX >= 0) savedX else screenW - widthPx - dp(EDGE_DP)
        posY = if (savedY >= 0) savedY else screenH - heightPx - dp(260)
        clampGeometry()
    }

    private fun saveGeometry() {
        runCatching {
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putInt("w", widthPx).putInt("h", heightPx)
                .putInt("x", posX).putInt("y", posY)
                .apply()
        }
    }

    private fun buildLayoutParams(): WindowManager.LayoutParams {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        val flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
        return WindowManager.LayoutParams(
            widthPx, heightPx, type, flags,
            android.graphics.PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = posX
            y = posY
        }
    }

    private fun applyLayoutParams() {
        val view = rootView ?: return
        val params = (view.layoutParams as? WindowManager.LayoutParams) ?: return
        params.width = widthPx
        params.height = heightPx
        params.x = posX
        params.y = posY
        runCatching { windowManager.updateViewLayout(view, params) }
    }

    private fun showOverlay() {
        if (!canDraw(this)) {
            // 没拿到浮窗权限：通知照常有（点它能回通话页），并告诉网页弹引导
            updateNotification()
            ShellBus.dispatchOverlayEvent("needPermission")
            return
        }
        loadGeometry()
        main.post {
            if (rootView == null) {
                val layout = FrameLayout(this)
                rootLayout = layout
                buildContentView(layout)
                rootView = layout
                runCatching { windowManager.addView(layout, buildLayoutParams()) }
            }
            renderOverlay()
            refreshAvatarAsync()
        }
        updateNotification()
    }

    /** 构建浮窗内容：底图 + 压暗遮罩 + 底部信息 + 右下缩放柄 + 长按弹出的回复框。 */
    private fun buildContentView(layout: FrameLayout) {
        layout.removeAllViews()

        bgImage = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(Color.parseColor("#1B1B22"))
            setOnClickListener { bringAppToFront() }
        }
        layout.addView(bgImage, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))

        // 压暗遮罩：白字在任何底图上都读得清
        layout.addView(View(this).apply {
            background = GradientDrawable(
                GradientDrawable.Orientation.BOTTOM_TOP,
                intArrayOf(Color.parseColor("#CC000000"), Color.parseColor("#00000000")),
            )
            isClickable = false
        }, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))

        val info = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(8), dp(4), dp(8), dp(7))
            isClickable = false
        }
        nameView = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setShadowLayer(4f, 0f, 1f, Color.parseColor("#99000000"))
        }
        metaView = TextView(this).apply {
            setTextColor(Color.parseColor("#E0FFFFFF"))
            textSize = 10.5f
            gravity = Gravity.CENTER
            maxLines = 2
            setShadowLayer(4f, 0f, 1f, Color.parseColor("#99000000"))
        }
        info.addView(nameView)
        info.addView(metaView)
        layout.addView(info, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM,
        ))

        // 右下角缩放柄
        val handle = View(this).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(6).toFloat()
                setColor(Color.parseColor("#40FFFFFF"))
            }
        }
        layout.addView(handle, FrameLayout.LayoutParams(dp(20), dp(20), Gravity.BOTTOM or Gravity.END).apply {
            setMargins(0, 0, dp(5), dp(5))
        })
        attachResize(handle, layout)

        // 快捷回复框：默认隐藏，长按浮窗弹出
        replyBox = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#F21B1B22"))
            setPadding(dp(8), dp(6), dp(8), dp(6))
            visibility = View.GONE
        }
        replyInput = EditText(this).apply {
            hint = "说点什么…"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#8A93A6"))
            textSize = 13f
            maxLines = 2
            background = null
        }
        val send = Button(this).apply {
            text = "发送"
            textSize = 12f
            setTextColor(Color.WHITE)
            background = GradientDrawable().apply {
                cornerRadius = dp(8).toFloat()
                setColor(Color.parseColor("#3B82F6"))
            }
            setPadding(dp(12), 0, dp(12), 0)
            setOnClickListener { submitReply() }
        }
        replyBox?.addView(replyInput, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        replyBox?.addView(send, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ))
        layout.addView(replyBox, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM,
        ))

        attachDrag(layout)
    }

    // ── 渲染 ──

    /**
     * 点浮窗 → 把小手机拉回前台并通知网页恢复全屏。
     * 「拉前台」只能原生做（网页改不了自己的前后台）；先派事件再拉起，
     * 页面收到事件时已在前台，切回全屏不会有延迟感。
     */
    private fun bringAppToFront() {
        ShellBus.dispatchOverlayEvent("restore", JSONObject().put("callId", currentCallId))
        runCatching {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        }
    }

    /** 把 {{time}} 占位替换成原生计时，网页只需在 meta 里写 {{time}} */
    private fun renderMeta() {
        val minutes = elapsedSeconds / 60
        val seconds = elapsedSeconds % 60
        val stamp = "%02d:%02d".format(minutes, seconds)
        metaView?.text = metaText.replace("{{time}}", stamp)
    }

    private fun renderOverlay() {
        nameView?.text = charName.ifBlank { "通话" }
        renderMeta()
        val bitmap = avatarBitmap
        if (bitmap != null) {
            bgImage?.setImageBitmap(bitmap)
        } else {
            bgImage?.setImageDrawable(null)
            bgImage?.setBackgroundColor(Color.parseColor("#2A2F3A"))
        }
    }

    /** 拉取头像（data: 内联或 http(s) 直链），失败退回纯色底。 */
    private fun refreshAvatarAsync() {
        val url = avatarUrl.trim()
        if (url.isEmpty() || url == lastAvatarUrl) return
        lastAvatarUrl = url
        if (url.startsWith("data:image/")) {
            avatarBitmap = decodeDataUrl(url)
            main.post { renderOverlay() }
            return
        }
        Thread {
            val bitmap = runCatching {
                if (!url.startsWith("http://") && !url.startsWith("https://")) return@runCatching null
                val request = Request.Builder().url(url).build()
                avatarClient.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@runCatching null
                    val bytes = response.body?.bytes() ?: return@runCatching null
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                }
            }.getOrNull()
            if (bitmap != null) {
                avatarBitmap = bitmap
                main.post { renderOverlay() }
            }
        }.also { it.name = "call-overlay-avatar"; it.start() }
    }

    private fun decodeDataUrl(dataUrl: String): Bitmap? = runCatching {
        val comma = dataUrl.indexOf(',')
        if (comma < 0) return@runCatching null
        val header = dataUrl.substring(0, comma)
        if (!header.contains("base64", ignoreCase = true)) return@runCatching null
        val bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }.getOrNull()

    // ── 拖动 ──

    private fun attachDrag(layout: FrameLayout) {
        var downX = 0f
        var downY = 0f
        var originX = 0
        var originY = 0
        var moved = false
        var downAt = 0L

        layout.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX
                    downY = event.rawY
                    originX = posX
                    originY = posY
                    moved = false
                    downAt = System.currentTimeMillis()
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downX
                    val dy = event.rawY - downY
                    if (!moved && Math.abs(dx) + Math.abs(dy) > dp(5)) moved = true
                    if (moved) {
                        posX = originX + dx.toInt()
                        posY = originY + dy.toInt()
                        clampGeometry()
                        applyLayoutParams()
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (moved) {
                        saveGeometry()
                    } else if (!moved && System.currentTimeMillis() - downAt > 450) {
                        // 长按：弹出快捷回复框（不跳回 App 也能回话）
                        toggleReplyBox()
                    }
                    true
                }
                else -> false
            }
        }
    }

    /** 右下角拖拽缩放：同步改窗口尺寸与位置基准。 */
    private fun attachResize(handle: View, layout: FrameLayout) {
        var downX = 0f
        var downY = 0f
        var originW = 0
        var originH = 0
        handle.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX
                    downY = event.rawY
                    originW = widthPx
                    originH = heightPx
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    widthPx = originW + (event.rawX - downX).toInt()
                    heightPx = originH + (event.rawY - downY).toInt()
                    clampGeometry()
                    applyLayoutParams()
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    saveGeometry()
                    true
                }
                else -> false
            }
        }
    }

    // ── 快捷回复 ──

    private fun toggleReplyBox() {
        val box = replyBox ?: return
        if (box.visibility == View.VISIBLE) {
            box.visibility = View.GONE
        } else {
            box.visibility = View.VISIBLE
            replyInput?.requestFocus()
        }
    }

    private fun submitReply() {
        val text = replyInput?.text?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return
        replyInput?.setText("")
        replyBox?.visibility = View.GONE
        // 送给网页，按「用户发言」走一趟正常对话轮（会落聊天记录、触发角色回复）
        ShellBus.dispatchOverlayEvent("reply", JSONObject().put("text", text).put("callId", currentCallId))
    }
}
