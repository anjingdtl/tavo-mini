# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# React Native discovers these modules through package metadata and invokes
# their methods from JavaScript. Keep the bridge classes and annotations while
# release minification is evaluated on a real device.
-keep class com.shinewriter.** { *; }
-keep class com.shinewriter.specs.** { *; }
-keepclassmembers class com.shinewriter.** {
    @com.facebook.react.bridge.ReactMethod <methods>;
}

# Native dependencies used by backup-adjacent runtime paths and app startup.
# SQLitePlugin is reflection/package-discovered, Keychain uses annotated
# modules and cipher implementations, and RNFS is used for backup files.
-keep class org.pgsqlite.** { *; }
-keep class com.oblador.keychain.** { *; }
-keep class com.rnfs.** { *; }
-keep class com.facebook.react.module.annotations.** { *; }
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,Signature
