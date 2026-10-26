/**
 * VisualCast 展馆智能播控全能管理后台交互引擎
 * 架构整合版：
 * 1. 顶部大屏监控与镜像回显 (1080P 超低延迟)
 * 2. 播控调度时间轴与主控台
 * 3. 全媒体素材库瀑布流与标准 6 大分类 (待机/视频/图片/文档/音乐/网页与流码)
 * 4. U 盘即插即用素材热更新状态与手动即时全量扫描
 * 5. 商业授权与在线续期 (机器码一键复制/激活码校验)
 * 6. 管理员登录与安全改密
 * 7. 系统运维中枢：CPU/内存/GPU 硬件态势四联仪表盘、VNC 远控服务启停与状态检测、底层主音量微调、开机自启、主机电源运维
 * 8. 展馆环境设备一键控制：TCP/UDP/WOL/SERIAL/HTTP 多协议支持，场景步骤编排与延时配置
 * 9. 大屏顶层跑马灯字幕 (上/中/下位置，背景全透明，自定义字号)
 * 10. 外部网页流码管理并在 media/网页_流码/ 生成同名 .txt 文件
 */

(function() {
  'use strict';

  // ===================== 0. 全局状态与引用 =====================
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let isPlatformAndroid = false;
  let isAuthenticated = false;
  let isLoopsStarted = false;
  let isSeeking = false;
  let isDraggingVolume = false;
  let currentDuration = 0;
  let currentPlayingFile = '';
  let lastPlayingFile = null;
  let currentPlayingType = 'video';
  let mediaFileList = [];
  let currentFilter = 'all';
  let currentFolderFilter = '待机';
  let foldersList = [];
  let devicesCache = [];
  let macrosCache = {};
  let lastHandledUsbTime = 0;
  let currentScaleMode = 'fill';
  let currentLoopMode = 'FOLDER_LOOP';
  let currentAdminOrientation = 'landscape';
  let currentEditingMacroKey = 'open_pavilion';
  let currentLicenseDetails = null;
  let videoThumbCache = {};

  // 循环播放模式配置 (默认循环，可选单个循环、播放一次)
  const LOOP_MODES_CONFIG = {
    'FOLDER_LOOP': { label: '🔁 全部循环', title: '当前：全部循环 (播完自动切下一项，末项切首项循环)' },
    'SINGLE_LOOP': { label: '🔂 单个循环', title: '当前：单个循环 (当前素材原地无缝循环重播)' },
    'PLAY_ONCE': { label: '➡️ 播放一次', title: '当前：播放一次即止 (播完停留在末帧静止，不自动循环)' }
  };
  const LOOP_MODES_ORDER = ['FOLDER_LOOP', 'SINGLE_LOOP', 'PLAY_ONCE'];

  // DOM 核心引用
  const echoImg = document.getElementById('echo-img');
  const echoStateTag = document.getElementById('echo-state-tag');
  const echoMediaTitle = document.getElementById('echo-media-title');
  const echoModeBadge = document.getElementById('echo-mode-badge');
  const echoMediaTypeBadge = document.getElementById('echo-media-type-badge');
  const echoWindowBadge = document.getElementById('echo-window-badge');
  const playerIndicator = document.getElementById('player-indicator');
  const playerStatusText = document.getElementById('player-status-text');

  const headerIpBadge = document.getElementById('header-ip-badge');
  const headerIp = document.getElementById('header-ip');
  const headerMiniHw = document.getElementById('header-mini-hw');
  const miniHwText = document.getElementById('mini-hw-text');
  const headerUsbBadge = document.getElementById('header-usb-badge');
  const headerUsbText = document.getElementById('header-usb-text');
  const headerLicenseBadge = document.getElementById('header-license-badge');
  const licenseStatusText = document.getElementById('license-status-text');
  const headerAuthBadge = document.getElementById('header-auth-badge');
  const authStatusText = document.getElementById('auth-status-text');

  // 控制台
  const timelineProgressRow = document.getElementById('timeline-progress-row');
  const timelineProgress = document.getElementById('timeline-progress');
  const timeDisplay = document.getElementById('time-display');

  const btnPlay = document.getElementById('btn-play');
  const btnStop = document.getElementById('btn-stop');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');
  const btnLoop = document.getElementById('btn-loop');
  const selectCyclePolicy = document.getElementById('select-cycle-policy');
  const cycleDurationWrap = document.getElementById('cycle-duration-wrap');
  const inputCycleDuration = document.getElementById('input-cycle-duration');
  const btnScaleMode = document.getElementById('btn-scale-mode');
  const btnAdminOrientation = document.getElementById('btn-admin-orientation');
  const btnBlackout = document.getElementById('btn-blackout');
  const btnFreeze = document.getElementById('btn-freeze');
  const volumeSlider = document.getElementById('volume-slider');
  const volumeValText = document.getElementById('volume-val-text');
  const btnMute = document.getElementById('btn-mute');

  // 文档按键
  const docCtrlGroup = document.getElementById('doc-ctrl-group');
  const btnDocPrev = document.getElementById('btn-doc-prev');
  const btnDocPause = document.getElementById('btn-doc-pause');
  const btnDocPlay = document.getElementById('btn-doc-play');
  const btnDocNext = document.getElementById('btn-doc-next');

  // 运维卡片内最小化大屏按键
  const btnScreenWindowMode = document.getElementById('btn-screen-window-mode');
  const screenModeIcon = document.getElementById('screen-mode-icon');
  const screenModeText = document.getElementById('screen-mode-text');

  // 素材库
  const mediaGrid = document.getElementById('media-grid');
  const mediaTotalCount = document.getElementById('media-total-count');
  const btnRefreshMediaLibrary = document.getElementById('btn-refresh-media-library');
  const fileUploader = document.getElementById('file-uploader');
  const dropZone = document.getElementById('drop-zone');
  const folderSelect = document.getElementById('folder-select');

  // IoT
  const macrosCardsContainer = document.getElementById('macros-cards-container');
  const macroProgressBox = document.getElementById('macro-progress-box');
  const macroStatusText = document.getElementById('macro-status-text');
  const macroStepCount = document.getElementById('macro-step-count');
  const macroProgressBar = document.getElementById('macro-progress-bar');
  const macroLogRecent = document.getElementById('macro-log-recent');
  const deviceCardsGrid = document.getElementById('device-cards-grid');

  // 第三方应用
  const extAppsContainer = document.getElementById('external-apps-container');

  // ===================== 辅助工具函数 =====================
  function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '00:00:00';
    const s = Math.floor(seconds);
    const hrs = Math.floor(s / 3600).toString().padStart(2, '0');
    const mins = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const secs = (s % 60).toString().padStart(2, '0');
    return `${hrs}:${mins}:${secs}`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // 统一 Toast 提示 (右上角轻量弹窗)
  let toastTimer = null;
  function showToast(msg, title = '系统提示') {
    let toast = document.getElementById('admin-global-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'admin-global-toast';
      toast.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;background:rgba(15,23,42,0.92);backdrop-filter:blur(12px);border:1px solid #38bdf8;border-radius:12px;padding:12px 20px;color:#fff;box-shadow:0 10px 30px rgba(0,0,0,0.5);display:flex;align-items:center;gap:12px;font-size:13px;transition:all 0.3s ease;';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span style="font-size:18px;">⚡</span><div><div style="font-weight:700;color:#38bdf8;font-size:12px;">${title}</div><div>${msg}</div></div>`;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-15px)';
    }, 3500);
  }

  // ===================== 全局 Fetch 鉴权拦截 =====================
  const rawFetch = window.fetch;
  window.fetch = async function(...args) {
    const token = localStorage.getItem('vc_token');
    if (token) {
      if (!args[1]) args[1] = {};
      if (!args[1].headers) args[1].headers = {};
      if (args[1].headers instanceof Headers) {
        if (!args[1].headers.has('Authorization')) {
          args[1].headers.set('Authorization', `Bearer ${token}`);
        }
      } else {
        if (!args[1].headers['Authorization']) {
          args[1].headers['Authorization'] = `Bearer ${token}`;
        }
      }
    }
    const resp = await rawFetch.apply(this, args);
    if (resp.status === 401) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
      if (!url.includes('/api/auth/login') && !url.includes('/api/auth/status')) {
        showLoginModal();
      }
    }
    return resp;
  };

  // ===================== 1. 大屏实时镜像回显与播控状态同步 =====================
  // 初始化纯正 HTTP 动图流长连接协议 (MJPEG Stream，支持自选 FPS 帧率)
  const selectEchoFps = document.getElementById('select-echo-fps');
  const echoExtraInfo = document.getElementById('echo-extra-info');
  let currentEchoFps = parseInt(localStorage.getItem('vc_echo_fps') || '12') || 12;

  function reloadEchoStream(fpsVal, isUserTrigger = false) {
    if (!echoImg) return;
    currentEchoFps = fpsVal || currentEchoFps || 12;
    localStorage.setItem('vc_echo_fps', currentEchoFps);
    if (selectEchoFps && selectEchoFps.value !== String(currentEchoFps)) {
      selectEchoFps.value = String(currentEchoFps);
    }
    if (echoExtraInfo) {
      echoExtraInfo.textContent = `HTTP动图流 · ${currentEchoFps} FPS`;
    }
    echoImg.src = `/api/stream/live.mjpeg?fps=${currentEchoFps}&t=${Date.now()}`;
    if (isUserTrigger) {
      showToast(`⚡ HTTP 动图流帧率已切换为 ${currentEchoFps} FPS`, '回显设定');
    }
  }

  if (selectEchoFps) {
    selectEchoFps.value = String(currentEchoFps);
    selectEchoFps.addEventListener('change', () => {
      const targetFps = parseInt(selectEchoFps.value) || 12;
      reloadEchoStream(targetFps, true);
    });
  }

  if (echoImg) {
    reloadEchoStream(currentEchoFps, false);
    echoImg.onerror = function() {
      // 动图流意外断开守护自愈，1.5 秒后携带当前 FPS 平滑重连
      setTimeout(() => {
        if (echoImg) echoImg.src = `/api/stream/live.mjpeg?fps=${currentEchoFps}&t=${Date.now()}`;
      }, 1500);
    };
  }

  // 绑定“返回大屏”按钮
  const btnReturnPlayer = document.getElementById('btn-return-player');
  if (btnReturnPlayer) {
    btnReturnPlayer.addEventListener('click', async () => {
      showToast('正在请求退出外部文档放映，恢复 VisualCast 播控...', '视窗调度');
      try {
        await fetch('/api/player/close_ppt', { method: 'POST' });
        showToast('已唤回 VisualCast 主视窗！', '操作成功');
      } catch (e) {
        showToast('请求下发失败: ' + e, '异常');
      }
    });
  }

  async function syncEchoLoop() {
    try {
      const isHidden = (document.visibilityState === 'hidden');

      // 1. 获取大屏当前播控状态 (状态拉取不破坏 HTTP 动图流持续传输)
      const statusRes = await fetch('/api/player/status');
      const statusData = await statusRes.json();
      if (statusData.status === 'ok' && statusData.player) {
        const p = statusData.player;
        currentDuration = p.duration || 0;
        currentPlayingFile = p.current_media || '';

        // 更新在线状态
        const isOnline = (Date.now() / 1000) - (p.last_heartbeat || 0) < 4.0;
        if (playerIndicator) playerIndicator.className = isOnline ? 'status-dot online' : 'status-dot offline';
        if (playerStatusText) playerStatusText.textContent = isOnline ? '大屏在线' : '大屏离线';

        // 更新回显标签与模式徽章
        if (echoStateTag) echoStateTag.textContent = p.state || 'STANDBY';
        if (echoMediaTitle) echoMediaTitle.textContent = p.current_media || 'VisualCast 就绪';
        if (echoModeBadge) {
          const isAttract = (p.mode === 'ATTRACT');
          echoModeBadge.textContent = isAttract ? '待机' : '现场点播';
          echoModeBadge.style.color = isAttract ? '#00f0ff' : '#fbbf24';
          echoModeBadge.style.borderColor = isAttract ? 'rgba(0,240,255,0.4)' : 'rgba(251,191,36,0.5)';
          echoModeBadge.style.background = isAttract ? 'rgba(0,240,255,0.15)' : 'rgba(245,158,11,0.15)';
        }

        // 更新窗口模式状态
        if (p.fullscreen !== undefined) {
          updateScreenWindowModeUI(p.fullscreen);
        }

        // 同步物理显示器下拉框选中态
        if (p.target_screen_index !== undefined && monitorSelectEl && document.activeElement !== monitorSelectEl) {
          monitorSelectEl.value = p.target_screen_index;
        }

        // 硬件负荷态势同步
        if (p.hardware) {
          renderHardwareData(p.hardware);
        }

        // 识别媒体类型以变换控制按键
        const ext = (p.current_media || '').split('.').pop().toLowerCase();
        let detectedType = 'video';
        if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].includes(ext)) detectedType = 'image';
        else if (['mp3', 'wav', 'aac', 'flac', 'ogg'].includes(ext)) detectedType = 'audio';
        else if (['pptx', 'ppt', 'pdf'].includes(ext)) detectedType = 'doc';
        else if (['html', 'htm', 'm3u8'].includes(ext)) detectedType = 'stream';

        currentPlayingType = detectedType;
        if (echoMediaTypeBadge) echoMediaTypeBadge.textContent = detectedType.toUpperCase();

        // 更新时间码与进度条
        if (timeDisplay) {
          timeDisplay.textContent = `${formatTime(p.current_time)} / ${formatTime(p.duration)}`;
        }
        if (!isSeeking && timelineProgress && currentDuration > 0) {
          const pct = ((p.current_time || 0) / currentDuration) * 100;
          timelineProgress.value = pct;
        }

        // 音量与静音状态同步
        if (!isDraggingVolume && p.volume !== undefined && volumeSlider) {
          volumeSlider.value = p.volume;
          if (volumeValText) volumeValText.textContent = `${p.volume}%`;
        }
        if (p.muted !== undefined && btnMute) {
          btnMute.textContent = p.muted ? '🔇' : '🔊';
        }

        if (btnPlay) btnPlay.textContent = p.state === 'PLAYING' ? '⏸' : '▶';
        if (btnBlackout) btnBlackout.classList.toggle('active', !!p.blackout);
        if (btnFreeze) btnFreeze.classList.toggle('active', !!p.freeze);

        // 待机与唤醒运维按钮状态联动
        const isOpsSleeping = !!p.is_sleeping || (!!p.blackout && p.state === 'STOPPED');
        const btnOpsWake = document.getElementById('btn-action-wakeup');
        const btnOpsSleep = document.getElementById('btn-action-sleep');
        if (btnOpsWake && btnOpsSleep) {
          if (isOpsSleeping) {
            btnOpsWake.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.6)';
            btnOpsWake.style.opacity = '1';
            btnOpsSleep.style.boxShadow = 'none';
            btnOpsSleep.style.opacity = '0.7';
          } else {
            btnOpsWake.style.boxShadow = 'none';
            btnOpsWake.style.opacity = '0.7';
            btnOpsSleep.style.boxShadow = '0 0 10px rgba(168, 85, 247, 0.4)';
            btnOpsSleep.style.opacity = '1';
          }
        }

        // 循环播放模式
        if (p.loop_mode) {
          updateLoopModeUI(p.loop_mode);
        } else if (p.loop !== undefined) {
          updateLoopModeUI(p.loop ? 'FOLDER_LOOP' : 'PLAY_ONCE');
        }

        // 循环时间切片策略同步 (播放完毕 vs 固定时长)
        if (p.switch_policy && selectCyclePolicy && document.activeElement !== selectCyclePolicy) {
          selectCyclePolicy.value = p.switch_policy;
          if (cycleDurationWrap) {
            cycleDurationWrap.style.display = (p.switch_policy === 'DURATION') ? 'inline-flex' : 'none';
          }
        }
        if (p.cycle_duration && inputCycleDuration && document.activeElement !== inputCycleDuration) {
          inputCycleDuration.value = p.cycle_duration;
        }

        // 方向
        if (p.orientation) {
          updateOrientationUI(p.orientation);
        }

        // 物理显示器选中项回显同步 (非获得焦点时平滑同步)
        const monitorSelectElPoll = document.getElementById('select-monitor');
        if (monitorSelectElPoll && document.activeElement !== monitorSelectElPoll && p.target_screen_index !== undefined) {
          if (monitorSelectElPoll.value !== String(p.target_screen_index)) {
            monitorSelectElPoll.value = p.target_screen_index;
          }
        }

        // 全屏拉伸/等比
        if (p.scale_mode) {
          currentScaleMode = p.scale_mode;
          updateScaleModeUI(p.scale_mode);
        }

        // 触摸交互模式同步 (按下启动大屏浮动交互栏，弹起关闭)
        if (p.touch_mode !== undefined) {
          updateTouchModeUI(p.touch_mode);
        }

        // 大屏菜单弹出/收起状态同步
        if (p.menu_open !== undefined) {
          updateScreenMenuUI(p.menu_open);
        }

        // 定时关机与节假日排程实时态势与倒计时预警横幅
        if (p.scheduled_shutdown) {
          updateScheduledShutdownIndicator(p.scheduled_shutdown);
        }

        // 素材管理库高亮当前播放项 (静默更新高亮，坚决不触发页面或列表滚动跳跃)
        const hasMediaChanged = (currentPlayingFile !== lastPlayingFile);
        if (hasMediaChanged) {
          lastPlayingFile = currentPlayingFile;
        }

        if (currentPlayingFile) {
          document.querySelectorAll('.media-item-row').forEach(row => {
            const fname = row.getAttribute('data-filename');
            row.classList.toggle('playing', fname === currentPlayingFile);
          });
        } else {
          document.querySelectorAll('.media-item-row.playing').forEach(r => r.classList.remove('playing'));
        }
      }
    } catch (e) {
    } finally {
      // 优化轮询频率：前台 1000ms，后台 3500ms，大幅降低 CPU 与带宽开销
      const delay = (document.visibilityState === 'hidden') ? 3500 : 1000;
      setTimeout(syncEchoLoop, delay);
    }
  }

  // ===================== 2. 播控指令极速下发通道 (无障碍直达传输) =====================
  async function sendPlayerCommand(cmd, params = {}) {
    try {
      const res = await fetch('/api/player/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, params: params })
      });
      // 指令下发后 100ms 立即执行一次状态同步，UI 毫秒级刷新
      setTimeout(syncEchoLoop, 100);
      return await res.json().catch(() => ({ status: 'ok' }));
    } catch (e) {
      console.warn('[VisualCast] 下发播控指令失败:', e);
    }
  }

  function updateLoopModeUI(mode) {
    if (!LOOP_MODES_CONFIG[mode]) mode = 'FOLDER_LOOP';
    currentLoopMode = mode;
    const cfg = LOOP_MODES_CONFIG[mode];
    if (btnLoop) {
      btnLoop.textContent = cfg.label;
      btnLoop.title = cfg.title;
      btnLoop.classList.toggle('active', mode !== 'PLAY_ONCE');
    }
    const btnCtrlLoopMode = document.getElementById('btn-ctrl-loop-mode');
    if (btnCtrlLoopMode) {
      btnCtrlLoopMode.textContent = cfg.label;
      btnCtrlLoopMode.title = cfg.title;
      btnCtrlLoopMode.classList.toggle('highlight', mode !== 'PLAY_ONCE');
    }
    const btnPlayCurFolder = document.getElementById('btn-play-current-folder');
    if (btnPlayCurFolder) {
      btnPlayCurFolder.textContent = cfg.label;
    }
  }

  function updateOrientationUI(ori) {
    if (!btnAdminOrientation) return;
    currentAdminOrientation = ori || 'landscape';
    const isPortrait = currentAdminOrientation.startsWith('portrait');
    btnAdminOrientation.textContent = isPortrait ? '📱 竖屏模式' : '🖥️ 横屏模式';
    btnAdminOrientation.style.color = isPortrait ? '#c084fc' : '#38bdf8';
    btnAdminOrientation.style.borderColor = isPortrait ? 'rgba(168, 85, 247, 0.5)' : 'rgba(56, 189, 248, 0.5)';
  }

  function updateScaleModeUI(mode) {
    if (!btnScaleMode) return;
    if (mode === 'contain') {
      btnScaleMode.textContent = '🖼️ 等比居中';
      btnScaleMode.title = '当前画面拉伸模式：等比居中 (保持原片宽高比，两侧或上下留黑边)。点击切换为全屏拉伸';
    } else {
      btnScaleMode.textContent = '⛶ 全屏拉伸';
      btnScaleMode.title = '当前画面拉伸模式：全屏拉伸 (强制铺满整个大屏幕，无黑边)。点击切换为等比居中';
    }
  }

  // 大屏运维模式与窗口切换
  function updateScreenWindowModeUI(isFs) {
    if (!btnScreenWindowMode) return;
    if (isFs) {
      if (screenModeIcon) screenModeIcon.textContent = '🗗';
      if (screenModeText) screenModeText.textContent = '最小化大屏';
      btnScreenWindowMode.style.background = 'rgba(245,158,11,0.15)';
      btnScreenWindowMode.style.borderColor = 'rgba(245,158,11,0.4)';
      btnScreenWindowMode.style.color = '#f59e0b';
      if (echoWindowBadge) {
        echoWindowBadge.textContent = '⛶ 全屏置顶';
        echoWindowBadge.style.color = '#c084fc';
      }
    } else {
      if (screenModeIcon) screenModeIcon.textContent = '⛶';
      if (screenModeText) screenModeText.textContent = '恢复全屏置顶';
      btnScreenWindowMode.style.background = 'rgba(239,68,68,0.2)';
      btnScreenWindowMode.style.borderColor = 'rgba(239,68,68,0.5)';
      btnScreenWindowMode.style.color = '#fca5a5';
      if (echoWindowBadge) {
        echoWindowBadge.textContent = '⛶ 点击置顶';
        echoWindowBadge.style.color = '#f59e0b';
      }
    }
  }

  // 监视窗头部一键窗口置顶按键
  if (echoWindowBadge) {
    echoWindowBadge.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/player/set_topmost', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'ok') {
          updateScreenWindowModeUI(true);
          showToast('大屏视窗已恢复硬件级全屏置顶 (HWND_TOPMOST)');
        }
      } catch (err) {
        showToast('置顶窗口失败: ' + err, '错误');
      }
    });
  }

  if (btnScreenWindowMode) {
    btnScreenWindowMode.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/player/toggle_fullscreen', { method: 'POST' });
        const data = await res.json();
        updateScreenWindowModeUI(data.fullscreen);
        showToast(data.fullscreen ? '已恢复全屏置顶' : '已最小化大屏');
      } catch (e) {
        showToast('切换大屏窗口模式失败: ' + e, '错误');
      }
    });
  }

  // 绑定播控按钮 (带乐观响应即时视觉反馈)
  if (btnPlay) {
    btnPlay.addEventListener('click', () => {
      const isPlaying = (btnPlay.textContent === '⏸');
      btnPlay.textContent = isPlaying ? '▶' : '⏸'; // 立即乐观变更为目标图标，绝不卡顿等待
      sendPlayerCommand(isPlaying ? 'PAUSE' : 'PLAY');
    });
  }

  if (btnStop) {
    btnStop.addEventListener('click', () => {
      if (btnPlay) btnPlay.textContent = '▶';
      if (timelineProgress) timelineProgress.value = 0;
      sendPlayerCommand('STOP');
    });
  }

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      btnPrev.style.transform = 'scale(0.88)';
      setTimeout(() => { if (btnPrev) btnPrev.style.transform = ''; }, 120);
      sendPlayerCommand('PREV');
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      btnNext.style.transform = 'scale(0.88)';
      setTimeout(() => { if (btnNext) btnNext.style.transform = ''; }, 120);
      sendPlayerCommand('NEXT');
    });
  }

  function updateFolderLoopButtonState() {
    const btnPlayCurFolder = document.getElementById('btn-play-current-folder');
    const cycleTimeBox = document.querySelector('.cycle-time-box');
    if (!btnPlayCurFolder) return;

    btnPlayCurFolder.style.opacity = '1';
    btnPlayCurFolder.style.pointerEvents = 'auto';
    btnPlayCurFolder.style.cursor = 'pointer';
    btnPlayCurFolder.classList.add('highlight');
    const cfg = LOOP_MODES_CONFIG[currentLoopMode] || LOOP_MODES_CONFIG['FOLDER_LOOP'];
    btnPlayCurFolder.textContent = cfg.label;
    btnPlayCurFolder.title = `播放策略：${cfg.label} (点击依次切换: 🔁 全部循环 / 🔂 单个循环 / ➡️ 播放一次)`;
    if (cycleTimeBox) cycleTimeBox.style.display = 'inline-flex';
  }

  function cycleLoopMode() {
    const idx = LOOP_MODES_ORDER.indexOf(currentLoopMode);
    const nextMode = LOOP_MODES_ORDER[(idx + 1) % LOOP_MODES_ORDER.length];
    const targetFolder = (currentFolderFilter === 'ALL') ? '待机' : currentFolderFilter;
    sendPlayerCommand('SET_LOOP_MODE', { loop_mode: nextMode, folder: targetFolder });
    updateLoopModeUI(nextMode);
    showToast(`播放模式已切换为: ${LOOP_MODES_CONFIG[nextMode].label}`);
  }

  if (btnLoop) {
    btnLoop.addEventListener('click', cycleLoopMode);
  }

  const btnCtrlLoopMode = document.getElementById('btn-ctrl-loop-mode');
  if (btnCtrlLoopMode) {
    btnCtrlLoopMode.addEventListener('click', cycleLoopMode);
  }

  const btnPlayCurrentFolder = document.getElementById('btn-play-current-folder');
  if (btnPlayCurrentFolder) {
    btnPlayCurrentFolder.addEventListener('click', cycleLoopMode);
  }

  // 循环切片策略切换 (播放完毕 vs 固定时长)
  if (selectCyclePolicy) {
    selectCyclePolicy.addEventListener('change', () => {
      const pol = selectCyclePolicy.value;
      if (cycleDurationWrap) {
        cycleDurationWrap.style.display = (pol === 'DURATION') ? 'inline-flex' : 'none';
      }
      const dur = parseInt(inputCycleDuration ? inputCycleDuration.value : 30) || 30;
      sendPlayerCommand('SET_CYCLE_POLICY', { switch_policy: pol, duration: dur });
      showToast(`已设置循环切片策略: ${pol === 'DURATION' ? `固定 ${dur} 秒切片` : '播放完毕切片'}`);
    });
  }

  if (inputCycleDuration) {
    inputCycleDuration.addEventListener('change', () => {
      const dur = Math.max(3, parseInt(inputCycleDuration.value) || 30);
      inputCycleDuration.value = dur;
      sendPlayerCommand('SET_CYCLE_POLICY', { switch_policy: selectCyclePolicy.value, duration: dur });
      showToast(`已设定每片播放时长: ${dur} 秒`);
    });
  }

  if (btnScaleMode) {
    btnScaleMode.addEventListener('click', () => {
      const nextMode = (currentScaleMode === 'fill') ? 'contain' : 'fill';
      currentScaleMode = nextMode;
      sendPlayerCommand('SET_SCALE_MODE', { scale_mode: nextMode });
      updateScaleModeUI(nextMode);
    });
  }

  if (btnAdminOrientation) {
    btnAdminOrientation.addEventListener('click', () => {
      const nextOri = (currentAdminOrientation === 'landscape') ? 'portrait' : 'landscape';
      currentAdminOrientation = nextOri;
      sendPlayerCommand('SET_ORIENTATION', { orientation: nextOri });
      updateOrientationUI(nextOri);
    });
  }

  if (btnBlackout) {
    btnBlackout.addEventListener('click', () => {
      const active = !btnBlackout.classList.contains('active');
      sendPlayerCommand('BLACKOUT', { blackout: active });
    });
  }

  if (btnFreeze) {
    btnFreeze.addEventListener('click', () => {
      const active = !btnFreeze.classList.contains('active');
      sendPlayerCommand('FREEZE', { freeze: active });
    });
  }

  // 进度拖动
  if (timelineProgress) {
    timelineProgress.addEventListener('mousedown', () => { isSeeking = true; });
    timelineProgress.addEventListener('touchstart', () => { isSeeking = true; }, { passive: true });
    timelineProgress.addEventListener('input', () => {
      isSeeking = true;
      if (currentDuration > 0 && timeDisplay) {
        const seekSec = (parseFloat(timelineProgress.value) / 100) * currentDuration;
        timeDisplay.textContent = `${formatTime(seekSec)} / ${formatTime(currentDuration)}`;
      }
    });
    timelineProgress.addEventListener('change', () => {
      isSeeking = false;
      if (currentDuration > 0) {
        const seekSec = (parseFloat(timelineProgress.value) / 100) * currentDuration;
        sendPlayerCommand('SEEK', { time: seekSec });
      }
    });
    timelineProgress.addEventListener('mouseup', () => { isSeeking = false; });
    timelineProgress.addEventListener('touchend', () => { isSeeking = false; });
  }

  // 播放器音量滑块与静音
  let volumeDebounceTimer = null;
  if (volumeSlider) {
    volumeSlider.addEventListener('mousedown', () => { isDraggingVolume = true; });
    volumeSlider.addEventListener('touchstart', () => { isDraggingVolume = true; }, { passive: true });
    volumeSlider.addEventListener('input', () => {
      isDraggingVolume = true;
      const val = volumeSlider.value;
      if (volumeValText) volumeValText.textContent = `${val}%`;
      clearTimeout(volumeDebounceTimer);
      volumeDebounceTimer = setTimeout(() => {
        sendPlayerCommand('VOLUME', { volume: parseInt(val) });
        if (parseInt(val) > 0 && btnMute) btnMute.textContent = '🔊';
      }, 60);
    });
    volumeSlider.addEventListener('change', () => {
      isDraggingVolume = false;
      const val = volumeSlider.value;
      clearTimeout(volumeDebounceTimer);
      sendPlayerCommand('VOLUME', { volume: parseInt(val) });
    });
    volumeSlider.addEventListener('mouseup', () => { isDraggingVolume = false; });
    volumeSlider.addEventListener('touchend', () => { isDraggingVolume = false; });
  }

  if (btnMute) {
    btnMute.addEventListener('click', () => {
      const isMuted = (btnMute.textContent === '🔇');
      btnMute.textContent = isMuted ? '🔊' : '🔇';
      sendPlayerCommand('MUTE', { muted: !isMuted });
    });
  }

  // 大屏深度休眠 / 唤醒模式 (带 2 秒拟真安卓系统开关机动效)
  const btnToggleSleep = document.getElementById('btn-toggle-sleep');
  let isDisplaySleeping = false;

  function updateSleepBtnUI(sleeping) {
    if (!btnToggleSleep) return;
    if (sleeping) {
      btnToggleSleep.innerHTML = '☀️ 唤醒大屏';
      btnToggleSleep.style.color = '#34d399';
      btnToggleSleep.style.borderColor = 'rgba(52, 211, 153, 0.6)';
      btnToggleSleep.style.background = 'rgba(52, 211, 153, 0.15)';
      btnToggleSleep.title = '大屏处于待机黑场态，点击解除黑场并自动恢复放映';
    } else {
      btnToggleSleep.innerHTML = '🌙 大屏待机';
      btnToggleSleep.style.color = '#38bdf8';
      btnToggleSleep.style.borderColor = 'rgba(56, 189, 248, 0.4)';
      btnToggleSleep.style.background = 'rgba(56, 189, 248, 0.08)';
      btnToggleSleep.title = '点击直接切入黑场停止放映，进入低功耗待机';
    }
  }

  if (btnToggleSleep) {
    btnToggleSleep.addEventListener('click', async () => {
      const targetSleep = !isDisplaySleeping;
      try {
        if (targetSleep) {
          await sendPlayerCommand('STOP');
          await sendPlayerCommand('BLACKOUT', { blackout: true });
          await fetch('/api/system/sleep', { method: 'POST' });
          isDisplaySleeping = true;
          updateSleepBtnUI(true);
          showToast('🌙 大屏已进入待机：停止放映并开启黑场', '大屏待机');
        } else {
          await sendPlayerCommand('BLACKOUT', { blackout: false });
          await sendPlayerCommand('RETURN_TO_STANDBY');
          await fetch('/api/system/wakeup', { method: 'POST' });
          isDisplaySleeping = false;
          updateSleepBtnUI(false);
          showToast('☀️ 大屏已唤醒：解除黑场并播放待机素材', '大屏唤醒');
        }
      } catch (e) {
        showToast('休眠/唤醒指令异常: ' + e, '系统提示');
      }
    });
  }

  // 文档 PPT 控制
  if (btnDocPrev) {
    btnDocPrev.addEventListener('click', () => {
      sendPlayerCommand('DOC_PREV');
      fetch('/api/player/send_key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'PGUP' }) }).catch(() => {});
    });
  }
  if (btnDocNext) {
    btnDocNext.addEventListener('click', () => {
      sendPlayerCommand('DOC_NEXT');
      fetch('/api/player/send_key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'PGDN' }) }).catch(() => {});
    });
  }
  if (btnDocPause) {
    btnDocPause.addEventListener('click', () => {
      fetch('/api/player/send_key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 's' }) }).catch(() => {});
    });
  }
  if (btnDocPlay) {
    btnDocPlay.addEventListener('click', () => {
      fetch('/api/player/send_key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'F5' }) }).catch(() => {});
    });
  }
  const btnDocExit = document.getElementById('btn-doc-exit');
  if (btnDocExit) {
    btnDocExit.addEventListener('click', () => {
      sendPlayerCommand('DOC_EXIT');
      sendPlayerCommand('RETURN_TO_STANDBY');
      fetch('/api/player/send_key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'ESCAPE' }) }).catch(() => {});
      fetch('/api/player/close_ppt', { method: 'POST' }).catch(() => {});
      showToast('已结束演示放映并恢复待机');
    });
  }

  // 页面与流媒体刷新重载 (点击后下发重载指令，并同步重新加载后台回显画面)
  const btnStreamRefresh = document.getElementById('btn-stream-refresh');
  if (btnStreamRefresh) {
    btnStreamRefresh.addEventListener('click', () => {
      sendPlayerCommand('REFRESH_STREAM');
      sendPlayerCommand('RELOAD_CURRENT');
      if (currentPlayingFile) {
        sendPlayerCommand('LOAD_AND_PLAY', { media: currentPlayingFile });
      }
      // 核心要求：点击后重新加载后台实时回显动图流
      if (typeof reloadEchoStream === 'function') {
        reloadEchoStream(currentEchoFps, false);
      }
      showToast('🔄 已下发流媒体与网页展项刷新指令，并重新加载回显画面', '视窗重载');
    });
  }

  // ===================== 3. 系统硬件态势与健康监控 =====================

  function renderHardwareData(hw) {
    if (!hw) return;

    // CPU
    const cpuPctEl = document.getElementById('hw-cpu-pct');
    const cpuBarEl = document.getElementById('hw-cpu-bar');
    const cpuCoresEl = document.getElementById('hw-cpu-cores');
    const cpuModelEl = document.getElementById('hw-cpu-model');
    const cpuPct = (hw.cpu && typeof hw.cpu.percent === 'number') ? hw.cpu.percent : 0;

    if (cpuPctEl) cpuPctEl.textContent = `${cpuPct.toFixed(1)}%`;
    if (cpuBarEl) {
      cpuBarEl.style.width = `${Math.min(100, Math.max(0, cpuPct))}%`;
      cpuBarEl.className = 'hw-bar-fill' + (cpuPct > 85 ? ' danger' : (cpuPct > 65 ? ' warning' : ''));
    }
    if (cpuCoresEl && hw.cpu) cpuCoresEl.textContent = `核心: ${hw.cpu.cores || 4} 逻辑处理器`;
    if (cpuModelEl && hw.cpu) cpuModelEl.textContent = hw.cpu.model || '高性能多核处理器';

    // 内存 RAM
    const memPctEl = document.getElementById('hw-mem-pct');
    const memBarEl = document.getElementById('hw-mem-bar');
    const memUsedEl = document.getElementById('hw-mem-used');
    const memAvailEl = document.getElementById('hw-mem-avail');
    const mem = hw.memory || {};
    const memPct = typeof mem.percent === 'number' ? mem.percent : 0;

    if (memPctEl) memPctEl.textContent = `${memPct}%`;
    if (memBarEl) {
      memBarEl.style.width = `${Math.min(100, Math.max(0, memPct))}%`;
      memBarEl.className = 'hw-bar-fill' + (memPct > 85 ? ' danger' : ' warning');
    }
    if (memUsedEl) memUsedEl.textContent = `已用: ${mem.used_gb || '--'} / ${mem.total_gb || '--'} GB`;
    if (memAvailEl) memAvailEl.textContent = `可用: ${mem.avail_gb || '--'} GB`;

    // GPU
    const gpuPctEl = document.getElementById('hw-gpu-pct');
    const gpuBarEl = document.getElementById('hw-gpu-bar');
    const gpuNameEl = document.getElementById('hw-gpu-name');
    const gpuStatusEl = document.getElementById('hw-gpu-status');
    const gpu = hw.gpu || {};
    const gpuPct = typeof gpu.percent === 'number' ? gpu.percent : 0;

    if (gpuPctEl) gpuPctEl.textContent = `${gpuPct.toFixed(1)}%`;
    if (gpuBarEl) {
      gpuBarEl.style.width = `${Math.min(100, Math.max(0, gpuPct))}%`;
      gpuBarEl.className = 'hw-bar-fill' + (gpuPct > 85 ? ' danger' : ' cyan');
    }
    if (gpuNameEl) gpuNameEl.textContent = gpu.name || 'DirectX 硬件加速渲染';
    if (gpuStatusEl) {
      const vramStr = gpu.memory_total_mb ? ` | 显存: ${gpu.memory_total_mb}MB` : '';
      gpuStatusEl.textContent = (gpu.status_text || '硬件加速就绪') + vramStr;
    }

    // 运行态势
    const runUptimeEl = document.getElementById('hw-run-uptime');
    const runPidEl = document.getElementById('hw-run-pid');
    const runBootEl = document.getElementById('hw-run-boot');
    if (hw.runtime) {
      if (runUptimeEl) runUptimeEl.textContent = hw.runtime.uptime || '00:00:00';
      if (runPidEl) runPidEl.textContent = `PID: ${hw.runtime.pid || '--'}`;
      if (runBootEl) runBootEl.textContent = `开机: ${hw.runtime.boot_time || '--'}`;
    }

    // 顶部小胶囊
    if (miniHwText) {
      miniHwText.textContent = `CPU: ${cpuPct.toFixed(0)}% | RAM: ${memPct}%`;
    }
  }

  async function pollHardwareStatus() {
    try {
      const res = await fetch('/api/system/hardware_status');
      const data = await res.json();
      if (data && data.status === 'ok') {
        renderHardwareData(data);
      }
    } catch (e) {}
  }
  setInterval(pollHardwareStatus, 6000);

  const btnRefreshHw = document.getElementById('btn-refresh-hardware');
  if (btnRefreshHw) {
    btnRefreshHw.addEventListener('click', async () => {
      btnRefreshHw.disabled = true;
      btnRefreshHw.textContent = '🔄 采样中...';
      await pollHardwareStatus();
      showToast('硬件与系统态势已刷新');
      setTimeout(() => {
        btnRefreshHw.disabled = false;
        btnRefreshHw.textContent = '🔄 刷新态势';
      }, 600);
    });
  }

  // ===================== 多机集群联播控制中枢 (Sync Hub) =====================
  const syncHubBox = document.getElementById('sync-hub-box');
  const syncHubHeaderTrigger = document.getElementById('sync-hub-header-trigger');
  const btnSyncToggle = document.getElementById('btn-sync-toggle');
  const syncToggleText = document.getElementById('sync-toggle-text');
  const syncSummarySlavesTag = document.getElementById('sync-summary-slaves-tag');
  const syncRoleBadge = document.getElementById('sync-role-badge');
  const syncTeleMode = document.getElementById('sync-tele-mode');
  const syncTeleSlavesCount = document.getElementById('sync-tele-slaves-count');
  const syncTeleOffset = document.getElementById('sync-tele-offset');
  const syncNodesContainer = document.getElementById('sync-nodes-container');
  const btnSyncCalibrate = document.getElementById('btn-sync-calibrate');
  const btnSyncRefresh = document.getElementById('btn-sync-refresh');
  const btnSyncAllConfig = document.getElementById('btn-sync-all-config');
  const portSync = document.getElementById('port-sync');
  const syncIpConfigRow = document.getElementById('sync-ip-config-row');
  const syncIpLabel = document.getElementById('sync-ip-label');
  const syncTargetIpInput = document.getElementById('sync-target-ip-input');
  const btnSaveSyncConfig = document.getElementById('btn-save-sync-config');
  const syncIpHint = document.getElementById('sync-ip-hint');

  let currentSyncRole = 'STANDALONE';
  let isEditingSyncIp = false;

  // 多机集群联播中枢折叠展开逻辑 (默认折叠收起)
  function setSyncHubCollapsed(collapsed) {
    if (!syncHubBox) return;
    if (collapsed) {
      syncHubBox.classList.add('collapsed');
      if (syncToggleText) syncToggleText.textContent = '展开面板';
      localStorage.setItem('sync_hub_collapsed', 'true');
    } else {
      syncHubBox.classList.remove('collapsed');
      if (syncToggleText) syncToggleText.textContent = '收起面板';
      localStorage.setItem('sync_hub_collapsed', 'false');
    }
  }

  // 读取本地折叠记忆，默认折叠收起保持清爽
  const savedCollapsed = localStorage.getItem('sync_hub_collapsed');
  setSyncHubCollapsed(savedCollapsed !== 'false');

  if (syncHubHeaderTrigger) {
    syncHubHeaderTrigger.addEventListener('click', (e) => {
      // 避免误触其他交互
      const isCurrentlyCollapsed = syncHubBox ? syncHubBox.classList.contains('collapsed') : true;
      setSyncHubCollapsed(!isCurrentlyCollapsed);
    });
  }

  async function fetchClusterSyncStatus() {
    try {
      const res = await fetch('/api/sync/status');
      if (!res.ok) return null;
      const text = await res.text();
      if (!text || !text.trim()) return null;
      const data = JSON.parse(text);
      if (data && data.status === 'ok') {
        renderClusterSyncUI(data);
      }
      return data;
    } catch (e) {
      // 容错吸收网络抖动
      return null;
    }
  }

  function renderClusterSyncUI(data) {
    currentSyncRole = data.role || 'STANDALONE';

    // 1. 角色按钮高亮与徽章
    document.querySelectorAll('.btn-role-tab').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-role') === currentSyncRole);
    });

    if (syncRoleBadge) {
      if (currentSyncRole === 'MASTER') {
        syncRoleBadge.textContent = '👑 播控主控机 (Master)';
        syncRoleBadge.style.color = '#00f0ff';
        syncRoleBadge.style.borderColor = 'rgba(0,240,255,0.5)';
      } else if (currentSyncRole === 'SLAVE') {
        syncRoleBadge.textContent = '🖥️ 同步从机 (Slave)';
        syncRoleBadge.style.color = '#34d399';
        syncRoleBadge.style.borderColor = 'rgba(16,185,129,0.5)';
      } else {
        syncRoleBadge.textContent = '⚪ 独立模式 (Standalone)';
        syncRoleBadge.style.color = '#94a3b8';
        syncRoleBadge.style.borderColor = 'rgba(255,255,255,0.2)';
      }
    }

    // 头部折叠状态摘要标签
    if (syncSummarySlavesTag) {
      if (currentSyncRole === 'MASTER') {
        const count = data.slaves_count || 0;
        syncSummarySlavesTag.textContent = `${count} 台从机就绪`;
        syncSummarySlavesTag.style.color = count > 0 ? '#34d399' : '#94a3b8';
      } else if (currentSyncRole === 'SLAVE') {
        syncSummarySlavesTag.textContent = data.master_alive ? '已跟随主控机' : '从机搜寻中';
        syncSummarySlavesTag.style.color = data.master_alive ? '#34d399' : '#fbbf24';
      } else {
        syncSummarySlavesTag.textContent = '独立单机';
        syncSummarySlavesTag.style.color = '#94a3b8';
      }
    }

    if (portSync) {
      portSync.textContent = data.is_running ? 'SYNC:8002 🟢' : 'SYNC:8002 ⚪';
    }

    // 固化 IP 输入框更新 (若用户当前没有在输入框聚焦输入)
    if (syncTargetIpInput && !isEditingSyncIp) {
      if (currentSyncRole === 'SLAVE') {
        syncTargetIpInput.value = data.master_ip || '';
        if (syncIpLabel) syncIpLabel.textContent = '👑 主控主机 IP:';
        if (syncIpHint) syncIpHint.textContent = '（从机直连该主机 IP 进行 UDP/HTTP 双通道毫秒对齐；留空则全网广播搜寻）';
        syncTargetIpInput.placeholder = '例如: 192.168.3.17';
        syncTargetIpInput.disabled = false;
      } else if (currentSyncRole === 'MASTER') {
        const sIps = data.slave_ips || [];
        syncTargetIpInput.value = Array.isArray(sIps) ? sIps.join(', ') : sIps;
        if (syncIpLabel) syncIpLabel.textContent = '🖥️ 目标从机 IP:';
        if (syncIpHint) syncIpHint.textContent = '（主控机将向该从机 IP 实施单播直连加速，多台用逗号隔开）';
        syncTargetIpInput.placeholder = '例如: 192.168.3.20';
        syncTargetIpInput.disabled = false;
      } else {
        syncTargetIpInput.value = '';
        if (syncIpLabel) syncIpLabel.textContent = '⚪ 模式提示:';
        if (syncIpHint) syncIpHint.textContent = '（当前为单机独立运行模式，不与其他设备同步）';
        syncTargetIpInput.placeholder = '无需配置 IP';
        syncTargetIpInput.disabled = true;
      }
    }

    if (btnSyncAllConfig) {
      if (currentSyncRole === 'MASTER') {
        btnSyncAllConfig.style.display = 'inline-block';
        btnSyncAllConfig.textContent = '⚡ 同步所有设置到从机';
        btnSyncAllConfig.title = '将当前主控机的画面比例、跑马灯字幕、音量、待机与轮播策略等所有设置一键广播并直推给所有从机';
      } else if (currentSyncRole === 'SLAVE') {
        btnSyncAllConfig.style.display = 'inline-block';
        btnSyncAllConfig.textContent = '📥 从主机拉取最新设置';
        btnSyncAllConfig.title = '向主控机拉取最新的画面比例、跑马灯字幕、音量、待机与轮播策略并应用到本机';
      } else {
        btnSyncAllConfig.style.display = 'none';
      }
    }

    // 2. 状态条目
    if (syncTeleMode) {
      if (currentSyncRole === 'MASTER') {
        syncTeleMode.textContent = 'MASTER (主控高精广播与单播就绪)';
        syncTeleMode.className = 'strip-val highlight';
      } else if (currentSyncRole === 'SLAVE') {
        const isAlive = data.master_alive;
        const mIp = (data.master_info && data.master_info.ip) || data.master_ip || '';
        if (isAlive) {
          syncTeleMode.textContent = `SLAVE (已锁定主控: ${mIp || '就绪'})`;
          syncTeleMode.className = 'strip-val';
          syncTeleMode.style.color = '#34d399';
        } else {
          syncTeleMode.textContent = mIp ? `SLAVE (正在连接主控 ${mIp}...)` : 'SLAVE (搜寻主控广播中...)';
          syncTeleMode.className = 'strip-val';
          syncTeleMode.style.color = '#fbbf24';
        }
      } else {
        syncTeleMode.textContent = 'STANDALONE (独立单机)';
        syncTeleMode.className = 'strip-val';
        syncTeleMode.style.color = '#94a3b8';
      }
    }

    if (syncTeleSlavesCount) {
      if (currentSyncRole === 'MASTER') {
        const count = data.slaves_count || 0;
        syncTeleSlavesCount.textContent = `${count} 台从机实时在线`;
      } else if (currentSyncRole === 'SLAVE') {
        const mInfo = data.master_info;
        syncTeleSlavesCount.textContent = mInfo ? `主控: ${mInfo.ip || mInfo.hostname}` : '等待主控广播';
      } else {
        syncTeleSlavesCount.textContent = '未加入集群';
      }
    }

    if (syncTeleOffset) {
      if (currentSyncRole === 'MASTER') {
        syncTeleOffset.textContent = '±0.0 ms (本端主钟源)';
      } else if (currentSyncRole === 'SLAVE') {
        const offset = data.clock_offset_ms || 0;
        syncTeleOffset.textContent = `${offset >= 0 ? '+' : ''}${offset.toFixed(1)} ms 时钟校准`;
      } else {
        syncTeleOffset.textContent = '--';
      }
    }

    // 3. 渲染在线从机节点网格卡片
    if (syncNodesContainer) {
      const slaves = data.slaves || [];
      if (currentSyncRole === 'MASTER') {
        if (slaves.length === 0) {
          syncNodesContainer.innerHTML = `
            <div class="sync-node-empty" id="sync-nodes-empty">
              <span class="empty-icon">🌐</span>
              <span>局域网暂无从机连接。在其他电脑后台将角色切换为【同步从机】后将在此自动列出。</span>
            </div>`;
        } else {
          syncNodesContainer.innerHTML = slaves.map(s => {
            const diff = s.diff_ms || 0;
            const isLock = !!s.is_locked;
            const diffLabel = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}ms`;
            return `
              <div class="sync-node-card">
                <div class="sync-node-header">
                  <span class="sync-node-name">🖥️ ${s.hostname || '从机节点'}</span>
                  <span class="sync-node-ip">${s.ip}</span>
                </div>
                <div class="sync-node-meta">
                  <span>当前播放: ${s.media ? (s.media.split('/').pop().slice(0, 16)) : '就绪'}</span>
                  <span class="sync-lock-tag ${isLock ? 'locked' : 'syncing'}">
                    ${isLock ? `🔒 ${diffLabel} (帧锁定)` : `⏳ ${diffLabel} (微调中)`}
                  </span>
                </div>
              </div>`;
          }).join('');
        }
      } else if (currentSyncRole === 'SLAVE') {
        const mInfo = data.master_info;
        if (mInfo && data.master_alive) {
          syncNodesContainer.innerHTML = `
            <div class="sync-node-card" style="grid-column: 1 / -1; border-color: rgba(16,185,129,0.4); background: rgba(16,185,129,0.06);">
              <div class="sync-node-header">
                <span class="sync-node-name" style="color:#34d399;">👑 主控主机已锁定: ${mInfo.hostname}</span>
                <span class="sync-node-ip">${mInfo.ip}</span>
              </div>
              <div class="sync-node-meta">
                <span>主控素材: <b>${mInfo.media || '待机'}</b> (${mInfo.state})</span>
                <span class="sync-lock-tag locked">🔒 高精度授时同步中</span>
              </div>
            </div>`;
        } else {
          syncNodesContainer.innerHTML = `
            <div class="sync-node-empty">
              <span class="empty-icon">📡</span>
              <span>正在监听局域网 Master 主控机的 UDP 8002 授时心跳...</span>
            </div>`;
        }
      } else {
        syncNodesContainer.innerHTML = `
          <div class="sync-node-empty">
            <span class="empty-icon">⚪</span>
            <span>当前为独立模式。如需与多台电脑同步播放，请在上方点击【👑 主控主机】或【🖥️ 同步从机】</span>
          </div>`;
      }
    }
  }

  // 跟踪目标 IP 输入框交互状态，避免定时刷新冲掉正在输入的内容
  if (syncTargetIpInput) {
    syncTargetIpInput.addEventListener('focus', () => { isEditingSyncIp = true; });
    syncTargetIpInput.addEventListener('blur', () => { isEditingSyncIp = false; });
  }

  // 保存并固化集群参数
  if (btnSaveSyncConfig) {
    btnSaveSyncConfig.addEventListener('click', async () => {
      const val = syncTargetIpInput ? syncTargetIpInput.value.trim() : '';
      const payload = { role: currentSyncRole };
      if (currentSyncRole === 'SLAVE') {
        payload.master_ip = val;
      } else if (currentSyncRole === 'MASTER') {
        payload.slave_ips = val;
      }
      try {
        const res = await fetch('/api/sync/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const text = await res.text();
        const ret = text ? JSON.parse(text) : null;
        if (ret && ret.status === 'ok') {
          showToast(`集群参数已永久固化！(角色: ${ret.role}, 目标IP: ${val || '自动'})`, '参数固化');
          fetchClusterSyncStatus();
        } else {
          showToast((ret && ret.message) || '固化配置保存失败', '提示');
        }
      } catch (e) {
        showToast('保存固化异常: ' + e, '错误');
      }
    });
  }

  // 绑定角色切换按键 (自动连同输入框参数一并固化)
  document.querySelectorAll('.btn-role-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetRole = btn.getAttribute('data-role');
      if (!targetRole) return;
      const targetIpVal = syncTargetIpInput ? syncTargetIpInput.value.trim() : '';
      const payload = { role: targetRole };
      if (targetRole === 'SLAVE') {
        payload.master_ip = targetIpVal;
      } else if (targetRole === 'MASTER') {
        payload.slave_ips = targetIpVal;
      }
      try {
        const res = await fetch('/api/sync/role', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const text = await res.text();
        let ret = null;
        try {
          ret = text ? JSON.parse(text) : null;
        } catch (pe) {
          console.warn('[Sync] 解析角色响应异常:', pe);
        }
        if (ret && ret.status === 'ok') {
          showToast(`已成功切换为【${ret.role}】模式并永久固化`, '集群联播');
          fetchClusterSyncStatus();
        } else {
          showToast((ret && ret.message) || '角色切换请求已提交', '集群联播');
          fetchClusterSyncStatus();
        }
      } catch (err) {
        showToast('请求异常: ' + err, '错误');
      }
    });
  });

  // 一键全量设置同步 (主机广播直推，从机向主机拉取)
  if (btnSyncAllConfig) {
    btnSyncAllConfig.addEventListener('click', async () => {
      if (currentSyncRole === 'MASTER') {
        const originalText = btnSyncAllConfig.textContent;
        btnSyncAllConfig.textContent = '⏳ 同步分发中...';
        btnSyncAllConfig.disabled = true;
        try {
          const res = await fetch('/api/sync/sync_all_to_slaves', { method: 'POST' });
          const ret = await res.json();
          if (ret && ret.status === 'ok') {
            showToast('已成功将主机所有设置（画面缩放/字幕/音量/待机等）同步给所有从机！', '全量同步');
          } else {
            showToast((ret && ret.message) || '设置同步请求已发送', '全量同步');
          }
        } catch (e) {
          showToast('同步设置异常: ' + e, '错误');
        } finally {
          btnSyncAllConfig.textContent = originalText;
          btnSyncAllConfig.disabled = false;
        }
      } else if (currentSyncRole === 'SLAVE') {
        const originalText = btnSyncAllConfig.textContent;
        btnSyncAllConfig.textContent = '⏳ 拉取中...';
        btnSyncAllConfig.disabled = true;
        try {
          const targetIp = (syncTargetIpInput && syncTargetIpInput.value.trim()) || '';
          let fetchUrl = '/api/sync/master_config';
          if (targetIp) {
            fetchUrl = `http://${targetIp}:8088/api/sync/master_config`;
          }
          const res = await fetch(fetchUrl);
          const cfg = await res.json();
          if (cfg && cfg.status === 'ok') {
            const applyRes = await fetch('/api/sync/apply_master_config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(cfg)
            });
            const applyRet = await applyRes.json();
            if (applyRet && applyRet.status === 'ok') {
              showToast('已成功从主机拉取并应用全部设置！', '设置同步');
            } else {
              showToast((applyRet && applyRet.message) || '设置已应用', '设置同步');
            }
          } else {
            showToast('未能获取到主机配置，请检查主机 IP 或网络连接', '同步失败');
          }
        } catch (e) {
          showToast('拉取主机配置异常: ' + e, '错误');
        } finally {
          btnSyncAllConfig.textContent = originalText;
          btnSyncAllConfig.disabled = false;
        }
      } else {
        alert('当前处于独立单机模式，请先切换为【主控主机】或【同步从机】');
      }
    });
  }

  // 全网校准
  if (btnSyncCalibrate) {
    btnSyncCalibrate.addEventListener('click', async () => {
      if (currentSyncRole !== 'MASTER') {
        alert('只有【👑 主控主机】可以发起全网校准。从机将自动跟随主机。');
        return;
      }
      try {
        const res = await fetch('/api/sync/calibrate', { method: 'POST' });
        const text = await res.text();
        let ret = null;
        try {
          ret = text ? JSON.parse(text) : null;
        } catch (pe) {
          console.warn('[Sync] 解析全网校准响应异常:', pe);
        }
        if (ret && ret.status === 'ok') {
          showToast('已向局域网广播精准对齐脉冲，所有从机无缝校准！', '全网校准');
        } else {
          showToast((ret && ret.message) || '全网校准脉冲已广播！', '全网校准');
        }
      } catch (e) {
        showToast('校准请求异常: ' + e, '错误');
      }
    });
  }

  // 从机检测 / 刷新节点
  if (btnSyncRefresh) {
    btnSyncRefresh.addEventListener('click', async () => {
      const originalText = btnSyncRefresh.textContent;
      btnSyncRefresh.textContent = '⏳ 检测中...';
      btnSyncRefresh.disabled = true;
      try {
        const res = await fetch('/api/sync/detect');
        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (pe) {
          console.warn('[Sync] 解析从机检测结果异常:', pe);
        }
        if (data && data.status === 'ok') {
          renderClusterSyncUI(data);
          const count = data.slaves_count || 0;
          if (data.role === 'MASTER') {
            showToast(`从机检测完成：当前在线 ${count} 台从机`, '从机检测');
          } else if (data.role === 'SLAVE') {
            showToast(data.master_alive ? '从机检测完成：已成功锁定主控主机' : '从机检测完成：正在搜寻主控广播', '从机检测');
          } else {
            showToast('当前处于独立单机模式，未加入集群', '提示');
          }
        } else {
          fetchClusterSyncStatus();
          showToast('从机检测脉冲已广播', '从机检测');
        }
      } catch (err) {
        console.warn('[Sync] 从机检测网络异常:', err);
        fetchClusterSyncStatus();
        showToast('从机检测已触发', '从机检测');
      } finally {
        btnSyncRefresh.textContent = originalText;
        btnSyncRefresh.disabled = false;
      }
    });
  }

  // 定时刷新集群状态 (温和错峰轮询，每 5 秒一次)
  setInterval(fetchClusterSyncStatus, 5000);


  // 系统主音量控制
  const btnSysVolUp = document.getElementById('btn-sys-vol-up');
  const btnSysVolDown = document.getElementById('btn-sys-vol-down');
  const btnSysVolMute = document.getElementById('btn-sys-vol-mute');

  if (btnSysVolUp) {
    btnSysVolUp.addEventListener('click', async () => {
      await fetch('/api/system/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'up' }) });
      showToast('系统物理音量 +4%');
    });
  }
  if (btnSysVolDown) {
    btnSysVolDown.addEventListener('click', async () => {
      await fetch('/api/system/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'down' }) });
      showToast('系统物理音量 -4%');
    });
  }
  if (btnSysVolMute) {
    btnSysVolMute.addEventListener('click', async () => {
      await fetch('/api/system/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'mute' }) });
      showToast('系统物理静音切换');
    });
  }
  // 视窗与显示控制区：大屏菜单弹出/关闭切换按钮
  const btnToggleScreenMenu = document.getElementById('btn-toggle-screen-menu');
  let isScreenMenuOpen = false;

  function updateScreenMenuUI(isOpen) {
    isScreenMenuOpen = !!isOpen;
    if (!btnToggleScreenMenu) return;
    if (isScreenMenuOpen) {
      btnToggleScreenMenu.classList.add('active');
      btnToggleScreenMenu.style.color = '#fff';
      btnToggleScreenMenu.style.borderColor = '#c084fc';
      btnToggleScreenMenu.style.background = 'linear-gradient(135deg, #a855f7, #9333ea)';
      btnToggleScreenMenu.style.boxShadow = '0 0 10px rgba(168, 85, 247, 0.4)';
      btnToggleScreenMenu.textContent = '📑 大屏菜单: 已弹出';
      btnToggleScreenMenu.title = '大屏端播放抽屉菜单当前已弹出，点击通知大屏关闭收起';
    } else {
      btnToggleScreenMenu.classList.remove('active');
      btnToggleScreenMenu.style.color = '#c084fc';
      btnToggleScreenMenu.style.borderColor = 'rgba(192,132,252,0.4)';
      btnToggleScreenMenu.style.background = 'rgba(192,132,252,0.12)';
      btnToggleScreenMenu.style.boxShadow = 'none';
      btnToggleScreenMenu.textContent = '📑 大屏菜单';
      btnToggleScreenMenu.title = '大屏端播放抽屉菜单当前已收起，点击通知大屏弹出菜单';
    }
  }

  if (btnToggleScreenMenu) {
    btnToggleScreenMenu.addEventListener('click', async () => {
      const targetState = !isScreenMenuOpen;
      updateScreenMenuUI(targetState);
      try {
        await sendPlayerCommand('TOGGLE_MENU', { open: targetState });
        showToast(targetState ? '已通知大屏弹出播放控制菜单' : '已通知大屏关闭播放控制菜单', '大屏菜单');
      } catch (err) {
        showToast('控制大屏菜单异常: ' + err, '错误');
      }
    });
  }

  // 系统主音量区：触摸交互模式切换 (开启/关闭大屏窗口左右选择按钮)
  const btnTouchModeToggle = document.getElementById('btn-touch-mode-toggle');
  let currentTouchMode = false;

  function updateTouchModeUI(enabled) {
    currentTouchMode = !!enabled;
    const btn = document.getElementById('btn-touch-mode-toggle');
    const txt = document.getElementById('touch-mode-text');
    if (!btn) return;
    if (currentTouchMode) {
      btn.classList.add('active');
      if (txt) txt.textContent = '👆 触摸交互: 已开启 (左右选片)';
      btn.title = '大屏窗口左右选择按钮已开启 (按下激活状态，观众可在大屏直接触摸左右切换)。点击弹起隐藏。';
    } else {
      btn.classList.remove('active');
      if (txt) txt.textContent = '👆 触摸交互: 已关闭';
      btn.title = '大屏窗口左右选择按钮已关闭 (弹起关闭状态，纯净展陈无按钮)。点击按下开启大屏左右选片按钮。';
    }
  }

  if (btnTouchModeToggle) {
    btnTouchModeToggle.addEventListener('click', async () => {
      const targetMode = !currentTouchMode;
      updateTouchModeUI(targetMode);
      try {
        const res = await fetch('/api/player/touch_mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: targetMode })
        });
        const data = await res.json();
        if (data.status === 'ok') {
          updateTouchModeUI(data.touch_mode);
          showToast(data.touch_mode ? '大屏端左右选片触控按钮已开启 (按下态)' : '大屏端左右选片触控按钮已隐藏 (弹起态)');
        }
      } catch (err) {
        showToast('切换触摸交互模式失败: ' + err, '错误');
        updateTouchModeUI(!targetMode);
      }
    });
  }

  // 主机电源与自启动
  const btnSysAutostart = document.getElementById('btn-sys-autostart-toggle');
  let currentAutostart = false;

  async function loadAdminAutostart() {
    if (!btnSysAutostart) return;
    try {
      const res = await fetch('/api/system/autostart');
      const data = await res.json();
      if (data.status === 'ok') {
        currentAutostart = !!data.enabled;
        const ind = document.getElementById('sys-autostart-indicator');
        const txt = document.getElementById('sys-autostart-text');
        if (ind) ind.className = 'status-dot ' + (currentAutostart ? 'online' : '');
        if (txt) txt.textContent = currentAutostart ? '开机自启: 已开启' : '开机自启: 已关闭';
        btnSysAutostart.style.color = currentAutostart ? '#34d399' : '#94a3b8';
      }
    } catch (e) {}
  }

  if (btnSysAutostart) {
    btnSysAutostart.addEventListener('click', async () => {
      try {
        const nextState = !currentAutostart;
        const res = await fetch('/api/system/autostart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enable: nextState })
        });
        const data = await res.json();
        if (data.status === 'ok') {
          currentAutostart = !!data.enabled;
          loadAdminAutostart();
          showToast(currentAutostart ? '✅ 软件开机自启动已成功开启并固化保存！下次开机自动拉起' : '软件开机自启动已成功关闭并生效', '自启设置');
        } else {
          showToast('自启动设置失败: ' + (data.message || '未知错误'), '错误');
        }
      } catch (e) {}
    });
  }

  // ===================== 通信网卡配置中枢 =====================
  const btnSysNetConfig = document.getElementById('btn-sys-network-config');
  const modalNetConfig = document.getElementById('modal-network-config');
  const btnCloseNetModal = document.getElementById('btn-close-net-modal');
  const btnCancelNetModal = document.getElementById('btn-cancel-net-modal');
  const selectAdminNetcard = document.getElementById('select-admin-netcard');
  const btnSaveNetConfig = document.getElementById('btn-save-net-config');
  const sysNetText = document.getElementById('sys-net-text');
  const sysNetIndicator = document.getElementById('sys-net-indicator');

  async function loadAdminNetworkInterfaces() {
    try {
      const res = await fetch('/api/system/network_interfaces');
      const data = await res.json();
      if (data.status === 'ok') {
        const list = data.network_interfaces || [];
        const currentIp = data.selected_ip || '';
        if (selectAdminNetcard) {
          selectAdminNetcard.innerHTML = '';
          list.forEach(net => {
            const opt = document.createElement('option');
            opt.value = net.ip;
            opt.textContent = net.display_name || `${net.name} (${net.ip})`;
            if (currentIp ? (net.ip === currentIp) : net.is_primary) {
              opt.selected = true;
            }
            selectAdminNetcard.appendChild(opt);
          });
        }
        if (sysNetText) {
          sysNetText.textContent = currentIp ? `网卡: ${currentIp}` : '🌐 通信网卡';
        }
        if (headerIp && currentIp) {
          headerIp.textContent = `${currentIp}:8088`;
        }
      }
    } catch (e) {
      console.warn('[Network] 获取网卡列表失败:', e);
    }
  }

  if (btnSysNetConfig) {
    btnSysNetConfig.addEventListener('click', () => {
      loadAdminNetworkInterfaces();
      if (modalNetConfig) modalNetConfig.classList.remove('hidden');
    });
  }

  function closeNetModal() {
    if (modalNetConfig) modalNetConfig.classList.add('hidden');
  }

  if (btnCloseNetModal) btnCloseNetModal.addEventListener('click', closeNetModal);
  if (btnCancelNetModal) btnCancelNetModal.addEventListener('click', closeNetModal);

  if (btnSaveNetConfig) {
    btnSaveNetConfig.addEventListener('click', async () => {
      const chosenIp = selectAdminNetcard ? selectAdminNetcard.value : '';
      if (!chosenIp) {
        showToast('请选择有效网卡 IP', '警告');
        return;
      }
      try {
        const res = await fetch('/api/system/select_network_interface', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ip: chosenIp })
        });
        const data = await res.json();
        if (data.status === 'ok') {
          showToast(`已成功设定受控端通信网卡为: ${chosenIp}`, '网卡设定');
          loadAdminNetworkInterfaces();
          closeNetModal();
        } else {
          showToast(data.message || '设定网卡失败', '错误');
        }
      } catch (err) {
        showToast('设定网卡网络异常: ' + err, '错误');
      }
    });
  }

  // 初始化拉取一次网卡状态
  setTimeout(loadAdminNetworkInterfaces, 1200);

  const btnSysReboot = document.getElementById('btn-sys-reboot');
  if (btnSysReboot) {
    btnSysReboot.addEventListener('click', () => {
      if (confirm('【远程重启确认】确定要重启大屏主机操作系统吗？')) {
        fetch('/api/system/restart', { method: 'POST' });
        showToast('正在向大屏主机下发重启指令...');
      }
    });
  }

  const btnSysShutdown = document.getElementById('btn-sys-shutdown');
  if (btnSysShutdown) {
    btnSysShutdown.addEventListener('click', () => {
      if (confirm('【远程关机确认】确定立即切断大屏主机电源关机吗？')) {
        fetch('/api/system/shutdown', { method: 'POST' });
        showToast('正在向大屏主机下发关机指令...');
      }
    });
  }

  // ===================== 定时关机与排程控制中枢 (支持折叠面板与模态弹窗双向同步) =====================
  const btnSysSchedShutdown = document.getElementById('btn-sys-scheduled-shutdown');
  const modalSchedShutdown = document.getElementById('modal-scheduled-shutdown');
  const btnCloseSchedModal = document.getElementById('btn-close-sched-modal');
  const btnCancelSchedModal = document.getElementById('btn-cancel-sched-modal');
  const chkSchedEnable = document.getElementById('chk-sched-enable');
  const chkSchedBootEnable = document.getElementById('chk-sched-boot-enable');
  const inputSchedTime = document.getElementById('input-sched-time');
  const btnSaveSchedConfig = document.getElementById('btn-save-sched-config');
  const sysSchedIndicator = document.getElementById('sys-sched-indicator');
  const sysSchedText = document.getElementById('sys-sched-text');

  // 折叠面板 DOM
  const schedHubBox = document.getElementById('sched-hub-box');
  const schedHubHeader = document.getElementById('sched-hub-header-trigger');
  const btnSchedToggle = document.getElementById('btn-sched-toggle');
  const schedToggleText = document.getElementById('sched-toggle-text');
  const schedHubBadge = document.getElementById('sched-hub-badge');
  const schedPanelStatusBanner = document.getElementById('sched-panel-status-banner');
  const schedPanelStatusDesc = document.getElementById('sched-panel-status-desc');
  const chkSchedPanelEnable = document.getElementById('chk-sched-panel-enable');
  const chkSchedPanelBootEnable = document.getElementById('chk-sched-panel-boot-enable');
  const inputSchedPanelBootTime = document.getElementById('input-sched-panel-boot-time');
  const inputSchedPanelTime = document.getElementById('input-sched-panel-time');
  const btnPanelSaveSched = document.getElementById('btn-panel-save-sched');
  const btnPanelCancelTodaySched = document.getElementById('btn-panel-cancel-today-sched');

  const btnQuickSelectAll = document.getElementById('btn-quick-select-all');
  const btnQuickSelectWorkdays = document.getElementById('btn-quick-select-workdays');
  const btnQuickSelectWeekends = document.getElementById('btn-quick-select-weekends');
  const btnQuickPanelAll = document.getElementById('btn-quick-panel-all');
  const btnQuickPanelWorkdays = document.getElementById('btn-quick-panel-workdays');
  const btnQuickPanelWeekends = document.getElementById('btn-quick-panel-weekends');

  // 定时面板折叠/展开逻辑 (持久化记忆到 localStorage)
  function updateSchedHubCollapseUI(isCollapsed) {
    if (!schedHubBox) return;
    if (isCollapsed) {
      schedHubBox.classList.add('collapsed');
      if (schedToggleText) schedToggleText.textContent = '展开面板';
    } else {
      schedHubBox.classList.remove('collapsed');
      if (schedToggleText) schedToggleText.textContent = '收起面板';
    }
    localStorage.setItem('vc_sched_collapsed', isCollapsed ? '1' : '0');
  }

  const savedSchedCollapsed = localStorage.getItem('vc_sched_collapsed') !== '0';
  updateSchedHubCollapseUI(savedSchedCollapsed);

  function toggleSchedHub() {
    if (!schedHubBox) return;
    const isCurrentlyCollapsed = schedHubBox.classList.contains('collapsed');
    updateSchedHubCollapseUI(!isCurrentlyCollapsed);
  }

  if (schedHubHeader) schedHubHeader.addEventListener('click', toggleSchedHub);
  if (btnSchedToggle) {
    btnSchedToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSchedHub();
    });
  }

  // 周一到周日药丸设置与状态读取 (弹窗与折叠面板保持严格一致)
  function setWeekdaysSelection(daysArray) {
    const list = Array.isArray(daysArray) ? daysArray.map(n => parseInt(n)) : [1, 2, 3, 4, 5, 6, 7];
    document.querySelectorAll('.weekday-chip').forEach(chip => {
      const day = parseInt(chip.getAttribute('data-day'));
      const chk = chip.querySelector('input[type="checkbox"]');
      const isSelected = list.includes(day);
      if (chk) chk.checked = isSelected;
      if (isSelected) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });
  }

  function getSelectedWeekdays() {
    const res = [];
    document.querySelectorAll('#sched-hub-content .weekday-chip, #modal-scheduled-shutdown .weekday-chip').forEach(chip => {
      const day = parseInt(chip.getAttribute('data-day'));
      const chk = chip.querySelector('input[type="checkbox"]');
      if ((chk && chk.checked) || chip.classList.contains('active')) {
        if (!res.includes(day)) res.push(day);
      }
    });
    return res.length > 0 ? res.sort() : [1, 2, 3, 4, 5, 6, 7];
  }

  // 绑定周一至周日药丸点击事件
  document.querySelectorAll('.weekday-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      const chk = chip.querySelector('input[type="checkbox"]');
      const day = chip.getAttribute('data-day');
      const willBeActive = !chip.classList.contains('active');
      
      // 同步所有匹配该星期的药丸 (弹窗与折叠面板双向同步)
      document.querySelectorAll(`.weekday-chip[data-day="${day}"]`).forEach(c => {
        const itemChk = c.querySelector('input[type="checkbox"]');
        if (willBeActive) {
          c.classList.add('active');
          if (itemChk) itemChk.checked = true;
        } else {
          c.classList.remove('active');
          if (itemChk) itemChk.checked = false;
        }
      });
    });
  });

  // 快捷点选周一至周日
  const bindQuickDays = (btn, days) => {
    if (btn) btn.addEventListener('click', () => setWeekdaysSelection(days));
  };
  bindQuickDays(btnQuickSelectAll, [1, 2, 3, 4, 5, 6, 7]);
  bindQuickDays(btnQuickSelectWorkdays, [1, 2, 3, 4, 5]);
  bindQuickDays(btnQuickSelectWeekends, [6, 7]);
  bindQuickDays(btnQuickPanelAll, [1, 2, 3, 4, 5, 6, 7]);
  bindQuickDays(btnQuickPanelWorkdays, [1, 2, 3, 4, 5]);
  bindQuickDays(btnQuickPanelWeekends, [6, 7]);

  // 双向同步开关与时间输入
  if (chkSchedEnable && chkSchedPanelEnable) {
    chkSchedEnable.addEventListener('change', () => { chkSchedPanelEnable.checked = chkSchedEnable.checked; });
    chkSchedPanelEnable.addEventListener('change', () => { chkSchedEnable.checked = chkSchedPanelEnable.checked; });
  }
  if (chkSchedBootEnable && chkSchedPanelBootEnable) {
    chkSchedBootEnable.addEventListener('change', () => { chkSchedPanelBootEnable.checked = chkSchedBootEnable.checked; });
    chkSchedPanelBootEnable.addEventListener('change', () => { chkSchedBootEnable.checked = chkSchedPanelBootEnable.checked; });
  }
  const inputSchedBootTime = document.getElementById('input-sched-boot-time');
  if (inputSchedBootTime && inputSchedPanelBootTime) {
    inputSchedBootTime.addEventListener('input', () => { inputSchedPanelBootTime.value = inputSchedBootTime.value; });
    inputSchedPanelBootTime.addEventListener('input', () => { inputSchedBootTime.value = inputSchedPanelBootTime.value; });
  }
  if (inputSchedTime && inputSchedPanelTime) {
    inputSchedTime.addEventListener('input', () => { inputSchedPanelTime.value = inputSchedTime.value; });
    inputSchedPanelTime.addEventListener('input', () => { inputSchedTime.value = inputSchedPanelTime.value; });
  }

  const schedStatusBanner = document.getElementById('sched-shutdown-status-banner');
  const schedStatusDesc = document.getElementById('sched-shutdown-status-desc');
  const btnToggleCancelTodaySched = document.getElementById('btn-toggle-cancel-today-sched');
  let currentTodayCancelled = false;

  // 状态指示器、徽章与标题文字同步及排程状态诊断
  function updateScheduledShutdownIndicator(statusData) {
    if (!statusData) return;
    const cfg = statusData.config || {};
    const isEnabled = !!cfg.enabled;
    currentTodayCancelled = !!statusData.today_cancelled;

    if (sysSchedIndicator) {
      sysSchedIndicator.className = 'status-dot ' + (isEnabled ? 'online' : '');
    }
    if (sysSchedText) {
      if (isEnabled) {
        if (currentTodayCancelled) {
          sysSchedText.textContent = `⏰ 定时: 今日已取消`;
          if (btnSysSchedShutdown) btnSysSchedShutdown.style.color = '#f87171';
        } else {
          sysSchedText.textContent = `⏰ 定时: ${cfg.time || '已启用'}`;
          if (btnSysSchedShutdown) btnSysSchedShutdown.style.color = '#34d399';
        }
      } else {
        sysSchedText.textContent = '⏰ 定时关机';
        if (btnSysSchedShutdown) btnSysSchedShutdown.style.color = '#f59e0b';
      }
    }

    // 更新折叠头部徽章
    if (schedHubBadge) {
      if (isEnabled) {
        if (currentTodayCancelled) {
          schedHubBadge.textContent = '⚠️ 今日关机已取消';
          schedHubBadge.className = 'collapsible-badge-tag danger';
        } else {
          schedHubBadge.textContent = `● 关机: ${cfg.shutdown_time || cfg.time || '21:30'}`;
          schedHubBadge.className = 'collapsible-badge-tag online';
        }
      } else {
        schedHubBadge.textContent = '○ 定时未开启';
        schedHubBadge.className = 'collapsible-badge-tag warning';
      }
    }

    // 更新紧急中止按钮文字与样式 (弹窗与面板两处同步)
    const updateCancelBtn = (btn) => {
      if (!btn) return;
      if (currentTodayCancelled) {
        btn.textContent = '🔄 恢复今日排程';
        btn.style.background = '#059669';
        btn.title = '重新激活今日的定时关机排程';
      } else {
        btn.textContent = '🚫 取消今日关机';
        btn.style.background = '#dc2626';
        btn.title = '立即中止任何关机操作并跳过今日关机';
      }
    };
    updateCancelBtn(btnToggleCancelTodaySched);
    updateCancelBtn(btnPanelCancelTodaySched);

    // 更新诊断横幅提示 (弹窗与折叠面板两处)
    let descHtml = '';
    let bannerBg = '', bannerBorder = '', bannerColor = '';

    if (!isEnabled) {
      bannerBg = 'rgba(148, 163, 184, 0.1)';
      bannerBorder = 'rgba(148, 163, 184, 0.25)';
      bannerColor = '#94a3b8';
      descHtml = '⚪ 定时未开启。开启开关并保存后，将按设定的时间与星期自动执行关机休眠。';
    } else if (statusData.today_cancelled) {
      bannerBg = 'rgba(239, 68, 68, 0.12)';
      bannerBorder = 'rgba(239, 68, 68, 0.3)';
      bannerColor = '#f87171';
      descHtml = '⚠️ <b>今日定时关机已成功取消</b>：主机将持续保持开机运行，绝不执行关机。';
    } else if (statusData.today_executed) {
      bannerBg = 'rgba(52, 211, 153, 0.12)';
      bannerBorder = 'rgba(52, 211, 153, 0.3)';
      bannerColor = '#34d399';
      descHtml = '✔️ 今日定时关机任务已成功执行完成。';
    } else if (statusData.target_time_str) {
      bannerBg = 'rgba(16, 185, 129, 0.12)';
      bannerBorder = 'rgba(16, 185, 129, 0.3)';
      bannerColor = '#34d399';
      descHtml = `✅ <b>今日排程正常生效</b>：将在今日 <b>${statusData.target_time_str}</b>（1分钟窗口内）执行安全关机休眠。`;
    } else {
      bannerBg = 'rgba(245, 158, 11, 0.12)';
      bannerBorder = 'rgba(245, 158, 11, 0.3)';
      bannerColor = '#fbbf24';
      descHtml = `⚠️ <b>今日跳过关机</b>：${statusData.schedule_desc || '今日未排程关机'}`;
    }

    [schedStatusBanner, schedPanelStatusBanner].forEach(b => {
      if (b) {
        b.style.background = bannerBg;
        b.style.borderColor = bannerBorder;
        b.style.color = bannerColor;
      }
    });
    if (schedStatusDesc) schedStatusDesc.innerHTML = descHtml;
    if (schedPanelStatusDesc) schedPanelStatusDesc.innerHTML = descHtml;
  }

  // 取消 / 恢复今日关机一键操作
  async function handleToggleTodaySched() {
    try {
      const url = currentTodayCancelled ? '/api/system/reset_shutdown' : '/api/system/cancel_shutdown';
      const res = await fetch(url, { method: 'POST' });
      const json = await res.json();
      if (json.status === 'ok') {
        showToast(json.message || '操作成功！');
        await loadScheduledShutdownModalData();
      } else {
        showToast('操作失败: ' + (json.message || '未知错误'), '错误');
      }
    } catch (err) {
      showToast('请求取消关机接口异常: ' + err, '错误');
    }
  }

  if (btnToggleCancelTodaySched) btnToggleCancelTodaySched.addEventListener('click', handleToggleTodaySched);
  if (btnPanelCancelTodaySched) btnPanelCancelTodaySched.addEventListener('click', handleToggleTodaySched);

  // 加载定时关机配置
  async function loadScheduledShutdownModalData() {
    try {
      const res = await fetch('/api/system/scheduled_shutdown');
      const json = await res.json();
      if (json.status === 'ok' && json.data) {
        const d = json.data;
        const cfg = d.config || {};
        const isEn = !!cfg.enabled;
        const isBootEn = cfg.boot_enabled !== false;
        const bootTime = cfg.boot_time || "08:30";
        const shutTime = cfg.shutdown_time || cfg.time || "21:30";

        if (chkSchedEnable) chkSchedEnable.checked = isEn;
        if (chkSchedPanelEnable) chkSchedPanelEnable.checked = isEn;

        if (chkSchedBootEnable) chkSchedBootEnable.checked = isBootEn;
        if (chkSchedPanelBootEnable) chkSchedPanelBootEnable.checked = isBootEn;

        if (inputSchedBootTime) inputSchedBootTime.value = bootTime;
        if (inputSchedPanelBootTime) inputSchedPanelBootTime.value = bootTime;

        if (inputSchedTime) inputSchedTime.value = shutTime;
        if (inputSchedPanelTime) inputSchedPanelTime.value = shutTime;

        setWeekdaysSelection(cfg.weekdays || [1, 2, 3, 4, 5, 6, 7]);
        updateScheduledShutdownIndicator(d);
      }
    } catch (e) {
      console.error('[ScheduledShutdown] 拉取配置失败:', e);
    }
  }

  // 点击运维中枢【⏰ 定时设置】按钮：直接调起定时排程设置模态窗口
  if (btnSysSchedShutdown) {
    btnSysSchedShutdown.addEventListener('click', (e) => {
      e.preventDefault();
      if (modalSchedShutdown) {
        modalSchedShutdown.classList.remove('hidden');
      }
      loadScheduledShutdownModalData();
    });
  }

  function closeSchedShutdownModal() {
    if (modalSchedShutdown) modalSchedShutdown.classList.add('hidden');
  }

  if (btnCloseSchedModal) btnCloseSchedModal.addEventListener('click', closeSchedShutdownModal);
  if (btnCancelSchedModal) btnCancelSchedModal.addEventListener('click', closeSchedShutdownModal);

  // 点击遮罩层空白处关闭弹窗
  if (modalSchedShutdown) {
    modalSchedShutdown.addEventListener('click', (e) => {
      if (e.target === modalSchedShutdown) {
        closeSchedShutdownModal();
      }
    });
  }

  // 保存定时关机配置实现
  async function executeSaveScheduledConfig() {
    try {
      const selectedWeekdays = getSelectedWeekdays();
      if (selectedWeekdays.length === 0) {
        showToast('请至少选择一天执行定时排程（如周一到周日）', '警告');
        return;
      }

      const isEn = !!(chkSchedPanelEnable ? chkSchedPanelEnable.checked : (chkSchedEnable && chkSchedEnable.checked));
      const bootTime = (inputSchedPanelBootTime && inputSchedPanelBootTime.value) || (inputSchedBootTime && inputSchedBootTime.value) || "08:30";
      const shutTime = (inputSchedPanelTime && inputSchedPanelTime.value) || (inputSchedTime && inputSchedTime.value) || "21:30";

      const payload = {
        enabled: isEn,
        boot_enabled: isPlatformAndroid ? isEn : false,
        boot_time: isPlatformAndroid ? bootTime : undefined,
        shutdown_time: shutTime,
        time: shutTime,
        weekdays: selectedWeekdays
      };

      const res = await fetch('/api/system/scheduled_shutdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.status === 'ok') {
        showToast('💾 定时排程配置已固化保存，下次开机自动按固化参数运行！');
        updateScheduledShutdownIndicator(data.data);
        closeSchedShutdownModal();
      } else {
        showToast('保存失败: ' + (data.message || '未知错误'), '错误');
      }
    } catch (err) {
      showToast('保存定时关机异常: ' + err, '错误');
    }
  }

  if (btnSaveSchedConfig) btnSaveSchedConfig.addEventListener('click', executeSaveScheduledConfig);
  if (btnPanelSaveSched) btnPanelSaveSched.addEventListener('click', executeSaveScheduledConfig);

  // 初始化拉取一次定时关机状态
  setTimeout(loadScheduledShutdownModalData, 1000);

  // 多屏切换 (物理显示器检测与无缝跨屏移动)
  async function loadMonitorsList() {
    const monitorSelect = document.getElementById('select-monitor');
    if (!monitorSelect) return;
    try {
      const res = await fetch('/api/system/monitors');
      const data = await res.json();
      if (data.status === 'ok' && data.monitors) {
        monitorSelect.innerHTML = '';
        data.monitors.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.index;
          opt.textContent = `${m.name || `屏幕 ${m.index + 1}`} (${m.width}x${m.height})`;
          if (m.is_primary) opt.textContent += ' [主屏]';
          monitorSelect.appendChild(opt);
        });
        const curIdx = (data.current_monitor_index !== undefined) ? data.current_monitor_index : (data.target_index !== undefined ? data.target_index : 0);
        monitorSelect.value = curIdx;
      }
    } catch (e) {}
  }

  const monitorSelectEl = document.getElementById('select-monitor');
  if (monitorSelectEl) {
    monitorSelectEl.addEventListener('change', async (e) => {
      const targetIdx = parseInt(e.target.value) || 0;
      try {
        const res = await fetch('/api/system/monitors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: targetIdx, monitor_index: targetIdx })
        });
        const data = await res.json();
        if (data.status === 'ok') {
          showToast(`大屏呈现窗口已成功切换并全屏投射至屏幕 #${targetIdx + 1}`);
        } else {
          showToast(data.message || '切换屏幕失败', '错误');
        }
      } catch (err) {
        showToast('切换屏幕网络异常: ' + err, '错误');
      }
    });
  }

  // 页面初始化时拉取物理显示器列表
  setTimeout(loadMonitorsList, 1200);

  // ===================== 4. 素材库管理与 6 大标准分类 =====================
  function extractVideoThumbnail(videoUrl, callback) {
    if (videoThumbCache[videoUrl]) {
      callback(videoThumbCache[videoUrl]);
      return;
    }
    const tempVideo = document.createElement('video');
    tempVideo.crossOrigin = 'anonymous';
    tempVideo.src = videoUrl;
    tempVideo.muted = true;
    tempVideo.preload = 'metadata';
    tempVideo.currentTime = 1.0;

    tempVideo.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 116;
        canvas.height = 80;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(tempVideo, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
        videoThumbCache[videoUrl] = dataUrl;
        callback(dataUrl);
      } catch (e) {}
    }, { once: true });

    tempVideo.addEventListener('error', () => {}, { once: true });
  }

  async function loadMediaLibrary() {
    try {
      const res = await fetch('/api/media?_t=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      if (data.status === 'ok') {
        mediaFileList = data.media || data.files || [];
        foldersList = data.folders || [];
        if (mediaTotalCount) mediaTotalCount.textContent = mediaFileList.length;
        renderFolderOptions();
        renderMediaRows();
        updateFolderLoopButtonState();
        if (typeof renderTlMediaGrid === 'function') {
          renderTlMediaGrid();
        }
      }
    } catch (e) {
      console.warn('读取素材库失败:', e);
    }
  }

  function renderFolderOptions() {
    const countMap = {};
    foldersList.forEach(f => { countMap[f.folder] = f.count; });
    document.querySelectorAll('.std-cat-btn').forEach(btn => {
      const f = btn.getAttribute('data-folder');
      const count = (f === 'ALL') ? mediaFileList.length : (countMap[f] || 0);
      let label = btn.getAttribute('data-origin-label');
      if (!label) {
        label = btn.textContent.replace(/\s*\(\d+\)$/, '');
        btn.setAttribute('data-origin-label', label);
      }
      btn.textContent = `${label} (${count})`;
      if (f === currentFolderFilter) {
        btn.classList.add('active');
        btn.style.background = (f === '待机') ? '#10b981' : '#00f0ff';
        btn.style.color = '#0f172a';
      } else {
        btn.classList.remove('active');
        btn.style.background = (f === '待机') ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.05)';
        btn.style.color = (f === '待机') ? '#10b981' : '#cbd5e1';
      }
    });
  }

  // 全局素材剪贴板状态 (支持跨文件夹复制/剪切/粘贴)
  let mediaClipboard = null; // { action: 'copy'|'move', name: string, filename: string, fromFolder: string }

  function setMediaClipboard(action, mediaItem) {
    mediaClipboard = {
      action: action,
      name: mediaItem.name,
      filename: mediaItem.filename || mediaItem.name,
      fromFolder: mediaItem.folder || '根目录'
    };
    updateMediaClipboardBar();
    renderMediaRows(true);
    const actText = (action === 'copy') ? '复制' : '剪切';
    showToast(`已${actText}素材 [${mediaClipboard.filename}]，请点击上方分类（如【待机】）后点击粘贴`);
  }

  function updateMediaClipboardBar() {
    const bar = document.getElementById('media-clipboard-bar');
    if (!bar) return;
    if (!mediaClipboard) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    const actTag = document.getElementById('clipboard-action-tag');
    const nameSpan = document.getElementById('clipboard-filename');
    const fromFolder = document.getElementById('clipboard-from-folder');
    const targetFolder = document.getElementById('clipboard-target-folder');
    if (actTag) {
      actTag.className = 'clipboard-tag ' + (mediaClipboard.action === 'copy' ? 'copy' : 'cut');
      actTag.textContent = (mediaClipboard.action === 'copy') ? '📋 复制中' : '✂️ 剪切中';
    }
    if (nameSpan) nameSpan.textContent = mediaClipboard.filename;
    if (fromFolder) fromFolder.textContent = mediaClipboard.fromFolder;
    if (targetFolder) {
      targetFolder.textContent = (currentFolderFilter === 'ALL' || !currentFolderFilter) ? '未选定(请点击上方分类)' : currentFolderFilter;
    }
  }

  function initMediaClipboardActions() {
    const btnPaste = document.getElementById('btn-paste-media');
    const btnCancelClip = document.getElementById('btn-cancel-clipboard');
    if (btnPaste) {
      btnPaste.addEventListener('click', async () => {
        if (!mediaClipboard) return;
        const target = (currentFolderFilter === 'ALL') ? '' : currentFolderFilter;
        if (currentFolderFilter === 'ALL') {
          showToast('请先点击上方分类胶囊（如【待机】、【视频】等）选择目标文件夹再粘贴！', '警告');
          return;
        }
        if (mediaClipboard.action === 'move' && (mediaClipboard.fromFolder === target || (!mediaClipboard.fromFolder && !target))) {
          showToast('来源文件夹与目标文件夹相同，无需剪切移动', '提示');
          return;
        }
        btnPaste.disabled = true;
        btnPaste.textContent = '正在粘贴...';
        try {
          const res = await fetch('/api/media/transfer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: mediaClipboard.action,
              sources: [mediaClipboard.name],
              target_folder: target
            })
          });
          const data = await res.json();
          if (data.status === 'ok') {
            showToast(data.message || '粘贴成功！');
            if (mediaClipboard.action === 'move') {
              mediaClipboard = null;
            }
            updateMediaClipboardBar();
            await loadMediaLibrary();
          } else {
            showToast('粘贴失败: ' + (data.message || '未知错误'), '错误');
          }
        } catch (err) {
          showToast('粘贴异常: ' + err, '错误');
        } finally {
          btnPaste.disabled = false;
          btnPaste.textContent = '📋 粘贴至当前分类';
        }
      });
    }
    if (btnCancelClip) {
      btnCancelClip.addEventListener('click', () => {
        mediaClipboard = null;
        updateMediaClipboardBar();
        renderMediaRows(true);
        showToast('已取消并清空剪贴板');
      });
    }

    // 全局点击空白自动收起展开的素材操作组
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.media-more-actions-wrap')) {
        document.querySelectorAll('.media-more-inline:not(.hidden)').forEach(el => {
          el.classList.add('hidden');
          const wrap = el.closest('.media-more-actions-wrap');
          if (wrap) {
            const btn = wrap.querySelector('.btn-item-more');
            if (btn) btn.classList.remove('hidden');
          }
        });
      }
    });
  }

  function renderMediaRows(preserveScroll = true) {
    if (!mediaGrid) return;
    const prevScrollTop = preserveScroll ? mediaGrid.scrollTop : 0;
    mediaGrid.innerHTML = '';

    let filtered = mediaFileList;
    if (currentFolderFilter !== 'ALL') {
      filtered = filtered.filter(m => (m.folder || '') === currentFolderFilter);
    }
    if (currentFilter !== 'all') {
      filtered = filtered.filter(m => m.type === currentFilter);
    }

    if (filtered.length === 0) {
      mediaGrid.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b;font-size:12px;">该分类下暂无素材，支持上传或插入 U 盘自动拷入</div>';
      return;
    }

    filtered.forEach(m => {
      const row = document.createElement('div');
      row.className = 'media-item-row';
      row.setAttribute('data-filename', m.name);
      if (m.name === currentPlayingFile) row.classList.add('playing');
      if (mediaClipboard && mediaClipboard.name === m.name) {
        row.classList.add(mediaClipboard.action === 'copy' ? 'copy-active' : 'cut-active');
      }

      const formatExt = (m.ext || '').toUpperCase().replace('.', '');
      let thumbContent = '';

      if (m.type === 'image') {
        thumbContent = `<img class="media-thumb-img" src="${m.url}" loading="lazy" alt="img" /><span class="media-type-tag">IMG</span>`;
      } else if (m.type === 'video') {
        const cached = videoThumbCache[m.url];
        const initialThumb = cached ? `<img class="media-thumb-img" src="${cached}" alt="video" />` : `<span class="thumb-emoji">🎬</span>`;
        const safeDomId = 'thumb-' + m.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        thumbContent = `<div id="${safeDomId}" class="video-thumb-container">${initialThumb}</div><span class="media-type-tag">VID</span>`;
        if (!cached) {
          extractVideoThumbnail(m.url, (dataUrl) => {
            const container = document.getElementById(safeDomId);
            if (container) container.innerHTML = `<img class="media-thumb-img" src="${dataUrl}" alt="video" />`;
          });
        }
      } else if (m.type === 'doc') {
        const isPdf = m.name.toLowerCase().endsWith('.pdf');
        thumbContent = `<span class="thumb-emoji">${isPdf ? '📄' : '📊'}</span><span class="media-type-tag">${formatExt}</span>`;
      } else if (m.type === 'audio') {
        thumbContent = `<span class="thumb-emoji">🎵</span><span class="media-type-tag">AUD</span>`;
      } else if (m.type === 'web' || m.type === 'stream') {
        thumbContent = `<span class="thumb-emoji">${m.type === 'web' ? '🌐' : '📡'}</span><span class="media-type-tag">${m.type.toUpperCase()}</span>`;
      } else {
        thumbContent = `<span class="thumb-emoji">📁</span><span class="media-type-tag">${formatExt}</span>`;
      }

      const isStandbyFolder = (m.folder === '待机' || m.folder === 'standby' || m.is_standby);
      row.innerHTML = `
        <div class="media-item-thumb-box">${thumbContent}</div>
        <div class="media-item-info">
          <div class="media-name-line" title="${m.name}">
            <span class="folder-pill ${isStandbyFolder ? 'standby' : ''}">${m.folder || '根目录'}</span>
            <span class="file-basename">${m.filename || m.name}</span>
          </div>
          <div class="media-meta-line">
            <span>${formatBytes(m.size)}</span>
            <span>•</span>
            <span>${new Date((m.mtime || 0) * 1000).toLocaleTimeString()}</span>
            ${m.url && (m.type === 'web' || m.type === 'stream') ? `<span class="media-link-hint" title="${m.url}">${m.url}</span>` : ''}
          </div>
        </div>
        <div class="media-item-actions">
          <button class="btn-play-trigger" title="立即大屏播放此素材">▶ 播</button>
          <div class="media-more-actions-wrap">
            <button class="btn-item-more" title="展开更多操作 (复制/剪切/改名)">⋯</button>
            <div class="media-more-inline hidden">
              <button class="btn-item-copy" title="复制此素材 (可切换至待机或其它分类后粘贴)">📋 复制</button>
              <button class="btn-item-cut" title="剪切此素材 (可移动至待机或其它分类后粘贴)">✂️ 剪切</button>
              <button class="btn-item-rename" title="重命名此素材">✏️ 改名</button>
              <button class="btn-item-collapse" title="收起">✕</button>
            </div>
          </div>
          <button class="btn-item-del" title="删除此素材">🗑</button>
        </div>
      `;

      // 播放点击 (沿用当前设定的循环播放策略，带即时乐观高亮与视窗标题响应)
      const playAction = () => {
        document.querySelectorAll('.media-item-row.playing').forEach(r => r.classList.remove('playing'));
        row.classList.add('playing');
        if (echoMediaTitle) echoMediaTitle.textContent = m.filename || m.name;
        if (btnPlay) btnPlay.textContent = '⏸';
        const targetLoop = currentLoopMode;
        sendPlayerCommand('LOAD_AND_PLAY', { media: m.name, media_item: m, folder: m.folder, loop_mode: targetLoop });
      };

      row.querySelector('.btn-play-trigger').addEventListener('click', (e) => {
        e.stopPropagation();
        playAction();
      });

      // 更多操作 (行内展开与收起，完全处于行内流中，绝不跨行，100% 杜绝遮挡)
      const moreBtn = row.querySelector('.btn-item-more');
      const moreInline = row.querySelector('.media-more-inline');
      const collapseBtn = row.querySelector('.btn-item-collapse');

      const openMore = () => {
        document.querySelectorAll('.media-more-inline:not(.hidden)').forEach(el => {
          el.classList.add('hidden');
          const wrap = el.closest('.media-more-actions-wrap');
          if (wrap) {
            const btn = wrap.querySelector('.btn-item-more');
            if (btn) btn.classList.remove('hidden');
          }
        });
        if (moreBtn) moreBtn.classList.add('hidden');
        if (moreInline) moreInline.classList.remove('hidden');
      };

      const closeMore = () => {
        if (moreInline) moreInline.classList.add('hidden');
        if (moreBtn) moreBtn.classList.remove('hidden');
      };

      if (moreBtn && moreInline) {
        moreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openMore();
        });
      }

      if (collapseBtn) {
        collapseBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeMore();
        });
      }

      // 复制点击
      row.querySelector('.btn-item-copy').addEventListener('click', (e) => {
        e.stopPropagation();
        closeMore();
        setMediaClipboard('copy', m);
      });

      // 剪切点击
      row.querySelector('.btn-item-cut').addEventListener('click', (e) => {
        e.stopPropagation();
        closeMore();
        setMediaClipboard('move', m);
      });

      // 重命名点击
      const renameBtn = row.querySelector('.btn-item-rename');
      if (renameBtn) {
        renameBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          closeMore();
          const currentBase = m.filename || (m.name.includes('/') ? m.name.split('/').pop() : m.name);
          const dotIdx = currentBase.lastIndexOf('.');
          const stem = dotIdx !== -1 ? currentBase.substring(0, dotIdx) : currentBase;
          const ext = dotIdx !== -1 ? currentBase.substring(dotIdx) : '';

          const inputName = prompt(`请输入新的素材名称 (原扩展名 ${ext} 将自动保留)：`, stem);
          if (!inputName || !inputName.trim() || inputName.trim() === stem) {
            return;
          }
          const cleanName = inputName.trim();
          try {
            const res = await fetch('/api/media/rename', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                old_name: m.name,
                new_name: cleanName
              })
            });
            const resJson = await res.json();
            if (resJson.status === 'ok') {
              showToast(`素材已成功重命名为 [${resJson.filename || cleanName}]`, '操作成功');
              fetchMediaLibrary(true);
            } else {
              alert(resJson.message || '重命名失败');
            }
          } catch (err) {
            alert('重命名请求异常: ' + err.message);
          }
        });
      }

      // 删除点击
      row.querySelector('.btn-item-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`确定要从素材库彻底删除 [${m.filename || m.name}] 吗？`)) {
          if (m.is_custom) {
            await fetch('/api/media/custom/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: m.id, name: m.name }) });
          } else {
            await fetch('/api/media/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: m.name }) });
          }
          showToast(`已删除素材: ${m.filename || m.name}`);
          if (mediaClipboard && mediaClipboard.name === m.name) {
            mediaClipboard = null;
            updateMediaClipboardBar();
          }
          loadMediaLibrary();
        }
      });

      // 整行点击直接播放
      row.addEventListener('click', playAction);

      mediaGrid.appendChild(row);
    });

    if (preserveScroll && prevScrollTop > 0) {
      mediaGrid.scrollTop = prevScrollTop;
    }
  }

  // 6 大标准分类导航胶囊切换
  document.querySelectorAll('.std-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentFolderFilter = btn.getAttribute('data-folder');
      renderFolderOptions();
      renderMediaRows();
      updateMediaClipboardBar();
      updateFolderLoopButtonState();
    });
  });

  initMediaClipboardActions();

  const btnQuickStandby = document.getElementById('btn-quick-standby');
  if (btnQuickStandby) {
    btnQuickStandby.addEventListener('click', async () => {
      await fetch('/api/player/return_to_standby', { method: 'POST' }).catch(() => {});
      showToast('已切回待机文件夹循环播放');
    });
  }

  // 素材栏【🔄 更新】按键：即时触发全量扫描与U盘同步
  if (btnRefreshMediaLibrary) {
    btnRefreshMediaLibrary.addEventListener('click', async () => {
      const origHtml = btnRefreshMediaLibrary.innerHTML;
      btnRefreshMediaLibrary.innerHTML = '⏳ 正在更新...';
      btnRefreshMediaLibrary.disabled = true;
      try {
        // 主动触发 U 盘全量探测与同步
        await fetch('/api/system/usb_sync', { method: 'POST', cache: 'no-store' }).catch(() => {});
        // 重新拉取素材列表与分类计数
        await loadMediaLibrary();
        showToast('素材库已完成全量更新扫描');
      } catch (err) {
        showToast('素材库更新完成');
      } finally {
        btnRefreshMediaLibrary.innerHTML = origHtml;
        btnRefreshMediaLibrary.disabled = false;
      }
    });
  }

  // 文件上传
  if (fileUploader) {
    fileUploader.addEventListener('change', async (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      await uploadFiles(files);
      fileUploader.value = '';
    });
  }

  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-active'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-active'));
    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-active');
      if (e.dataTransfer && e.dataTransfer.files) {
        await uploadFiles(e.dataTransfer.files);
      }
    });
  }

  async function uploadFiles(files) {
    if (!files || files.length === 0) return;
    const total = files.length;
    let successCount = 0;
    showToast(`开始上传 ${total} 个素材至分类 [${currentFolderFilter}]...`, '素材上传');
    
    let lastTargetFolder = currentFolderFilter;
    const uploadedNames = [];

    for (let i = 0; i < total; i++) {
      const f = files[i];
      const ext = f.name.toLowerCase().substring(f.name.lastIndexOf('.'));
      let targetFolder = currentFolderFilter;
      if (!targetFolder || targetFolder === 'ALL') {
        if (['.ppt', '.pptx', '.pps', '.ppsx', '.pdf', '.doc', '.docx', '.wps', '.dps', '.et', '.xls', '.xlsx'].includes(ext)) targetFolder = '文档';
        else if (['.mp4', '.mov', '.mkv', '.webm', '.avi', '.flv', '.ts'].includes(ext)) targetFolder = '视频';
        else if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'].includes(ext)) targetFolder = '图片';
        else if (['.mp3', '.wav', '.aac', '.flac', '.ogg', '.wma', '.m4a'].includes(ext)) targetFolder = '音乐';
        else if (['.html', '.htm', '.m3u8', '.txt', '.url'].includes(ext)) targetFolder = '网页_流码';
        else targetFolder = '待机';
      }
      lastTargetFolder = targetFolder;

      // 优先采用工业级纯二进制流直传 (零 Boundary 解析，零 OOM，100% 成功)
      let lastErrMsg = '';
      let successThis = false;
      try {
        const res = await fetch('/api/media/upload_raw', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Filename': encodeURIComponent(f.name),
            'X-Folder': encodeURIComponent(targetFolder)
          },
          body: f
        });
        const text = await res.text();
        let ret = null;
        try { ret = JSON.parse(text); } catch (e) {}
        if (res.ok && ret && (ret.status === 'ok' || ret.savedFilename || ret.filename)) {
          successCount++;
          successThis = true;
          uploadedNames.push(f.name);
        } else {
          lastErrMsg = ret ? (ret.message || ret.error || '保存失败') : `HTTP ${res.status}`;
        }
      } catch (err) {
        lastErrMsg = '直传网络异常: ' + (err.message || err);
      }

      // 若直传接口异常或未响应，自动无缝降级走传统表单上传
      if (!successThis) {
        try {
          const formData = new FormData();
          formData.append('folder', targetFolder);
          formData.append('original_filename', f.name);
          formData.append('file', f, f.name);
          const res2 = await fetch('/api/media/upload', { method: 'POST', body: formData });
          const text2 = await res2.text();
          let ret2 = null;
          try { ret2 = JSON.parse(text2); } catch (e) {}
          if (res2.ok && ret2 && (ret2.status === 'ok' || ret2.savedFilename || ret2.filename)) {
            successCount++;
            successThis = true;
            uploadedNames.push(f.name);
          } else {
            lastErrMsg = ret2 ? (ret2.message || ret2.error || '保存失败') : (lastErrMsg || `HTTP ${res2.status}`);
            showToast(`文件 ${f.name} 保存失败: ${lastErrMsg}`, '上传警告');
          }
        } catch (err2) {
          showToast(`文件 ${f.name} 上传异常: ${lastErrMsg || err2}`, '上传错误');
        }
      }
    }

    if (successCount === total) {
      showToast(`✅ 全部素材上传成功！成功保存 ${successCount}/${total} 个素材至【${lastTargetFolder}】`, '上传完成');
    } else if (successCount > 0) {
      showToast(`⚠️ 部分素材保存成功：${successCount}/${total} 个，已归纳至【${lastTargetFolder}】`, '上传警告');
    } else {
      showToast(`❌ 素材保存失败 (0/${total})：${lastErrMsg || '请检查文件名或磁盘存储空间'}`, '上传失败');
    }

    // 体验跃升：自动切换分类并刷新素材列表视图
    if (successCount > 0 && lastTargetFolder && lastTargetFolder !== 'ALL') {
      currentFolderFilter = lastTargetFolder;
    }
    await loadMediaLibrary();

    // 视觉定位：平滑滚动到新上传的文件并光晕高亮提示
    setTimeout(() => {
      if (uploadedNames.length > 0 && mediaGrid) {
        const lastName = uploadedNames[uploadedNames.length - 1];
        const rows = mediaGrid.querySelectorAll('.media-item-row');
        for (const row of rows) {
          const fn = row.getAttribute('data-filename') || '';
          if (fn.includes(lastName) || lastName.includes(fn)) {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.style.transition = 'all 0.5s ease';
            row.style.boxShadow = '0 0 25px rgba(0, 240, 255, 0.9)';
            row.style.borderColor = '#00f0ff';
            setTimeout(() => {
              row.style.boxShadow = '';
              row.style.borderColor = '';
            }, 3500);
            break;
          }
        }
      }
    }, 150);
  }



  // ===================== 5. U 盘即插即用热更新检测 =====================
  async function checkUsbStatus() {
    try {
      const res = await fetch('/api/system/usb_status');
      const data = await res.json();
      if (data.status === 'ok') {
        if (data.has_usb) {
          const driveNames = (data.drives || []).join(' ');
          if (headerUsbText) headerUsbText.textContent = `💾 U盘已插入 (${driveNames})`;
          if (headerUsbBadge) {
            headerUsbBadge.style.borderColor = 'rgba(16, 185, 129, 0.6)';
            headerUsbBadge.style.color = '#34d399';
            headerUsbBadge.style.background = 'rgba(16, 185, 129, 0.15)';
          }
        } else {
          if (headerUsbText) headerUsbText.textContent = `💾 U盘就绪 (等待插入)`;
          if (headerUsbBadge) {
            headerUsbBadge.style.borderColor = '';
            headerUsbBadge.style.color = '';
            headerUsbBadge.style.background = '';
          }
        }

        const ev = data.event;
        if (ev && ev.timestamp > lastHandledUsbTime) {
          lastHandledUsbTime = ev.timestamp;
          showToast(`已从盘符 [${ev.drive}] 自动完成素材同步！共处理 ${ev.count} 个素材`, 'U盘热更新');
          if (headerUsbText) headerUsbText.textContent = `💾 已同步 [${ev.drive}] (${ev.count}个)`;
          loadMediaLibrary();
        }
      }
    } catch (e) {}
  }
  setInterval(checkUsbStatus, 6000);

  if (headerUsbBadge) {
    headerUsbBadge.addEventListener('click', async () => {
      showToast('正在立即全盘扫描接入的 U 盘...', 'U盘扫描');
      try {
        const res = await fetch('/api/system/usb_sync_now', { method: 'POST' });
        const ret = await res.json();
        const msg = ret.message || ((ret.synced_files && ret.synced_files.length > 0) ? `扫描同步完成！更新了 ${ret.synced_files.length} 个素材` : 'U盘扫描完毕，暂无待更新素材');
        showToast(msg, ret.status === 'ok' ? 'U盘同步' : '提示');
        if (ret.synced_files && ret.synced_files.length > 0 || ret.standby_updated) {
          loadMediaLibrary();
        }
      } catch (e) {
        showToast('扫描 U 盘失败: ' + e, '错误');
      }
    });
  }

  // ===================== 6. 展馆一键控制与场景宏流程编排 =====================
  async function loadMacros() {
    try {
      const res = await fetch('/api/iot/macros');
      const data = await res.json();
      if (data.status === 'ok') {
        macrosCache = data.macros || {};
        renderMacroCards();
      }
    } catch (e) {}
  }

  function renderMacroCards() {
    if (!macrosCardsContainer) return;
    macrosCardsContainer.innerHTML = '';

    const keys = Object.keys(macrosCache);
    if (keys.length === 0) {
      macrosCardsContainer.innerHTML = '<div style="color:#64748b;font-size:12px;">暂无控制场景，请点击右上角新增场景</div>';
      return;
    }

    keys.forEach(k => {
      const m = macrosCache[k];
      const stepCount = (m.steps && Array.isArray(m.steps)) ? m.steps.length : 0;
      const theme = m.theme || 'cyan';

      const card = document.createElement('div');
      card.className = `macro-card theme-${theme}`;
      card.innerHTML = `
        <div class="macro-card-header">
          <div class="macro-title-line">
            <span class="macro-theme-dot"></span>
            <span class="macro-title-text">${m.name || k}</span>
          </div>
          <span class="macro-step-badge">${stepCount} 步流程</span>
        </div>
        <div class="macro-card-desc">${m.desc || '预设多设备按序联动控制流程'}</div>
        <div class="macro-card-actions">
          <button class="btn-macro-action btn-macro-run" data-id="${k}">⚡ 立即执行</button>
          <button class="btn-macro-action btn-macro-edit" data-id="${k}">⚙ 编排</button>
          <button class="btn-macro-action btn-macro-rename" data-id="${k}">✏️ 改名</button>
          ${(k !== 'open_pavilion' && k !== 'close_pavilion') ? `<button class="btn-macro-action btn-macro-del" data-id="${k}" title="删除此场景">🗑</button>` : ''}
        </div>
      `;

      card.querySelector('.btn-macro-run').addEventListener('click', () => runMacro(k));
      card.querySelector('.btn-macro-edit').addEventListener('click', () => openMacroModal(k));
      card.querySelector('.btn-macro-rename').addEventListener('click', () => openRenameModal(k, m.name, m.desc));

      const delBtn = card.querySelector('.btn-macro-del');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          if (confirm(`确定要删除场景 [${m.name}] 吗？`)) {
            await fetch('/api/iot/macros/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ macro_id: k }) });
            delete macrosCache[k];
            renderMacroCards();
            showToast(`已删除场景: ${m.name}`);
          }
        });
      }

      macrosCardsContainer.appendChild(card);
    });
  }

  async function runMacro(macroId) {
    const macroObj = macrosCache[macroId] || {};
    showToast(`正在触发场景流程: ${macroObj.name || macroId}...`);
    try {
      const res = await fetch('/api/iot/macros/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ macro_id: macroId })
      });
      const ret = await res.json();
      if (ret.status === 'ok') {
        if (macroProgressBox) macroProgressBox.classList.remove('hidden');
        trackMacroProgress();
      } else {
        alert(ret.message || '执行流程异常');
      }
    } catch (e) {
      alert('网络请求失败: ' + e);
    }
  }

  let macroPollingTimer = null;
  function trackMacroProgress() {
    if (macroPollingTimer) clearInterval(macroPollingTimer);
    macroPollingTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/iot/macros/status');
        const data = await res.json();
        if (data.status === 'ok' && data.macro_status) {
          const st = data.macro_status;
          if (macroStatusText) macroStatusText.textContent = `${st.macro_name} - ${st.current_step_title}`;
          if (macroStepCount) macroStepCount.textContent = `步骤 ${st.current_step} / ${st.total_steps}`;
          const pct = st.total_steps > 0 ? (st.current_step / st.total_steps) * 100 : 0;
          if (macroProgressBar) macroProgressBar.style.width = `${pct}%`;

          if (st.logs && st.logs.length > 0 && macroLogRecent) {
            macroLogRecent.textContent = st.logs[st.logs.length - 1];
          }

          if (!st.is_running) {
            clearInterval(macroPollingTimer);
            macroPollingTimer = null;
            setTimeout(() => {
              if (macroProgressBox) macroProgressBox.classList.add('hidden');
            }, 3000);
          }
        }
      } catch (e) {
        clearInterval(macroPollingTimer);
      }
    }, 500);
  }

  // 重命名场景模态框
  const modalRenameMacro = document.getElementById('modal-rename-macro');
  const renameMacroIdInput = document.getElementById('rename-macro-id');
  const renameMacroNameInput = document.getElementById('rename-macro-name');
  const renameMacroDescInput = document.getElementById('rename-macro-desc');
  const btnCloseRename = document.getElementById('btn-close-rename-modal');
  const btnCancelRename = document.getElementById('btn-cancel-rename');
  const btnSaveRename = document.getElementById('btn-save-rename');

  function openRenameModal(macroId, currentName, currentDesc) {
    if (!modalRenameMacro) return;
    if (renameMacroIdInput) renameMacroIdInput.value = macroId;
    if (renameMacroNameInput) renameMacroNameInput.value = currentName || '';
    if (renameMacroDescInput) renameMacroDescInput.value = currentDesc || '';
    modalRenameMacro.classList.remove('hidden');
  }

  if (btnCloseRename) btnCloseRename.addEventListener('click', () => modalRenameMacro.classList.add('hidden'));
  if (btnCancelRename) btnCancelRename.addEventListener('click', () => modalRenameMacro.classList.add('hidden'));
  if (btnSaveRename) {
    btnSaveRename.addEventListener('click', async () => {
      const macroId = renameMacroIdInput.value;
      const newName = renameMacroNameInput.value.trim();
      const newDesc = renameMacroDescInput.value.trim();
      if (!newName) return;

      await fetch('/api/iot/macros/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ macro_id: macroId, new_name: newName, new_desc: newDesc })
      });

      modalRenameMacro.classList.add('hidden');
      if (macrosCache[macroId]) {
        macrosCache[macroId].name = newName;
        macrosCache[macroId].desc = newDesc;
      }
      renderMacroCards();
      showToast('场景名称已修改保存');
    });
  }

  // 新增场景模态框
  const modalAddMacro = document.getElementById('modal-add-macro');
  const btnAddMacro = document.getElementById('btn-add-macro');
  const btnCloseAddMacro = document.getElementById('btn-close-add-macro-modal');
  const btnCancelAddMacro = document.getElementById('btn-cancel-add-macro');
  const formAddMacro = document.getElementById('form-add-macro');
  const newMacroName = document.getElementById('new-macro-name');
  const newMacroDesc = document.getElementById('new-macro-desc');
  const newMacroTheme = document.getElementById('new-macro-theme');

  if (btnAddMacro) {
    btnAddMacro.addEventListener('click', () => {
      if (modalAddMacro) {
        if (newMacroName) newMacroName.value = '';
        if (newMacroDesc) newMacroDesc.value = '';
        modalAddMacro.classList.remove('hidden');
      }
    });
  }
  if (btnCloseAddMacro) btnCloseAddMacro.addEventListener('click', () => modalAddMacro.classList.add('hidden'));
  if (btnCancelAddMacro) btnCancelAddMacro.addEventListener('click', () => modalAddMacro.classList.add('hidden'));

  if (formAddMacro) {
    formAddMacro.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = (newMacroName ? newMacroName.value : '').trim();
      const desc = (newMacroDesc ? newMacroDesc.value : '').trim();
      const theme = newMacroTheme ? newMacroTheme.value : 'cyan';
      if (!name) return;

      const macroId = `macro_${Date.now()}`;
      const firstDev = devicesCache[0] ? devicesCache[0].id : '';
      const defaultSteps = [
        { title: `${name} 步骤1: 开启设备`, device_id: firstDev, action: 'on', delay: 1.0 }
      ];

      await fetch('/api/iot/macros/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: macroId, name, desc, theme, steps: defaultSteps })
      });

      macrosCache[macroId] = { id: macroId, name, desc, theme, steps: defaultSteps };
      modalAddMacro.classList.add('hidden');
      renderMacroCards();
      showToast(`已创建场景 [${name}]，现在可编排步骤`);
      openMacroModal(macroId);
    });
  }

  // 步骤编排模态框
  const modalMacroSteps = document.getElementById('modal-macro-steps');
  const btnEditMacros = document.getElementById('btn-edit-macros');
  const btnCloseMacroSteps = document.getElementById('btn-close-macro-modal');
  const btnCancelMacroSteps = document.getElementById('btn-cancel-macro');
  const btnSaveMacroSteps = document.getElementById('btn-save-macro');
  const btnAddStep = document.getElementById('btn-add-step');
  const macroTabContainer = document.getElementById('macro-tab-container');
  const macroStepsList = document.getElementById('macro-steps-list');

  function openMacroModal(defaultKey = null) {
    if (!modalMacroSteps) return;
    const keys = Object.keys(macrosCache);
    if (keys.length === 0) {
      alert('请先创建控制场景后再编排步骤');
      return;
    }
    currentEditingMacroKey = (defaultKey && macrosCache[defaultKey]) ? defaultKey : (macrosCache['open_pavilion'] ? 'open_pavilion' : keys[0]);
    renderMacroTabs();
    renderMacroStepsEditor();
    modalMacroSteps.classList.remove('hidden');
  }

  function renderMacroTabs() {
    if (!macroTabContainer) return;
    macroTabContainer.innerHTML = '';
    Object.keys(macrosCache).forEach(k => {
      const m = macrosCache[k];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab-btn' + (k === currentEditingMacroKey ? ' active' : '');
      btn.textContent = m.name || k;
      btn.setAttribute('data-macro', k);
      btn.addEventListener('click', () => {
        macroTabContainer.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentEditingMacroKey = k;
        renderMacroStepsEditor();
      });
      macroTabContainer.appendChild(btn);
    });
  }

  function renderMacroStepsEditor() {
    if (!macroStepsList) return;
    macroStepsList.innerHTML = '';
    const macroObj = macrosCache[currentEditingMacroKey] || { steps: [] };
    const steps = macroObj.steps || [];

    if (steps.length === 0) {
      macroStepsList.innerHTML = '<div style="padding:24px;color:#64748b;font-size:12px;text-align:center;">该流程暂无步骤，请点击右上角【➕ 追加执行步骤】</div>';
      return;
    }

    steps.forEach((st, idx) => {
      const row = document.createElement('div');
      row.className = 'macro-step-item';

      let devOptions = '<option value="">-- 选择受控设备 --</option>';
      devicesCache.forEach(d => {
        const sel = (d.id === st.device_id) ? 'selected' : '';
        devOptions += `<option value="${d.id}" ${sel}>${d.name} (${d.type})</option>`;
      });

      row.innerHTML = `
        <span class="step-num">#${idx + 1}</span>
        <input type="text" class="step-input-title" placeholder="步骤名称说明" value="${st.title || ''}" />
        <select class="step-input-dev">${devOptions}</select>
        <select class="step-input-cmd">
          <option value="on" ${st.action === 'on' ? 'selected' : ''}>⚡ 开机 / 通电 (ON)</option>
          <option value="off" ${st.action === 'off' ? 'selected' : ''}>⏹ 关机 / 断电 (OFF)</option>
        </select>
        <div style="display:flex;align-items:center;gap:4px;">
          <input type="number" class="step-input-delay" title="步骤间执行延时 (秒)" placeholder="延时秒" min="0" max="600" step="0.5" value="${st.delay !== undefined ? st.delay : 1.0}" />
          <span style="font-size:12px;color:#94a3b8;">秒延时</span>
        </div>
        <button type="button" class="btn-del-step" title="删除该步骤">🗑</button>
      `;

      row.querySelector('.btn-del-step').addEventListener('click', () => {
        steps.splice(idx, 1);
        renderMacroStepsEditor();
      });

      macroStepsList.appendChild(row);
    });
  }

  if (btnAddStep) {
    btnAddStep.addEventListener('click', () => {
      const macroObj = macrosCache[currentEditingMacroKey] || { steps: [] };
      if (!macroObj.steps) macroObj.steps = [];
      const firstDev = devicesCache[0] ? devicesCache[0].id : '';
      macroObj.steps.push({
        title: `执行步骤 ${macroObj.steps.length + 1}`,
        device_id: firstDev,
        action: 'on',
        delay: 1.0
      });
      renderMacroStepsEditor();
    });
  }

  if (btnSaveMacroSteps) {
    btnSaveMacroSteps.addEventListener('click', async () => {
      const stepItems = macroStepsList.querySelectorAll('.macro-step-item');
      const newSteps = [];
      stepItems.forEach(item => {
        const title = item.querySelector('.step-input-title').value.trim();
        const devId = item.querySelector('.step-input-dev').value;
        const act = item.querySelector('.step-input-cmd').value;
        const delay = parseFloat(item.querySelector('.step-input-delay').value) || 0;
        newSteps.push({ title, device_id: devId, action: act, delay });
      });

      if (!macrosCache[currentEditingMacroKey]) {
        macrosCache[currentEditingMacroKey] = {};
      }
      macrosCache[currentEditingMacroKey].steps = newSteps;

      await fetch('/api/iot/macros', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ macros: macrosCache })
      });
      showToast('场景步骤编排已成功保存！');
      if (modalMacroSteps) modalMacroSteps.classList.add('hidden');
      renderMacroCards();
    });
  }

  if (btnEditMacros) btnEditMacros.addEventListener('click', () => openMacroModal());
  if (btnCloseMacroSteps) btnCloseMacroSteps.addEventListener('click', () => modalMacroSteps.classList.add('hidden'));
  if (btnCancelMacroSteps) btnCancelMacroSteps.addEventListener('click', () => modalMacroSteps.classList.add('hidden'));

  // ===================== 7. 受控环境设备管理 (TCP/UDP/HTTP/WOL/SERIAL) =====================
  async function loadDevices() {
    try {
      const res = await fetch('/api/iot/devices');
      const data = await res.json();
      if (data.status === 'ok') {
        devicesCache = data.devices || [];
        renderDeviceCards(devicesCache);
      }
    } catch (e) {}
  }

  function renderDeviceCards(devices) {
    if (!deviceCardsGrid) return;
    deviceCardsGrid.innerHTML = '';
    if (devices.length === 0) {
      deviceCardsGrid.innerHTML = '<div style="grid-column:1/-1;color:#64748b;font-size:12px;">暂无受控环境设备，请点击右上角【+ 添加受控设备】</div>';
      return;
    }
    devices.forEach(d => {
      const card = document.createElement('div');
      card.className = 'device-card-item';
      card.innerHTML = `
        <div class="dev-item-header">
          <span class="dev-item-name">${d.name}</span>
          <span class="dev-type-tag">${d.type}</span>
        </div>
        <div class="dev-item-addr">${d.host || ''}:${d.port || ''}</div>
        <div class="dev-actions-row">
          <button class="btn-dev-test on" data-id="${d.id}" data-action="on">⚡ 开机测试</button>
          <button class="btn-dev-test off" data-id="${d.id}" data-action="off">关断测试</button>
          <button class="btn-dev-edit" data-id="${d.id}">编辑</button>
        </div>
      `;
      deviceCardsGrid.appendChild(card);
    });

    deviceCardsGrid.querySelectorAll('.btn-dev-test').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.getAttribute('data-id');
        const act = e.target.getAttribute('data-action');
        const res = await fetch('/api/iot/devices/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: id, cmd_type: act })
        });
        const ret = await res.json();
        showToast(ret.message || '已触发测试指令', act === 'on' ? '开启测试' : '关断测试');
      });
    });

    deviceCardsGrid.querySelectorAll('.btn-dev-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.getAttribute('data-id');
        const dev = devicesCache.find(d => d.id === id);
        if (dev) openDeviceModal(dev);
      });
    });
  }

  // 设备模态框
  const modalDevice = document.getElementById('modal-device');
  const btnAddDevice = document.getElementById('btn-add-device');
  const btnCloseDevModal = document.getElementById('btn-close-device-modal');
  const btnCancelDev = document.getElementById('btn-cancel-device');
  const btnDeleteDev = document.getElementById('btn-delete-device');
  const formDevice = document.getElementById('form-device');
  const editDevIdInput = document.getElementById('edit-device-id');
  const modalDevTitle = document.getElementById('modal-device-title');
  const devNameInput = document.getElementById('dev-name');
  const devTypeSelect = document.getElementById('dev-type');
  const devProtoSelect = document.getElementById('dev-protocol');
  const lblDevHost = document.getElementById('lbl-dev-host');
  const devHostInput = document.getElementById('dev-host');
  const lblDevPort = document.getElementById('lbl-dev-port');
  const devPortInput = document.getElementById('dev-port');
  const devCmdOnInput = document.getElementById('dev-cmd-on');
  const devCmdOffInput = document.getElementById('dev-cmd-off');

  function updateDevTypeUI() {
    if (!devTypeSelect) return;
    const t = devTypeSelect.value;
    if (t === 'WOL') {
      if (lblDevHost) lblDevHost.textContent = '目标 MAC 物理地址 (网卡物理地址)';
      if (devHostInput) devHostInput.placeholder = '例如: 00:11:22:33:44:55';
      if (lblDevPort) lblDevPort.textContent = '广播唤醒端口 (默认 9)';
      if (devPortInput) devPortInput.value = 9;
    } else if (t === 'SERIAL') {
      if (lblDevHost) lblDevHost.textContent = '串口号 (COM口)';
      if (devHostInput) devHostInput.placeholder = '例如: COM1, COM2';
      if (lblDevPort) lblDevPort.textContent = '波特率 (Baudrate)';
      if (devPortInput) devPortInput.value = 9600;
    } else if (t === 'HTTP') {
      if (lblDevHost) lblDevHost.textContent = '目标服务器 IP 或完整 URL';
      if (devHostInput) devHostInput.placeholder = '192.168.1.100 或 http://...';
      if (lblDevPort) lblDevPort.textContent = 'HTTP 端口 (默认 80)';
      if (devPortInput) devPortInput.value = 80;
    } else {
      if (lblDevHost) lblDevHost.textContent = '目标 IP 地址 / 主机名';
      if (devHostInput) devHostInput.placeholder = '192.168.1.200';
      if (lblDevPort) lblDevPort.textContent = '通信端口 (Port)';
      if (devPortInput && !devPortInput.value) devPortInput.value = 4001;
    }
  }

  if (devTypeSelect) devTypeSelect.addEventListener('change', updateDevTypeUI);

  function openDeviceModal(dev = null) {
    if (!modalDevice) return;
    if (dev) {
      if (modalDevTitle) modalDevTitle.textContent = `编辑受控设备 - ${dev.name}`;
      if (editDevIdInput) editDevIdInput.value = dev.id || '';
      if (devNameInput) devNameInput.value = dev.name || '';
      if (devTypeSelect) devTypeSelect.value = dev.type || 'TCP';
      if (devProtoSelect) devProtoSelect.value = dev.protocol || 'hex';
      if (devHostInput) devHostInput.value = dev.host || '192.168.1.200';
      if (devPortInput) devPortInput.value = dev.port || 4001;
      if (devCmdOnInput) devCmdOnInput.value = (dev.commands && dev.commands.on) ? dev.commands.on : (dev.on_cmd || '');
      if (devCmdOffInput) devCmdOffInput.value = (dev.commands && dev.commands.off) ? dev.commands.off : (dev.off_cmd || '');
      if (btnDeleteDev) btnDeleteDev.classList.remove('hidden');
    } else {
      if (modalDevTitle) modalDevTitle.textContent = '配置新增受控环境设备';
      if (editDevIdInput) editDevIdInput.value = '';
      if (devNameInput) devNameInput.value = '';
      if (devTypeSelect) devTypeSelect.value = 'TCP';
      if (devProtoSelect) devProtoSelect.value = 'hex';
      if (devHostInput) devHostInput.value = '192.168.1.200';
      if (devPortInput) devPortInput.value = 4001;
      if (devCmdOnInput) devCmdOnInput.value = 'A5 5A 08 01 FF FF FF FF';
      if (devCmdOffInput) devCmdOffInput.value = 'A5 5A 08 01 00 00 00 00';
      if (btnDeleteDev) btnDeleteDev.classList.add('hidden');
    }
    updateDevTypeUI();
    modalDevice.classList.remove('hidden');
  }

  if (btnAddDevice) btnAddDevice.addEventListener('click', () => openDeviceModal(null));
  if (btnCloseDevModal) btnCloseDevModal.addEventListener('click', () => modalDevice.classList.add('hidden'));
  if (btnCancelDev) btnCancelDev.addEventListener('click', () => modalDevice.classList.add('hidden'));

  if (btnDeleteDev) {
    btnDeleteDev.addEventListener('click', async () => {
      const devId = editDevIdInput.value;
      if (!devId) return;
      if (confirm('确定要删除此受控设备吗？')) {
        devicesCache = devicesCache.filter(d => d.id !== devId);
        await fetch('/api/iot/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ devices: devicesCache })
        });
        modalDevice.classList.add('hidden');
        renderDeviceCards(devicesCache);
        showToast('设备已删除');
      }
    });
  }

  if (formDevice) {
    formDevice.addEventListener('submit', async (e) => {
      e.preventDefault();
      const devId = editDevIdInput.value || `dev_${Date.now()}`;
      const onVal = devCmdOnInput.value.trim();
      const offVal = devCmdOffInput.value.trim();
      const devObj = {
        id: devId,
        name: devNameInput.value.trim(),
        type: devTypeSelect.value,
        protocol: devProtoSelect.value,
        host: devHostInput.value.trim(),
        port: parseInt(devPortInput.value) || 4001,
        on_cmd: onVal,
        off_cmd: offVal,
        commands: { on: onVal, off: offVal }
      };

      const existingIdx = devicesCache.findIndex(d => d.id === devId);
      if (existingIdx !== -1) {
        devicesCache[existingIdx] = devObj;
      } else {
        devicesCache.push(devObj);
      }

      await fetch('/api/iot/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devices: devicesCache })
      });
      modalDevice.classList.add('hidden');
      renderDeviceCards(devicesCache);
      showToast(`受控设备 [${devObj.name}] 配置已保存`);
    });
  }

  // ===================== 7.1 自定义中转与协议分发 (Forwarder Engine) =====================
  let forwardersCache = [];
  const forwarderCardsGrid = document.getElementById('forwarder-cards-grid');
  const fwdCountBadge = document.getElementById('fwd-count-badge');
  const modalForwarder = document.getElementById('modal-forwarder');
  const btnAddForwarder = document.getElementById('btn-add-forwarder');
  const btnAddForwarderDirect = document.getElementById('btn-add-forwarder-direct');
  const btnCloseFwdModal = document.getElementById('btn-close-forwarder-modal');
  const btnCancelFwd = document.getElementById('btn-cancel-forwarder');
  const btnDeleteFwd = document.getElementById('btn-delete-forwarder');
  const btnTestFwd = document.getElementById('btn-test-forwarder');
  const formForwarder = document.getElementById('form-forwarder');
  const modalFwdTitle = document.getElementById('modal-forwarder-title');

  const editFwdId = document.getElementById('edit-fwd-id');
  const fwdNameInput = document.getElementById('fwd-name');
  const fwdEnabledSelect = document.getElementById('fwd-enabled');
  const fwdDescInput = document.getElementById('fwd-desc');
  const fwdMatchProtoSelect = document.getElementById('fwd-match-protocol');
  const fwdMatchTypeSelect = document.getElementById('fwd-match-type');
  const fwdSerialListenGroup = document.getElementById('fwd-serial-listen-group');
  const fwdNetListenGroup = document.getElementById('fwd-net-listen-group');
  const fwdNetListenPortInput = document.getElementById('fwd-net-listen-port');
  const fwdListenSerialPortInput = document.getElementById('fwd-listen-serial-port');
  const fwdListenBaudInput = document.getElementById('fwd-listen-baud');
  const fwdMatchCmdInput = document.getElementById('fwd-match-cmd');
  const fwdTargetProtoSelect = document.getElementById('fwd-target-protocol');
  const fwdTargetFormatSelect = document.getElementById('fwd-target-format');
  const lblFwdTargetHost = document.getElementById('lbl-fwd-target-host');
  const fwdTargetHostInput = document.getElementById('fwd-target-host');
  const lblFwdTargetPort = document.getElementById('lbl-fwd-target-port');
  const fwdTargetPortInput = document.getElementById('fwd-target-port');
  const fwdTargetPortGroup = document.getElementById('fwd-target-port-group');
  const fwdTargetCmdInput = document.getElementById('fwd-target-cmd');
  const fwdDelayMsInput = document.getElementById('fwd-delay-ms');

  function updateFwdUIState() {
    if (!fwdMatchProtoSelect || !fwdTargetProtoSelect) return;
    const mp = fwdMatchProtoSelect.value;
    if (mp === 'SERIAL') {
      if (fwdSerialListenGroup) fwdSerialListenGroup.classList.remove('hidden');
      if (fwdNetListenGroup) fwdNetListenGroup.classList.add('hidden');
    } else {
      if (fwdSerialListenGroup) fwdSerialListenGroup.classList.add('hidden');
      if (fwdNetListenGroup) fwdNetListenGroup.classList.remove('hidden');
      if (fwdNetListenPortInput && !fwdNetListenPortInput.value) {
        fwdNetListenPortInput.value = (mp === 'TCP' ? 8000 : 8001);
      }
    }

    const tp = fwdTargetProtoSelect.value;
    if (tp === 'WOL') {
      if (lblFwdTargetHost) lblFwdTargetHost.textContent = '目标网卡 MAC 物理地址';
      if (fwdTargetHostInput) fwdTargetHostInput.placeholder = '例如: 00:11:22:33:44:55';
      if (lblFwdTargetPort) lblFwdTargetPort.textContent = '广播端口 (默认 9)';
      if (fwdTargetPortInput) fwdTargetPortInput.value = 9;
      if (fwdTargetPortGroup) fwdTargetPortGroup.classList.remove('hidden');
    } else if (tp === 'SERIAL') {
      if (lblFwdTargetHost) lblFwdTargetHost.textContent = '目标写出串口号 (COM口)';
      if (fwdTargetHostInput) fwdTargetHostInput.placeholder = '例如: COM1, COM2';
      if (lblFwdTargetPort) lblFwdTargetPort.textContent = '波特率 (Baudrate)';
      if (fwdTargetPortInput) fwdTargetPortInput.value = 9600;
      if (fwdTargetPortGroup) fwdTargetPortGroup.classList.remove('hidden');
    } else if (tp === 'HTTP') {
      if (lblFwdTargetHost) lblFwdTargetHost.textContent = '目标服务器 IP 或完整 URL';
      if (fwdTargetHostInput) fwdTargetHostInput.placeholder = '127.0.0.1 或 http://...';
      if (lblFwdTargetPort) lblFwdTargetPort.textContent = '目标端口 (默认 80)';
      if (fwdTargetPortInput) fwdTargetPortInput.value = 80;
      if (fwdTargetPortGroup) fwdTargetPortGroup.classList.remove('hidden');
    } else {
      if (lblFwdTargetHost) lblFwdTargetHost.textContent = '目标 IP 地址 / 广播IP';
      if (fwdTargetHostInput) fwdTargetHostInput.placeholder = '192.168.1.188';
      if (lblFwdTargetPort) lblFwdTargetPort.textContent = '通信端口 (Port)';
      if (fwdTargetPortInput && !fwdTargetPortInput.value) fwdTargetPortInput.value = 4001;
      if (fwdTargetPortGroup) fwdTargetPortGroup.classList.remove('hidden');
    }
  }

  if (fwdMatchProtoSelect) fwdMatchProtoSelect.addEventListener('change', updateFwdUIState);
  if (fwdTargetProtoSelect) fwdTargetProtoSelect.addEventListener('change', updateFwdUIState);

  async function loadForwarders() {
    try {
      const res = await fetch('/api/iot/forwarders');
      const data = await res.json();
      if (data.status === 'ok') {
        forwardersCache = data.forwarders || [];
        renderForwarderCards(forwardersCache);
      }
    } catch (e) {
      console.error('加载中转规则失败:', e);
    }
  }

  function renderForwarderCards(list) {
    if (!forwarderCardsGrid) return;
    forwarderCardsGrid.innerHTML = '';
    const activeCount = list.filter(f => f.enabled !== false).length;
    if (fwdCountBadge) fwdCountBadge.textContent = `${activeCount} / ${list.length} 条已生效`;

    if (list.length === 0) {
      forwarderCardsGrid.innerHTML = '<div style="grid-column: 1 / -1; color: #64748b; font-size: 13px; padding: 16px; background: rgba(15,23,42,0.4); border-radius: 8px; border: 1px dashed rgba(255,255,255,0.1); text-align: center;">暂无自定义中转规则，点击右上角【+ 添加中转规则】配置 UDP、TCP、串口或 HTTP 中继</div>';
      return;
    }

    list.forEach(item => {
      const card = document.createElement('div');
      card.className = 'device-card-item';
      card.style.cssText = `background: ${item.enabled ? 'rgba(30, 41, 59, 0.7)' : 'rgba(15, 23, 42, 0.4)'}; border: 1px solid ${item.enabled ? 'rgba(56, 189, 248, 0.3)' : 'rgba(255,255,255,0.06)'}; border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; transition: all 0.2s; position: relative;`;
      
      const isEnabled = item.enabled !== false;
      const protoColor = item.match_protocol === 'UDP' ? '#38bdf8' : (item.match_protocol === 'TCP' ? '#34d399' : (item.match_protocol === 'SERIAL' ? '#fbbf24' : '#a78bfa'));

      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <div style="font-weight: 700; color: #f8fafc; font-size: 14px; display: flex; align-items: center; gap: 6px;">
              <span>${item.name || '未命名规则'}</span>
              <span style="font-size: 10px; padding: 1px 6px; border-radius: 4px; background: ${isEnabled ? 'rgba(34,197,94,0.15)' : 'rgba(148,163,184,0.15)'}; color: ${isEnabled ? '#4ade80' : '#94a3b8'}; border: 1px solid ${isEnabled ? 'rgba(34,197,94,0.3)' : 'rgba(148,163,184,0.3)'};">${isEnabled ? '已启用' : '已禁用'}</span>
            </div>
            <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">${item.desc || '收到指定命令后自动执行自定义转发'}</div>
          </div>
          <button class="btn-fwd-toggle" data-id="${item.id}" data-enabled="${isEnabled ? '0' : '1'}" style="background: none; border: 1px solid rgba(255,255,255,0.15); color: #cbd5e1; padding: 2px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;">
            ${isEnabled ? '暂停' : '启用'}
          </button>
        </div>

        <div style="background: rgba(15, 23, 42, 0.6); border-radius: 6px; padding: 8px; font-size: 12px; display: flex; align-items: center; justify-content: space-between; gap: 6px;">
          <div style="flex: 1; min-width: 0;">
            <div style="color: ${protoColor}; font-weight: 600; font-size: 11px;">📥 监听 [${item.match_protocol || 'ALL'}${item.listen_port ? ':' + item.listen_port : ''}]</div>
            <div style="color: #e2e8f0; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${item.match_cmd}">匹配: ${item.match_cmd || '*'}</div>
          </div>
          <div style="color: #38bdf8; font-size: 16px;">➔</div>
          <div style="flex: 1; min-width: 0; text-align: right;">
            <div style="color: #818cf8; font-weight: 600; font-size: 11px;">📤 转发 [${item.target_protocol || 'TCP'}]</div>
            <div style="color: #e2e8f0; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${item.target_host}:${item.target_port}">${item.target_host}:${item.target_port}</div>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #64748b; padding-top: 2px;">
          <div>⚡ 触发: <span style="color: #38bdf8; font-weight: 600;">${item.trigger_count || 0}</span> 次</div>
          <div style="display: flex; gap: 6px;">
            <button class="btn-fwd-test" data-id="${item.id}" style="background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.3); color: #fbbf24; border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer;">测试</button>
            <button class="btn-fwd-edit" data-id="${item.id}" style="background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.3); color: #38bdf8; border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer;">编辑</button>
          </div>
        </div>
      `;
      forwarderCardsGrid.appendChild(card);
    });

    forwarderCardsGrid.querySelectorAll('.btn-fwd-toggle').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.getAttribute('data-id');
        const enableTarget = e.target.getAttribute('data-enabled') === '1';
        try {
          const res = await fetch('/api/iot/forwarders/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, enabled: enableTarget })
          });
          const ret = await res.json();
          if (ret.status === 'ok') {
            loadForwarders();
            showToast(ret.message, '中转规则切换');
          }
        } catch (err) {
          showToast('切换失败', '网络错误');
        }
      });
    });

    forwarderCardsGrid.querySelectorAll('.btn-fwd-test').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.getAttribute('data-id');
        try {
          const res = await fetch('/api/iot/forwarders/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          });
          const ret = await res.json();
          showToast(ret.message || '模拟测试已派发', '中转测试执行');
          loadForwarders();
        } catch (err) {
          showToast('测试执行失败', '异常');
        }
      });
    });

    forwarderCardsGrid.querySelectorAll('.btn-fwd-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.getAttribute('data-id');
        const item = forwardersCache.find(f => f.id === id);
        if (item) openForwarderModal(item);
      });
    });
  }

  function openForwarderModal(fwd = null) {
    if (!modalForwarder) return;
    if (fwd) {
      if (modalFwdTitle) modalFwdTitle.textContent = `编辑自定义中转规则 - ${fwd.name}`;
      if (editFwdId) editFwdId.value = fwd.id || '';
      if (fwdNameInput) fwdNameInput.value = fwd.name || '';
      if (fwdEnabledSelect) fwdEnabledSelect.value = fwd.enabled !== false ? 'true' : 'false';
      if (fwdDescInput) fwdDescInput.value = fwd.desc || '';
      if (fwdMatchProtoSelect) fwdMatchProtoSelect.value = fwd.match_protocol || 'ALL';
      if (fwdMatchTypeSelect) fwdMatchTypeSelect.value = fwd.match_type || 'CONTAINS';
      if (fwdNetListenPortInput) fwdNetListenPortInput.value = fwd.listen_port || (fwd.match_protocol === 'TCP' ? 8000 : 8001);
      if (fwdListenSerialPortInput) fwdListenSerialPortInput.value = fwd.listen_serial_port || 'COM1';
      if (fwdListenBaudInput) fwdListenBaudInput.value = fwd.listen_baudrate || 9600;
      if (fwdMatchCmdInput) fwdMatchCmdInput.value = fwd.match_cmd || '';
      if (fwdTargetProtoSelect) fwdTargetProtoSelect.value = fwd.target_protocol || 'TCP';
      if (fwdTargetFormatSelect) fwdTargetFormatSelect.value = fwd.target_data_format || 'TEXT';
      if (fwdTargetHostInput) fwdTargetHostInput.value = fwd.target_host || '127.0.0.1';
      if (fwdTargetPortInput) fwdTargetPortInput.value = fwd.target_port || 4001;
      if (fwdTargetCmdInput) fwdTargetCmdInput.value = fwd.target_cmd || '';
      if (fwdDelayMsInput) fwdDelayMsInput.value = fwd.delay_ms || 0;
      if (btnDeleteFwd) btnDeleteFwd.classList.remove('hidden');
      if (btnTestFwd) btnTestFwd.classList.remove('hidden');
    } else {
      if (modalFwdTitle) modalFwdTitle.textContent = '新增自定义指令中转与转发规则';
      if (editFwdId) editFwdId.value = '';
      if (fwdNameInput) fwdNameInput.value = '';
      if (fwdEnabledSelect) fwdEnabledSelect.value = 'true';
      if (fwdDescInput) fwdDescInput.value = '';
      if (fwdMatchProtoSelect) fwdMatchProtoSelect.value = 'ALL';
      if (fwdMatchTypeSelect) fwdMatchTypeSelect.value = 'CONTAINS';
      if (fwdNetListenPortInput) fwdNetListenPortInput.value = 8001;
      if (fwdListenSerialPortInput) fwdListenSerialPortInput.value = 'COM1';
      if (fwdListenBaudInput) fwdListenBaudInput.value = 9600;
      if (fwdMatchCmdInput) fwdMatchCmdInput.value = '';
      if (fwdTargetProtoSelect) fwdTargetProtoSelect.value = 'TCP';
      if (fwdTargetFormatSelect) fwdTargetFormatSelect.value = 'TEXT';
      if (fwdTargetHostInput) fwdTargetHostInput.value = '192.168.1.188';
      if (fwdTargetPortInput) fwdTargetPortInput.value = 4001;
      if (fwdTargetCmdInput) fwdTargetCmdInput.value = '';
      if (fwdDelayMsInput) fwdDelayMsInput.value = 0;
      if (btnDeleteFwd) btnDeleteFwd.classList.add('hidden');
      if (btnTestFwd) btnTestFwd.classList.add('hidden');
    }
    updateFwdUIState();
    modalForwarder.classList.remove('hidden');
  }

  if (btnAddForwarder) btnAddForwarder.addEventListener('click', () => openForwarderModal(null));
  if (btnAddForwarderDirect) btnAddForwarderDirect.addEventListener('click', () => openForwarderModal(null));
  if (btnCloseFwdModal) btnCloseFwdModal.addEventListener('click', () => modalForwarder.classList.add('hidden'));
  if (btnCancelFwd) btnCancelFwd.addEventListener('click', () => modalForwarder.classList.add('hidden'));

  if (btnDeleteFwd) {
    btnDeleteFwd.addEventListener('click', async () => {
      const id = editFwdId.value;
      if (!id) return;
      if (confirm('确定要删除此条自定义中转规则吗？')) {
        try {
          const res = await fetch('/api/iot/forwarders/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          });
          const ret = await res.json();
          modalForwarder.classList.add('hidden');
          loadForwarders();
          showToast(ret.message || '中转规则已删除', '规则管理');
        } catch (e) {
          showToast('删除失败', '异常');
        }
      }
    });
  }

  if (btnTestFwd) {
    btnTestFwd.addEventListener('click', async () => {
      const id = editFwdId.value;
      if (!id) return;
      try {
        const res = await fetch('/api/iot/forwarders/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        const ret = await res.json();
        showToast(ret.message || '测试执行完成', '单步模拟测试');
        loadForwarders();
      } catch (e) {
        showToast('测试执行失败', '异常');
      }
    });
  }

  if (formForwarder) {
    formForwarder.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fwdObj = {
        id: editFwdId.value || `fwd_${Date.now()}`,
        name: fwdNameInput.value.trim(),
        enabled: fwdEnabledSelect.value === 'true',
        desc: fwdDescInput.value.trim(),
        match_protocol: fwdMatchProtoSelect.value,
        match_type: fwdMatchTypeSelect.value,
        listen_port: parseInt(fwdNetListenPortInput ? fwdNetListenPortInput.value : 0) || 0,
        listen_serial_port: fwdListenSerialPortInput ? fwdListenSerialPortInput.value.trim() : '',
        listen_baudrate: parseInt(fwdListenBaudInput ? fwdListenBaudInput.value : 9600) || 9600,
        match_cmd: fwdMatchCmdInput.value.trim(),
        target_protocol: fwdTargetProtoSelect.value,
        target_data_format: fwdTargetFormatSelect.value,
        target_host: fwdTargetHostInput.value.trim(),
        target_port: parseInt(fwdTargetPortInput.value) || 4001,
        target_cmd: fwdTargetCmdInput.value,
        delay_ms: parseInt(fwdDelayMsInput.value) || 0
      };

      try {
        const res = await fetch('/api/iot/forwarders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fwdObj)
        });
        const ret = await res.json();
        modalForwarder.classList.add('hidden');
        loadForwarders();
        showToast(ret.message || '中转规则已保存', '规则配置生效');
      } catch (err) {
        showToast('保存失败', '网络异常');
      }
    });
  }

  // ===================== 8. 网页流码管理 (生成同名.txt) =====================
  const modalCustomMedia = document.getElementById('modal-custom-media');
  const btnOpenCustomModal = document.getElementById('btn-open-custom-media-modal');
  const btnCloseCustomModal = document.getElementById('btn-close-custom-media-modal');
  const btnCancelCustomMedia = document.getElementById('btn-cancel-custom-media');
  const formCustomMedia = document.getElementById('form-custom-media');
  const customMediaType = document.getElementById('custom-media-type');
  const customMediaName = document.getElementById('custom-media-name');
  const customMediaTarget = document.getElementById('custom-media-target');
  const customMediaTargetLabel = document.getElementById('custom-media-target-label');

  if (btnOpenCustomModal) {
    btnOpenCustomModal.addEventListener('click', () => {
      if (modalCustomMedia) {
        if (customMediaName) customMediaName.value = '';
        if (customMediaTarget) customMediaTarget.value = '';
        modalCustomMedia.classList.remove('hidden');
      }
    });
  }
  if (btnCloseCustomModal) btnCloseCustomModal.addEventListener('click', () => modalCustomMedia.classList.add('hidden'));
  if (btnCancelCustomMedia) btnCancelCustomMedia.addEventListener('click', () => modalCustomMedia.classList.add('hidden'));

  if (customMediaType) {
    customMediaType.addEventListener('change', () => {
      const isStream = (customMediaType.value === 'stream');
      if (customMediaTargetLabel) customMediaTargetLabel.textContent = isStream ? '直播流 URL 目标地址 (M3U8 / RTSP / FLV)' : '网页 / H5 展项 URL 目标地址';
      if (customMediaTarget) customMediaTarget.placeholder = isStream ? 'rtsp:// 或 http://...m3u8' : 'http:// 或 https://';
    });
  }

  if (formCustomMedia) {
    formCustomMedia.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = customMediaName.value.trim();
      const type = customMediaType.value;
      const target = customMediaTarget.value.trim();
      if (!name || !target) return;

      try {
        const res = await fetch('/api/media/custom', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, type, url: target })
        });
        const ret = await res.json();
        if (ret.status === 'ok') {
          modalCustomMedia.classList.add('hidden');
          showToast(ret.message || `已成功添加自定义素材 [${name}]`);
          loadMediaLibrary();
        } else {
          alert(ret.message || '添加失败');
        }
      } catch (err) {
        alert('保存失败: ' + err);
      }
    });
  }

  // ===================== 9. 大屏顶层字幕 (多行悬浮 / 静态居中 / 第三方天气与时间 / 快捷模板) =====================
  const modalSubtitle = document.getElementById('modal-subtitle');
  const btnOpenSubtitleModal = document.getElementById('btn-open-subtitle-modal');
  const btnCloseSubtitleModal = document.getElementById('btn-close-subtitle-modal');
  const btnCancelSubtitle = document.getElementById('btn-cancel-subtitle');
  const formSubtitleConfig = document.getElementById('form-subtitle-config');
  const subEnabled = document.getElementById('sub-enabled');
  const subText = document.getElementById('sub-text');
  const subMode = document.getElementById('sub-mode');
  const subPosition = document.getElementById('sub-position');
  const subSpeedGroup = document.getElementById('sub-speed-group');
  const subStaticHint = document.getElementById('sub-static-hint');
  const subSpeed = document.getElementById('sub-speed');
  const subFontsize = document.getElementById('sub-fontsize');
  const subColor = document.getElementById('sub-color');
  const subTransparentBg = document.getElementById('sub-transparent-bg');
  const subShowTime = document.getElementById('sub-show-time');
  const subShowWeather = document.getElementById('sub-show-weather');
  const subCity = document.getElementById('sub-city');
  const btnInsertSubTime = document.getElementById('btn-insert-sub-time');
  const btnInsertSubDate = document.getElementById('btn-insert-sub-date');
  const btnInsertSubWeather = document.getElementById('btn-insert-sub-weather');

  // 辅助函数：在文本输入框当前光标处插入内容
  function insertTextAtCursor(inputEl, textToInsert) {
    if (!inputEl) return;
    const start = inputEl.selectionStart || 0;
    const end = inputEl.selectionEnd || 0;
    const val = inputEl.value;
    inputEl.value = val.substring(0, start) + textToInsert + val.substring(end);
    inputEl.focus();
    inputEl.selectionStart = inputEl.selectionEnd = start + textToInsert.length;
  }

  if (btnInsertSubTime) {
    btnInsertSubTime.addEventListener('click', () => insertTextAtCursor(subText, '{time}'));
  }
  if (btnInsertSubDate) {
    btnInsertSubDate.addEventListener('click', () => insertTextAtCursor(subText, '{date}'));
  }
  if (btnInsertSubWeather) {
    btnInsertSubWeather.addEventListener('click', () => insertTextAtCursor(subText, '{weather}'));
  }

  // 快捷场景预置模板库 (全面升级支持多行悬浮与天气时间)
  const SUBTITLE_TEMPLATES = {
    welcome: {
      text: "热烈欢迎各位领导与专家\n莅临展馆参观与指导工作！",
      mode: "static",
      position: "center",
      font_size: 88,
      color: "#f59e0b",
      speed: 0,
      transparent_bg: true,
      show_time: false,
      show_weather: false,
      city: "北京"
    },
    weather_time: {
      text: "科技赋能 · 智享未来\n展馆实时时间：{date} {time}\n当前气象：{weather}",
      mode: "static",
      position: "center",
      font_size: 72,
      color: "#60a5fa",
      speed: 0,
      transparent_bg: true,
      show_time: true,
      show_weather: true,
      city: "北京"
    },
    notice: {
      text: "【临时通告】\n因设备系统例行维护，本区域展项暂时调整\n请遵从现场工作人员指引，敬请谅解！",
      mode: "static",
      position: "center",
      font_size: 56,
      color: "#ef4444",
      speed: 0,
      transparent_bg: false,
      show_time: false,
      show_weather: false,
      city: "北京"
    },
    event: {
      text: "【展厅活动预告】多媒体沉浸式光影秀将于 15:00 准时开场，请各位观众提前就座观赏！",
      mode: "marquee",
      position: "bottom",
      font_size: 46,
      color: "#06b6d4",
      speed: 25,
      transparent_bg: true,
      show_time: false,
      show_weather: false,
      city: "北京"
    },
    tips: {
      text: "【温馨提示】\n请爱护公共展品设施，保持场馆整洁有序\n展厅内请勿追逐喧哗与饮食，祝您参观愉快！",
      mode: "static",
      position: "bottom",
      font_size: 40,
      color: "#10b981",
      speed: 0,
      transparent_bg: true,
      show_time: false,
      show_weather: false,
      city: "北京"
    },
    holiday: {
      text: "盛世欢歌 · 喜迎贵宾\n祝愿大家身体健康、万事顺遂、阖家幸福！",
      mode: "static",
      position: "center",
      font_size: 88,
      color: "#fb7185",
      speed: 0,
      transparent_bg: true,
      show_time: false,
      show_weather: false,
      city: "北京"
    }
  };

  function updateSubModeUI(mode) {
    const isMarquee = (mode === 'marquee');
    if (subSpeedGroup) subSpeedGroup.style.display = isMarquee ? 'block' : 'none';
    if (subStaticHint) subStaticHint.style.display = isMarquee ? 'none' : 'block';
  }

  if (subMode) {
    subMode.addEventListener('change', () => {
      const mode = subMode.value;
      updateSubModeUI(mode);
      if (mode === 'marquee') {
        if (subPosition && subPosition.value === 'center') subPosition.value = 'bottom';
        if (subSpeed && (parseInt(subSpeed.value) || 0) === 0) subSpeed.value = 20;
      } else if (mode === 'multiline_top') {
        if (subPosition) subPosition.value = 'top';
        if (subSpeed) subSpeed.value = 0;
      } else if (mode === 'multiline_bottom') {
        if (subPosition) subPosition.value = 'bottom';
        if (subSpeed) subSpeed.value = 0;
      } else {
        if (subPosition && subPosition.value !== 'top') subPosition.value = 'center';
        if (subSpeed) subSpeed.value = 0;
        if (subFontsize && parseInt(subFontsize.value) < 60) subFontsize.value = 72;
      }
    });
  }

  // 绑定模板快捷按钮
  document.querySelectorAll('.btn-sub-tpl').forEach(btn => {
    btn.addEventListener('click', () => {
      const tplKey = btn.getAttribute('data-tpl');
      const tpl = SUBTITLE_TEMPLATES[tplKey];
      if (!tpl) return;
      if (subText) subText.value = tpl.text;
      if (subMode) subMode.value = tpl.mode;
      if (subPosition) subPosition.value = tpl.position;
      if (subFontsize) subFontsize.value = tpl.font_size;
      if (subColor) subColor.value = tpl.color;
      if (subSpeed) subSpeed.value = tpl.speed;
      if (subTransparentBg) subTransparentBg.checked = tpl.transparent_bg;
      if (subShowTime) subShowTime.checked = !!tpl.show_time;
      if (subShowWeather) subShowWeather.checked = !!tpl.show_weather;
      if (subCity && tpl.city) subCity.value = tpl.city;
      updateSubModeUI(tpl.mode);
      showToast(`已应用【${btn.textContent.trim()}】模板，可按需微调后发布`);
    });
  });

  if (btnOpenSubtitleModal) {
    btnOpenSubtitleModal.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/subtitle?_t=' + Date.now(), { cache: 'no-store' });
        const data = await res.json();
        if (data.status === 'ok' && data.subtitle) {
          const s = data.subtitle;
          if (subEnabled) subEnabled.checked = (s.enabled !== false);
          if (subText) subText.value = s.text || '';
          const currentSpeed = (s.speed !== undefined) ? parseInt(s.speed) : 20;
          let currentMode = s.mode || (currentSpeed === 0 ? 'static' : 'marquee');
          if (subMode) subMode.value = currentMode;
          if (subPosition) subPosition.value = s.position || (currentMode === 'marquee' ? 'bottom' : 'center');
          if (subSpeed) subSpeed.value = currentSpeed;
          if (subFontsize) subFontsize.value = s.font_size || (currentMode === 'marquee' ? 48 : 72);
          if (subColor) subColor.value = s.color || '#ffffff';
          if (subTransparentBg) subTransparentBg.checked = (s.transparent_bg !== false);
          if (subShowTime) subShowTime.checked = (s.show_time === true);
          if (subShowWeather) subShowWeather.checked = (s.show_weather === true);
          if (subCity) subCity.value = s.city || '北京';
          updateSubModeUI(currentMode);
        }
      } catch (e) {}
      if (modalSubtitle) modalSubtitle.classList.remove('hidden');
    });
  }

  if (btnCloseSubtitleModal) btnCloseSubtitleModal.addEventListener('click', () => modalSubtitle.classList.add('hidden'));
  if (btnCancelSubtitle) btnCancelSubtitle.addEventListener('click', () => modalSubtitle.classList.add('hidden'));

  if (formSubtitleConfig) {
    formSubtitleConfig.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentModeVal = subMode ? subMode.value : 'static';
      const isMarquee = (currentModeVal === 'marquee');
      const payload = {
        enabled: subEnabled ? subEnabled.checked : true,
        text: subText ? subText.value : '',
        mode: currentModeVal,
        position: subPosition ? subPosition.value : (isMarquee ? 'bottom' : 'center'),
        speed: isMarquee ? (subSpeed ? parseInt(subSpeed.value) || 20 : 20) : 0,
        font_size: subFontsize ? parseInt(subFontsize.value) || 64 : 64,
        color: subColor ? subColor.value : '#ffffff',
        transparent_bg: subTransparentBg ? subTransparentBg.checked : true,
        bg_color: (subTransparentBg && subTransparentBg.checked) ? 'transparent' : 'rgba(0, 0, 0, 0.72)',
        show_time: subShowTime ? subShowTime.checked : false,
        show_weather: subShowWeather ? subShowWeather.checked : false,
        city: subCity ? subCity.value.trim() : '北京'
      };

      try {
        const res = await fetch('/api/subtitle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const ret = await res.json();
        if (ret.status === 'ok') {
          modalSubtitle.classList.add('hidden');
          showToast(payload.enabled ? (isMarquee ? '跑马灯字幕已推送到大屏生效' : '多行悬浮字幕与天气时间已推送到大屏生效') : '大屏悬浮字幕已关闭');
        } else {
          alert('保存字幕失败: ' + ret.message);
        }
      } catch (err) {
        alert('提交异常: ' + err);
      }
    });
  }

  // ===================== 10. 管理员登录与改密 =====================
  const modalAuthLogin = document.getElementById('modal-auth-login');
  const formAuthLogin = document.getElementById('form-auth-login');
  const loginPassword = document.getElementById('login-password');
  const loginErrorMsg = document.getElementById('login-error-msg');

  function showLoginModal() {
    if (modalAuthLogin) {
      modalAuthLogin.classList.remove('hidden');
      if (loginPassword) {
        loginPassword.value = '';
        setTimeout(() => loginPassword.focus(), 150);
      }
      if (loginErrorMsg) loginErrorMsg.classList.add('hidden');
    }
  }

  function hideLoginModal() {
    if (modalAuthLogin) modalAuthLogin.classList.add('hidden');
  }

  if (formAuthLogin) {
    formAuthLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pwd = loginPassword ? loginPassword.value.trim() : '';
      if (!pwd) return;
      try {
        const res = await rawFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd })
        });
        const ret = await res.json();
        if (res.ok && ret.status === 'ok') {
          if (ret.token) localStorage.setItem('vc_token', ret.token);
          isAuthenticated = true;
          hideLoginModal();
          showToast('欢迎回来，管理员！');
          startAdminLoops();
        } else {
          if (loginErrorMsg) {
            loginErrorMsg.textContent = ret.message || '密码错误，请重新输入';
            loginErrorMsg.classList.remove('hidden');
          }
        }
      } catch (err) {
        if (loginErrorMsg) {
          loginErrorMsg.textContent = '网络连接错误，请稍后重试';
          loginErrorMsg.classList.remove('hidden');
        }
      }
    });
  }

  const btnAuthLogout = document.getElementById('btn-auth-logout');
  if (btnAuthLogout) {
    btnAuthLogout.addEventListener('click', async (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      try { 
        await fetch('/api/auth/logout', { method: 'POST' }); 
      } catch (err) {}
      localStorage.removeItem('vc_token');
      document.cookie = 'vc_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      isAuthenticated = false;
      showToast('已安全退出后台');
      showLoginModal();
    });
  }

  // 修改密码模态框
  const modalChangePwd = document.getElementById('modal-change-pwd');
  const btnOpenChangePwd = document.getElementById('btn-open-change-pwd');
  const btnSecChangePwd = document.getElementById('btn-sec-change-pwd');
  const btnCloseChangePwd = document.getElementById('btn-close-change-pwd');
  const btnCancelPwd = document.getElementById('btn-cancel-pwd');
  const formChangePwd = document.getElementById('form-change-pwd');
  const pwdOld = document.getElementById('pwd-old');
  const pwdNew = document.getElementById('pwd-new');
  const pwdConfirm = document.getElementById('pwd-confirm');
  const changePwdError = document.getElementById('change-pwd-error');

  function openChangePwdModal() {
    if (!modalChangePwd) return;
    if (pwdOld) pwdOld.value = '';
    if (pwdNew) pwdNew.value = '';
    if (pwdConfirm) pwdConfirm.value = '';
    if (changePwdError) changePwdError.classList.add('hidden');
    modalChangePwd.classList.remove('hidden');
    setTimeout(() => pwdOld && pwdOld.focus(), 150);
  }

  if (btnOpenChangePwd) {
    btnOpenChangePwd.addEventListener('click', (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      openChangePwdModal();
    });
  }
  if (btnSecChangePwd) {
    btnSecChangePwd.addEventListener('click', (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      openChangePwdModal();
    });
  }
  if (btnCloseChangePwd) btnCloseChangePwd.addEventListener('click', () => modalChangePwd.classList.add('hidden'));
  if (btnCancelPwd) btnCancelPwd.addEventListener('click', () => modalChangePwd.classList.add('hidden'));

  if (formChangePwd) {
    formChangePwd.addEventListener('submit', async (e) => {
      e.preventDefault();
      const oldVal = pwdOld ? pwdOld.value.trim() : '';
      const newVal = pwdNew ? pwdNew.value.trim() : '';
      const confirmVal = pwdConfirm ? pwdConfirm.value.trim() : '';

      if (newVal !== confirmVal) {
        if (changePwdError) {
          changePwdError.textContent = '两次输入的新密码不一致，请检查';
          changePwdError.classList.remove('hidden');
        }
        return;
      }
      if (newVal.length < 4) {
        if (changePwdError) {
          changePwdError.textContent = '新管理密码长度至少需要4位';
          changePwdError.classList.remove('hidden');
        }
        return;
      }

      try {
        const res = await fetch('/api/auth/change_password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ old_password: oldVal, new_password: newVal })
        });
        const ret = await res.json();
        if (res.ok && ret.status === 'ok') {
          modalChangePwd.classList.add('hidden');
          localStorage.removeItem('vc_token');
          alert('管理密码修改成功！请使用新密码重新登录');
          showLoginModal();
        } else {
          if (changePwdError) {
            changePwdError.textContent = ret.message || '密码修改失败';
            changePwdError.classList.remove('hidden');
          }
        }
      } catch (err) {
        if (changePwdError) {
          changePwdError.textContent = '网络提交异常: ' + err;
          changePwdError.classList.remove('hidden');
        }
      }
    });
  }

  // ===================== 11. 商业授权与在线续期 =====================
  const modalLicense = document.getElementById('modal-license');
  const btnOpenLicModal = document.getElementById('btn-open-license-modal');
  const btnSecLicense = document.getElementById('btn-sec-license');
  const btnCloseLicModal = document.getElementById('btn-close-license-modal');
  const btnCancelLic = document.getElementById('btn-cancel-license');
  const btnCopyMachineCode = document.getElementById('btn-copy-machine-code');
  const btnApplyLicense = document.getElementById('btn-apply-license');
  const licCodeInput = document.getElementById('lic-code-input');

  let licenseExpiredModalShown = false;

  async function loadLicenseInfo(autoPopupIfInvalid = false) {
    try {
      const res = await fetch('/api/system/license?_t=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      if (data.status === 'success') {
        currentLicenseDetails = {
          ...(data.details || {}),
          is_valid: data.is_valid,
          status_code: data.status_code
        };
        renderLicenseBadge(data);

        // 未授权或授权到期时，直接弹出专属授权弹窗
        if (!data.is_valid || data.status_code === 'EXPIRED' || data.status_code === 'NO_LICENSE') {
          if (autoPopupIfInvalid && !licenseExpiredModalShown) {
            licenseExpiredModalShown = true;
            showLicenseModal(true);
          }
        } else {
          // 已经恢复合法授权，重置弹窗标志
          licenseExpiredModalShown = false;
        }
      }
    } catch (e) {
      console.warn('获取授权信息失败:', e);
    }
  }

  function renderLicenseBadge(data) {
    if (!licenseStatusText || !headerLicenseBadge) return;
    const details = data.details || {};
    if (data.is_valid) {
      licenseStatusText.textContent = `已授权 (${details.remaining_days || '永久'})`;
      headerLicenseBadge.style.borderColor = 'rgba(16,185,129,0.4)';
      headerLicenseBadge.style.color = '#34d399';
    } else {
      const sc = data.status_code;
      licenseStatusText.textContent = (sc === 'EXPIRED') ? '⚠️ 授权已到期' : '⚠️ 未授权';
      headerLicenseBadge.style.borderColor = 'rgba(239,68,68,0.6)';
      headerLicenseBadge.style.color = '#f87171';
    }
  }

  function showLicenseModal(isUrgent = false) {
    if (!modalLicense) return;
    if (currentLicenseDetails) {
      const elStatus = document.getElementById('lic-status-badge');
      const elMachine = document.getElementById('lic-machine-code');
      const elReqCode = document.getElementById('lic-request-code');
      const elDays = document.getElementById('lic-remaining-days');

      if (elMachine) elMachine.textContent = currentLicenseDetails.machine_code || 'MC-001';
      if (elReqCode) elReqCode.textContent = currentLicenseDetails.request_code || '--------';
      if (elDays) elDays.textContent = currentLicenseDetails.remaining_days || (currentLicenseDetails.is_valid ? '永久有效' : '已到期');
      if (elStatus) {
        if (currentLicenseDetails.is_valid) {
          elStatus.textContent = `✅ 商业授权正常 (${currentLicenseDetails.remaining_days || '永久'})`;
          elStatus.style.color = '#34d399';
        } else {
          const reasonMap = {
            'NO_LICENSE': '未激活商业授权 (需要授权)',
            'EXPIRED': '商业授权已到期 (需要重新授权)',
            'MACHINE_MISMATCH': '设备硬件特征不符 (需要重新申请)',
            'CLOCK_TAMPERED': '系统时钟被异常篡改 (请校准北京时间)'
          };
          const reason = reasonMap[currentLicenseDetails.status_code] || '商业授权未生效 (需要授权)';
          elStatus.textContent = `⚠️ ${reason}`;
          elStatus.style.color = '#f87171';
        }
      }
    }
    if (licCodeInput) licCodeInput.value = '';
    modalLicense.classList.remove('hidden');
    if (isUrgent) {
      showToast('⚠️ 当前商业授权未激活或已到期，需要输入激活码进行授权！', '需要授权');
    }
  }

  async function openLicModalSafe(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    try {
      await loadLicenseInfo(false);
    } catch (err) {
      console.warn('获取授权信息异常:', err);
    }
    showLicenseModal(false);
  }

  if (headerLicenseBadge) {
    headerLicenseBadge.addEventListener('click', openLicModalSafe);
    headerLicenseBadge.addEventListener('dblclick', openLicModalSafe);
  }
  if (btnOpenLicModal) btnOpenLicModal.addEventListener('click', openLicModalSafe);
  if (btnSecLicense) btnSecLicense.addEventListener('click', openLicModalSafe);
  if (btnCloseLicModal) btnCloseLicModal.addEventListener('click', () => modalLicense.classList.add('hidden'));
  if (btnCancelLic) btnCancelLic.addEventListener('click', () => modalLicense.classList.add('hidden'));

  // 跨平台剪贴板复制兜底工具函数 (兼容局域网 HTTP 非 HTTPS 安全上下文及手机端)
  function copyTextToClipboard(text) {
    if (!text) return Promise.reject(new Error('复制内容为空'));
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
    }
    return fallbackCopyText(text);
  }

  function fallbackCopyText(text) {
    return new Promise((resolve, reject) => {
      try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.top = '0';
        textArea.style.left = '-9999px';
        textArea.style.opacity = '0';
        textArea.setAttribute('readonly', '');
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        textArea.setSelectionRange(0, 99999);
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (successful) {
          resolve();
        } else {
          reject(new Error('execCommand copy failed'));
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  // 统一复制申请码的核心实现函数
  function executeCopyRequestCode() {
    let code = (currentLicenseDetails && currentLicenseDetails.request_code) || '';
    if (!code || code === '----' || code === '--------') {
      const el = document.getElementById('lic-request-code');
      if (el && el.textContent) {
        code = el.textContent.trim();
      }
    }
    if (!code || code === '----' || code === '--------') {
      showToast('正在拉取申请码，请稍候...', '提示');
      loadLicenseInfo().then(() => {
        executeCopyRequestCode();
      });
      return;
    }

    const btn = document.getElementById('btn-copy-request-code');
    const oldText = btn ? btn.textContent : '';

    copyTextToClipboard(code).then(() => {
      showToast(`已成功复制 8 位申请码: ${code}，请粘贴至【国文创加密机】签发激活码`, '复制成功');
      if (btn) {
        btn.textContent = '✓ 已复制申请码';
        btn.style.background = '#10b981';
        setTimeout(() => {
          btn.textContent = oldText || '📋 复制申请码';
          btn.style.background = 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)';
        }, 1800);
      }
    }).catch((err) => {
      showToast(`申请码: ${code} (请长按或手动复制)`, '复制提示');
    });
  }

  // 无论点击复制申请码、点击原机器码复制、还是点击申请码本身，统统复制 8 位动态申请码！
  const btnCopyReqCode = document.getElementById('btn-copy-request-code');
  if (btnCopyReqCode) {
    btnCopyReqCode.addEventListener('click', executeCopyRequestCode);
  }

  if (btnCopyMachineCode) {
    btnCopyMachineCode.addEventListener('click', executeCopyRequestCode);
  }

  const elReqCodeDisplay = document.getElementById('lic-request-code');
  if (elReqCodeDisplay) {
    elReqCodeDisplay.style.cursor = 'pointer';
    elReqCodeDisplay.title = '点击直接复制 8 位申请码';
    elReqCodeDisplay.addEventListener('click', executeCopyRequestCode);
  }

  if (btnApplyLicense) {
    btnApplyLicense.addEventListener('click', async () => {
      const code = licCodeInput ? licCodeInput.value.trim().toUpperCase() : '';
      if (!code) {
        alert('请先输入或粘贴授权激活码 (格式: XXXX-XXXX-XXXX)');
        return;
      }
      btnApplyLicense.disabled = true;
      btnApplyLicense.textContent = '激活验证中...';
      const clean = code.replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g, '');
      try {
        const res = await fetch('/api/system/license', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: clean, license_key: clean })
        });
        const data = await res.json();
        if (data.status === 'success' || data.is_valid) {
          alert('🎉 ' + (data.message || '商业授权验证通过！系统已成功激活解锁。'));
          modalLicense.classList.add('hidden');
          licenseExpiredModalShown = false;
          await loadLicenseInfo(false);
        } else {
          alert('❌ ' + (data.message || '授权激活失败，请检查激活码或硬件特征是否匹配'));
        }
      } catch (err) {
        alert('提交异常: ' + err);
      } finally {
        btnApplyLicense.disabled = false;
        btnApplyLicense.textContent = '立即激活 / 续期';
      }
    });
  }

  // ===================== 12. 第三方应用拉起与状态 =====================
  async function loadSystemAndApps() {
    try {
      const res = await fetch('/api/system/info');
      const data = await res.json();
      if (data.status === 'ok') {
        isPlatformAndroid = (data.platform === 'android' || !!data.is_android || /Android/i.test(navigator.userAgent));
        updateOpsPowerButtonsUI();
        const ip = data.selected_ip || ((data.ips && data.ips.length > 0) ? data.ips[0] : '127.0.0.1');
        if (headerIp) headerIp.textContent = `${ip}:8088`;
        if (sysNetText && ip) sysNetText.textContent = `网卡: ${ip}`;

        const apps = data.external_apps || [];
        const appsSummaryBadge = document.getElementById('apps-summary-badge');
        if (appsSummaryBadge) {
          appsSummaryBadge.textContent = apps.length > 0 ? `${apps.length} 个程序` : '未配置程序';
          appsSummaryBadge.className = 'collapsible-badge-tag ' + (apps.length > 0 ? 'online' : '');
        }

        if (!extAppsContainer) return;
        extAppsContainer.innerHTML = '';
        if (apps.length === 0) {
          extAppsContainer.innerHTML = '<span style="font-size:12px;color:#64748b;">受控端暂未指定第三方外部程序</span>';
        } else {
          let statusMap = {};
          try {
            const stRes = await fetch('/api/system/app_status', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ apps: apps })
            });
            const stData = await stRes.json();
            if (stData.status === 'ok') statusMap = stData.app_status || {};
          } catch (e) {}

          apps.forEach(app => {
            const appId = app.id || app.name;
            const isRunning = !!(statusMap[appId] && statusMap[appId].is_running);
            const group = document.createElement('div');
            group.style.cssText = 'display:inline-flex;align-items:center;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:4px;gap:6px;margin-right:8px;margin-bottom:8px;';
            group.innerHTML = `
              <span style="font-size:12px;padding:0 6px;display:flex;align-items:center;gap:5px;">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${isRunning ? '#10b981' : '#64748b'};box-shadow:${isRunning ? '0 0 8px #10b981' : 'none'};"></span>
                <span style="color:#f8fafc;font-weight:600;">${app.name}</span>
              </span>
              <button class="btn-ops highlight btn-app-launch" style="padding:4px 10px;font-size:12px;" title="运行: ${app.path}">🚀 启动</button>
              <button class="btn-ops danger btn-app-kill" style="padding:4px 10px;font-size:12px;background:rgba(239,68,68,0.18);border-color:rgba(239,68,68,0.4);color:#ef4444;" title="强制关闭此程序">⏹ 结束</button>
            `;

            group.querySelector('.btn-app-launch').addEventListener('click', async () => {
              await fetch('/api/system/launch_app', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: app.path, args: app.args || '' }) });
              showToast(`已向大屏下发拉起指令: ${app.name}`);
              setTimeout(loadSystemAndApps, 1200);
            });

            group.querySelector('.btn-app-kill').addEventListener('click', async () => {
              await fetch('/api/system/kill_app', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: app.path, name: app.name }) });
              showToast(`已下发结束进程指令: ${app.name}`);
              setTimeout(loadSystemAndApps, 800);
            });

            extAppsContainer.appendChild(group);
          });
        }
      }
    } catch (e) {}
  }

  const btnRefreshApps = document.getElementById('btn-refresh-apps');
  if (btnRefreshApps) btnRefreshApps.addEventListener('click', loadSystemAndApps);

  // 第三方应用联动面板折叠/展开逻辑 (持久化记忆到 localStorage)
  const appsHubBox = document.getElementById('apps-hub-box');
  const appsHubHeader = document.getElementById('apps-hub-header-trigger');
  const btnAppsToggle = document.getElementById('btn-apps-toggle');
  const appsToggleText = document.getElementById('apps-toggle-text');

  function updateAppsHubCollapseUI(isCollapsed) {
    if (!appsHubBox) return;
    if (isCollapsed) {
      appsHubBox.classList.add('collapsed');
      if (appsToggleText) appsToggleText.textContent = '展开面板';
    } else {
      appsHubBox.classList.remove('collapsed');
      if (appsToggleText) appsToggleText.textContent = '收起面板';
    }
    localStorage.setItem('vc_apps_collapsed', isCollapsed ? '1' : '0');
  }

  const savedAppsCollapsed = localStorage.getItem('vc_apps_collapsed') !== '0';
  updateAppsHubCollapseUI(savedAppsCollapsed);

  function toggleAppsHub() {
    if (!appsHubBox) return;
    const isCurrentlyCollapsed = appsHubBox.classList.contains('collapsed');
    updateAppsHubCollapseUI(!isCurrentlyCollapsed);
  }

  if (appsHubHeader) {
    appsHubHeader.addEventListener('click', (e) => {
      if (e.target.closest('#btn-refresh-apps')) return;
      toggleAppsHub();
    });
  }
  if (btnAppsToggle) {
    btnAppsToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAppsHub();
    });
  }

  // 点击 IP 快速复制
  if (headerIpBadge) {
    headerIpBadge.addEventListener('click', () => {
      const url = `http://${headerIp ? headerIp.textContent : '127.0.0.1:8088'}`;
      navigator.clipboard.writeText(url).then(() => {
        showToast(`已复制控制后台地址: ${url}`, '复制成功');
      });
    });
  }

  // 移动端汉堡菜单展开/折叠
  const btnMobileMenu = document.getElementById('btn-mobile-menu');
  const headerStatusPanel = document.getElementById('header-status-panel');
  if (btnMobileMenu && headerStatusPanel) {
    btnMobileMenu.addEventListener('click', () => {
      headerStatusPanel.classList.toggle('show-mobile');
    });
  }

  // 移动端底部快捷跳转
  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ===================== 13. 核心轮询自启动与鉴权初始化 =====================
  function startAdminLoops() {
    if (isLoopsStarted) return;
    isLoopsStarted = true;
    loadMediaLibrary();
    loadMacros();
    loadDevices();
    loadForwarders();
    loadSystemAndApps();
    loadAdminAutostart();
    loadLicenseInfo(true);
    setInterval(() => loadLicenseInfo(true), 10000);
    loadMonitorsList();
    fetchClusterSyncStatus();
    checkUsbStatus();
    pollHardwareStatus();
    syncEchoLoop();
    pollCastHubStatus();
    setInterval(pollCastHubStatus, 3000);
  }

  // ===================== 14. 无线投屏控制中枢 (WebRTC 扫码投屏 + 原生 DLNA/AirPlay) =====================
  const btnOpenCastModal = document.getElementById('btn-open-cast-modal');
  const btnQuickCast = document.getElementById('btn-quick-cast');
  const modalCastHub = document.getElementById('modal-cast-hub');
  const btnCloseCastModal = document.getElementById('btn-close-cast-modal');
  const adminCastStatusText = document.getElementById('admin-cast-status-text');
  const btnAdminStopCast = document.getElementById('btn-admin-stop-cast');
  const castStatusIndicator = document.getElementById('cast-status-indicator');
  const adminNativeCastNameInput = document.getElementById('admin-native-cast-name-input');
  const btnSaveCastDeviceName = document.getElementById('btn-save-cast-device-name');
  const btnTriggerScreenBoard = document.getElementById('btn-trigger-screen-board');

  let isCastActiveOrOpened = false; // 当前投屏看板或媒体流是否正在激活

  async function openCastModal(notifyScreen = true) {
    if (!modalCastHub) return;
    modalCastHub.classList.remove('hidden');

    if (notifyScreen) {
      try {
        const res = await fetch('/api/cast/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'open' })
        });
        const data = await res.json();
        if (data && data.info && data.info.native_cast) {
          if (adminNativeCastNameInput) {
            adminNativeCastNameInput.value = data.info.native_cast.device_name || 'VisualCast 展厅大屏';
          }
        }
        isCastActiveOrOpened = true;
        updateQuickCastBtnState();
      } catch (e) {
        console.warn('开启投屏看板异常:', e);
      }
    } else {
      // 仅拉取当前设备名
      try {
        const res = await fetch('/api/cast/info');
        const data = await res.json();
        if (data && data.native_cast && adminNativeCastNameInput) {
          adminNativeCastNameInput.value = data.native_cast.device_name || 'VisualCast 展厅大屏';
        }
      } catch (e) {}
    }
  }

  // 关闭投屏：同时关闭模态框，并向大屏发送 close 指令彻底恢复媒体放映
  async function closeCastModalAndScreen(showNotice = false) {
    if (modalCastHub) modalCastHub.classList.add('hidden');
    try {
      await fetch('/api/cast/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close' })
      });
      isCastActiveOrOpened = false;
      updateQuickCastBtnState();
      if (showNotice) {
        showToast('已关闭大屏无线投屏并恢复放映');
      }
    } catch (e) {
      console.warn('关闭投屏异常:', e);
    }
  }

  function updateQuickCastBtnState() {
    if (!btnQuickCast) return;
    if (isCastActiveOrOpened) {
      btnQuickCast.innerHTML = '⏹ 关闭无线投屏';
      btnQuickCast.title = '大屏正在展示无线投屏，点击立即关闭投屏并恢复媒体播放';
      btnQuickCast.style.color = '#f87171';
      btnQuickCast.style.borderColor = 'rgba(239,68,68,0.5)';
      btnQuickCast.style.background = 'rgba(239,68,68,0.18)';
    } else {
      btnQuickCast.innerHTML = '📡 无线投屏';
      btnQuickCast.title = '开启系统级无线投屏 (支持苹果 AirPlay / 安卓多屏互动 / Win+K 无需扫码)';
      btnQuickCast.style.color = '#00f0ff';
      btnQuickCast.style.borderColor = 'rgba(0,240,255,0.4)';
      btnQuickCast.style.background = 'rgba(0,240,255,0.12)';
    }
  }

  // 顶部投屏标签：打开面板
  if (btnOpenCastModal) {
    btnOpenCastModal.addEventListener('click', () => {
      openCastModal(true);
    });
  }

  // 主操作区快捷投屏按钮：做成智能开关 (开着的时候点击关，关着的时候点击开)
  if (btnQuickCast) {
    btnQuickCast.addEventListener('click', () => {
      if (isCastActiveOrOpened) {
        closeCastModalAndScreen(true);
      } else {
        openCastModal(true);
        showToast('大屏已切换至无线投屏连接看板');
      }
    });
  }

  // 模态框右上角 ✕ 按钮：关闭时彻底关闭投屏
  if (btnCloseCastModal) {
    btnCloseCastModal.addEventListener('click', () => {
      closeCastModalAndScreen(true);
    });
  }

  // 模态框内部按钮：切换看板
  if (btnTriggerScreenBoard) {
    btnTriggerScreenBoard.addEventListener('click', async () => {
      try {
        await fetch('/api/cast/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'open' })
        });
        isCastActiveOrOpened = true;
        updateQuickCastBtnState();
        showToast('大屏已切换至无线投屏连接看板');
      } catch (e) {}
    });
  }

  // 模态框内部按钮：关闭投屏
  if (btnAdminStopCast) {
    btnAdminStopCast.addEventListener('click', () => {
      closeCastModalAndScreen(true);
    });
  }

  // 保存投屏设备名称
  if (btnSaveCastDeviceName && adminNativeCastNameInput) {
    btnSaveCastDeviceName.addEventListener('click', async () => {
      const newName = adminNativeCastNameInput.value.trim();
      if (!newName) {
        alert('请输入有效的设备名称');
        return;
      }
      try {
        const res = await fetch('/api/cast/set_device_name', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_name: newName })
        });
        const ret = await res.json();
        if (ret.status === 'ok') {
          showToast(`🎯 投屏广播设备名称已成功更新为: ${newName}`);
        } else {
          alert('保存投屏设备名称失败: ' + ret.message);
        }
      } catch (err) {
        alert('保存异常: ' + err);
      }
    });
  }

  // 一键保存全局系统配置 (下次开机自动加载生效)
  const btnSaveAllSysConfig = document.getElementById('btn-save-all-sys-config');
  if (btnSaveAllSysConfig) {
    btnSaveAllSysConfig.addEventListener('click', async () => {
      try {
        const payload = {
          volume: volumeSlider ? parseInt(volumeSlider.value) : undefined,
          scale_mode: currentScaleMode,
          orientation: currentAdminOrientation,
          loop_mode: currentLoopMode,
          switch_policy: selectCyclePolicy ? selectCyclePolicy.value : undefined,
          cycle_duration: inputCycleDuration ? parseInt(inputCycleDuration.value) : undefined,
          touch_mode: currentTouchMode
        };
        const res = await fetch('/api/system/save_all_config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.status === 'ok') {
          showToast('💾 系统全局配置已成功保存！下次启动自动加载生效');
        } else {
          showToast('保存配置失败: ' + (data.message || '未知错误'), '错误');
        }
      } catch (err) {
        showToast('保存配置网络异常: ' + err, '错误');
      }
    });
  }

  // 轮询投屏中枢状态同步
  async function pollCastHubStatus() {
    try {
      const res = await fetch('/api/cast/info');
      const data = await res.json();
      if (!data) return;

      const isCastActive = data.is_active || (data.native_cast && data.native_cast.is_active);
      const senderIp = data.sender_ip || (data.native_cast && data.native_cast.sender_ip) || '';

      isCastActiveOrOpened = Boolean(isCastActive || data.waiting_qr);
      updateQuickCastBtnState();

      if (data.native_cast && data.native_cast.device_name && adminNativeCastNameInput && document.activeElement !== adminNativeCastNameInput) {
        adminNativeCastNameInput.value = data.native_cast.device_name;
      }

      if (castStatusIndicator) {
        if (isCastActive) {
          castStatusIndicator.textContent = `🟢 投屏中 (${senderIp || '已连接'})`;
          castStatusIndicator.style.color = '#34d399';
        } else if (data.waiting_qr) {
          castStatusIndicator.textContent = '📡 投屏看板已开';
          castStatusIndicator.style.color = '#00f0ff';
        } else {
          castStatusIndicator.textContent = '无线投屏';
          castStatusIndicator.style.color = '';
        }
      }

      if (adminCastStatusText) {
        if (isCastActive) {
          adminCastStatusText.textContent = `🟢 设备 [${senderIp || '未知'}] 正在投屏放映`;
          adminCastStatusText.style.color = '#34d399';
        } else if (data.waiting_qr) {
          adminCastStatusText.textContent = '大屏已展开无线投屏指引看板，等待连接...';
          adminCastStatusText.style.color = '#38bdf8';
        } else {
          adminCastStatusText.textContent = '无线投屏就绪：手机/电脑下拉菜单直连即可投屏';
          adminCastStatusText.style.color = '#94a3b8';
        }
      }
    } catch (e) {}
  }

  async function initAuth() {
    try {
      const res = await rawFetch('/api/auth/status', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('vc_token') || ''}` }
      });
      const data = await res.json();
      if (data.authenticated) {
        isAuthenticated = true;
        hideLoginModal();
        startAdminLoops();
      } else {
        showLoginModal();
      }
    } catch (e) {
      showLoginModal();
    }
  }

  // 立即初始化
  initAuth();


  // ===================== 开机、唤醒、待机、关机与重启系统按键绑定 =====================
  function updateOpsPowerButtonsUI() {
    const btnWake = document.getElementById('btn-action-wakeup');
    const btnSleep = document.getElementById('btn-action-sleep');
    const btnShut = document.getElementById('btn-action-shutdown');
    const btnReboot = document.getElementById('btn-action-reboot');
    const schedBootGroup = document.getElementById('sched-boot-setting-group');
    const schedBootTimeGroup = document.getElementById('sched-boot-time-group');
    const schedPanelBootGroup = document.getElementById('panel-sched-boot-group');

    if (isPlatformAndroid) {
      // 安卓 APK 专属：唤醒 (关闭黑场播放待机) 与 待机 (开启黑场停止放映)，没有重启与关机
      if (btnWake) btnWake.style.display = 'inline-block';
      if (btnSleep) btnSleep.style.display = 'inline-block';
      if (btnShut) btnShut.style.display = 'none';
      if (btnReboot) btnReboot.style.display = 'none';
      if (schedBootGroup) schedBootGroup.style.display = 'flex';
      if (schedBootTimeGroup) schedBootTimeGroup.style.display = 'flex';
      if (schedPanelBootGroup) schedPanelBootGroup.style.display = 'block';
    } else {
      // Windows EXE 专属：关机 (系统底层安全关机) 与 重启 (系统底层安全重启)，没有开机
      if (btnWake) btnWake.style.display = 'none';
      if (btnSleep) btnSleep.style.display = 'none';
      if (btnShut) btnShut.style.display = 'inline-block';
      if (btnReboot) btnReboot.style.display = 'inline-block';
      if (schedBootGroup) schedBootGroup.style.display = 'none';
      if (schedBootTimeGroup) schedBootTimeGroup.style.display = 'none';
      if (schedPanelBootGroup) schedPanelBootGroup.style.display = 'none';
    }
  }

  // APK 唤醒按键 (解除黑场，播放待机素材)
  const btnActionWakeup = document.getElementById('btn-action-wakeup');
  if (btnActionWakeup) {
    btnActionWakeup.addEventListener('click', async () => {
      showToast('☀️ 正在唤醒大屏...', '大屏唤醒');
      try {
        await fetch('/api/system/wakeup', { method: 'POST' });
        showToast('✅ 大屏已唤醒：解除黑场并恢复播放待机素材', '大屏唤醒');
      } catch (e) {
        showToast('⚠️ 唤醒异常: ' + e, '唤醒提示');
      }
    });
  }

  // APK 待机按键 (停止放映，开启黑场)
  const btnActionSleep = document.getElementById('btn-action-sleep');
  if (btnActionSleep) {
    btnActionSleep.addEventListener('click', async () => {
      showToast('🌙 正在将大屏切入待机模式...', '大屏待机');
      try {
        await fetch('/api/system/sleep', { method: 'POST' });
        showToast('✅ 大屏已进入待机：停止放映并开启黑场', '大屏待机');
      } catch (e) {
        showToast('⚠️ 待机异常: ' + e, '待机提示');
      }
    });
  }

  // 兼容开机旧按钮 (已彻底删除功能)
  const btnActionPowerOn = document.getElementById('btn-action-poweron');
  if (btnActionPowerOn) {
    btnActionPowerOn.addEventListener('click', () => {});
  }

  // EXE 关机按键 (调用系统底层安全关机)
  const btnActionShutdown = document.getElementById('btn-action-shutdown');
  if (btnActionShutdown) {
    btnActionShutdown.addEventListener('click', async () => {
      if (confirm('确定要执行大屏主机关机吗？\n系统将执行底层安全关机命令切断电源。')) {
        showToast('🛑 正在执行系统关机指令...', '主机关机');
        await fetch('/api/system/shutdown', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ delay: 1 }) }).catch(() => {});
      }
    });
  }

  // EXE 重启按键 (调用系统底层安全重启)
  const btnActionReboot = document.getElementById('btn-action-reboot');
  if (btnActionReboot) {
    btnActionReboot.addEventListener('click', async () => {
      if (confirm('确定要立即重启大屏主机操作系统吗？\n系统将执行底层安全重启命令并在数秒内自动重启。')) {
        showToast('🔄 正在执行系统重启指令...', '系统重启');
        await fetch('/api/system/reboot', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ delay: 1 }) }).catch(() => {});
      }
    });
  }

  // 默认根据当前环境初始化按键可见性
  updateOpsPowerButtonsUI();



  // ===================== 7.2 展馆多媒体与物联设备同步时间轴 (Timeline Sync Studio) =====================
  let timelineConfig = {
    master: {
      type: 'video',
      name: '展厅默认开场片.mp4',
      url: '',
      duration: 60
    },
    tracks: []
  };

  let tlIsPlaying = false;
  let tlCurrentTime = 0.0;
  let tlIsLoop = true;
  let tlTimerAnimFrame = null;
  let tlLastTimestamp = 0;
  let tlTriggeredNodeIds = new Set();
  let tlFilterMediaType = 'all';

  // DOM 元素引用
  const tlStatusBadge = document.getElementById('timeline-status-badge');
  const btnTlPlay = document.getElementById('btn-timeline-play');
  const btnTlStop = document.getElementById('btn-timeline-stop');
  const btnTlLoop = document.getElementById('btn-timeline-loop');
  const btnTlAddTrack = document.getElementById('btn-timeline-add-track');
  const btnTlSyncScreen = document.getElementById('btn-timeline-sync-screen');
  const btnTlSave = document.getElementById('btn-timeline-save');
  const tlTimeCurEl = document.getElementById('timeline-time-cur');
  const tlTimeTotalEl = document.getElementById('timeline-time-total');
  const tlMasterTypeEl = document.getElementById('timeline-master-type');
  const tlMasterNameEl = document.getElementById('timeline-master-name');
  const btnTlPickMedia = document.getElementById('btn-timeline-pick-media');
  const tlMasterDurationInput = document.getElementById('timeline-master-duration');
  const tlRulerLane = document.getElementById('timeline-ruler-lane');
  const rulerTicksEl = document.getElementById('ruler-ticks');
  const tlPlayhead = document.getElementById('timeline-playhead');
  const playheadTag = document.getElementById('playhead-tag');
  const masterFillBar = document.getElementById('master-fill-bar');
  const masterLaneTitle = document.getElementById('master-lane-title');
  const tlMasterLane = document.getElementById('timeline-master-lane');
  const tlSyncTracksContainer = document.getElementById('timeline-sync-tracks-container');
  const tlEventBar = document.getElementById('timeline-event-bar');
  const tlLastEventEl = document.getElementById('timeline-last-event');

  // 时间轴工作室弹窗及相关引用
  const modalTlStudio = document.getElementById('modal-timeline-studio');
  const btnOpenTlStudio = document.getElementById('btn-open-timeline-studio');
  const btnCloseTlStudio = document.getElementById('btn-close-tl-studio');
  const btnStudioPlay = document.getElementById('btn-studio-play');
  const btnStudioStop = document.getElementById('btn-studio-stop');
  const btnStudioSyncScreen = document.getElementById('btn-studio-sync-screen');
  const btnGenerateStandbyProg = document.getElementById('btn-generate-standby-prog');
  const btnModalGenerateStandby = document.getElementById('btn-modal-generate-standby');
  const progTracksSummaryEl = document.getElementById('prog-tracks-summary');
  const studioTimeCurEl = document.getElementById('studio-time-cur');
  const studioTimeTotalEl = document.getElementById('studio-time-total');
  const studioMasterTypeEl = document.getElementById('studio-master-type');
  const studioMasterNameEl = document.getElementById('studio-master-name');

  // 模态框引用
  const modalTlNode = document.getElementById('modal-timeline-node');
  const btnCloseTlNodeModal = document.getElementById('btn-close-tl-node-modal');
  const btnCancelTlNode = document.getElementById('btn-cancel-tl-node');
  const btnDelTlNode = document.getElementById('btn-del-tl-node');
  const btnTestTlNode = document.getElementById('btn-test-tl-node');
  const formTlNode = document.getElementById('form-tl-node');
  const tlNodeTrackIdInput = document.getElementById('tl-node-track-id');
  const tlNodeIdInput = document.getElementById('tl-node-id');
  const tlNodeTimeInput = document.getElementById('tl-node-time');
  const tlNodeTimePreview = document.getElementById('tl-node-time-preview');
  const tlNodeDeviceSelect = document.getElementById('tl-node-device');
  const tlNodeActionSelect = document.getElementById('tl-node-action');
  const groupTlNodeCustom = document.getElementById('group-tl-node-custom');
  const tlNodeCustomCmdInput = document.getElementById('tl-node-custom-cmd');
  const tlNodeLabelInput = document.getElementById('tl-node-label');

  // 媒体模态框与素材时长编辑引用
  const modalTlMedia = document.getElementById('modal-timeline-media');
  const btnCloseTlMediaModal = document.getElementById('btn-close-tl-media-modal');
  const tlMediaPickerGrid = document.getElementById('tl-media-picker-grid');
  const tlCustomMediaUrl = document.getElementById('tl-custom-media-url');
  const tlCustomMediaType = document.getElementById('tl-custom-media-type');
  const btnApplyCustomMedia = document.getElementById('btn-apply-custom-media');

  // 素材时长编辑模态框引用
  const modalClipEdit = document.getElementById('modal-timeline-clip-edit');
  const btnCloseClipEdit = document.getElementById('btn-close-clip-edit');
  const btnCancelClipEdit = document.getElementById('btn-cancel-clip-edit');
  const btnSaveClipEdit = document.getElementById('btn-save-clip-edit');
  const btnDeleteClip = document.getElementById('btn-delete-clip');
  const clipEditTrackIdInput = document.getElementById('clip-edit-track-id');
  const clipEditClipIdInput = document.getElementById('clip-edit-clip-id');
  const clipEditNameEl = document.getElementById('clip-edit-name');
  const clipEditStartTimeInput = document.getElementById('clip-edit-start-time');
  const clipEditDurationInput = document.getElementById('clip-edit-duration');

  const masterClipsContainer = document.getElementById('master-clips-container');
  const btnMasterAddClip = document.getElementById('btn-master-add-clip');

  let tlMediaPickerTarget = { type: 'master' }; // 'master' 或 { type: 'track', trackId: 'xxx' }

  function formatTimecode(seconds) {
    const s = Math.max(0, seconds || 0);
    const mins = Math.floor(s / 60);
    const secs = (s % 60).toFixed(1);
    const mStr = String(mins).padStart(2, '0');
    const sStr = (secs < 10 ? '0' : '') + secs;
    return `${mStr}:${sStr}`;
  }

  // 保证主时间轴多素材数据结构兼容升级
  function ensureTimelineClipsStructure() {
    if (!timelineConfig.master_clips) {
      timelineConfig.master_clips = [];
      const m = timelineConfig.master;
      if (m && (m.name || m.url)) {
        timelineConfig.master_clips.push({
          id: 'clip_master_default',
          name: m.name || '默认开场媒体',
          url: m.url || '',
          type: m.type || 'video',
          start_time: 0,
          duration: Math.max(1, parseFloat(m.duration) || 60)
        });
      }
    }
    if (!timelineConfig.tracks) timelineConfig.tracks = [];
    timelineConfig.tracks.forEach(tr => {
      if (!tr.clips) tr.clips = [];
      if (!tr.nodes) tr.nodes = [];
    });
  }

  // 计算时间轴总时长 (自适应素材最大结束时间，可手动调大)
  function getTlTotalDuration() {
    ensureTimelineClipsStructure();
    let maxEnd = 0;
    (timelineConfig.master_clips || []).forEach(c => {
      const end = (parseFloat(c.start_time) || 0) + (parseFloat(c.duration) || 15);
      if (end > maxEnd) maxEnd = end;
    });
    (timelineConfig.tracks || []).forEach(tr => {
      (tr.clips || []).forEach(c => {
        const end = (parseFloat(c.start_time) || 0) + (parseFloat(c.duration) || 15);
        if (end > maxEnd) maxEnd = end;
      });
      (tr.nodes || []).forEach(n => {
        const t = parseFloat(n.time) || 0;
        if (t > maxEnd) maxEnd = t;
      });
    });

    const manualVal = parseFloat(tlMasterDurationInput ? tlMasterDurationInput.value : (timelineConfig.master?.duration || 60));
    return Math.max(30, Math.max(maxEnd, manualVal || 60));
  }

  // 渲染走带游标与数显 (主卡片与工作室内同步更新)
  function updateTimelinePlayheadUI() {
    const total = getTlTotalDuration();
    const cur = Math.min(total, Math.max(0, tlCurrentTime));
    const pct = (cur / total) * 100;

    if (tlPlayhead) tlPlayhead.style.left = `${pct}%`;
    if (playheadTag) playheadTag.textContent = formatTimecode(cur);
    if (masterFillBar) masterFillBar.style.width = `${pct}%`;
    const curCode = formatTimecode(cur);
    const totalCode = formatTimecode(total);
    if (tlTimeCurEl) tlTimeCurEl.textContent = curCode;
    if (tlTimeTotalEl) tlTimeTotalEl.textContent = totalCode;
    if (studioTimeCurEl) studioTimeCurEl.textContent = curCode;
    if (studioTimeTotalEl) studioTimeTotalEl.textContent = totalCode;
  }

  // 渲染刻度尺
  function renderTimelineRuler() {
    if (!rulerTicksEl) return;
    rulerTicksEl.innerHTML = '';
    const total = getTlTotalDuration();

    let step = 5;
    if (total <= 30) step = 2;
    else if (total <= 60) step = 5;
    else if (total <= 180) step = 10;
    else if (total <= 600) step = 30;
    else step = 60;

    for (let sec = 0; sec <= total; sec += step) {
      const pct = (sec / total) * 100;
      const tick = document.createElement('div');
      tick.className = 'ruler-tick' + (sec % (step * 2) === 0 ? ' major' : '');
      tick.style.left = `${pct}%`;
      tick.textContent = formatTimecode(sec);
      rulerTicksEl.appendChild(tick);
    }
  }

  // 渲染主时间轴多素材片段 (支持多个素材、自定义时长、拖拽重排)
  function renderTimelineMaster() {
    ensureTimelineClipsStructure();
    const total = getTlTotalDuration();
    const clips = timelineConfig.master_clips || [];

    // 状态统计显示
    if (studioMasterNameEl) {
      studioMasterNameEl.textContent = clips.length > 0 ? `已编排 ${clips.length} 个素材片段` : '未载入主素材 (点击增添)';
    }
    if (tlMasterNameEl) {
      tlMasterNameEl.textContent = clips.length > 0 ? `主轴 ${clips.length} 个素材片段 (${formatTimecode(total)})` : '未载入主素材 (点击选择)';
    }
    if (tlMasterDurationInput) {
      tlMasterDurationInput.value = Math.round(total);
    }

    // 渲染车道内的素材剪辑块
    const container = masterClipsContainer || tlMasterLane;
    if (container) {
      container.innerHTML = '';

      clips.sort((a, b) => (a.start_time || 0) - (b.start_time || 0));

      clips.forEach(clip => {
        const clipEl = document.createElement('div');
        const typeClass = `type-${clip.type || 'video'}`;
        clipEl.className = `tl-media-clip ${typeClass}`;
        clipEl.dataset.clipId = clip.id;

        const start = Math.max(0, parseFloat(clip.start_time) || 0);
        const duration = Math.max(0.5, parseFloat(clip.duration) || 15);
        const leftPct = (start / total) * 100;
        const widthPct = Math.max(2, (duration / total) * 100);

        clipEl.style.left = `${leftPct}%`;
        clipEl.style.width = `${widthPct}%`;

        const typeIcons = { video: '🎬', audio: '🎵', image: '🖼️', doc: '📄' };
        const icon = typeIcons[clip.type] || '📺';

        clipEl.innerHTML = `
          <div class="clip-info" title="${escapeHtml(clip.name)} [${formatTimecode(start)} - ${formatTimecode(start + duration)}]">
            <span>${icon}</span>
            <span class="clip-name">${escapeHtml(clip.name)}</span>
            <span class="clip-duration-tag">${duration}s</span>
          </div>
          <div class="clip-actions">
            <button type="button" class="btn-clip-tool btn-edit-clip" title="自定义该素材时长与时间点">⏱️</button>
            <button type="button" class="btn-clip-tool btn-del-clip" title="从主轴移除该素材">🗑️</button>
          </div>
        `;

        // 点击打开时长与时间点自定义模态框
        clipEl.querySelector('.btn-edit-clip').addEventListener('click', (e) => {
          e.stopPropagation();
          openClipEditModal('master', clip);
        });

        clipEl.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          openClipEditModal('master', clip);
        });

        // 删除素材
        clipEl.querySelector('.btn-del-clip').addEventListener('click', (e) => {
          e.stopPropagation();
          if (confirm(`确定要从主时间轴中移除素材 [${clip.name}] 吗？`)) {
            timelineConfig.master_clips = timelineConfig.master_clips.filter(c => c.id !== clip.id);
            renderTimelineMaster();
            renderTimelineTracks();
            showToast('已移除主轴素材');
          }
        });

        // 核心功能：支持鼠标拖拽改变素材起始时间
        clipEl.addEventListener('mousedown', (e) => {
          if (e.button !== 0 || e.target.closest('.btn-clip-tool')) return;
          e.stopPropagation();
          const startX = e.clientX;
          const origStart = clip.start_time || 0;
          const laneRect = (masterClipsContainer || tlMasterLane).getBoundingClientRect();

          function onMouseMove(moveEvent) {
            const dx = moveEvent.clientX - startX;
            const dt = (dx / laneRect.width) * total;
            let newStart = Math.max(0, Math.min(total - clip.duration, origStart + dt));
            newStart = parseFloat(newStart.toFixed(1));
            clip.start_time = newStart;
            const newLeftPct = (newStart / total) * 100;
            clipEl.style.left = `${newLeftPct}%`;
          }

          function onMouseUp() {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            clips.sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
            renderTimelineMaster();
            renderTimelineTracks();
          }

          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
        });

        container.appendChild(clipEl);
      });
    }

    renderTimelineRuler();
    updateTimelinePlayheadUI();
  }

  // 渲染下方所有同步时间轴轨道 (支持添加命令节点与添加素材片段)
  function renderTimelineTracks() {
    if (!tlSyncTracksContainer) return;
    tlSyncTracksContainer.innerHTML = '';
    ensureTimelineClipsStructure();
    const total = getTlTotalDuration();

    (timelineConfig.tracks || []).forEach(track => {
      const row = document.createElement('div');
      row.className = 'timeline-track-row';
      row.dataset.trackId = track.id;

      // 轨道头部
      const headerCol = document.createElement('div');
      headerCol.className = 'timeline-track-header-col';
      headerCol.innerHTML = `
        <div class="track-header-title">
          <span class="track-icon">🎛️</span>
          <span class="track-name-text" title="点击改名">${escapeHtml(track.name)}</span>
        </div>
        <div class="track-header-sub">${(track.clips || []).length} 个素材 · ${(track.nodes || []).length} 个中控命令</div>
        <div class="track-header-actions" style="display:flex; gap:4px; flex-wrap:wrap; margin-top:4px;">
          <button type="button" class="btn-track-tool add-clip" style="background:rgba(99,102,241,0.2); border:1px solid rgba(99,102,241,0.5); color:#a5b4fc;" title="向此轨道增加多媒体素材">📁 加素材</button>
          <button type="button" class="btn-track-tool add-cmd" title="在此轨道添加设备控制命令">➕ 加命令</button>
          <button type="button" class="btn-track-tool delete" title="删除整条时间轴轨道">🗑️</button>
        </div>
      `;

      // 点击轨道名改名
      headerCol.querySelector('.track-name-text').addEventListener('click', () => {
        const newName = prompt('请输入该同步时间轴名称:', track.name);
        if (newName && newName.trim()) {
          track.name = newName.trim();
          renderTimelineTracks();
        }
      });

      // 增添多媒体素材
      headerCol.querySelector('.add-clip').addEventListener('click', () => {
        openTimelineMediaModal({ type: 'track', trackId: track.id });
      });

      // 添加命令节点
      headerCol.querySelector('.add-cmd').addEventListener('click', () => {
        openTimelineNodeModal(track.id, null);
      });

      // 删除整条轨道
      headerCol.querySelector('.delete').addEventListener('click', () => {
        if (confirm(`确定要删除 [${track.name}] 同步时间轴吗？`)) {
          timelineConfig.tracks = timelineConfig.tracks.filter(t => t.id !== track.id);
          renderTimelineTracks();
        }
      });

      // 轨道时间线车道
      const lane = document.createElement('div');
      lane.className = 'timeline-track-lane sync-track-lane';
      lane.dataset.trackId = track.id;

      // 双击车道空白处直接在该时间添加节点
      lane.addEventListener('dblclick', (e) => {
        if (e.target.closest('.tl-keyframe-node') || e.target.closest('.tl-media-clip')) return;
        const rect = lane.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, clickX / rect.width));
        const clickTime = parseFloat((pct * total).toFixed(1));
        openTimelineNodeModal(track.id, null, clickTime);
      });

      // A. 渲染该轨道上的多媒体素材片段
      (track.clips || []).forEach(clip => {
        const clipEl = document.createElement('div');
        const typeClass = `type-${clip.type || 'video'}`;
        clipEl.className = `tl-media-clip ${typeClass}`;
        clipEl.dataset.clipId = clip.id;

        const start = Math.max(0, parseFloat(clip.start_time) || 0);
        const duration = Math.max(0.5, parseFloat(clip.duration) || 15);
        const leftPct = (start / total) * 100;
        const widthPct = Math.max(2, (duration / total) * 100);

        clipEl.style.left = `${leftPct}%`;
        clipEl.style.width = `${widthPct}%`;

        const typeIcons = { video: '🎬', audio: '🎵', image: '🖼️', doc: '📄' };
        const icon = typeIcons[clip.type] || '📺';

        clipEl.innerHTML = `
          <div class="clip-info" title="${escapeHtml(clip.name)} [${formatTimecode(start)} - ${formatTimecode(start + duration)}]">
            <span>${icon}</span>
            <span class="clip-name">${escapeHtml(clip.name)}</span>
            <span class="clip-duration-tag">${duration}s</span>
          </div>
          <div class="clip-actions">
            <button type="button" class="btn-clip-tool btn-edit-clip" title="自定义该素材时长与时间点">⏱️</button>
            <button type="button" class="btn-clip-tool btn-del-clip" title="移除该素材">🗑️</button>
          </div>
        `;

        clipEl.querySelector('.btn-edit-clip').addEventListener('click', (e) => {
          e.stopPropagation();
          openClipEditModal(track.id, clip);
        });

        clipEl.querySelector('.btn-del-clip').addEventListener('click', (e) => {
          e.stopPropagation();
          if (confirm(`确定要从轨道 [${track.name}] 中移除素材 [${clip.name}] 吗？`)) {
            track.clips = (track.clips || []).filter(c => c.id !== clip.id);
            renderTimelineTracks();
            showToast('已移除轨道素材');
          }
        });

        // 拖动副轨素材片段
        clipEl.addEventListener('mousedown', (e) => {
          if (e.button !== 0 || e.target.closest('.btn-clip-tool')) return;
          e.stopPropagation();
          const startX = e.clientX;
          const origStart = clip.start_time || 0;
          const laneRect = lane.getBoundingClientRect();

          function onMouseMove(moveEvent) {
            const dx = moveEvent.clientX - startX;
            const dt = (dx / laneRect.width) * total;
            let newStart = Math.max(0, Math.min(total - clip.duration, origStart + dt));
            newStart = parseFloat(newStart.toFixed(1));
            clip.start_time = newStart;
            const newLeftPct = (newStart / total) * 100;
            clipEl.style.left = `${newLeftPct}%`;
          }

          function onMouseUp() {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            track.clips.sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
            renderTimelineTracks();
          }

          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
        });

        lane.appendChild(clipEl);
      });

      // B. 渲染该轨道上的所有中控关键帧命令节点
      (track.nodes || []).forEach(node => {
        const nodeEl = document.createElement('div');
        nodeEl.className = 'tl-keyframe-node';
        nodeEl.id = `tl-node-${node.id}`;
        nodeEl.dataset.nodeId = node.id;
        nodeEl.dataset.trackId = track.id;

        const leftPct = (Math.max(0, Math.min(total, node.time)) / total) * 100;
        nodeEl.style.left = `${leftPct}%`;

        // 匹配设备名称
        const dev = (devicesCache || []).find(d => d.id === node.device_id);
        const devName = dev ? dev.name : (node.device_id || '设备');
        const actBadgeClass = node.action === 'on' ? 'on' : (node.action === 'off' ? 'off' : 'custom');
        const actBadgeText = node.action === 'on' ? '⚡ON' : (node.action === 'off' ? '⚪OFF' : '🛠️指令');

        nodeEl.innerHTML = `
          <div class="keyframe-pill ${actBadgeClass}" title="${escapeHtml(node.label || devName)} - ${formatTimecode(node.time)} (点击编辑，可拖拽)">
            <span class="keyframe-time">${formatTimecode(node.time)}</span>
            <span class="keyframe-name">${escapeHtml(devName)}</span>
            <span class="keyframe-action-badge ${actBadgeClass}">${actBadgeText}</span>
          </div>
        `;

        // 点击打开编辑模态框
        nodeEl.addEventListener('click', (e) => {
          e.stopPropagation();
          openTimelineNodeModal(track.id, node);
        });

        // 支持拖拽调整时间点
        nodeEl.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          let startX = e.clientX;
          let originalTime = node.time;
          const laneRect = lane.getBoundingClientRect();

          function onMouseMove(moveEvent) {
            const dx = moveEvent.clientX - startX;
            const dt = (dx / laneRect.width) * total;
            let newTime = Math.max(0, Math.min(total, originalTime + dt));
            newTime = parseFloat(newTime.toFixed(1));
            node.time = newTime;
            const newPct = (newTime / total) * 100;
            nodeEl.style.left = `${newPct}%`;
            const timeTag = nodeEl.querySelector('.keyframe-time');
            if (timeTag) timeTag.textContent = formatTimecode(newTime);
          }

          function onMouseUp() {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            track.nodes.sort((a, b) => a.time - b.time);
            renderTimelineTracks();
          }

          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
        });

        lane.appendChild(nodeEl);
      });

      row.appendChild(headerCol);
      row.appendChild(lane);
      tlSyncTracksContainer.appendChild(row);
    });

    let totalNodes = 0;
    let totalClips = 0;
    (timelineConfig.tracks || []).forEach(tr => {
      totalNodes += (tr.nodes || []).length;
      totalClips += (tr.clips || []).length;
    });
    if (progTracksSummaryEl) {
      progTracksSummaryEl.textContent = `${(timelineConfig.tracks || []).length} 条同步轨道 · ${totalClips} 个素材 · ${totalNodes} 个命令节点`;
    }
  }

  // 标尺与主轴车道点击与拖拽平滑走带 (Playhead Scrubbing)
  function handleTimelineSeekClick(e, container) {
    if (e.target.closest('.timeline-track-header-col') || e.target.closest('.tl-media-clip') || e.target.closest('.tl-keyframe-node')) return;
    const rect = container.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));
    const total = getTlTotalDuration();
    tlCurrentTime = parseFloat((pct * total).toFixed(1));
    // 跳转后重置已触发记录中大于等于当前时间的节点
    tlTriggeredNodeIds.clear();
    (timelineConfig.tracks || []).forEach(tr => {
      (tr.nodes || []).forEach(n => {
        if (n.time < tlCurrentTime) {
          tlTriggeredNodeIds.add(n.id);
        }
      });
    });
    updateTimelinePlayheadUI();
  }

  // 支持标尺上按住鼠标平滑拖拽时间指针 (Scrub)
  if (tlRulerLane) {
    tlRulerLane.addEventListener('click', (e) => handleTimelineSeekClick(e, tlRulerLane));
    tlRulerLane.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      handleTimelineSeekClick(e, tlRulerLane);
      function onScrubMove(ev) { handleTimelineSeekClick(ev, tlRulerLane); }
      function onScrubUp() {
        window.removeEventListener('mousemove', onScrubMove);
        window.removeEventListener('mouseup', onScrubUp);
      }
      window.addEventListener('mousemove', onScrubMove);
      window.addEventListener('mouseup', onScrubUp);
    });
  }
  if (tlMasterLane) {
    tlMasterLane.addEventListener('click', (e) => handleTimelineSeekClick(e, tlMasterLane));
  }

  // 自定义总时长改变
  if (tlMasterDurationInput) {
    tlMasterDurationInput.addEventListener('change', () => {
      const val = Math.max(1, parseFloat(tlMasterDurationInput.value) || 60);
      if (!timelineConfig.master) timelineConfig.master = {};
      timelineConfig.master.duration = val;
      renderTimelineRuler();
      renderTimelineMaster();
      renderTimelineTracks();
      updateTimelinePlayheadUI();
    });
  }

  // 素材时长与起始时间自定义模态框交互
  function openClipEditModal(trackId, clip) {
    if (!modalClipEdit) return;
    if (clipEditTrackIdInput) clipEditTrackIdInput.value = trackId;
    if (clipEditClipIdInput) clipEditClipIdInput.value = clip.id;
    if (clipEditNameEl) clipEditNameEl.textContent = `${clip.name} (${(clip.type || 'video').toUpperCase()})`;
    if (clipEditStartTimeInput) clipEditStartTimeInput.value = clip.start_time || 0;
    if (clipEditDurationInput) clipEditDurationInput.value = clip.duration || 15;
    modalClipEdit.classList.remove('hidden');
    modalClipEdit.style.display = 'flex';
  }

  function closeClipEditModal() {
    if (modalClipEdit) {
      modalClipEdit.classList.add('hidden');
      modalClipEdit.style.display = 'none';
    }
  }

  if (btnCloseClipEdit) btnCloseClipEdit.addEventListener('click', closeClipEditModal);
  if (btnCancelClipEdit) btnCancelClipEdit.addEventListener('click', closeClipEditModal);

  if (btnSaveClipEdit) {
    btnSaveClipEdit.addEventListener('click', () => {
      const trackId = clipEditTrackIdInput.value;
      const clipId = clipEditClipIdInput.value;
      const newStart = Math.max(0, parseFloat(clipEditStartTimeInput.value) || 0);
      const newDuration = Math.max(0.5, parseFloat(clipEditDurationInput.value) || 15);

      if (trackId === 'master') {
        const c = (timelineConfig.master_clips || []).find(it => it.id === clipId);
        if (c) {
          c.start_time = newStart;
          c.duration = newDuration;
        }
        renderTimelineMaster();
      } else {
        const tr = (timelineConfig.tracks || []).find(it => it.id === trackId);
        if (tr) {
          const c = (tr.clips || []).find(it => it.id === clipId);
          if (c) {
            c.start_time = newStart;
            c.duration = newDuration;
          }
        }
        renderTimelineTracks();
      }
      closeClipEditModal();
      showToast('素材时长与时间点已更新');
    });
  }

  if (btnDeleteClip) {
    btnDeleteClip.addEventListener('click', () => {
      const trackId = clipEditTrackIdInput.value;
      const clipId = clipEditClipIdInput.value;
      if (confirm('确定要删除该素材片段吗？')) {
        if (trackId === 'master') {
          timelineConfig.master_clips = (timelineConfig.master_clips || []).filter(it => it.id !== clipId);
          renderTimelineMaster();
        } else {
          const tr = (timelineConfig.tracks || []).find(it => it.id === trackId);
          if (tr) {
            tr.clips = (tr.clips || []).filter(it => it.id !== clipId);
          }
          renderTimelineTracks();
        }
        closeClipEditModal();
        showToast('素材已删除');
      }
    });
  }

  if (btnMasterAddClip) {
    btnMasterAddClip.addEventListener('click', () => {
      openTimelineMediaModal({ type: 'master' });
    });
  }

  // 触发受控设备动作
  async function triggerTimelineNode(node) {
    if (!node) return;
    const dev = (devicesCache || []).find(d => d.id === node.device_id);
    const devName = dev ? dev.name : (node.device_id || '设备');
    const actName = node.action === 'on' ? '开启(ON)' : (node.action === 'off' ? '关断(OFF)' : '自定义指令');

    // 节点脉冲动画
    const nodeEl = document.getElementById(`tl-node-${node.id}`);
    if (nodeEl) {
      nodeEl.classList.add('pulsing');
      setTimeout(() => nodeEl.classList.remove('pulsing'), 700);
    }

    // 更新底部日志条
    if (tlLastEventEl) {
      tlLastEventEl.textContent = `[${formatTimecode(node.time)}] ⚡ 已联动触发受控设备 [${devName}] -> ${actName}`;
    }
    if (tlEventBar) {
      tlEventBar.classList.add('active');
      setTimeout(() => tlEventBar.classList.remove('active'), 1500);
    }

    try {
      await fetch('/api/iot/devices/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: node.device_id,
          cmd_type: node.action,
          custom_cmd: node.custom_cmd || undefined
        })
      });
    } catch (e) {}
  }

  const tlTriggeredClipIds = new Set();

  async function triggerTimelineClip(clip) {
    if (!clip || !clip.name) return;
    try {
      await fetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'play_media',
          media: clip.name,
          url: clip.url || `/media/视频/${clip.name}`,
          type: clip.type || 'video'
        })
      });
      if (tlLastEventEl) {
        tlLastEventEl.textContent = `[${formatTimecode(clip.start_time)}] 🎬 主轴自动切换放映: ${clip.name} (时长: ${clip.duration}s)`;
      }
    } catch (e) {}
  }

  // 走带主循环 (毫秒级高精度轮询：主轴多素材与各副轨命令节点)
  function timelineTick(now) {
    if (!tlIsPlaying) return;
    if (!tlLastTimestamp) tlLastTimestamp = now;
    const dt = (now - tlLastTimestamp) / 1000.0;
    tlLastTimestamp = now;

    const total = getTlTotalDuration();
    tlCurrentTime += dt;

    // 检查并联动切换主时间轴多素材
    (timelineConfig.master_clips || []).forEach(clip => {
      const st = clip.start_time || 0;
      if (st <= tlCurrentTime && tlCurrentTime < st + (clip.duration || 15) && !tlTriggeredClipIds.has(clip.id)) {
        tlTriggeredClipIds.add(clip.id);
        triggerTimelineClip(clip);
      }
    });

    // 检查并触发物联节点
    (timelineConfig.tracks || []).forEach(track => {
      (track.nodes || []).forEach(node => {
        if (node.time <= tlCurrentTime && !tlTriggeredNodeIds.has(node.id)) {
          tlTriggeredNodeIds.add(node.id);
          triggerTimelineNode(node);
        }
      });
    });

    if (tlCurrentTime >= total) {
      if (tlIsLoop) {
        tlCurrentTime = 0.0;
        tlTriggeredNodeIds.clear();
        tlTriggeredClipIds.clear();
      } else {
        tlCurrentTime = total;
        stopTimeline(false);
      }
    }

    updateTimelinePlayheadUI();
    if (tlIsPlaying) {
      tlTimerAnimFrame = requestAnimationFrame(timelineTick);
    }
  }

  function playTimeline() {
    if (tlIsPlaying) {
      // 暂停
      tlIsPlaying = false;
      if (tlTimerAnimFrame) cancelAnimationFrame(tlTimerAnimFrame);
      if (btnTlPlay) {
        btnTlPlay.textContent = '▶ 播放';
        btnTlPlay.classList.remove('active');
      }
      if (tlStatusBadge) {
        tlStatusBadge.textContent = '暂停';
        tlStatusBadge.classList.remove('playing');
      }
    } else {
      // 开始播放
      const total = getTlTotalDuration();
      if (tlCurrentTime >= total) {
        tlCurrentTime = 0.0;
        tlTriggeredNodeIds.clear();
        tlTriggeredClipIds.clear();
      }
      tlIsPlaying = true;
      tlLastTimestamp = performance.now();
      if (btnTlPlay) {
        btnTlPlay.textContent = '⏸ 暂停';
        btnTlPlay.classList.add('active');
      }
      if (tlStatusBadge) {
        tlStatusBadge.textContent = '正在播放';
        tlStatusBadge.classList.add('playing');
      }
      tlTimerAnimFrame = requestAnimationFrame(timelineTick);
    }
  }

  function stopTimeline(resetTime = true) {
    tlIsPlaying = false;
    if (tlTimerAnimFrame) cancelAnimationFrame(tlTimerAnimFrame);
    if (resetTime) tlCurrentTime = 0.0;
    tlTriggeredNodeIds.clear();
    tlTriggeredClipIds.clear();
    if (btnTlPlay) {
      btnTlPlay.textContent = '▶ 播放';
      btnTlPlay.classList.remove('active');
    }
    if (tlStatusBadge) {
      tlStatusBadge.textContent = '就绪';
      tlStatusBadge.classList.remove('playing');
    }
    updateTimelinePlayheadUI();
  }

  if (btnTlPlay) btnTlPlay.addEventListener('click', playTimeline);
  if (btnTlStop) btnTlStop.addEventListener('click', () => stopTimeline(true));

  if (btnTlLoop) {
    btnTlLoop.addEventListener('click', () => {
      tlIsLoop = !tlIsLoop;
      if (tlIsLoop) {
        btnTlLoop.classList.add('active');
        btnTlLoop.textContent = '🔁 循环: 开';
      } else {
        btnTlLoop.classList.remove('active');
        btnTlLoop.textContent = '🔁 循环: 关';
      }
    });
  }

  // 增加新同步时间轴 (直接生成并渲染，彻底防止系统 prompt 弹窗被拦截)
  function addNewSyncTrack() {
    if (!timelineConfig.tracks) timelineConfig.tracks = [];
    const trackIdx = timelineConfig.tracks.length + 1;
    const defaultName = `轨道 ${trackIdx}: 展馆受控设备轨`;
    const newTrack = {
      id: `track_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      name: defaultName,
      clips: [],
      nodes: []
    };
    timelineConfig.tracks.push(newTrack);
    renderTimelineTracks();
    showToast(`✅ 已成功增加同步时间轴 [${defaultName}]！`);
    if (tlLastEventEl) {
      tlLastEventEl.textContent = `已成功增加时间轴: ${defaultName} (可加素材、可双击添加设备命令节点，点击标题可改名)`;
    }
  }

  if (btnTlAddTrack) btnTlAddTrack.addEventListener('click', addNewSyncTrack);

  // 新增：增添中控命令按钮交互
  const btnTlAddCmd = document.getElementById('btn-timeline-add-cmd');
  if (btnTlAddCmd) {
    btnTlAddCmd.addEventListener('click', () => {
      if (!timelineConfig.tracks || timelineConfig.tracks.length === 0) {
        addNewSyncTrack();
      }
      const firstTrack = timelineConfig.tracks[0];
      if (firstTrack) {
        openTimelineNodeModal(firstTrack.id, null, parseFloat(tlCurrentTime.toFixed(1)));
      }
    });
  }

  // 联动大屏投映
  if (btnTlSyncScreen) {
    btnTlSyncScreen.addEventListener('click', async () => {
      ensureTimelineClipsStructure();
      const clips = timelineConfig.master_clips || [];
      const m = clips.length > 0 ? clips[0] : timelineConfig.master;
      if (!m || !m.name) {
        alert('主时间轴尚未载入媒体文件，请先点击【➕ 增添主轴素材】！');
        return;
      }
      if (confirm(`确定要将主时间轴编排节目投送到大屏并从起点同步启动物联联动吗？`)) {
        stopTimeline(true);
        // 调用大屏切换
        try {
          await fetch('/api/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'play_media',
              media: m.name,
              url: m.url || `/media/视频/${m.name}`,
              type: m.type || 'video'
            })
          });
        } catch (e) {}
        // 本地启动时间轴
        playTimeline();
        showToast(`已投映至大屏并启动时间轴物联同步！`);
      }
    });
  }

  // 保存时间轴配置
  async function saveTimelineConfig() {
    if (!timelineConfig.master) timelineConfig.master = {};
    timelineConfig.master.duration = Math.max(1, parseFloat(tlMasterDurationInput.value) || 60);

    try {
      const res = await fetch('/api/iot/timeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeline: timelineConfig })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        showToast('💾 展馆多媒体与物联同步时间轴配置已成功保存！');
      }
    } catch (e) {
      showToast('❌ 保存时间轴失败');
    }
  }

  if (btnTlSave) btnTlSave.addEventListener('click', saveTimelineConfig);

  // 时间轴全功能工作室弹窗交互
  if (btnOpenTlStudio && modalTlStudio) {
    btnOpenTlStudio.addEventListener('click', () => {
      modalTlStudio.classList.remove('hidden');
      modalTlStudio.style.display = 'flex';
      setTimeout(() => {
        renderTimelineMaster();
        renderTimelineTracks();
      }, 50);
    });
  }

  // 安全关闭并退出时间轴工作室 (双重保证 display none，杜绝弹窗退不出)
  function closeTimelineStudioModal(e) {
    if (e) {
      try { e.preventDefault(); e.stopPropagation(); } catch (ignored) {}
    }
    if (modalTlStudio) {
      modalTlStudio.classList.add('hidden');
      modalTlStudio.style.display = 'none';
      stopTimeline(true);
    }
  }

  if (btnCloseTlStudio) btnCloseTlStudio.addEventListener('click', closeTimelineStudioModal);
  const btnExitTlStudio = document.getElementById('btn-exit-tl-studio');
  if (btnExitTlStudio) {
    btnExitTlStudio.addEventListener('click', closeTimelineStudioModal);
  }

  // 点击遮罩空白背景安全退出工作室
  if (modalTlStudio) {
    modalTlStudio.addEventListener('click', (e) => {
      if (e.target === modalTlStudio) {
        closeTimelineStudioModal(e);
      }
    });
  }

  // 键盘 ESC 键全局退出工作室
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.keyCode === 27) {
      if (modalTlStudio && !modalTlStudio.classList.contains('hidden') && modalTlStudio.style.display !== 'none') {
        closeTimelineStudioModal(e);
      }
    }
  });

  if (btnStudioPlay) btnStudioPlay.addEventListener('click', playTimeline);
  if (btnStudioStop) btnStudioStop.addEventListener('click', () => stopTimeline(true));
  if (btnStudioSyncScreen && btnTlSyncScreen) {
    btnStudioSyncScreen.addEventListener('click', () => btnTlSyncScreen.click());
  }

  // 生成节目放入待机文件夹 (待机轮播改成待机)
  async function generateStandbyTimelineProgram() {
    ensureTimelineClipsStructure();
    const clips = timelineConfig.master_clips || [];
    const firstClip = clips.length > 0 ? clips[0] : timelineConfig.master;
    if (!firstClip || !firstClip.name) {
      showToast('⚠️ 当前时间轴尚未选择主媒体素材，正在为您打开素材库...');
      openTimelineMediaModal({ type: 'master' });
      return;
    }

    try {
      const sourcesToCopy = clips.length > 0 ? clips.map(c => c.name) : [firstClip.name];
      showToast(`正在将主时间轴素材 (${sourcesToCopy.length} 个) 复制放入【待机】文件夹...`);
      const resp = await fetch('/api/media/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'copy',
          target_folder: '待机',
          sources: sourcesToCopy
        })
      });
      await resp.json();

      await saveTimelineConfig();
      await loadMediaLibrary();

      // 切换主界面素材分类至【待机】
      currentFolderFilter = '待机';
      renderFolderOptions();
      renderMediaRows();

      const progSummary = `${timelineConfig.master.name || '主节目'} (${timelineConfig.tracks?.length || 0}条受控设备轨)`;
      showToast(`🎉 成功生成时间轴节目并存入【待机】！${progSummary}`);
      if (tlStatusBadge) {
        tlStatusBadge.textContent = '🟢 已生成待机节目';
        tlStatusBadge.style.color = '#34d399';
        tlStatusBadge.style.borderColor = 'rgba(52, 211, 153, 0.4)';
        tlStatusBadge.style.background = 'rgba(16, 185, 129, 0.2)';
      }
      if (tlLastEventEl) {
        tlLastEventEl.textContent = `✅ 时间轴节目已生成并生效存入【待机】文件夹: ${mediaName}`;
      }
    } catch (e) {
      console.error(e);
      showToast('❌ 生成节目放入待机失败: ' + (e.message || e));
    }
  }

  if (btnGenerateStandbyProg) btnGenerateStandbyProg.addEventListener('click', generateStandbyTimelineProgram);
  if (btnModalGenerateStandby) btnModalGenerateStandby.addEventListener('click', generateStandbyTimelineProgram);

  // 加载时间轴配置
  async function loadTimelineConfig() {
    try {
      const res = await fetch('/api/iot/timeline');
      const data = await res.json();
      if (data.status === 'ok' && data.timeline) {
        timelineConfig = data.timeline;
      }
    } catch (e) {}
    renderTimelineMaster();
    renderTimelineTracks();
  }

  // ===================== 节点编辑模态框交互 =====================
  function openTimelineNodeModal(trackId, node = null, defaultTime = null) {
    if (!modalTlNode) return;
    tlNodeTrackIdInput.value = trackId;

    // 填充受控设备下拉列表 (拉取上方已配置设备)
    if (tlNodeDeviceSelect) {
      tlNodeDeviceSelect.innerHTML = '';
      if (!devicesCache || devicesCache.length === 0) {
        tlNodeDeviceSelect.innerHTML = '<option value="">(上方暂未配置受控设备，请先在上方添加设备)</option>';
      } else {
        devicesCache.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.id;
          opt.textContent = `${d.name} (${d.type} - ${d.host || ''}:${d.port || ''})`;
          tlNodeDeviceSelect.appendChild(opt);
        });
      }
    }

    if (node) {
      document.getElementById('modal-tl-node-title').textContent = '编辑时间轴命令节点';
      tlNodeIdInput.value = node.id;
      tlNodeTimeInput.value = node.time;
      if (tlNodeTimePreview) tlNodeTimePreview.textContent = formatTimecode(node.time);
      if (tlNodeDeviceSelect) tlNodeDeviceSelect.value = node.device_id;
      if (tlNodeActionSelect) tlNodeActionSelect.value = node.action || 'on';
      if (tlNodeCustomCmdInput) tlNodeCustomCmdInput.value = node.custom_cmd || '';
      if (tlNodeLabelInput) tlNodeLabelInput.value = node.label || '';
      if (btnDelTlNode) btnDelTlNode.style.display = 'inline-block';
    } else {
      document.getElementById('modal-tl-node-title').textContent = '添加时间轴命令节点';
      tlNodeIdInput.value = '';
      const setTime = (defaultTime !== null) ? defaultTime : parseFloat(tlCurrentTime.toFixed(1));
      tlNodeTimeInput.value = setTime;
      if (tlNodeTimePreview) tlNodeTimePreview.textContent = formatTimecode(setTime);
      if (tlNodeActionSelect) tlNodeActionSelect.value = 'on';
      if (tlNodeCustomCmdInput) tlNodeCustomCmdInput.value = '';
      if (tlNodeLabelInput) tlNodeLabelInput.value = '';
      if (btnDelTlNode) btnDelTlNode.style.display = 'none';
    }

    updateNodeActionUI();
    modalTlNode.classList.remove('hidden');
  }

  function updateNodeActionUI() {
    if (!tlNodeActionSelect || !groupTlNodeCustom) return;
    if (tlNodeActionSelect.value === 'custom') {
      groupTlNodeCustom.style.display = 'block';
    } else {
      groupTlNodeCustom.style.display = 'none';
    }
  }

  if (tlNodeActionSelect) tlNodeActionSelect.addEventListener('change', updateNodeActionUI);

  if (tlNodeTimeInput) {
    tlNodeTimeInput.addEventListener('input', () => {
      const val = parseFloat(tlNodeTimeInput.value) || 0;
      if (tlNodeTimePreview) tlNodeTimePreview.textContent = formatTimecode(val);
    });
  }

  if (btnCloseTlNodeModal) btnCloseTlNodeModal.addEventListener('click', () => modalTlNode.classList.add('hidden'));
  if (btnCancelTlNode) btnCancelTlNode.addEventListener('click', () => modalTlNode.classList.add('hidden'));

  // 单独测试当前选中的命令
  if (btnTestTlNode) {
    btnTestTlNode.addEventListener('click', async () => {
      const devId = tlNodeDeviceSelect.value;
      if (!devId) {
        alert('请先选择受控设备！');
        return;
      }
      const act = tlNodeActionSelect.value;
      const customCmd = tlNodeCustomCmdInput.value.trim();
      const res = await fetch('/api/iot/devices/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: devId, cmd_type: act, custom_cmd: customCmd || undefined })
      });
      const data = await res.json();
      showToast(data.message || '测试指令已发送', '节点指令测试');
    });
  }

  // 删除节点
  if (btnDelTlNode) {
    btnDelTlNode.addEventListener('click', () => {
      const trackId = tlNodeTrackIdInput.value;
      const nodeId = tlNodeIdInput.value;
      const track = (timelineConfig.tracks || []).find(t => t.id === trackId);
      if (track) {
        track.nodes = track.nodes.filter(n => n.id !== nodeId);
        renderTimelineTracks();
      }
      modalTlNode.classList.add('hidden');
      showToast('已删除命令节点');
    });
  }

  // 保存节点表单
  if (formTlNode) {
    formTlNode.addEventListener('submit', (e) => {
      e.preventDefault();
      const trackId = tlNodeTrackIdInput.value;
      const nodeId = tlNodeIdInput.value || `node_${Date.now()}`;
      const timeVal = parseFloat(tlNodeTimeInput.value) || 0;
      const devId = tlNodeDeviceSelect.value;
      const act = tlNodeActionSelect.value;
      const customCmd = tlNodeCustomCmdInput.value.trim();
      const label = tlNodeLabelInput.value.trim();

      const track = (timelineConfig.tracks || []).find(t => t.id === trackId);
      if (!track) return;
      if (!track.nodes) track.nodes = [];

      const nodeObj = {
        id: nodeId,
        time: timeVal,
        device_id: devId,
        action: act,
        custom_cmd: customCmd,
        label: label
      };

      const existingIdx = track.nodes.findIndex(n => n.id === nodeId);
      if (existingIdx !== -1) {
        track.nodes[existingIdx] = nodeObj;
      } else {
        track.nodes.push(nodeObj);
      }

      // 按时间戳升序排序
      track.nodes.sort((a, b) => a.time - b.time);

      renderTimelineTracks();
      modalTlNode.classList.add('hidden');
      showToast('命令节点配置已保存');
    });
  }

  // ===================== 多轨道多素材选择模态框 =====================
  function openTimelineMediaModal(target = { type: 'master' }) {
    tlMediaPickerTarget = target;
    if (!modalTlMedia) return;
    renderTlMediaGrid();
    modalTlMedia.classList.remove('hidden');
    modalTlMedia.style.display = 'flex';
  }

  function renderTlMediaGrid() {
    if (!tlMediaPickerGrid) return;
    tlMediaPickerGrid.innerHTML = '';

    // 过滤素材库素材
    const filtered = (mediaFileList || []).filter(item => {
      const type = (item.type || '').toLowerCase();
      if (tlFilterMediaType === 'all') return type === 'video' || type === 'audio' || type === 'image' || type === 'doc';
      return type === tlFilterMediaType;
    });

    if (filtered.length === 0) {
      tlMediaPickerGrid.innerHTML = '<div style="grid-column:1/-1;color:#64748b;font-size:13px;text-align:center;padding:20px;">素材库中暂无该类型素材，请先在上方素材库上传，或在下方直接填入 URL</div>';
      return;
    }

    filtered.forEach(m => {
      const card = document.createElement('div');
      card.className = 'tl-media-picker-item';
      const icon = m.type === 'video' ? '🎬' : (m.type === 'audio' ? '🎵' : (m.type === 'image' ? '🖼️' : '📄'));
      const folderBadge = m.folder ? `<span style="font-size:10px; color:#38bdf8; background:rgba(56,189,248,0.12); padding:1px 6px; border-radius:4px;">📁 ${escapeHtml(m.folder)}</span>` : '';
      card.innerHTML = `
        <div class="media-icon">${icon}</div>
        <div class="media-name" title="${escapeHtml(m.name)}" style="font-weight:600; font-size:12px; margin:4px 0;">${escapeHtml(m.name)}</div>
        <div style="display:flex; gap:4px; align-items:center; margin-top:auto;">
          ${folderBadge}
          <span style="font-size:10px; color:#00f0ff; background:rgba(0,240,255,0.1); padding:1px 5px; border-radius:4px;">${m.type.toUpperCase()}</span>
        </div>
      `;
      card.addEventListener('click', () => {
        addMediaClipToTarget(m.name, m.url || `/media/${m.folder}/${m.name}`, m.type, m.duration);
        modalTlMedia.classList.add('hidden');
        modalTlMedia.style.display = 'none';
      });
      tlMediaPickerGrid.appendChild(card);
    });
  }

  function addMediaClipToTarget(name, url, type, duration = null) {
    ensureTimelineClipsStructure();
    let defaultDuration = 15;
    if (duration && duration > 0) {
      defaultDuration = Math.round(duration);
    } else if (type === 'image') {
      defaultDuration = 10;
    } else if (type === 'video' || type === 'audio') {
      defaultDuration = 15;
    }

    if (tlMediaPickerTarget.type === 'master') {
      // 计算主时间轴下一个素材放置时间点 (依次紧随现有素材之后排列)
      let nextStart = 0;
      (timelineConfig.master_clips || []).forEach(c => {
        const end = (parseFloat(c.start_time) || 0) + (parseFloat(c.duration) || 15);
        if (end > nextStart) nextStart = end;
      });
      nextStart = parseFloat(nextStart.toFixed(1));

      const newClip = {
        id: `clip_m_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        name: name,
        url: url,
        type: type || 'video',
        start_time: nextStart,
        duration: defaultDuration
      };

      timelineConfig.master_clips.push(newClip);

      // 若为第一个素材，兼容同步更新旧 master 属性
      if (timelineConfig.master_clips.length === 1) {
        timelineConfig.master = { name, url, type, duration: defaultDuration };
      }

      renderTimelineMaster();
      renderTimelineTracks();
      showToast(`✅ 已向主时间轴增添素材 [${name}] (时长: ${defaultDuration}秒)`);

      // 异步探测音视频真实播放时长并自动校正
      if (type === 'video' || type === 'audio') {
        const probeEl = document.createElement(type);
        probeEl.preload = 'metadata';
        probeEl.src = url;
        probeEl.onloadedmetadata = () => {
          if (probeEl.duration && !isNaN(probeEl.duration) && isFinite(probeEl.duration) && probeEl.duration > 0) {
            const autoSec = Math.round(probeEl.duration);
            newClip.duration = autoSec;
            renderTimelineMaster();
            renderTimelineTracks();
            showToast(`⏱️ 素材 [${name}] 时长已自动校准为: ${autoSec}秒`);
          }
        };
      }

    } else if (tlMediaPickerTarget.type === 'track') {
      const trackId = tlMediaPickerTarget.trackId;
      const tr = (timelineConfig.tracks || []).find(it => it.id === trackId);
      if (tr) {
        if (!tr.clips) tr.clips = [];
        const newClip = {
          id: `clip_tr_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
          name: name,
          url: url,
          type: type || 'video',
          start_time: parseFloat(tlCurrentTime.toFixed(1)),
          duration: defaultDuration
        };
        tr.clips.push(newClip);
        renderTimelineTracks();
        showToast(`✅ 已向轨道 [${tr.name}] 增添素材 [${name}]`);
      }
    }
  }

  if (btnTlPickMedia) btnTlPickMedia.addEventListener('click', () => openTimelineMediaModal({ type: 'master' }));
  if (tlMasterNameEl) tlMasterNameEl.addEventListener('click', () => openTimelineMediaModal({ type: 'master' }));
  if (studioMasterNameEl) studioMasterNameEl.addEventListener('click', () => openTimelineMediaModal({ type: 'master' }));
  if (tlMasterLane) {
    tlMasterLane.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.tl-media-clip')) {
        openTimelineMediaModal({ type: 'master' });
      }
    });
  }
  if (btnCloseTlMediaModal) {
    btnCloseTlMediaModal.addEventListener('click', () => {
      modalTlMedia.classList.add('hidden');
      modalTlMedia.style.display = 'none';
    });
  }

  // 媒体分类过滤
  document.querySelectorAll('.btn-filter-media').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.btn-filter-media').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      tlFilterMediaType = e.target.getAttribute('data-type');
      renderTlMediaGrid();
    });
  });

  // 手动应用自定义 URL
  if (btnApplyCustomMedia) {
    btnApplyCustomMedia.addEventListener('click', () => {
      const url = (tlCustomMediaUrl.value || '').trim();
      if (!url) {
        alert('请输入素材路径或 URL！');
        return;
      }
      const type = tlCustomMediaType.value;
      const name = url.split('/').pop() || '自定义媒体';
      addMediaClipToTarget(name, url, type);
      modalTlMedia.classList.add('hidden');
      modalTlMedia.style.display = 'none';
    });
  }

  // 点击任意空白处收起素材折叠菜单
  document.addEventListener('click', () => {
    document.querySelectorAll('.media-more-menu').forEach(m => m.classList.add('hidden'));
  });

  // 页面初始化时载入时间轴配置
  loadTimelineConfig();

})();


