#include <jni.h>
#include <android/log.h>
#include <llama.h>

#define TAG "LlamaCppJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

extern "C" {

JNIEXPORT jint JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeInit(
        JNIEnv *env, jobject thiz, jint num_threads) {
    LOGI("nativeInit: numThreads=%d", num_threads);
    // Stub: return 0 for success
    return 0;
}

JNIEXPORT jlong JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeLoadModel(
        JNIEnv *env, jobject thiz, jstring model_path, jint context_len) {
    const char *path = env->GetStringUTFChars(model_path, nullptr);
    LOGI("nativeLoadModel: path=%s, contextLen=%d", path, context_len);
    env->ReleaseStringUTFChars(model_path, path);
    // Stub: return 0 (no model handle)
    return 0;
}

JNIEXPORT void JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeGenerate(
        JNIEnv *env, jobject thiz, jlong model_handle, jstring prompt,
        jint max_tokens, jfloat temperature, jfloat top_p, jobject callback) {
    const char *prompt_str = env->GetStringUTFChars(prompt, nullptr);
    LOGI("nativeGenerate: handle=%lld, maxTokens=%d, temp=%.2f, topP=%.2f, prompt='%s'",
         (long long)model_handle, max_tokens, temperature, top_p, prompt_str);
    env->ReleaseStringUTFChars(prompt, prompt_str);
    // Stub: no-op
}

JNIEXPORT void JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeCancel(
        JNIEnv *env, jobject thiz, jlong model_handle) {
    LOGI("nativeCancel: handle=%lld", (long long)model_handle);
    // Stub: no-op
}

JNIEXPORT void JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeUnload(
        JNIEnv *env, jobject thiz, jlong model_handle) {
    LOGI("nativeUnload: handle=%lld", (long long)model_handle);
    // Stub: no-op
}

} // extern "C"
