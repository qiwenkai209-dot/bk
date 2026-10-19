# Add project specific ProGuard rules here.
-keep class com.visualcast.player.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
