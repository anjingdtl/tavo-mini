package com.shinewriter.llamacpp

import android.content.Context
import android.util.Log

class LlamaCppEngine(private val context: Context) {
    companion object {
        private const val TAG = "LlamaCppEngine"
        init {
            System.loadLibrary("llamacpp_jni")
            Log.i(TAG, "llamacpp_jni library loaded")
        }
    }

    private var modelHandle: Long = 0

    fun init(numThreads: Int): Int {
        return nativeInit(numThreads)
    }

    fun loadModel(modelPath: String, contextLen: Int): Long {
        modelHandle = nativeLoadModel(modelPath, contextLen)
        return modelHandle
    }

    private external fun nativeInit(numThreads: Int): Int
    private external fun nativeLoadModel(modelPath: String, contextLen: Int): Long
    private external fun nativeGenerate(
        modelHandle: Long, prompt: String, maxTokens: Int,
        temperature: Float, topP: Float, callback: Any
    )
    private external fun nativeCancel(modelHandle: Long)
    private external fun nativeUnload(modelHandle: Long)
}
