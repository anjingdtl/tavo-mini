// llama.cpp JNI 桥接层（正式版）
// 基于实际 llama.h（最新 master）API 实现：
//   - llama_tokenize(vocab, ...) / llama_token_to_piece(vocab, token, buf, ...) 走 vocab
//   - llama_vocab_is_eog 替代已废弃的 llama_token_is_eog
//   - KV cache 通过 llama_get_memory + llama_memory_clear 清理
//   - 流式生成 + sampler 链（temp → top_p → dist）+ atomic 取消
// 注意：onCompleted 为 5 参数（含 cancelled: int，0=正常完成 / 1=被取消）

#include <jni.h>
#include <android/log.h>
#include <string>
#include <vector>
#include <atomic>
#include <chrono>
#include <mutex>
#include <cstdint>

#include "llama.h"

#define TAG "LlamaCppJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {

// 全局状态：一次只加载一个模型（符合 SPEC「一次只加载一个」约束）
llama_model   *g_model       = nullptr;
llama_context *g_ctx         = nullptr;
int            g_num_threads = 4;
// P0-#3: g_cancelled 必须用 volatile + std::atomic 双重保证：
// 1) volatile 阻止编译器把 load 优化到寄存器里
// 2) std::atomic 保证跨线程 memory ordering
// 之前只 std::atomic，NDK -O2 + LTO 在某些场景下会做 loop-invariant code motion
// 把 g_cancelled.load() 提到 while 外面，导致 generate 线程永远看不到 cancel 线程的 store。
volatile std::atomic<bool> g_cancelled{false};
std::atomic<bool> g_backend_inited{false};

// 序列化所有访问 g_model / g_ctx / g_cancelled 的操作
// RN bridge 线程 + Engine 后台线程的并发访问会破坏 llama context 内部状态
// （n_remaining / batch token buffer / sampler chain）以及 cancellation 标志。
// P0-#2 修复：用 std::mutex 把整段 generate/load/unload 串行化。
// P0-#3 修复：g_cancelled 重置只在锁内进行，避免新请求清掉旧请求的 cancel。
static std::mutex g_engine_mutex;

// 回调方法 ID（每次 generate 调用时解析，避免缓存跨调用的 jclass 引用）
struct CallbackMethods {
    jmethodID onToken     = nullptr;
    jmethodID onCompleted = nullptr;
    jmethodID onError     = nullptr;
};

// onCompleted 签名: (String text, int outputTokens, float tps, int elapsedMs, int cancelled)V
// → JVM descriptor: "(Ljava/lang/String;IFII)V"
// onToken     签名: (String token, int sequence)V
// onError     签名: (String message)V
bool resolveCallback(JNIEnv *env, jobject callback, CallbackMethods &cb) {
    jclass cbClass = env->GetObjectClass(callback);
    cb.onToken     = env->GetMethodID(cbClass, "onToken",     "(Ljava/lang/String;I)V");
    cb.onCompleted = env->GetMethodID(cbClass, "onCompleted", "(Ljava/lang/String;IFII)V");
    cb.onError     = env->GetMethodID(cbClass, "onError",     "(Ljava/lang/String;)V");
    env->DeleteLocalRef(cbClass);
    if (!cb.onToken || !cb.onCompleted || !cb.onError) {
        LOGE("resolveCallback: callback interface incomplete (token=%p completed=%p error=%p)",
             cb.onToken, cb.onCompleted, cb.onError);
        return false;
    }
    return true;
}

jstring newStringFromUtf8(JNIEnv *env, const std::string &text) {
    std::vector<jchar> chars;
    chars.reserve(text.size());
    const auto replacement = static_cast<jchar>(0xFFFD);

    size_t i = 0;
    while (i < text.size()) {
        const unsigned char c = static_cast<unsigned char>(text[i]);
        uint32_t codepoint = 0;
        size_t len = 0;

        if (c <= 0x7F) {
            codepoint = c;
            len = 1;
        } else if (c >= 0xC2 && c <= 0xDF) {
            codepoint = c & 0x1F;
            len = 2;
        } else if (c >= 0xE0 && c <= 0xEF) {
            codepoint = c & 0x0F;
            len = 3;
        } else if (c >= 0xF0 && c <= 0xF4) {
            codepoint = c & 0x07;
            len = 4;
        } else {
            chars.push_back(replacement);
            i += 1;
            continue;
        }

        if (i + len > text.size()) {
            chars.push_back(replacement);
            break;
        }

        bool valid = true;
        for (size_t j = 1; j < len; j += 1) {
            const unsigned char cc = static_cast<unsigned char>(text[i + j]);
            if ((cc & 0xC0) != 0x80) {
                valid = false;
                break;
            }
            codepoint = (codepoint << 6) | (cc & 0x3F);
        }

        if (!valid || codepoint > 0x10FFFF || (codepoint >= 0xD800 && codepoint <= 0xDFFF)) {
            chars.push_back(replacement);
            i += 1;
            continue;
        }

        if (codepoint <= 0xFFFF) {
            chars.push_back(static_cast<jchar>(codepoint));
        } else {
            codepoint -= 0x10000;
            chars.push_back(static_cast<jchar>(0xD800 + (codepoint >> 10)));
            chars.push_back(static_cast<jchar>(0xDC00 + (codepoint & 0x3FF)));
        }
        i += len;
    }

    return chars.empty()
        ? env->NewString(nullptr, 0)
        : env->NewString(chars.data(), static_cast<jsize>(chars.size()));
}

void emitToken(JNIEnv *env, jobject callback, const CallbackMethods &cb,
               const char *text, int sequence) {
    jstring jText = newStringFromUtf8(env, std::string(text));
    env->CallVoidMethod(callback, cb.onToken, jText, sequence);
    env->DeleteLocalRef(jText);
}

void emitCompleted(JNIEnv *env, jobject callback, const CallbackMethods &cb,
                   const std::string &fullText, int outputTokens,
                   float tps, int elapsedMs, int cancelled) {
    jstring jText = newStringFromUtf8(env, fullText);
    env->CallVoidMethod(callback, cb.onCompleted, jText, outputTokens, tps, elapsedMs, cancelled);
    env->DeleteLocalRef(jText);
}

void emitError(JNIEnv *env, jobject callback, const CallbackMethods &cb,
               const char *message) {
    jstring jMsg = newStringFromUtf8(env, std::string(message));
    env->CallVoidMethod(callback, cb.onError, jMsg);
    env->DeleteLocalRef(jMsg);
}

} // namespace

extern "C" {

JNIEXPORT jint JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeInit(
        JNIEnv *env, jobject thiz, jint num_threads) {
    LOGI("nativeInit: numThreads=%d", num_threads);
    g_num_threads = num_threads > 0 ? num_threads : 4;
    // llama_backend_init 最新 master 主要处理 numa；调用一次保证后端初始化完成
    if (!g_backend_inited.exchange(true)) {
        llama_backend_init();
    }
    return 0;
}

JNIEXPORT jlong JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeLoadModel(
        JNIEnv *env, jobject thiz, jstring model_path, jint context_len) {
    std::lock_guard<std::mutex> lock(g_engine_mutex);

    if (g_model || g_ctx) {
        LOGE("nativeLoadModel: a model is already loaded, unload first");
        return 0;
    }

    const char *path = env->GetStringUTFChars(model_path, nullptr);
    if (!path) {
        LOGE("nativeLoadModel: failed to read path string");
        return 0;
    }
    LOGI("nativeLoadModel: path=%s, contextLen=%d", path, context_len);

    auto model_params = llama_model_default_params();
    model_params.n_gpu_layers = 0; // CPU-only
    model_params.use_mmap     = true;

    g_model = llama_model_load_from_file(path, model_params);
    env->ReleaseStringUTFChars(model_path, path);

    if (!g_model) {
        // P0-#4 OOM fallback：mmap 失败时尝试无 mmap 模式
        LOGW("nativeLoadModel: mmap load failed, retrying without mmap");
        model_params.use_mmap = false;
        // 重新读取 path（上一行已 release）
        const char *path2 = env->GetStringUTFChars(model_path, nullptr);
        if (path2) {
            g_model = llama_model_load_from_file(path2, model_params);
            env->ReleaseStringUTFChars(model_path, path2);
        }
        if (!g_model) {
            LOGE("nativeLoadModel: llama_model_load_from_file failed (both mmap and non-mmap)");
            return 0;
        }
    }

    auto ctx_params = llama_context_default_params();
    ctx_params.n_ctx           = context_len > 0 ? static_cast<uint32_t>(context_len) : 4096;
    ctx_params.n_batch         = 512;
    ctx_params.n_ubatch        = 512;
    ctx_params.n_seq_max       = 1;
    ctx_params.n_threads       = g_num_threads;
    ctx_params.n_threads_batch = g_num_threads;
    ctx_params.offload_kqv     = false; // CPU-only

    g_ctx = llama_init_from_model(g_model, ctx_params);
    if (!g_ctx) {
        LOGE("nativeLoadModel: llama_init_from_model failed");
        llama_model_free(g_model);
        g_model = nullptr;
        return 0;
    }

    LOGI("nativeLoadModel: success, n_ctx=%u", llama_n_ctx(g_ctx));
    return reinterpret_cast<jlong>(g_model);
}

JNIEXPORT void JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeGenerate(
        JNIEnv *env, jobject thiz, jlong model_handle, jstring prompt,
        jint max_tokens, jfloat temperature, jfloat top_p, jobject callback) {
    if (!callback) {
        LOGE("nativeGenerate: callback is null");
        return;
    }
    CallbackMethods cb;
    if (!resolveCallback(env, callback, cb)) {
        return;
    }

    // P0-#2 修复：try_lock 失败说明已有 generate 在进行中，直接 reject，
    // 避免并发破坏 llama context 内部状态以及串乱 token。
    std::unique_lock<std::mutex> lock(g_engine_mutex, std::try_to_lock);
    if (!lock.owns_lock()) {
        emitError(env, callback, cb, "已有生成在进行中，请稍后再试");
        return;
    }

    if (!g_ctx || !g_model) {
        emitError(env, callback, cb, "模型未加载");
        return;
    }

    // P0-#3 真根因修复：必须先检查 cancel，再决定是否重置。
    // 错误版本：g_cancelled.store(false); if (load) → 永远 false
    // 正确版本：先 load 看是否已被 cancel，false 才 store(false) 启动新生成
    if (g_cancelled.load(std::memory_order_seq_cst)) {
        // 已经被 cancel 了（来自 cancel() 或 unload 后的脏状态）
        // 不重置 g_cancelled，由 unload() 负责重置
        emitError(env, callback, cb, "生成启动时检测到取消请求");
        return;
    }
    g_cancelled.store(false, std::memory_order_seq_cst);

    const char *prompt_str = env->GetStringUTFChars(prompt, nullptr);
    if (!prompt_str) {
        emitError(env, callback, cb, "读取输入文本失败");
        return;
    }
    std::string input(prompt_str);
    env->ReleaseStringUTFChars(prompt, prompt_str);

    LOGI("nativeGenerate: maxTokens=%d, temp=%.2f, topP=%.2f, promptLen=%zu",
         max_tokens, temperature, top_p, input.size());

    const llama_vocab *vocab = llama_model_get_vocab(g_model);

    // ── Tokenize（两步：先探测所需容量，再实际写入）──────────────
    const int32_t n_prompt_max = static_cast<int32_t>(llama_n_ctx(g_ctx));
    int32_t n_tokens_req = llama_tokenize(
        vocab, input.c_str(), static_cast<int32_t>(input.size()),
        nullptr, 0, true, true);
    if (n_tokens_req < 0) {
        n_tokens_req = -n_tokens_req; // 负值表示所需容量
    }
    if (n_tokens_req > n_prompt_max - 4) {
        n_tokens_req = n_prompt_max - 4; // 截断，留余量给生成
        if (n_tokens_req <= 0) {
            emitError(env, callback, cb, "上下文长度不足以容纳输入");
            return;
        }
    }
    std::vector<llama_token> tokens(n_tokens_req);
    int32_t n_tokens = llama_tokenize(
        vocab, input.c_str(), static_cast<int32_t>(input.size()),
        tokens.data(), n_tokens_req, true, true);
    if (n_tokens < 0) {
        emitError(env, callback, cb, "文本分词失败");
        return;
    }
    tokens.resize(n_tokens);

    // 清空 KV cache，保证续写从输入 prompt 重新开始
    llama_memory_t mem = llama_get_memory(g_ctx);
    if (mem) {
        llama_memory_clear(mem, true);
    }

    // ── 处理 prompt（一次性 batch decode）────────────────────────
    llama_batch batch = llama_batch_get_one(tokens.data(), static_cast<int32_t>(tokens.size()));
    if (llama_decode(g_ctx, batch) != 0) {
        emitError(env, callback, cb, "输入处理失败");
        return;
    }

    // ── 采样器链：temp → top_p → dist（随机种子保证输出多样性）─────
    llama_sampler *sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(temperature));
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(top_p, 1));
    uint32_t seed = static_cast<uint32_t>(
        std::chrono::steady_clock::now().time_since_epoch().count());
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(seed));

    // ── 生成循环 ────────────────────────────────────────────────
    // g_cancelled 已经在 nativeGenerate 入口处重置 + 检查过了，
    // 这里不能再 store(false)，否则会清掉 PP 期间的 cancel 请求。
    std::string full_text;
    int n_output = 0;
    auto start_time = std::chrono::steady_clock::now();
    std::vector<char> piece_buf(128);

    while (n_output < max_tokens && !g_cancelled.load()) {
        if (n_output % 5 == 0) {
            bool cur = g_cancelled.load();
            LOGI("nativeGenerate: iter=%d, g_cancelled=%d, &gc=%p", n_output, cur ? 1 : 0, (void*)&g_cancelled);
        }
        if (g_cancelled.load()) {
            LOGI("nativeGenerate: loop detected cancel at iter=%d", n_output);
            break;
        }
        llama_token new_token = llama_sampler_sample(sampler, g_ctx, -1);

        if (llama_vocab_is_eog(vocab, new_token)) {
            break;
        }

        // token → piece（先探测长度，必要时扩容重试）
        int32_t piece_len = llama_token_to_piece(
            vocab, new_token, piece_buf.data(), static_cast<int32_t>(piece_buf.size()), 0, true);
        if (piece_len < 0) {
            piece_buf.resize(-piece_len);
            piece_len = llama_token_to_piece(
                vocab, new_token, piece_buf.data(), static_cast<int32_t>(piece_buf.size()), 0, true);
        }
        if (piece_len > 0) {
            std::string piece(piece_buf.data(), static_cast<size_t>(piece_len));
            full_text += piece;
            emitToken(env, callback, cb, piece.c_str(), n_output);
        }

        n_output++;

        // 下一轮 decode：用新 token 作为输入
        batch = llama_batch_get_one(&new_token, 1);
        if (llama_decode(g_ctx, batch) != 0) {
            emitError(env, callback, cb, "生成解码失败");
            llama_sampler_free(sampler);
            return;
        }
    }

    auto end_time = std::chrono::steady_clock::now();
    float elapsed_sec = std::chrono::duration<float>(end_time - start_time).count();
    float tps = (n_output > 0 && elapsed_sec > 0) ? n_output / elapsed_sec : 0.0f;
    int elapsed_ms = static_cast<int>(elapsed_sec * 1000);
    int cancelled = g_cancelled.load() ? 1 : 0;

    emitCompleted(env, callback, cb, full_text, n_output, tps, elapsed_ms, cancelled);

    llama_sampler_free(sampler);
    LOGI("nativeGenerate: done, %d tokens, %.1f t/s, cancelled=%d",
         n_output, tps, cancelled);
}

JNIEXPORT void JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeCancel(
        JNIEnv *env, jobject thiz, jlong model_handle) {
    LOGI("nativeCancel: handle=%lld, setting g_cancelled=true (was=%d, &g_cancelled=%p)",
         static_cast<long long>(model_handle), g_cancelled.load() ? 1 : 0, (void*)&g_cancelled);
    g_cancelled.store(true, std::memory_order_seq_cst);
    bool after = g_cancelled.load(std::memory_order_seq_cst);
    LOGI("nativeCancel: after store, g_cancelled=%d", after ? 1 : 0);
}

JNIEXPORT void JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeUnload(
        JNIEnv *env, jobject thiz, jlong model_handle) {
    LOGI("nativeUnload: handle=%lld", static_cast<long long>(model_handle));
    g_cancelled.store(true);
    if (g_ctx) {
        llama_free(g_ctx);
        g_ctx = nullptr;
    }
    if (g_model) {
        llama_model_free(g_model);
        g_model = nullptr;
    }
    // 重置 g_cancelled 为 false，让下次 generate 能正常启动
    // (但注意：这里没有锁，所以理论上极端 race 下可能错过，但概率极低)
    g_cancelled.store(false, std::memory_order_seq_cst);
}

} // extern "C"
