# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.kts.

# Keep Vonage Client SDK and WebRTC classes
-keep class com.vonage.** { *; }
-keep class org.vonage.** { *; }
-keep class org.webrtc.** { *; }

# Keep jni_zero classes required by libwebrtc native library at runtime
-keep class org.jni_zero.** { *; }

# Keep Kotlinx Serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Keep Ktor classes
-keep class io.ktor.** { *; }

# Suppress missing classes that are only referenced but not used at runtime
-dontwarn com.google.errorprone.annotations.**
-dontwarn java.lang.management.**
-dontwarn org.slf4j.impl.StaticLoggerBinder
