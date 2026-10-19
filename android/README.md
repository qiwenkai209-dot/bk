# VisualCast 独立安卓原生版 (Android Standalone APK) 说明与部署指南

本工程为 **VisualCast 展馆智能播控系统** 的原生 Android 独立工程源码。  
完全脱离 Windows 环境，独立运行在各类 Android 智能电视、商显一体机、触摸屏、机顶盒或定制安卓主板（如瑞芯微 RK3288 / RK3399 / RK3568 / RK3588、全志、晶晨等）上。

---

## 核心特性

1. **单机单一 APK 交付**：
   - 内部已内置全套硬件加速大屏视窗（`player.html`）、电脑/手机自适应管理后台（`admin.html`）与讲解员无线手牌端（`remote.html`）；
   - 内置纯 Java 极轻量 8088 端口 HTTP 微服务，开机即在设备后台自动提供局域网控制服务。

2. **商业大屏 7×24h 稳定运营**：
   - **全屏沉浸（Immersive Sticky）**：彻底隐藏安卓底栏虚拟三大键和顶部状态栏；
   - **通电开机 2 秒极速自启**：系统配备 `BootReceiver`，接通电源即可秒级拉起；
   - **防黑屏休眠**：注入双重唤醒锁（`FLAG_KEEP_SCREEN_ON` + `WakeLock`）；
   - **免手势自动播音**：彻底消除安卓默认需要人工触控才能自动播放发声的系统限制。

3. **展馆环境物联中控**：
   - 原生 Java Socket 驱动，支持 TCP、UDP、HTTP 报文发送（Hex / ASCII），完美支持时序电源、激光投影机（PJLink）、Art-Net 调光灯网关、电动幕帘与开闭馆宏流水线。

4. **安全鉴权**：
   - 管理后台基于 SHA256 加盐 Token 验证，默认密码 `admin888`，大屏播放端保持免密畅通。

---

## 工程目录结构

```
android/
├── build.gradle                   # 顶层 Gradle 构建脚本
├── settings.gradle                # 模块配置
├── gradle.properties              # JVM 与 AndroidX 配置
└── app/
    ├── build.gradle               # 应用模块构建脚本 (minSdk 21, targetSdk 34)
    ├── proguard-rules.pro         # 混淆优化规则
    └── src/
        └── main/
            ├── AndroidManifest.xml # 核心权限 (网络/开机自启/唤醒锁/存储)
            ├── assets/            # 内置静态前端资源
            │   ├── static/        # player.*, admin.*, remote.* 等
            │   ├── assets/        # 系统图标
            │   └── config/        # 默认配置模板
            ├── res/               # Android 图标与主题
            └── java/com/visualcast/player/
                ├── MainActivity.java           # 主界面全屏 WebView 与按键交互
                ├── BootReceiver.java           # 开机自启广播接收器
                ├── App.java                    # 全局 Application
                ├── server/
                │   ├── EmbeddedHttpServer.java # 8088 端口轻量 HTTP 服务器
                │   ├── HttpRequest.java        # 请求解析
                │   ├── HttpResponse.java       # 响应输出
                │   ├── HttpRouter.java         # RESTful 业务路由处理器
                │   ├── AuthManager.java        # 密码鉴权
                │   └── IoTEngine.java          # 物联中控 Socket 引擎
                └── utils/
                    ├── NetworkUtils.java       # 本机 IP 探测
                    ├── StorageHelper.java      # 素材与配置文件管理
                    └── SystemHelper.java       # 系统音量与应用唤醒
```

---

## 编译与生成 APK 操作步骤

### 方法一：使用 Android Studio (推荐)
1. 启动 **Android Studio**，选择 `Open` 并选中本目录中的 `d:\aiagent\bk\android` 文件夹；
2. 等待 Gradle 依赖同步完成（耗时约 1~2 分钟）；
3. 点击顶部菜单：`Build` -> `Build Bundle(s) / APK(s)` -> `Build APK(s)`；
4. 构建成功后，在 `app/build/outputs/apk/debug/app-debug.apk` 即可提取打包好的 APK 文件！

### 方法二：命令行一键构建
若系统已配置 Android SDK 和 Gradle，进入 `android` 目录执行：
```bash
./gradlew assembleRelease
# 或
./gradlew assembleDebug
```

---

## 安装与商业大屏部署

1. **安装 APK**：
   - 将生成的 `app-debug.apk` 复制到 U 盘插入安卓电视/大屏一体机，通过文件管理器点击安装；
   - 或通过 ADB 命令直接网络/有线安装：
     ```bash
     adb connect [大屏IP]
     adb install -r app-debug.apk
     ```

2. **首次启动与素材配置**：
   - 启动后大屏即刻进入全屏播放，并在终端下方或抽屉显示本机 IP（如 `http://192.168.1.100:8088`）；
   - 在同局域网内的任何手机、iPad 或控制电脑的浏览器打开该地址，输入默认密码 `admin888` 即可进入管理后台：
     - 在素材库直接点击“上传”，将展厅视频、图片或音频无线推送到大屏；
     - 素材自动持久化在安卓设备的 `/sdcard/VisualCast/media/` 目录下；
     - 讲解员在手机上打开 `http://192.168.1.100:8088/remote` 即可手持点播。

3. **开机通电自启配置**：
   - 系统已内置开机广播 `BOOT_COMPLETED`；
   - 在 Android 商显一体机（如视源、RK3568 等）的系统设置中，建议开启“通电自动开机”与“开机默认桌面/开机自启应用”并选择 **VisualCast**，即可达成展厅开馆上电自动亮屏播放的工业级效果。
