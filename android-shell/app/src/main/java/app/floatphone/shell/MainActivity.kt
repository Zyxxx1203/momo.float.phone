package app.floatphone.shell

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.io.FileOutputStream

/**
 * Float 小手机安卓壳：全屏 WebView 直接加载线上站点。
 * 网页每次部署即时生效，本壳只负责原生能力（推送长连接、文件上下行、外链）。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        val SITE_URL: String = BuildConfig.SITE_URL
        const val VERSION = "1.0.10"
        /** 来电接听等场景的站内深链（必须以 SITE_URL 开头，否则忽略） */
        const val EXTRA_OPEN_URL = "open_url"
        /** 外部 App（如桌宠）唤起本壳用的自定义 scheme：floatshell://open?url=<站内地址> */
        const val DEEP_LINK_SCHEME = "floatshell"
        /**
         * 网页消息通知用的渠道 id，与 PushService 的「角色消息」渠道刻意同名：
         * 离线推送和网页内提醒最终落到通知栏的同一个分组，用户在系统设置里
         * 只需要管一个开关。渠道一旦创建过，后建的只更新名称/描述，不会重置用户选择。
         */
        const val CH_MESSAGES = "shell_messages"
    }

    private lateinit var rootContainer: FrameLayout
    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    /** 系统状态栏实际高度（CSS px，即物理像素 / density），实时更新。 */
    @Volatile
    private var statusBarHeightCssPx: Int = 0

    /** 当前键盘（IME）高度（物理像素），0 = 键盘收起；用于给 WebView 让出底部空间。 */
    private var imeInsetPx: Int = 0

    /** 网页消息通知的自增 id：同一条消息覆盖同一 id 会让新通知顶掉旧的，故逐条递增。 */
    private var webNotifId = 500

    /** 拉取远程头像用；超时压短，头像拿不到就退回默认图标，不能拖住通知。 */
    private val avatarClient = OkHttpClient.Builder()
        .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
        .build()

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        callback.onReceiveValue(collectChosenUris(result))
    }

    /**
     * 收集文件选择器返回的全部 URI。
     *
     * 网页的 input 带 multiple 时，FileChooserParams.createIntent() 会给系统 Intent 带上
     * EXTRA_ALLOW_MULTIPLE，多选结果只放进 clipData、data 为 null；华为/荣耀等 ROM 的文件
     * 管理器即使单选也常只填 clipData。此前只读 data?.data，于是回给 WebView 的是空数组：
     * 选择器正常弹出、关掉后页面毫无变化（网页侧 files.length 为 0，连格式提示都不会有）。
     */
    private fun collectChosenUris(result: ActivityResult): Array<Uri> {
        if (result.resultCode != android.app.Activity.RESULT_OK) return emptyArray()
        val data = result.data ?: return emptyArray()
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) {
                clip.getItemAt(index)?.uri?.let { uris.add(it) }
            }
        }
        data.data?.let { uris.add(it) }
        return uris.distinct().toTypedArray()
    }

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) PushService.start(this)
    }

    // 网页侧 getUserMedia（通话按住说话、语音条录音、视频通话摄像头）触发的
    // WebView 权限请求：先要系统运行时权限，拿到后再转授给页面。
    // 不实现 onPermissionRequest 时 WebView 会静默拒绝，页面永远拿不到麦克风。
    private var pendingWebPermissionRequest: android.webkit.PermissionRequest? = null

    private val webPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        val request = pendingWebPermissionRequest ?: return@registerForActivityResult
        pendingWebPermissionRequest = null
        val granted = request.resources.filter { resource ->
            webResourcePermissions(resource).all {
                ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
            }
        }
        if (granted.isEmpty()) request.deny() else request.grant(granted.toTypedArray())
    }

    private fun webResourcePermissions(resource: String): List<String> = when (resource) {
        android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE -> listOf(Manifest.permission.RECORD_AUDIO)
        android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE -> listOf(Manifest.permission.CAMERA)
        else -> emptyList()
    }

    /**
     * 文件名安全化 + 避开重名。系统下载器遇到同名文件会直接失败（ERROR_FILE_ALREADY_EXISTS），
     * 所以这里先算一个「名字(1).ext」式的不冲突名称。
     */
    private fun safeDownloadName(fileName: String): String {
        val cleaned = fileName
            .replace(Regex("[\\\\/:*?\"<>|]"), "_")
            .trim()
            .ifBlank { "download" }
        val dot = cleaned.lastIndexOf('.')
        val stem = if (dot > 0) cleaned.substring(0, dot) else cleaned
        val ext = if (dot > 0) cleaned.substring(dot) else ""
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        var candidate = stem.take(100) + ext
        var index = 1
        while (File(dir, candidate).exists() && index < 100) {
            candidate = stem.take(100) + "($index)" + ext
            index++
        }
        return candidate
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        enableDisplayCutoutCover()
        hideSystemStatusBar()
        // 音量键默认调媒体流：WebView 里的语音条/TTS 都走媒体流播放，
        // 不设的话短音频没在播时按键调的是铃声，用户感觉"音量键无效、声音巨大"
        volumeControlStream = AudioManager.STREAM_MUSIC

        // 外层容器：decorFits=false 后系统不再替 App 避让键盘，由容器底部内边距
        // 把键盘高度让出来（WebView 随之变矮），网页收到 resize 后输入栏自动上移。
        webView = WebView(this)
        // 打开 WebView 远程调试通道。Android 默认是关闭的，导致在电脑上
        // chrome://inspect 根本看不到这台设备——排查推送/后台任务时没有任何日志可看。
        // 打开后仅在「USB 调试 + chrome://inspect」时可见，不影响正常使用。
        WebView.setWebContentsDebuggingEnabled(true)
        rootContainer = FrameLayout(this).apply {
            addView(
                webView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        setContentView(rootContainer)
        // 挂上 insets 监听：状态栏高度注入 + 键盘避让都靠它。必须在 setContentView 之后，
        // 此时 rootContainer 已初始化，监听回调里才能安全地给它设内边距。
        observeWindowInsets()
        // 首帧主动请求一次 insets，确保启动即拿到状态栏高度（部分机型不会自动派发首次回调）。
        ViewCompat.requestApplyInsets(rootContainer)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            userAgentString = "$userAgentString FloatShell/$VERSION"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        webView.addJavascriptInterface(ShellBridge(), "AndroidShell")
        // 登记给 ShellBus：浮窗服务/无障碍服务要把事件投回页面，需要这个引用。
        // WebView 只能在主线程访问，投递时由 ShellBus 统一 post 到主线程。
        ShellBus.webView = webView

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val scheme = url.scheme ?: return false
                // 站内导航留在壳里；http(s) 外链和自定义协议（shortcuts:// 等）交给系统
                if (scheme == "http" || scheme == "https") {
                    if (url.host == Uri.parse(SITE_URL).host) return false
                    return runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, url)); true
                    }.getOrDefault(true)
                }
                return runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, url)); true
                }.getOrDefault(true)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                val supported = request.resources.filter { webResourcePermissions(it).isNotEmpty() }
                if (supported.isEmpty()) { request.deny(); return }
                val missing = supported.flatMap { webResourcePermissions(it) }
                    .distinct()
                    .filter { ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) { request.grant(supported.toTypedArray()); return }
                if (pendingWebPermissionRequest != null) { request.deny(); return }
                pendingWebPermissionRequest = request
                webPermissionLauncher.launch(missing.toTypedArray())
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                filePathCallback?.onReceiveValue(emptyArray())
                filePathCallback = callback
                return runCatching {
                    val intent = params.createIntent()
                    // createIntent() 一般已按 params.mode 带上 EXTRA_ALLOW_MULTIPLE；个别 WebView
                    // 版本拿不到 multiple 模式，网页多选会退化成单选，这里显式兜一次。
                    if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    fileChooserLauncher.launch(intent); true
                }.getOrElse {
                    filePathCallback = null; false
                }
            }
        }

        // 备份导出等下载：交给系统下载管理器，落到公共下载目录
        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            runCatching {
                if (url.startsWith("blob:") || url.startsWith("data:")) {
                    // blob/data 由页面内 JS 触发的 a[download] 处理；提示用户等待
                    Toast.makeText(this, "正在导出…", Toast.LENGTH_SHORT).show()
                    return@DownloadListener
                }
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    addRequestHeader("User-Agent", userAgent)
                    addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS,
                        safeDownloadName(android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType)),
                    )
                }
                (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this, "已开始下载到「下载」目录", Toast.LENGTH_SHORT).show()
            }
        })

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
            }
        })

        // 冷启动带深链（如来电接听）直接加载目标；否则加载首页
        webView.loadUrl(consumeOpenUrl(intent) ?: SITE_URL)
        ensurePushService()
    }

    /** singleTask：App 已在运行时（如全屏来电页接听）通过 onNewIntent 送达深链 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val target = consumeOpenUrl(intent) ?: return
        // SPA 已加载：loadUrl 到同页 hash 只触发 hashchange，不会整页重载
        webView.loadUrl(target)
    }

    /**
     * 取出本次要加载的站内地址。两个来源：
     * 1. 内部深链（来电接听）走 EXTRA_OPEN_URL；
     * 2. 外部 App 走 floatshell://open?url=… 的 Intent.data。
     * 无论哪个来源都必须以 SITE_URL 开头，防止被外部应用指到任意网址。
     * 取走后清空，避免配置变更重建时重复加载。
     */
    private fun consumeOpenUrl(intent: Intent?): String? {
        if (intent == null) return null
        val extra = intent.getStringExtra(EXTRA_OPEN_URL)
        intent.removeExtra(EXTRA_OPEN_URL)
        if (extra != null) return extra.takeIf { it.startsWith(SITE_URL) }
        val data = intent.data
        if (data != null && data.scheme == DEEP_LINK_SCHEME) {
            intent.data = null
            return data.getQueryParameter("url").orEmpty().takeIf { it.startsWith(SITE_URL) }
        }
        return null
    }

    /**
     * 隐藏系统状态栏（沉浸式）：页面自带虚拟状态栏，系统那条纯属多余。
     * decorFitsSystemWindows=false 时 WebView 本就铺满全屏，这里只负责隐掉系统状态栏那一条；
     * 键盘避让改由 observeWindowInsets() 里的 IME 内边距接管。
     * 从屏幕顶部下滑可临时唤出系统状态栏，松手自动再隐藏。
     */
    /**
     * 允许窗口画进刘海/挖孔区域。
     *
     * 隐藏状态栏后，LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT 只允许内容进入「仍被系统栏盖住」
     * 的挖孔区；状态栏一藏，挖孔区就不再算系统栏范围，窗口被整块下移留黑——页面 top:0 因此
     * 落在挖孔下方，表现为顶部一条黑边（截图里红条诊断条下面那截就是它）。
     * shortEdges 让窗口在竖屏短边（顶部/底部）无条件铺进挖孔区，WebView 才能盖满整块屏幕。
     */
    private fun enableDisplayCutoutCover() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
    }

    private fun hideSystemStatusBar() {
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.statusBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    /**
     * 监听真实状态栏高度（物理像素，经 WindowInsets 实测，隐藏状态栏后依然能拿到原始尺寸）。
     * 不同机型/异形屏/系统字体缩放都会让这个值跟 CSS 的 env(safe-area-inset-top) 估算不一致，
     * 页面自己猜不准——所以由壳实测后用 JS 注入，页面只管用，不用再猜。
     */
    private fun observeWindowInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
            // 必须用 getInsetsIgnoringVisibility：状态栏已被 hideSystemStatusBar() 隐藏，
            // getInsets() 只返回"当前可见"的栏尺寸，隐藏后恒为 0——这正是此前注入链路
            // 失效（诊断条上 bridge 值 0、CSS/行内值皆空）、页面顶部露出黑块的根因。
            val statusBarPx = insets
                .getInsetsIgnoringVisibility(WindowInsetsCompat.Type.statusBars()).top
            val density = resources.displayMetrics.density
            val cssPx = (statusBarPx / density).toInt()
            if (cssPx > 0 && cssPx != statusBarHeightCssPx) {
                statusBarHeightCssPx = cssPx
                injectStatusBarHeight()
            }

            // 键盘避让：setDecorFitsSystemWindows(false) 后 adjustResize 不再由系统代劳，
            // 网页侧 interactiveWidget("resizes-content") 在 WebView 里同样不生效，
            // 于是输入框被键盘盖住。这里把 IME 高度写成容器底部内边距，WebView 变矮，
            // 网页 resize 后输入栏自然贴在键盘上方。
            val imePx = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            if (imePx != imeInsetPx) {
                imeInsetPx = imePx
                if (::rootContainer.isInitialized) rootContainer.setPadding(0, 0, 0, imePx)
            }
            insets
        }
    }

    /** 把实测状态栏高度（CSS px）写入页面根元素的 CSS 变量，供 phone-shell.css 的 --status-bar-drop 消费。 */
    private fun injectStatusBarHeight() {
        if (!::webView.isInitialized || statusBarHeightCssPx <= 0) return
        val js = "document.documentElement.style.setProperty('--android-shell-status-bar-height', '${statusBarHeightCssPx}px');" +
            "window.dispatchEvent(new CustomEvent('floatshell-statusbarheight', { detail: $statusBarHeightCssPx }));"
        webView.evaluateJavascript(js, null)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // 临时唤出状态栏后、或从锁屏/多任务回来时焦点变化，需要重新隐藏一次
        if (hasFocus) hideSystemStatusBar()
    }

    /**
     * 点通知的落点。带 sessionId 时通过深链直达对应会话（复用 consumeOpenUrl 的
     * EXTRA_OPEN_URL 通道，来电接听走的就是它）；不带则回首页。
     *
     * 用 hash（#open_session=）而不是 query：SPA 已在运行时 loadUrl 到同页 hash
     * 只触发 hashchange，不会整页重载；query 变化会触发一次完整重新加载。
     */
    private fun contentIntent(sessionId: String? = null): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val id = sessionId?.trim().orEmpty()
        if (id.isNotEmpty()) {
            intent.putExtra(EXTRA_OPEN_URL, "${SITE_URL.trimEnd('/')}/#open-chat=${Uri.encode(id)}")
        }
        return PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun ensurePushService() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            PushService.start(this)
        }
    }

    /**
     * App 退到后台／回到前台：直接驱动浮窗显隐。
     *
     * 这是浮窗可见性的主路径，不再只依赖网页 visibilitychange + 桥调用。
     * 原因：App 一退到后台，WebView 的 JS 会被系统冻结或节流，那条
     * 「网页通知原生显示」的链路本身就会断——表现正是「退出去后浮窗不弹，
     * 但声音照旧」（放音走媒体通道，不依赖网页）。Activity 的生命周期回调
     * 由系统直接给，不受 JS 是否还在跑影响。
     */
    override fun onStop() {
        super.onStop()
        CallOverlayService.onHostBackground()
    }

    override fun onStart() {
        super.onStart()
        CallOverlayService.onHostForeground()
    }

    override fun onDestroy() {
        if (ShellBus.webView === webView) ShellBus.webView = null
        CookieManager.getInstance().flush()
        webView.destroy()
        super.onDestroy()
    }

    /** 暴露给网页的原生桥（网页侧可用 window.AndroidShell 特性检测壳环境）。 */
    inner class ShellBridge {
        @JavascriptInterface
        fun getVersion(): String = VERSION

        /** 实测系统状态栏高度（CSS px）。页面侧兜底轮询用；主要注入路径见 injectStatusBarHeight。 */
        @JavascriptInterface
        fun getStatusBarHeightPx(): Int = statusBarHeightCssPx

        /**
         * 让网页直接发一条真正的系统通知（网页侧封装在 lib/shell-notify.ts）。
         *
         * 为什么必须由壳来做：Android WebView 里 Notification API 与 PushManager 都
         * 不存在，网页再怎么请求权限也弹不出通知，过去壳内只有覆盖在手机界面上的
         * 站内横幅。这里用 NotificationManager 发到「角色消息」渠道，与离线推送同一个
         * 渠道，锁屏/通知栏/后台都能看到。
         *
         * @param avatarUrl 角色头像：data:image/... 内联，或 http(s) 直链；空则用应用图标。
         * @return 是否已发出（JS 端据此决定要不要退回浏览器通知路径）。
         */
        @JavascriptInterface
        fun notify(title: String, body: String, avatarUrl: String, sessionId: String?): Boolean = runCatching {
            ensureMessageChannel()
            val manager = getSystemService(NotificationManager::class.java)
            val icon = loadAvatarBitmap(avatarUrl)
            val builder = NotificationCompat.Builder(this@MainActivity, CH_MESSAGES)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title.ifBlank { "小手机" })
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(contentIntent(sessionId))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
            if (icon != null) builder.setLargeIcon(icon)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                builder.setColor(0xFF5B7CFA.toInt())
            }
            manager.notify(webNotifId++, builder.build())
            if (webNotifId > 900) webNotifId = 500
            true
        }.getOrDefault(false)

        /**
         * 按直链交给系统下载管理器下载（真·后台）。
         *
         * 页面里 fetch → blob → base64 → saveBase64File 这条路虽然能落盘，但读取与编码
         * 全在网页里跑：App 一进后台 WebView 就暂停 JS，下载随之卡住。有直链的资源
         * （图片、音乐、安装包等）走这里，交给系统托管——切后台、锁屏、退出 App 都会继续，
         * 完成后通知栏提示。返回是否成功入队。
         */
        @JavascriptInterface
        fun downloadUrl(url: String, fileName: String): Boolean = runCatching {
            if (!url.startsWith("http://") && !url.startsWith("https://")) return@runCatching false
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safeDownloadName(fileName))
            }
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
            true
        }.getOrDefault(false)

        // ── 通话浮窗 ──────────────────────────────

        /**
         * 开一个原生通话浮窗（浮在其他 App 上层）。
         *
         * 网页侧在通话开始/缩小时调用；参数是渲染所需的全部信息：
         * @param name   角色名
         * @param avatar 头像：data:image/... 内联或 http(s) 直链，空则纯色底
         * @param meta   底部信息（如「语音通话 · 00:12」，换行分段）
         * @param callId 本次通话 id，随事件回传，供网页校验是不是同一通电话
         * @return 是否已具备浮窗权限；false 时网页应引导用户去授权
         */
        @JavascriptInterface
        fun startCallOverlay(name: String, avatar: String, meta: String, callId: String, elapsedSeconds: Int): Boolean {
            // 通话接通时（App 一定在前台）就把服务暖好：窗口建出来但先藏着。
            // 切到后台只是把已有窗口显示出来（showCallOverlay），不再从后台启动
            // 前台服务——Android 12+ 会拒绝，浮窗于是「有时不弹」。
            if (!CallOverlayService.canDraw(this@MainActivity)) return false
            // 头像落成缓存文件再传：内联 data URL 可能有几 MB，塞进 Intent 会抛
            // TransactionTooLargeException，服务根本起不来（浮窗不出现的真凶）。
            val avatarRef = CallOverlayService.prepareAvatarRef(this@MainActivity, avatar)
            // 交给 start 判断成败：它会把失败原因记进诊断，网页侧据此提示而不是静默
            return CallOverlayService.start(this@MainActivity, name, avatarRef, meta, callId, elapsedSeconds)
        }

        /** 浮窗内部状态快照（JSON），网页诊断面板直接展示。 */
        @JavascriptInterface
        fun getOverlayDebugInfo(): String = CallOverlayService.debugInfo(this@MainActivity)

        /** 切到后台：把预热好的浮窗显示出来。 */
        @JavascriptInterface
        fun showCallOverlay() {
            runCatching { CallOverlayService.show(this@MainActivity) }
        }

        /** 回到前台：把浮窗藏起来（服务继续活着，下次切出去秒显）。 */
        @JavascriptInterface
        fun hideCallOverlay() {
            runCatching { CallOverlayService.hide(this@MainActivity) }
        }

        /** 更新浮窗显示（改名/换头像/刷新时长），不重建窗口。 */
        @JavascriptInterface
        fun updateCallOverlay(name: String, avatar: String, meta: String, elapsedSeconds: Int) {
            // 同样走缓存文件：update 也是 Intent，一样受 Binder 事务上限约束
            val avatarRef = CallOverlayService.prepareAvatarRef(this@MainActivity, avatar)
            runCatching { CallOverlayService.update(this@MainActivity, name, avatarRef, meta, elapsedSeconds) }
        }

        /**
         * 更新浮窗左上角的「待发 N」角标（0 = 隐藏）。
         *
         * 网页小窗一直有这个角标，原生浮窗此前没有：通话忙碌时从浮窗回复条
         * 发的消息会排队等角色说完，没有角标用户完全不知道话还排着，只当是丢了。
         * 走同进程实例直改（不走 Intent）：角标是高频小改动，没必要排队等一次
         * Service 投递。
         */
        @JavascriptInterface
        fun updateCallOverlayPending(count: Int) {
            runCatching { CallOverlayService.updatePending(this@MainActivity, count) }
        }

        /** 收掉浮窗（挂断或退回全屏时调用）。 */
        @JavascriptInterface
        fun stopCallOverlay() {
            runCatching { CallOverlayService.stop(this@MainActivity) }
        }

        /** 读当前快捷回复条配色（网页侧「通话浮窗外观」用它回显预设与自定义项）。 */
        @JavascriptInterface
        fun getOverlayThemeJson(): String = CallOverlayService.currentThemeJson(this@MainActivity)

        /** 下发完整配色（预设键 + 逐项自定义）；已弹出的回复条会即时换色。 */
        @JavascriptInterface
        fun setOverlayThemeJson(json: String) {
            runCatching { CallOverlayService.setThemeJson(this@MainActivity, json) }
        }

        /** 浮窗权限是否已授予。 */
        @JavascriptInterface
        fun canDrawOverlay(): Boolean = CallOverlayService.canDraw(this@MainActivity)

        /** 跳到系统的「显示在其他应用上层」授权页。 */
        @JavascriptInterface
        fun requestOverlayPermission() {
            if (Build.VERSION.SDK_INT < 23) return
            runCatching {
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:$packageName"),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }

        /** 无障碍服务是否已开启。 */
        @JavascriptInterface
        fun isAccessibilityConnected(): Boolean = CallControlService.connected

        /** 跳到系统「无障碍」设置页，引导用户开启通话控制服务。 */
        @JavascriptInterface
        fun openAccessibilitySettings() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }

        /** 打开本应用的系统设置页（引导用户关电池限制、开自启动）。 */
        @JavascriptInterface
        fun openAppSettings() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }

        /** 请求忽略电池优化（保活关键一步）。 */
        @SuppressLint("BatteryLife")
        @JavascriptInterface
        fun requestIgnoreBatteryOptimization() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }

        /**
         * 把 base64 内容写入公共「下载」目录（导出备份、导出数据用）。
         *
         * 为什么必须走这里：网页导出走的是 blob: + a[download]，而 WebView 的
         * DownloadListener 拿到 blob: 时 DownloadManager 取不到内存地址，
         * 页面上既没落盘也没有任何提示。所以页面把内容 base64 交给壳来落盘。
         * Android 10+ 走 MediaStore 不需要任何权限；8/9 需要 WRITE_EXTERNAL_STORAGE
         * （Manifest 里已用 maxSdkVersion=28 限定）。
         * 返回是否写入成功；文件名里的非法字符会被替换，避免路径穿越。
         */
        @JavascriptInterface
        fun saveBase64File(fileName: String, base64: String): Boolean = runCatching {
            val safeName = fileName
                .replace(Regex("[\\\\/:*?\"<>|]"), "_")
                .trim()
                .ifBlank { "download" }
                .take(120)
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                    put(MediaStore.Downloads.MIME_TYPE, guessMimeType(safeName))
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return@runCatching false
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                    ?: return@runCatching false
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                contentResolver.update(uri, values, null, null)
            } else {
                @Suppress("DEPRECATION")
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                if (!dir.exists()) dir.mkdirs()
                FileOutputStream(File(dir, safeName)).use { it.write(bytes) }
            }
            true
        }.getOrDefault(false)

        /**
         * 打开另一个 App（桌宠联动用）。给出目标包名；可选的 dataUrl 会作为
         * Intent.data 带上（对方 Activity 的 intent-filter 能收到）。
         * 返回是否成功发起跳转——目标未安装时返回 false，页面据此提示。
         */
        @JavascriptInterface
        fun launchExternalApp(packageName: String, dataUrl: String): Boolean = runCatching {
            val intent = packageManager.getLaunchIntentForPackage(packageName)
                ?: return@runCatching false
            if (dataUrl.isNotBlank()) intent.data = Uri.parse(dataUrl)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            true
        }.getOrDefault(false)

        /**
         * 用 ACTION_VIEW 打开任意 URL / 自定义 scheme（如桌宠的 deskpet://xxx）。
         * 与 launchExternalApp 的区别：这条路不绑定包名，由系统按 scheme 匹配目标，
         * 对方只需在 Manifest 里声明对应的 intent-filter——是跨 App 联动的推荐方式，
         * 而且对方没在运行时也能把它的入口 Activity 拉起来。
         */
        @JavascriptInterface
        fun openUrl(url: String): Boolean = runCatching {
            startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            true
        }.getOrDefault(false)
    }

    /**
     * 兜底创建「角色消息」渠道。
     *
     * PushService 也会建同名渠道，但两者时机不定：网页可能在推送服务起来前就
     * 发第一条消息通知，那时渠道还不存在——Android 8+ 上往未创建的渠道发通知
     * 会被静默丢弃（通知栏什么都不出现，且没有任何报错）。这里补一次幂等创建。
     * 渠道已存在时 createNotificationChannel 只更新名称与描述，不会重置用户的
     * 重要性/声音选择。
     */
    private fun ensureMessageChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        runCatching {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CH_MESSAGES, "角色消息", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "角色发来的消息"
                },
            )
        }
    }

    /**
     * 把网页传来的头像变成通知大图标。支持 data:image/... 内联与 http(s) 直链。
     * 解析失败或超时一律返回 null，调用方退回应用图标——头像只是锦上添花，
     * 绝不能因为一张图让通知迟到或丢失。
     */
    private fun loadAvatarBitmap(avatarUrl: String): Bitmap? {
        val value = avatarUrl.trim()
        if (value.isEmpty()) return null
        return runCatching {
            if (value.startsWith("data:image/")) decodeDataUrlBitmap(value) else fetchRemoteAvatar(value)
        }.getOrNull()
    }

    /** 解 data:image/png;base64,xxxx 形式的头像。 */
    private fun decodeDataUrlBitmap(dataUrl: String): Bitmap? = runCatching {
        val comma = dataUrl.indexOf(',')
        if (comma < 0) return@runCatching null
        val header = dataUrl.substring(0, comma)
        if (!header.contains("base64", ignoreCase = true)) return@runCatching null
        val bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }.getOrNull()

    /** 拉取远程头像。站点可能要求登录 Cookie，这里带上；失败返回 null。 */
    private fun fetchRemoteAvatar(url: String): Bitmap? = runCatching {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return@runCatching null
        val builder = Request.Builder().url(url)
        val cookie = CookieManager.getInstance().getCookie(url)
        if (!cookie.isNullOrEmpty()) builder.header("Cookie", cookie)
        avatarClient.newCall(builder.build()).execute().use { response ->
            if (!response.isSuccessful) return@runCatching null
            val bytes = response.body?.bytes() ?: return@runCatching null
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }
    }.getOrNull()

    /** 按扩展名猜 MIME，MediaStore 用；猜不中给通用二进制。 */
    private fun guessMimeType(fileName: String): String = when (fileName.substringAfterLast('.', "").lowercase()) {
        "json" -> "application/json"
        "zip" -> "application/zip"
        "txt" -> "text/plain"
        "md" -> "text/markdown"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "mp3" -> "audio/mpeg"
        "wav" -> "audio/wav"
        "mp4" -> "video/mp4"
        else -> "application/octet-stream"
    }
}
