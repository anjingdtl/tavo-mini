# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# LiteRT-LM local model runtime: keep all public classes/methods used by the
# native engine and JNI so that ProGuard/R8 does not strip them in release builds.
-keep class com.google.ai.edge.litertlm.** { *; }

# llama.cpp JNI bridge (android/app/jni/llamacpp_jni.cpp).
# The native code calls back into Kotlin via reflection on these classes/methods.
# Without these rules R8/D8 will rename or strip methods causing
# NoSuchMethodError at runtime.
-keep class com.shinewriter.llamacpp.LlamaCppEngine { *; }
-keep class com.shinewriter.llamacpp.LlamaCppEngine$GenerationCallback { *; }
-keep class com.shinewriter.llamacpp.LlamaCppEngine$* { *; }

# Any external class passed as a callback to LlamaCppEngine.generate(...)
# Keep the three callback methods so JNI GetMethodID can resolve them.
-keep class * implements com.shinewriter.llamacpp.LlamaCppEngine$GenerationCallback { *; }

# Preserve the interface method signatures (required for JNI reflection)
-keep interface com.shinewriter.llamacpp.LlamaCppEngine$GenerationCallback { *; }

# Do not strip method parameters even if they appear unused to R8 — JNI
# resolves methods by exact signature.
-keepattributes Signature, *Annotation*
-keepclassmembers class * implements com.shinewriter.llamacpp.LlamaCppEngine$GenerationCallback {
    public <init>(...);
    public void onToken(java.lang.String, int);
    public void onCompleted(java.lang.String, int, int, float, int, int);
    public void onError(java.lang.String);
}