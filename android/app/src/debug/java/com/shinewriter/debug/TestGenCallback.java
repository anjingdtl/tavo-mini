package com.shinewriter.debug;

import android.util.Log;
import com.shinewriter.llamacpp.LlamaCppEngine;
import java.util.concurrent.CountDownLatch;

/**
 * Java-implemented callback to avoid D8 dexer's "kotlin metadata"
 * parameter-stripping optimization on debug builds. See:
 * https://issuetracker.google.com/issues/... (D8 strips unused Kotlin
 * parameters even when the override method signature requires them).
 */
public class TestGenCallback implements LlamaCppEngine.GenerationCallback {

    public interface OutputCallback {
        void onOutput(String delta);
    }

    public interface StatusCallback {
        void onStatus(String status);
    }

    private static final String TAG = "LlamaTest";
    private final String requestId;
    private final CountDownLatch latch;
    private final OutputCallback outputCallback;
    private final StatusCallback statusCallback;

    public TestGenCallback(
        String requestId,
        CountDownLatch latch,
        OutputCallback outputCallback,
        StatusCallback statusCallback
    ) {
        this.requestId = requestId;
        this.latch = latch;
        this.outputCallback = outputCallback;
        this.statusCallback = statusCallback;
    }

    @Override
    public void onToken(String token, int sequence) {
        Log.i(TAG, "token[" + sequence + "]: " + token);
        if (outputCallback != null) {
            outputCallback.onOutput(token);
        }
    }

    @Override
    public void onCompleted(
        String text,
        int outputTokens,
        float tokensPerSecond,
        int elapsedMs,
        int cancelled
    ) {
        Log.i(
            TAG,
            "completed: tokens=" + outputTokens +
                " tps=" + tokensPerSecond +
                " elapsed=" + elapsedMs +
                " cancelled=" + cancelled
        );
        if (statusCallback != null) {
            statusCallback.onStatus(
                "完成 tokens=" + outputTokens +
                    " tps=" + tokensPerSecond +
                    " ms=" + elapsedMs
            );
            statusCallback.onStatus("输出: " + text);
        }
        latch.countDown();
    }

    @Override
    public void onError(String message) {
        Log.e(TAG, "error: " + message);
        if (statusCallback != null) {
            statusCallback.onStatus("ERROR: " + message);
        }
        latch.countDown();
    }

    public String getRequestId() {
        return requestId;
    }
}