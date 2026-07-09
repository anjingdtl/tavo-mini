package com.shinewriter.debug

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.shinewriter.llamacpp.GenerateOptions
import com.shinewriter.llamacpp.LlamaCppEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Debug-only 测试 Activity：
 *  - 加载 sdcard 或 App 私有目录的 .gguf 模型
 *  - 默认跑 256 token 生成（够长，方便测 cancel）
 *  - 监听 broadcast：
 *      com.shinewriter.LLAMA_CANCEL      → engine.cancel()  测 P0-#3 (g_cancelled 保护)
 *      com.shinewriter.LLAMA_CONCURRENT  → 启动第二个 generate 测 P0-#2 (try_lock 拒绝并发)
 *  - 第三个 generate 通过 engine.generate() 自己被 reject（activeRequestId 已占用）
 */
class LlamaTestActivity : Activity() {

    companion object {
        private const val TAG = "LlamaTest"
        private const val DEFAULT_MODEL_PATH =
            "/data/data/com.shinewriter/files/models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"
        private const val DEFAULT_PROMPT =
            "<|im_start|>system\nYou are a helpful assistant.<|im_end|>\n" +
                "<|im_start|>user\n用一段话详细介绍你自己，包括你的名字、性格、专长和一段简短的童年故事。<|im_end|>\n" +
                "<|im_start|>assistant\n"
        private const val ACTION_CANCEL = "com.shinewriter.LLAMA_CANCEL"
        private const val ACTION_CONCURRENT = "com.shinewriter.LLAMA_CONCURRENT"
    }

    private lateinit var statusView: TextView
    private lateinit var outputView: TextView
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var engine: LlamaCppEngine? = null
    @Volatile private var testJob: Job? = null
    @Volatile private var concurrentLaunched: Boolean = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            when (intent?.action) {
                ACTION_CANCEL -> {
                    Log.i(TAG, "BroadcastReceiver: CANCEL received")
                    appendStatus("[BROADCAST] 收到 CANCEL，调 engine.cancel()")
                    engine?.cancel()
                }
                ACTION_CONCURRENT -> {
                    Log.i(TAG, "BroadcastReceiver: CONCURRENT received")
                    appendStatus("[BROADCAST] 收到 CONCURRENT，启动第二次 generate")
                    if (concurrentLaunched) {
                        appendStatus("[CONCURRENT] 已经触发过，忽略重复")
                        return
                    }
                    concurrentLaunched = true
                    launchConcurrentGenerate()
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 64, 32, 32)
        }
        statusView = TextView(this).apply {
            textSize = 16f
            text = "状态：初始化..."
        }
        outputView = TextView(this).apply {
            textSize = 14f
            setTextIsSelectable(true)
        }
        val scroll = ScrollView(this).apply {
            addView(outputView, LinearLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f)
        }
        root.addView(statusView, LinearLayout.LayoutParams(MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        root.addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        setContentView(root, LinearLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        val filter = IntentFilter().apply {
            addAction(ACTION_CANCEL)
            addAction(ACTION_CONCURRENT)
        }
        // API 33+ 需要指定 RECEIVER_EXPORTED / NOT_EXPORTED flag
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(receiver, filter)
        }

        window.decorView.post { startTest() }
    }

    fun appendStatus(s: String) {
        runOnUiThread { statusView.text = "状态：$s" }
    }

    fun appendOutput(delta: String) {
        runOnUiThread { outputView.append(delta) }
    }

    private fun startTest() {
        val modelPath = intent.getStringExtra("model_path") ?: DEFAULT_MODEL_PATH
        val prompt = intent.getStringExtra("prompt") ?: DEFAULT_PROMPT
        val maxTokens = intent.getIntExtra("max_tokens", 256)
        appendStatus("model_path = $modelPath  maxTokens=$maxTokens")
        Log.i(TAG, "startTest: model=$modelPath maxTokens=$maxTokens")

        testJob = scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val e = LlamaCppEngine.getInstance(applicationContext)
                    engine = e
                    Log.i(TAG, "engine obtained, calling load()")
                    val result = e.load(
                        modelId = "test-model-001",
                        absolutePath = modelPath,
                        contextLength = 2048,
                    )
                    if (result.isFailure) {
                        val ex = result.exceptionOrNull()
                        appendStatus("加载失败：${ex?.message}")
                        Log.e(TAG, "load failed", ex)
                        return@withContext
                    }
                    val loadResult = result.getOrThrow()
                    appendStatus("加载成功 ${loadResult.loadTimeMs}ms - 推理中…（可用广播触发 cancel/concurrent）")
                    Log.i(TAG, "load success: $loadResult")

                    val latch = CountDownLatch(1)
                    val cb = TestGenCallback(
                        "test-req-1",
                        latch,
                        { delta -> appendOutput(delta) },
                        { status -> appendStatus(status) },
                    )
                    val opts = GenerateOptions(
                        maxTokens = maxTokens,
                        temperature = 0.7f,
                        topP = 0.9f,
                    )
                    e.generate(
                        requestId = "test-req-1",
                        prompt = prompt,
                        opts = opts,
                        callback = cb,
                    )
                    val done = latch.await(300, TimeUnit.SECONDS)
                    if (!done) {
                        appendStatus("超时未完成")
                        Log.w(TAG, "latch timeout")
                    } else {
                        appendStatus("流程结束")
                    }
                    e.unload()
                }
            } catch (t: Throwable) {
                Log.e(TAG, "test failed", t)
                appendStatus("异常：${t.message}")
            }
        }
    }

    private fun launchConcurrentGenerate() {
        val e = engine ?: return
        // P0-#2: 在第一个 generate 进行中调第二次 generate，应该被 reject
        // 第二个 callback 不需要 latch，直接 fire and forget
        val cb = TestGenCallback(
            "test-req-2",
            CountDownLatch(0), // 立即完成
            { delta -> appendOutput("[REQ2]$delta") },
            { status -> appendStatus("[REQ2] $status") },
        )
        val opts = GenerateOptions(
            maxTokens = 16,
            temperature = 0.7f,
            topP = 0.9f,
        )
        e.generate(
            requestId = "test-req-2",
            prompt = "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n",
            opts = opts,
            callback = cb,
        )
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            unregisterReceiver(receiver)
        } catch (_: Throwable) { /* may already be unregistered */ }
        scope.coroutineContext[Job]?.cancel()
    }
}
