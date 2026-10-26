/**
 * VisualCast 受控大屏呈现端核心逻辑
 * 1. 默认无边框最前置全屏自适应，UI 默认关闭，按键盘 H 键展开/隐藏
 * 2. 全格式媒体渲染支持 (视频, 图片, 音频, PDF, 网页, H5, 直播流, 外挂字幕)
 * 3. 局域网访问引导与屏幕键盘映射
 * 4. 受控端指定保存第三方应用程序并同步
 * 5. U 盘插入自动同步检测感知与 Toast 提示
 * 6. 实时大屏镜像回显抽取器 (Live Echo Grabber)
 */

(function() {
  // 彻底屏蔽浏览器默认右键菜单与开发者快捷键，确保纯净原生播控视窗体验
  window.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('keydown', e => {
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.key === 'J' || e.key === 'j')) || (e.ctrlKey && (e.key === 'r' || e.key === 'R' || e.key === 'u' || e.key === 'U' || e.key === 'p' || e.key === 'P' || e.key === 's' || e.key === 'S'))) {
      e.preventDefault();
    }
  });

  // 工业级大屏体验：鼠标静止 2.5 秒后自动隐藏光标，避免屏幕残留鼠标箭头
  let cursorHideTimer = null;
  window.addEventListener('mousemove', () => {
    document.body.style.cursor = 'default';
    clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(() => {
      const panel = document.getElementById('control-panel');
      if (!panel || panel.classList.contains('hidden')) {
        document.body.style.cursor = 'none';
      }
    }, 2500);
  });

  const viewportEl = document.getElementById('media-viewport');
  const videoA = document.getElementById('video-a');
  const videoB = document.getElementById('video-b');
  let activeVideoEl = videoA;
  const videoEl = videoA; // 向后兼容别名，防止任何未迁移引用抛出异常

  const imgEl = document.getElementById('main-image');
  const frameEl = document.getElementById('main-frame');
  const audioVisEl = document.getElementById('audio-visualizer');
  const mainAudioEl = document.getElementById('main-audio');
  const blackoutMask = document.getElementById('blackout-mask');
  let isLicenseBlocked = false;
  let isSystemSleeping = false; // 严密隔离系统待机休眠与用户普通黑场屏蔽状态

// ===================== 左右翻页与触控滑动：严格仅翻页待机素材 =====================
  const touchNavPrev = document.getElementById('touch-nav-prev');
  const touchNavNext = document.getElementById('touch-nav-next');
  const swipeFeedbackEl = document.getElementById('touch-swipe-feedback');
  let isTouchNavEnabled = false;
  let lastNavTouchTime = 0;
  let swipeFeedbackTimer = null;

  function showSwipeFeedback(text) {
    if (!swipeFeedbackEl) return;
    clearTimeout(swipeFeedbackTimer);
    swipeFeedbackEl.textContent = text;
    swipeFeedbackEl.classList.remove('hidden');
    swipeFeedbackEl.style.display = 'block';
    swipeFeedbackEl.style.opacity = '1';
    swipeFeedbackTimer = setTimeout(() => {
      swipeFeedbackEl.style.opacity = '0';
      setTimeout(() => { swipeFeedbackEl.classList.add('hidden'); }, 200);
    }, 600);
  }

  function navStandbyFolder(direction) {
    const now = Date.now();
    if (now - lastNavTouchTime < 250) return; // 250ms 点击防抖
    lastNavTouchTime = now;

    console.log('[VisualCast] 左右按键触控：严格切播待机素材, 方向:', direction);
    isExplicitlyStopped = false;
    setBlackout(false);
    currentFolder = '待机';
    loopMode = 'FOLDER_LOOP';
    refreshPlaylist();

    if (currentPlaylist.length === 0) return;
    if (direction > 0) {
      currentPlayIndex = (currentPlayIndex + 1) % currentPlaylist.length;
    } else {
      currentPlayIndex = (currentPlayIndex - 1 + currentPlaylist.length) % currentPlaylist.length;
    }
    const targetItem = currentPlaylist[currentPlayIndex];
    if (targetItem) {
      switchMedia(targetItem, true);
    }
  }

  if (touchNavPrev) {
    const onPrev = (e) => {
      e.stopPropagation();
      if (e.cancelable && e.type === 'touchstart') e.preventDefault();
      showSwipeFeedback('◀ 上一素材');
      navStandbyFolder(-1);
    };
    touchNavPrev.addEventListener('pointerdown', onPrev, { passive: false });
    touchNavPrev.addEventListener('click', onPrev);
  }
  if (touchNavNext) {
    const onNext = (e) => {
      e.stopPropagation();
      if (e.cancelable && e.type === 'touchstart') e.preventDefault();
      showSwipeFeedback('下一素材 ▶');
      navStandbyFolder(1);
    };
    touchNavNext.addEventListener('pointerdown', onNext, { passive: false });
    touchNavNext.addEventListener('click', onNext);
  }

  // 大屏触屏全局左右滑动手势监听 (Swipe Left / Swipe Right 切换待机素材)
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;

  window.addEventListener('touchstart', (e) => {
    if (isPanelOpen) return;
    if (e.touches && e.touches.length === 1) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
    }
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    if (isPanelOpen) return;
    if (!isTouchNavEnabled) return;
    // 如果触摸事件落在控制面板、按键或者文档交互栏上，不触发全局滑动
    if (e.target && e.target.closest && (e.target.closest('#control-panel') || e.target.closest('.touch-nav-btn') || e.target.closest('#screen-doc-touch-bar') || e.target.closest('#screen-license-modal'))) {
      return;
    }
    const touchEndTime = Date.now();
    if (touchEndTime - touchStartTime > 800) return; // 超过 800ms 算长按或拖拽，不判定为滑动
    if (!e.changedTouches || e.changedTouches.length === 0) return;
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    const deltaX = touchEndX - touchStartX;
    const deltaY = touchEndY - touchStartY;

    // 水平滑动位移必须大于 60px，且水平位移明显大于垂直位移 (1.3 倍以上)
    if (Math.abs(deltaX) > 60 && Math.abs(deltaX) > Math.abs(deltaY) * 1.3) {
      if (deltaX < 0) {
        // 向左滑动：切换下一待机素材
        console.log('[VisualCast] 触控手势：向左滑动 -> 切换下一待机素材');
        showSwipeFeedback('下一素材 ▶');
        navStandbyFolder(1);
      } else {
        // 向右滑动：切换上一待机素材
        console.log('[VisualCast] 触控手势：向右滑动 -> 切换上一待机素材');
        showSwipeFeedback('◀ 上一素材');
        navStandbyFolder(-1);
      }
    }
  }, { passive: true });

  function setTouchModeUI(enabled) {
    isTouchNavEnabled = !!enabled;
    if (touchNavPrev) {
      touchNavPrev.classList.toggle('hidden', !enabled);
      touchNavPrev.style.display = (enabled && !isBlackout) ? 'flex' : 'none';
      if (enabled && !isBlackout) {
        touchNavPrev.style.setProperty('display', 'flex', 'important');
        touchNavPrev.style.setProperty('opacity', '1', 'important');
        touchNavPrev.style.setProperty('visibility', 'visible', 'important');
      }
    }
    if (touchNavNext) {
      touchNavNext.classList.toggle('hidden', !enabled);
      touchNavNext.style.display = (enabled && !isBlackout) ? 'flex' : 'none';
      if (enabled && !isBlackout) {
        touchNavNext.style.setProperty('display', 'flex', 'important');
        touchNavNext.style.setProperty('opacity', '1', 'important');
        touchNavNext.style.setProperty('visibility', 'visible', 'important');
      }
    }
  }

  const freezeCanvas = document.getElementById('freeze-canvas');
  const subtitleLayer = document.getElementById('subtitle-layer');
  const echoCanvas = document.getElementById('echo-canvas');
  const echoCtx = echoCanvas ? echoCanvas.getContext('2d') : null;
  if (echoCanvas) {
    echoCanvas.width = 640;
    echoCanvas.height = 360;
  }

  const panel = document.getElementById('control-panel');
  const panelMask = document.getElementById('control-panel-mask');
  const closeBtn = document.getElementById('btn-close-panel');
  const webUrlEl = document.getElementById('web-url');
  const remoteUrlEl = document.getElementById('remote-url');
  const usbToast = document.getElementById('usb-toast');
  const usbDesc = document.getElementById('usb-desc');
  const btnToggleFs = document.getElementById('btn-toggle-fs');
  const chkAutostart = document.getElementById('chk-autostart');
  const touchTriggerEl = document.getElementById('touch-corner-trigger');

  // 第三方应用表单
  const inputAppId = document.getElementById('input-app-id');
  const inputAppName = document.getElementById('input-app-name');
  const inputAppPath = document.getElementById('input-app-path');
  const btnBrowseApp = document.getElementById('btn-browse-app');
  const btnSaveApp = document.getElementById('btn-save-app');
  const btnCancelAppEdit = document.getElementById('btn-cancel-app-edit');
  const regAppsList = document.getElementById('registered-apps-list');

  // 大屏端悬浮 PPT / PDF 放映触控操作栏
  const screenDocTouchBar = document.getElementById('screen-doc-touch-bar');
  const screenBtnDocPrev = document.getElementById('screen-btn-doc-prev');
  const screenBtnDocNext = document.getElementById('screen-btn-doc-next');
  const screenBtnDocExit = document.getElementById('screen-btn-doc-exit');
  const screenDocPageIndicator = document.getElementById('screen-doc-page-indicator');

  function updateScreenDocTouchBar(show, title = '文档演示') {
    if (screenDocTouchBar) screenDocTouchBar.classList.add('hidden');
  }

  // ===================== 大屏端原生无线投屏连接看板 =====================
  const castBoardModal = document.getElementById('cast-board-modal');
  const castBoardDeviceName = document.getElementById('cast-board-device-name');
  const btnCloseCastBoard = document.getElementById('btn-close-cast-board');

  function showCastBoard(devName) {
    if (!castBoardModal) return;
    if (devName && castBoardDeviceName) {
      castBoardDeviceName.textContent = devName;
    }
    castBoardModal.classList.remove('hidden');
    console.log('[VisualCast] 大屏已弹出无线投屏连接看板: ' + (devName || ''));
  }
  window.showCastBoard = showCastBoard;

  function hideCastBoard() {
    if (!castBoardModal) return;
    castBoardModal.classList.add('hidden');
    console.log('[VisualCast] 大屏已关闭无线投屏看板');
  }
  window.hideCastBoard = hideCastBoard;

  if (btnCloseCastBoard) {
    btnCloseCastBoard.addEventListener('click', async () => {
      hideCastBoard();
      try {
        await fetch('/api/cast/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'close' })
        });
      } catch (e) {}
    });
  }

  // 当前媒体状态
  let currentMediaType = 'video';
  let currentMediaName = '';
  let isBlackout = false;
  let isFrozen = false;

  function setBlackout(active) {
    isBlackout = !!active;
    if (blackoutMask) {
      if (isBlackout) {
        blackoutMask.classList.add('active');
        blackoutMask.style.display = 'block';
        blackoutMask.style.opacity = '1';
        blackoutMask.style.pointerEvents = 'all';
      } else {
        blackoutMask.classList.remove('active');
        blackoutMask.style.display = 'none';
        blackoutMask.style.opacity = '0';
        blackoutMask.style.pointerEvents = 'none';
      }
    }
    // 关键需求4：黑场后所有都不显示，包括字幕
    const subLayer = document.getElementById('subtitle-layer');
    if (subLayer) {
      if (isBlackout) {
        subLayer.classList.remove('active');
        subLayer.style.display = 'none';
      } else if (currentSubtitleConfig && currentSubtitleConfig.enabled && currentSubtitleConfig.text) {
        subLayer.classList.add('active');
        subLayer.style.display = '';
      }
    }
    // 黑场时同步隐藏文档触控栏与投屏连接看板
    const docBar = document.getElementById('screen-doc-touch-bar');
    if (docBar && isBlackout) docBar.style.display = 'none';
    if (isBlackout) hideCastBoard();
  }
  window.setBlackout = setBlackout;

  function setFreeze(active) {
    isFrozen = !!active;
    if (freezeCanvas) {
      if (isFrozen) {
        try {
          const ctx = freezeCanvas.getContext('2d');
          freezeCanvas.width = window.innerWidth || 1920;
          freezeCanvas.height = window.innerHeight || 1080;
          if (currentMediaType === 'video' && activeVideoEl) {
            ctx.drawImage(activeVideoEl, 0, 0, freezeCanvas.width, freezeCanvas.height);
          } else if (currentMediaType === 'image' && imgEl) {
            ctx.drawImage(imgEl, 0, 0, freezeCanvas.width, freezeCanvas.height);
          }
          freezeCanvas.classList.add('active');
          freezeCanvas.style.display = 'block';
        } catch (e) {
          console.warn('setFreeze error', e);
        }
      } else {
        freezeCanvas.classList.remove('active');
        freezeCanvas.style.display = 'none';
      }
    }
  }
  window.setFreeze = setFreeze;

  let cachedApps = [];
  let lastHandledUsbTime = 0;
  let isPanelOpen = false;

  // 待机与点播状态机
  let currentMode = 'ATTRACT';       // ATTRACT (待机) / ON_DEMAND (点播插播)
  let idleMedia = 'demo_show.mp4';   // 待机素材
  let idleTimeout = 60;              // 空闲超时自动回退秒数
  let lastActivityTime = Date.now(); // 最近活跃时间
  let isEchoActive = false;         // 是否有管理员正在查看回显 (按需抽帧，默认静默)
  let currentScaleMode = 'fill';     // fill (全屏拉伸) / contain (等比原始) / cover (裁切铺满)
  let isLoopMode = true;             // 向后兼容：true (循环播放) / false (单次播放)
  let loopMode = 'FOLDER_LOOP';
  let isExplicitlyStopped = false;      // 核心播放模式：FOLDER_LOOP (文件夹循环) / SINGLE_LOOP (单个循环) / ALL_LOOP (全部循环) / PLAY_ONCE (播放一次)
  let currentFolder = '待机';            // 当前播放文件夹 (空字符串为默认根目录)
  let cachedMediaList = [];          // 全部素材库平铺列表
  let currentPlaylist = [];          // 当前模式下动态计算的待播队列
  let currentPlayIndex = 0;          // 当前播放队列指针
  let currentSubtitleConfig = null;  // 悬浮字幕配置
  let imageTimer = null;             // 图片轮播计时器
  let currentOrientation = 'landscape'; // landscape (横屏 16:9) / portrait (竖屏 9:16)
  let selectedNetworkCard = '';         // 用户选择的通信网卡 IP

  // 屏幕方向切换 (支持物理竖屏与横屏软件旋转90度)
  function setScreenOrientation(ori) {
    if (!['landscape', 'portrait', 'portrait_cw', 'portrait_ccw'].includes(ori)) {
      ori = 'landscape';
    }
    currentOrientation = ori;
    if (viewportEl) {
      viewportEl.classList.remove('orientation-portrait', 'orientation-portrait-rotate90', 'orientation-portrait-rotate270');
      if (ori === 'portrait') {
        if (window.innerWidth < window.innerHeight) {
          viewportEl.classList.add('orientation-portrait');
        } else {
          viewportEl.classList.add('orientation-portrait-rotate90');
        }
      } else if (ori === 'portrait_cw') {
        viewportEl.classList.add('orientation-portrait-rotate90');
      } else if (ori === 'portrait_ccw') {
        viewportEl.classList.add('orientation-portrait-rotate270');
      }
    }
    const btnOri = document.getElementById('btn-toggle-orientation');
    if (btnOri) {
      const isPortrait = ori.startsWith('portrait');
      btnOri.textContent = isPortrait ? '📱 横竖屏切换 (当前: 竖屏)' : '🖥️ 横竖屏切换 (当前: 横屏)';
    }
    console.log(`[VisualCast] 屏幕方向已切换为: ${ori}`);
  }

  // ===================== 顶层字幕引擎 (支持多行悬浮 / 实时时间 / 第三方天气) =====================
  let cachedWeatherInfo = {
    city: '北京',
    text: '晴',
    temp: '22℃',
    wind: '微风',
    str: '🌤️ 晴 22℃ 微风',
    updateTime: 0
  };
  let subtitleTickerTimer = null;

  // 格式化实时时间 (HH:mm:ss)
  function getSubCurrentTimeStr() {
    const d = new Date();
    return d.toTimeString().split(' ')[0];
  }

  // 格式化当前日期星期 (YYYY年MM月DD日 星期X)
  function getSubCurrentDateStr() {
    const d = new Date();
    const weeks = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const y = d.getFullYear();
    const m = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    const w = weeks[d.getDay()];
    return `${y}年${m}月${day}日 ${w}`;
  }

  // 异步获取第三方城市天气 (带 4 秒超时与 30 分钟缓存与智能降级)
  async function updateThirdPartyWeather(city) {
    city = (city || '北京').trim();
    const now = Date.now();
    // 30分钟内若城市相同则直接复用缓存
    if (cachedWeatherInfo.city === city && (now - cachedWeatherInfo.updateTime) < 1800000) {
      return cachedWeatherInfo;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

    try {
      // 优先使用高可用天气 API (vvhan 开放 API，免密且响应快)
      const res = await fetch(`https://api.vvhan.com/api/weather?city=${encodeURIComponent(city)}`, {
        signal: controller.signal,
        cache: 'no-store'
      });
      clearTimeout(timer);
      const data = await res.json();
      if (data && data.success && data.data) {
        const d = data.data;
        const weatherType = d.type || '晴';
        let icon = '🌤️';
        if (weatherType.includes('雨')) icon = '🌧️';
        else if (weatherType.includes('云') || weatherType.includes('阴')) icon = '⛅';
        else if (weatherType.includes('雪')) icon = '❄️';
        else if (weatherType.includes('雷')) icon = '⛈️';

        const tempStr = d.high ? `${d.low || ''}~${d.high}` : (d.temp ? `${d.temp}℃` : '22℃');
        const windStr = d.fengxiang || '微风';
        cachedWeatherInfo = {
          city: city,
          text: weatherType,
          temp: tempStr,
          wind: windStr,
          str: `${icon} ${city} ${weatherType} ${tempStr} ${windStr}`.trim(),
          updateTime: now
        };
      }
    } catch (e) {
      // 若因无外网、断网或代理拦截，降级使用保底数据，绝不抛出异常阻碍大屏运行
      if (!cachedWeatherInfo.str || cachedWeatherInfo.city !== city) {
        cachedWeatherInfo = {
          city: city,
          text: '晴',
          temp: '22℃',
          wind: '微风',
          str: `🌤️ ${city} 晴 22℃ 微风`,
          updateTime: now
        };
      }
    }
    return cachedWeatherInfo;
  }

  // 动态替换文案中的变量占位符 {time}、{date}、{weather}
  function interpolateSubText(rawText) {
    if (!rawText) return '';
    return rawText
      .replace(/\{time\}/gi, getSubCurrentTimeStr())
      .replace(/\{date\}/gi, getSubCurrentDateStr())
      .replace(/\{weather\}/gi, cachedWeatherInfo.str || '🌤️ 晴 22℃');
  }

  // 渲染字幕到 DOM (支持多行、独立天气时间挂件)
  function renderSubtitleDom(sub) {
    if (!sub || !sub.enabled || !sub.text) {
      subtitleLayer.className = 'subtitle-layer';
      subtitleLayer.classList.remove('active');
      subtitleLayer.innerHTML = '';
      subtitleLayer.style.background = 'transparent';
      return;
    }

    subtitleLayer.className = 'subtitle-layer active';
    const pos = sub.position || 'center';
    if (pos === 'top') subtitleLayer.classList.add('pos-top');
    else if (pos === 'bottom') subtitleLayer.classList.add('pos-bottom');
    else subtitleLayer.classList.add('pos-center');

    const fontSize = sub.font_size || sub.fontSize || 72;
    const color = sub.color || '#ffffff';
    const bgColor = sub.bg_color || sub.bgColor || (sub.transparent_bg ? 'transparent' : 'rgba(0, 0, 0, 0.72)');
    const isMarquee = (sub.mode === 'marquee' || ((sub.speed !== undefined) && parseInt(sub.speed) > 0 && sub.mode !== 'static' && !sub.mode?.startsWith('multiline')));
    const speed = (sub.speed !== undefined) ? parseInt(sub.speed) : 20;

    subtitleLayer.style.background = bgColor;

    // 组装天气与时间小部件 HTML
    let widgetHtml = '';
    if (sub.show_time || sub.show_weather) {
      widgetHtml = `
        <div class="sub-weather-time-bar">
          ${sub.show_weather ? `<span class="sub-weather-item" id="sub-dyn-weather">${cachedWeatherInfo.str}</span>` : ''}
          ${sub.show_time ? `<span class="sub-time-item">🕒 <span id="sub-dyn-time">${getSubCurrentTimeStr()}</span></span>` : ''}
        </div>
      `;
    }

    const processedText = interpolateSubText(sub.text);

    if (isMarquee) {
      subtitleLayer.innerHTML = `
        ${widgetHtml}
        <div class="subtitle-marquee" style="font-size: ${fontSize}px; color: ${color}; animation-duration: ${speed}s;">
          ${processedText}
        </div>
      `;
    } else {
      subtitleLayer.innerHTML = `
        <div class="subtitle-card-box">
          ${widgetHtml}
          <div class="subtitle-multiline" style="font-size: ${fontSize}px; color: ${color};">
            ${processedText}
          </div>
        </div>
      `;
    }
  }

  // 启动秒级时间轻量更新调度器 (每秒局部更新时钟，0%额外能耗)
  function ensureSubtitleTicker() {
    if (subtitleTickerTimer) return;
    subtitleTickerTimer = setInterval(() => {
      if (!currentSubtitleConfig || !currentSubtitleConfig.enabled || isBlackout) return;
      const sub = currentSubtitleConfig;
      
      // 1. 如果有专门的时间挂件，局部更新时间
      const timeEl = document.getElementById('sub-dyn-time');
      if (timeEl) {
        timeEl.textContent = getSubCurrentTimeStr();
      }

      // 2. 如果文本中含有 {time} 动态宏变量，秒级局部更新文本内容
      if (sub.text && sub.text.includes('{time}')) {
        const multiEl = subtitleLayer.querySelector('.subtitle-multiline');
        const marqueeEl = subtitleLayer.querySelector('.subtitle-marquee');
        const updated = interpolateSubText(sub.text);
        if (multiEl && multiEl.textContent !== updated) {
          multiEl.textContent = updated;
        } else if (marqueeEl && marqueeEl.textContent !== updated) {
          marqueeEl.textContent = updated;
        }
      }
    }, 1000);
  }

  // 独立顶层悬浮字幕管理器 (完全穿透触控，支持多行悬浮/跑马灯/时间天气)
  function applySubtitleConfig(sub) {
    if (!sub) return;
    currentSubtitleConfig = sub;

    if (!sub.enabled || !sub.text) {
      subtitleLayer.className = 'subtitle-layer';
      subtitleLayer.classList.remove('active');
      subtitleLayer.innerHTML = '';
      subtitleLayer.style.background = 'transparent';
      return;
    }

    // 异步拉取第三方天气并重新渲染
    if (sub.show_weather || (sub.text && sub.text.includes('{weather}'))) {
      updateThirdPartyWeather(sub.city || '北京').then(() => {
        renderSubtitleDom(currentSubtitleConfig);
      });
    }

    renderSubtitleDom(sub);
    ensureSubtitleTicker();
  }

  // 动态刷新当前播放队列 (根据 loopMode 与 currentFolder 智能聚合)
  function refreshPlaylist() {
    if (!cachedMediaList || cachedMediaList.length === 0) {
      updateMediaLibraryCache();
      return;
    }
    const playable = cachedMediaList.filter(m => ['video', 'image', 'audio', 'doc', 'web', 'stream'].includes(m.type) || !m.is_custom);
    // 待机素材核心判定规则：文件夹为“待机”或包含待机/standby关键字，或 is_standby 为 true
    const standbyItems = playable.filter(m => {
      const f = (m.folder || '').toLowerCase();
      return f === '待机' || f === 'standby' || f.startsWith('待机/') || f.startsWith('standby/') || f.includes('待机') || f.includes('standby') || m.is_standby;
    });

    if (loopMode === 'FOLDER_LOOP') {
      let folderItems = [];
      const cfLower = (currentFolder || '').toLowerCase();
      if (cfLower === '待机' || cfLower === 'standby' || cfLower.includes('待机') || cfLower.includes('standby')) {
        folderItems = standbyItems;
      } else {
        folderItems = playable.filter(m => (m.folder || '') === currentFolder || (m.folder || '').startsWith(currentFolder + '/'));
      }
      currentPlaylist = (folderItems.length > 0) ? folderItems : (standbyItems.length > 0 ? standbyItems : playable);
    } else if (loopMode === 'ALL_LOOP') {
      // 业务硬性规则：全部播放/全部轮播模式下，只轮播待机文件夹内容，杜绝未整理杂项穿透
      currentPlaylist = (standbyItems.length > 0) ? standbyItems : playable;
    } else {
      currentPlaylist = (standbyItems.length > 0) ? standbyItems : playable;
    }

    const idx = currentPlaylist.findIndex(m => m.name === currentMediaName);
    if (idx !== -1) {
      currentPlayIndex = idx;
    }
  }

  async function updateMediaLibraryCache() {
    try {
      const mRes = await fetch('/api/media?_t=' + Date.now(), { cache: 'no-store' });
      const mData = await mRes.json();
      if (mData.status === 'ok') {
        cachedMediaList = mData.media || mData.files || [];
        const playable = cachedMediaList.filter(m => ['video', 'image', 'audio', 'doc', 'web', 'stream'].includes(m.type) || !m.is_custom);
        const standbyItems = playable.filter(m => {
          const f = (m.folder || '').toLowerCase();
          return f === '待机' || f === 'standby' || f.startsWith('待机/') || f.startsWith('standby/') || f.includes('待机') || f.includes('standby') || m.is_standby;
        });

        if (loopMode === 'FOLDER_LOOP') {
          let folderItems = [];
          const cfLower = (currentFolder || '').toLowerCase();
          if (cfLower === '待机' || cfLower === 'standby' || cfLower.includes('待机') || cfLower.includes('standby')) {
            folderItems = standbyItems;
          } else {
            folderItems = playable.filter(m => (m.folder || '') === currentFolder || (m.folder || '').startsWith(currentFolder + '/'));
          }
          currentPlaylist = (folderItems.length > 0) ? folderItems : (standbyItems.length > 0 ? standbyItems : playable);
        } else if (loopMode === 'ALL_LOOP') {
          // 全部播放模式下只轮播待机文件夹内容
          currentPlaylist = (standbyItems.length > 0) ? standbyItems : playable;
        } else {
          currentPlaylist = (standbyItems.length > 0) ? standbyItems : playable;
        }
        const idx = currentPlaylist.findIndex(m => m.name === currentMediaName);
        if (idx !== -1) currentPlayIndex = idx;
      }
    } catch (e) {}
  }
  window.updateMediaLibraryCache = updateMediaLibraryCache;
  window.refreshPlaylist = refreshPlaylist;
  window.switchMedia = switchMedia;

  // 图片切页调度机 (支持上下页直切，强制穿透 PLAY_ONCE 限制)
  function navImageTrack(direction = 1) {
    refreshPlaylist();
    let list = currentPlaylist;
    if (!list || list.length === 0) list = cachedMediaList || [];
    if (list.length === 0) return;

    // 优先在图片列表中切换
    const images = list.filter(m => m.type === 'image' || ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].includes((m.name || '').split('.').pop().toLowerCase()));
    const targetList = (images.length > 1) ? images : list;

    let idx = targetList.findIndex(m => m.name === currentMediaName);
    if (idx === -1) idx = 0;

    let nextIdx = (idx + direction + targetList.length) % targetList.length;
    const nextItem = targetList[nextIdx];
    if (nextItem) {
      console.log(`[VisualCast] 切换图片 [${direction > 0 ? '下一张' : '上一张'}]: ${nextItem.name}`);
      switchMedia(nextItem, true);
    }
  }

  let currentDocBaseUrl = '';

  // PDF 文档翻页调度机 (动态生成 Query+Hash，强制 Chromium / WebView2 内置 PDF 引擎百分之百无缝跳转)
  function navPdfPage(direction = 1) {
    if (direction > 0) {
      currentDocPage++;
    } else {
      currentDocPage = Math.max(1, currentDocPage - 1);
    }
    console.log(`[VisualCast] PDF 翻页 -> 第 ${currentDocPage} 页`);
    updateScreenDocTouchBar(true, `PDF 演示: 第 ${currentDocPage} 页`);
    if (frameEl) {
      const base = (currentDocBaseUrl || frameEl.src || '').split('#')[0].split('?')[0];
      if (base) {
        frameEl.src = `${base}?page=${currentDocPage}&_t=${Date.now()}#page=${currentDocPage}&view=FitH&toolbar=0`;
      }
      try {
        frameEl.focus();
      } catch (e) {}
    }
  }

  // 切下一曲调度机
  function playNextTrack(force = false) {
    if (isSystemSleeping) {
      console.log('[VisualCast] 当前处于待机休眠黑屏态，坚决拦截自动切曲');
      return;
    }
    if (force) {
      isExplicitlyStopped = false;
    } else if (isExplicitlyStopped) {
      console.log('[VisualCast] 当前处于后台停止态，保持停止');
      return;
    }
    if (!force && loopMode === 'SINGLE_LOOP') {
      if (currentMediaType === 'video' && activeVideoEl) {
        activeVideoEl.currentTime = 0;
        activeVideoEl.play().catch(() => {});
      } else if (currentMediaType === 'audio' && mainAudioEl) {
        mainAudioEl.currentTime = 0;
        mainAudioEl.play().catch(() => {});
      }
      return;
    }

    if (!force && loopMode === 'PLAY_ONCE') {
      console.log('[VisualCast] 单个播放一次模式播放完毕，停止放映');
      if (currentMediaType === 'video' && activeVideoEl) {
        activeVideoEl.pause();
      } else if (currentMediaType === 'audio' && mainAudioEl) {
        mainAudioEl.pause();
      }
      return;
    }

    refreshPlaylist();
    if (currentPlaylist.length === 0) {
      if (currentMediaType === 'video' && activeVideoEl) {
        activeVideoEl.currentTime = 0;
        activeVideoEl.play().catch(() => {});
      }
      return;
    }

    currentPlayIndex = (currentPlayIndex + 1) % currentPlaylist.length;
    const nextItem = currentPlaylist[currentPlayIndex];
    if (nextItem) {
      console.log(`[VisualCast] 切换下一曲 [${loopMode}]: ${nextItem.name}`);
      switchMedia(nextItem, true);
    }
  }

  // 切上一曲调度机
  function playPrevTrack(force = false) {
    console.log('[VisualCast] 执行切上一曲');
    isExplicitlyStopped = false;
    setBlackout(false);
    dismissFreezeCanvas();
    refreshPlaylist();
    if (currentPlaylist.length === 0) return;
    currentPlayIndex = (currentPlayIndex - 1 + currentPlaylist.length) % currentPlaylist.length;
    const prevItem = currentPlaylist[currentPlayIndex];
    if (prevItem) {
      console.log(`[VisualCast] 切换上一曲 [${loopMode}]: ${prevItem.name}`);
      switchMedia(prevItem, true, true);
    }
  }

  // 切下一曲调度机
  function playNextTrack(force = false) {
    if (isSystemSleeping) {
      console.log('[VisualCast] 当前处于待机休眠黑屏态，拦截自动切曲');
      return;
    }
    if (force) {
      setBlackout(false);
      dismissFreezeCanvas();
    }
    if (!force && loopMode === 'SINGLE_LOOP') {
      if (currentMediaType === 'video' && activeVideoEl) {
        activeVideoEl.currentTime = 0;
        activeVideoEl.play().catch(() => {});
      } else if (currentMediaType === 'audio' && mainAudioEl) {
        mainAudioEl.currentTime = 0;
        mainAudioEl.play().catch(() => {});
      }
      return;
    }

    if (!force && loopMode === 'PLAY_ONCE') {
      console.log('[VisualCast] 单个播放一次模式播放完毕，平稳暂停放映');
      pauseCurrentMedia();
      return;
    }

    refreshPlaylist();
    if (currentPlaylist.length === 0) {
      if (currentMediaType === 'video' && activeVideoEl) {
        activeVideoEl.currentTime = 0;
        activeVideoEl.play().catch(() => {});
      }
      return;
    }

    currentPlayIndex = (currentPlayIndex + 1) % currentPlaylist.length;
    const nextItem = currentPlaylist[currentPlayIndex];
    if (nextItem) {
      console.log(`[VisualCast] 切换下一曲 [${loopMode}]: ${nextItem.name}`);
      switchMedia(nextItem, true, true);
    }
  }

  // 抓取当前大屏画面至静帧 Canvas (大屏常亮保活，彻底杜绝黑屏与黑闪)
  function captureFreezeCanvas() {
    if (!freezeCanvas) return;
    try {
      const v = (videoA && videoA.classList.contains('active')) ? videoA : ((videoB && videoB.classList.contains('active')) ? videoB : activeVideoEl);
      const w = window.innerWidth || 1920;
      const h = window.innerHeight || 1080;
      freezeCanvas.width = w;
      freezeCanvas.height = h;
      const ctx = freezeCanvas.getContext('2d');
      if (ctx) {
        if (currentMediaType === 'video' && v && v.videoWidth > 0) {
          ctx.drawImage(v, 0, 0, w, h);
        } else if (currentMediaType === 'image' && imgEl) {
          ctx.drawImage(imgEl, 0, 0, w, h);
        }
      }
      freezeCanvas.classList.add('active');
      freezeCanvas.style.display = 'block';
      isFrozen = true;
    } catch (e) {
      console.warn('[VisualCast] captureFreezeCanvas 异常:', e);
    }
  }

  // 隐藏并清空静帧 Canvas
  function dismissFreezeCanvas() {
    isFrozen = false;
    if (freezeCanvas) {
      freezeCanvas.classList.remove('active');
      freezeCanvas.style.display = 'none';
      try {
        const ctx = freezeCanvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, freezeCanvas.width, freezeCanvas.height);
      } catch (e) {}
    }
  }

  // 播放/暂停切换
  function togglePlayPause() {
    const v = (videoA && videoA.classList.contains('active')) ? videoA : ((videoB && videoB.classList.contains('active')) ? videoB : activeVideoEl);
    if (currentMediaType === 'video' && v) {
      if (v.paused) {
        playCurrentMedia();
      } else {
        pauseCurrentMedia();
      }
    } else if (currentMediaType === 'audio' && mainAudioEl) {
      if (mainAudioEl.paused) {
        playCurrentMedia();
      } else {
        pauseCurrentMedia();
      }
    } else if (currentMediaType === 'image') {
      if (imageTimer) {
        pauseCurrentMedia();
      } else {
        playCurrentMedia();
      }
    } else {
      playCurrentMedia();
    }
  }

  // 开始/继续播放 (平滑稳定起播)
  function playCurrentMedia() {
    console.log('[VisualCast] 执行开始/继续播放');
    setBlackout(false);
    dismissFreezeCanvas();
    isExplicitlyStopped = false;

    const v = (videoA && videoA.classList.contains('active')) ? videoA : ((videoB && videoB.classList.contains('active')) ? videoB : activeVideoEl);

    if (currentMediaType === 'video' && v) {
      if (v.ended) {
        try { v.currentTime = 0; } catch (e) {}
      }

      const p = v.play();
      if (p !== undefined) {
        p.catch(function(err) {
          console.warn('[VisualCast] 视频直接播放被阻，使用 switchMedia 重新载入起播:', err);
          if (currentMediaName) {
            switchMedia(currentMediaName, true, true);
          }
        });
      }
    } else if (currentMediaType === 'audio' && mainAudioEl) {
      if (mainAudioEl.ended) {
        try { mainAudioEl.currentTime = 0; } catch(e) {}
      }
      mainAudioEl.play().catch(function() {
        if (currentMediaName) switchMedia(currentMediaName, true, true);
      });
    } else if (currentMediaType === 'image') {
      if (!imageTimer) scheduleImageNext();
    } else {
      refreshPlaylist();
      if (currentPlaylist.length > 0) {
        switchMedia(currentPlaylist[currentPlayIndex] || currentPlaylist[0], true, false);
      }
    }
  }

  // 暂停播放 (保持在当前画面暂停)
  function pauseCurrentMedia() {
    console.log('[VisualCast] 执行暂停播放');
    isExplicitlyStopped = false;
    const v = (videoA && videoA.classList.contains('active')) ? videoA : ((videoB && videoB.classList.contains('active')) ? videoB : activeVideoEl);
    if (currentMediaType === 'video' && v) v.pause();
    if (currentMediaType === 'audio' && mainAudioEl) mainAudioEl.pause();
    if (imageTimer) { clearTimeout(imageTimer); imageTimer = null; }
    if (docTimer) { clearTimeout(docTimer); docTimer = null; }
  }

  // 停止播放影片和音乐，并切至图片素材文件夹的第一个图片展示
  function stopMedia() {
    console.log('[VisualCast] 执行停止功能：影片、音乐停止播放，播放图片素材文件夹第一张图片');
    
    // 1. 彻底停止正在播放的视频和音频，进度归零
    const v = (videoA && videoA.classList.contains('active')) ? videoA : ((videoB && videoB.classList.contains('active')) ? videoB : activeVideoEl);
    if (v) {
      v.pause();
      try { v.currentTime = 0; } catch (e) {}
    }
    if (mainAudioEl) {
      mainAudioEl.pause();
      try { mainAudioEl.currentTime = 0; } catch (e) {}
    }

    // 2. (已按用户要求取消：不执行关闭黑场、解除定格、清除定时器、关闭文档)

    // 3. 寻找“图片素材文件夹的第一个图片”
    let targetImage = null;
    const mediaPool = (cachedMediaList && cachedMediaList.length > 0) ? cachedMediaList : (currentPlaylist || []);

    // 优先：查找 folder 名称为“图片”或包含“图片”的素材
    targetImage = mediaPool.find(m => {
      const f = (m.folder || '').trim();
      const isImg = (m.type === 'image') || /\.(jpe?g|png|webp|bmp|gif)$/i.test(m.name || m.full_name || '');
      return isImg && (f === '图片' || f.includes('图片') || f.toLowerCase().includes('image') || f.toLowerCase().includes('pic'));
    });

    // 备选 1：如果未找到，查找任何 folder 名称包含“图片”的第一个素材
    if (!targetImage) {
      targetImage = mediaPool.find(m => {
        const f = (m.folder || '').trim();
        return (f === '图片' || f.includes('图片')) && (m.type === 'image' || !m.type || m.type === 'other');
      });
    }

    // 备选 2：如果仍未找到指定文件夹，在整个素材库中寻找第一张图片
    if (!targetImage) {
      targetImage = mediaPool.find(m => {
        return (m.type === 'image') || /\.(jpe?g|png|webp|bmp|gif)$/i.test(m.name || m.full_name || '');
      });
    }

    if (targetImage) {
      console.log('[VisualCast] 已锁定图片素材文件夹第一张图片，立即切播:', targetImage.name || targetImage.full_name);
      if (targetImage.folder) {
        currentFolder = targetImage.folder;
      }
      switchMedia(targetImage, true, true);
    } else {
      console.warn('[VisualCast] 素材库中未检测到图片素材，已平稳暂停视频与音频放映');
      pauseCurrentMedia();
    }
  }

  function nextMedia() {
    playNextTrack(true);
  }

  function prevMedia() {
    playPrevTrack(true);
  }

  window.togglePlayPause = togglePlayPause;
  window.playCurrentMedia = playCurrentMedia;
  window.pauseCurrentMedia = pauseCurrentMedia;
  window.stopMedia = stopMedia;
  window.nextMedia = nextMedia;
  window.prevMedia = prevMedia;
  window.playNextTrack = playNextTrack;
  window.playPrevTrack = playPrevTrack;

  // 图片轮播定时调度 (默认展示 10 秒自动轮播)
  function scheduleImageNext() {
    if (imageTimer) clearTimeout(imageTimer);
    if (loopMode === 'SINGLE_LOOP' || loopMode === 'PLAY_ONCE') return;
    imageTimer = setTimeout(() => {
      if (currentMediaType === 'image' && (loopMode === 'FOLDER_LOOP' || loopMode === 'ALL_LOOP')) {
        playNextTrack();
      }
    }, 10000);
  }

  let docTimer = null;
  let docPageCountInSession = 0;

  // PDF 文档自动轮播调度 (支持待机模式及全模式自动翻页放映)
  function schedulePdfNext() {
    if (docTimer) clearTimeout(docTimer);
    if (loopMode === 'SINGLE_LOOP' || loopMode === 'PLAY_ONCE') return;
    docTimer = setTimeout(() => {
      if (currentMediaType === 'frame' && (currentMode === 'ATTRACT' || loopMode === 'FOLDER_LOOP' || loopMode === 'ALL_LOOP')) {
        navPdfPage(1);
        schedulePdfNext();
      }
    }, 8000);
  }

  // 画面拉伸模式切换函数 (支持窗口播放时全屏拉伸)
// 画面拉伸模式切换函数 (直接强行赋值 style，杜绝老 WebView 样式失效)
  function setScaleMode(mode) {
    if (!['fill', 'contain', 'cover'].includes(mode)) mode = 'fill';
    currentScaleMode = mode;
    if (viewportEl) {
      viewportEl.classList.remove('scale-fill', 'scale-contain', 'scale-cover');
      viewportEl.classList.add(`scale-${mode}`);
    }
    const fitVal = (mode === 'contain') ? 'contain' : (mode === 'cover' ? 'cover' : 'fill');
    [videoA, videoB, imgEl].forEach(function(el) {
      if (el) {
        el.style.objectFit = fitVal;
      }
    });
    console.log(`[VisualCast] 画面拉伸适配模式已应用: ${mode} (objectFit: ${fitVal})`);
  }

// 1. UI 抽屉面板切换 (按 H 键或右上角5击展开，隐藏时恢复全屏)
  let lastPanelOpenTime = 0;

  async function togglePanel(targetState) {
    if (targetState === undefined) {
      isPanelOpen = panel.classList.contains('hidden');
    } else {
      isPanelOpen = targetState;
    }

    if (isPanelOpen) {
      lastPanelOpenTime = Date.now();
      panel.classList.remove('hidden');
      panel.style.setProperty('display', 'flex', 'important');
      panel.style.setProperty('opacity', '1', 'important');
      panel.style.setProperty('visibility', 'visible', 'important');
      panel.style.setProperty('transform', 'none', 'important');
      panel.style.setProperty('pointer-events', 'auto', 'important');
      panel.style.setProperty('z-index', '99999999', 'important');

      // 全屏暗黑高对比度背景遮罩同步呈现
      if (panelMask) {
        panelMask.classList.remove('hidden');
        panelMask.style.setProperty('display', 'block', 'important');
        panelMask.style.setProperty('opacity', '1', 'important');
        panelMask.style.setProperty('visibility', 'visible', 'important');
        panelMask.style.setProperty('pointer-events', 'auto', 'important');
        panelMask.style.setProperty('z-index', '99999990', 'important');
      }

      // 面板打开时立即隐藏并完全穿透右上角触控热区，杜绝遮挡返回大屏与网卡卡片按钮
      if (touchTriggerEl) {
        touchTriggerEl.style.setProperty('display', 'none', 'important');
        touchTriggerEl.style.setProperty('pointer-events', 'none', 'important');
        touchTriggerEl.style.setProperty('visibility', 'hidden', 'important');
        touchTriggerEl.style.setProperty('width', '0px', 'important');
        touchTriggerEl.style.setProperty('height', '0px', 'important');
      }
      try { loadSystemInfo(); } catch (e) { console.warn(e); }
      try { loadAutostartStatus(); } catch (e) { console.warn(e); }
      try { loadFullscreenStatus(); } catch (e) { console.warn(e); }
      try { if (typeof loadPlayerMonitorsList === 'function') loadPlayerMonitorsList(); } catch (e) {}
      try { if (typeof loadPanelScheduledShutdown === 'function') loadPanelScheduledShutdown(); } catch (e) {}
    } else {
      panel.classList.add('hidden');
      panel.style.setProperty('display', 'none', 'important');
      panel.style.setProperty('opacity', '0', 'important');
      panel.style.setProperty('visibility', 'hidden', 'important');
      panel.style.setProperty('pointer-events', 'none', 'important');

      if (panelMask) {
        panelMask.classList.add('hidden');
        panelMask.style.setProperty('display', 'none', 'important');
        panelMask.style.setProperty('opacity', '0', 'important');
        panelMask.style.setProperty('visibility', 'hidden', 'important');
        panelMask.style.setProperty('pointer-events', 'none', 'important');
      }

      // 面板隐藏后恢复右上角触控热区
      if (touchTriggerEl) {
        touchTriggerEl.style.removeProperty('display');
        touchTriggerEl.style.removeProperty('pointer-events');
        touchTriggerEl.style.removeProperty('visibility');
        touchTriggerEl.style.removeProperty('width');
        touchTriggerEl.style.removeProperty('height');
        touchTriggerEl.style.width = '240px';
        touchTriggerEl.style.height = '240px';
        touchTriggerEl.style.display = 'block';
        touchTriggerEl.style.pointerEvents = 'auto';
      }
    }
  }
  window.togglePanel = togglePanel;

// 触控大屏 / 鼠标交互专用：右上角连续点击 5 次唤出抽屉 (过程静默计数，彻底杜绝闪退跳过)
  let cornerTouchCount = 0;
  let lastCornerTouchTime = 0;
  let lastRegisterTimestamp = 0;
  let cornerIndicatorTimer = null;

  function showCornerIndicator(count) {
    const ind = document.getElementById('touch-corner-indicator');
    if (!ind) return;
    clearTimeout(cornerIndicatorTimer);
    // 严格按要求：点击 1~4 次过程完全静默，不弹出任何气泡扰屏
    if (count < 5) {
      ind.style.display = 'none';
      ind.style.opacity = '0';
      return;
    }
    // 达到 5 次成功唤出时，极轻量反馈并迅速隐去
    ind.textContent = '🚀 受控面板已唤出';
    ind.style.borderColor = '#10b981';
    ind.style.color = '#34d399';
    ind.style.boxShadow = '0 0 20px rgba(16,185,129,0.5)';
    ind.style.display = 'block';
    ind.style.opacity = '1';
    cornerIndicatorTimer = setTimeout(() => {
      ind.style.opacity = '0';
      setTimeout(() => { ind.style.display = 'none'; }, 200);
    }, 1000);
  }

  function registerCornerHit(e) {
    if (isPanelOpen) return;
    const now = Date.now();
    // 物理点击防抖：140ms 内相同物理点击只计一次
    if (now - lastRegisterTimestamp < 140) {
      return;
    }
    lastRegisterTimestamp = now;

    // 超过 3.5 秒无后续点击，重置为 1
    if (now - lastCornerTouchTime > 3500) {
      cornerTouchCount = 1;
    } else {
      cornerTouchCount++;
    }
    lastCornerTouchTime = now;
    console.log('[VisualCast] 右上角点击静默计数: ' + cornerTouchCount + '/5');
    showCornerIndicator(cornerTouchCount);

    if (cornerTouchCount >= 5) {
      cornerTouchCount = 0;
      if (isBlackout) {
        setBlackout(false);
      }
      togglePanel(true);
    }
  }

  if (touchTriggerEl) {
    const handleCornerEvent = function(e) {
      if (isPanelOpen) return;
      e.stopPropagation();
      registerCornerHit(e);
    };
    touchTriggerEl.addEventListener('pointerdown', handleCornerEvent, { passive: true });
    touchTriggerEl.addEventListener('touchstart', handleCornerEvent, { passive: true });
    touchTriggerEl.addEventListener('click', handleCornerEvent);
  }

  // 全局保底监听：如果任何鼠标/触控指针点击落在右上角 240×240px 范围 (排除面板展开中及面板内元素)
  const handleGlobalCorner = function(e) {
    if (isPanelOpen) return;
    if (e.target && e.target.closest && (e.target.closest('#control-panel') || e.target.closest('#control-panel-mask'))) return;
    let clientX = e.clientX;
    let clientY = e.clientY;
    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    }
    const w = window.innerWidth || 1920;
    if (clientX !== undefined && clientY !== undefined && clientX > w - 240 && clientY < 240) {
      registerCornerHit(e);
    }
  };
  window.addEventListener('pointerdown', handleGlobalCorner, { passive: true });
  window.addEventListener('touchstart', handleGlobalCorner, { passive: true });

  // 面板返回大屏 / 关闭按钮 (带 1200ms 面板展开保护锁与 350ms 防抖，杜绝 5 击过程中的惯性点击导致秒关跳过)
  let lastClosePanelTime = 0;
  function doClosePanel(e) {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    const now = Date.now();
    // 核心保护：面板刚展开 1200ms 内严格禁止任何关闭触发，防止连续敲击第 5 次时的手指惯性砸中右上角关闭按钮导致直接跳过！
    if (now - lastPanelOpenTime < 1200) {
      console.log('[VisualCast] 过滤面板唤出瞬间的惯性误触关闭');
      return;
    }
    if (now - lastClosePanelTime < 350) return;
    lastClosePanelTime = now;
    cornerTouchCount = 0;
    togglePanel(false);
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', doClosePanel);
  }
  if (panelMask) {
    panelMask.addEventListener('click', doClosePanel);
  }

  // 阻止面板内部点击冒泡
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

  // 键盘快捷键监听
  window.addEventListener('keydown', function(e) {
    var k = (e.key || '').toLowerCase();
    var code = e.keyCode || e.which || 0;
    if (k === 'h' || code === 72 || code === 82 || e.code === 'KeyH') {
      togglePanel();
    } else if (k === 'escape' || code === 27) {
      togglePanel(false);
    }
  });

  function updateFullscreenBtn(isFs) {
    if (!btnToggleFs) return;
    if (isFs) {
      btnToggleFs.textContent = '🗗 退出全屏';
      btnToggleFs.classList.add('highlight');
      btnToggleFs.title = '点击退出全屏缩小为 1280×720 居中窗口并解除置顶，露出 Windows 任务栏便于调试工程软件';
    } else {
      btnToggleFs.textContent = '⛶ 恢复全屏置顶';
      btnToggleFs.classList.remove('highlight');
      btnToggleFs.title = '点击瞬间恢复全屏无边框置顶模式，进入纯净播映状态';
    }
  }

  async function loadFullscreenStatus() {
    try {
      const res = await fetch('/api/player/window_mode');
      const data = await res.json();
      if (data.status === 'ok') {
        updateFullscreenBtn(data.fullscreen);
      }
    } catch (e) {}
  }

  if (btnToggleFs) {
    btnToggleFs.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/player/toggle_fullscreen', { method: 'POST' });
        const data = await res.json();
        updateFullscreenBtn(data.fullscreen);
      } catch (e) {
        console.error('切换全屏运维模式异常:', e);
      }
    });
  }

  // 物理显示器检测与无缝跨屏切换 (受控端大屏快捷面板)
  async function loadPlayerMonitorsList() {
    const sel = document.getElementById('player-select-monitor');
    const row = document.getElementById('player-monitors-row');
    if (!sel || !row) return;
    try {
      const res = await fetch('/api/system/monitors');
      const data = await res.json();
      if (data.status === 'ok' && data.monitors && data.monitors.length > 1) {
        sel.innerHTML = '';
        data.monitors.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.index;
          opt.textContent = `${m.name || `屏幕 ${m.index + 1}`} (${m.width}x${m.height})`;
          if (m.is_primary) opt.textContent += ' [主屏]';
          sel.appendChild(opt);
        });
        const curIdx = (data.current_monitor_index !== undefined) ? data.current_monitor_index : (data.target_index !== undefined ? data.target_index : 0);
        sel.value = curIdx;
        row.style.display = 'block';
      } else {
        row.style.display = 'none';
      }
    } catch (e) {
      row.style.display = 'none';
    }
  }

  const playerSelectMonitor = document.getElementById('player-select-monitor');
  if (playerSelectMonitor) {
    playerSelectMonitor.addEventListener('change', async (e) => {
      const targetIdx = parseInt(e.target.value) || 0;
      try {
        await fetch('/api/system/monitors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: targetIdx, monitor_index: targetIdx })
        });
      } catch (err) {}
    });
  }

  // 大屏端悬浮翻页按钮点击事件
  if (screenBtnDocPrev) {
    screenBtnDocPrev.addEventListener('click', async () => {
      navPdfPage(-1);
      await fetch('/api/player/send_key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'PGUP' })
      }).catch(() => {});
    });
  }

  if (screenBtnDocNext) {
    screenBtnDocNext.addEventListener('click', async () => {
      navPdfPage(1);
      await fetch('/api/player/send_key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'PGDN' })
      }).catch(() => {});
    });
  }

  if (screenBtnDocExit) {
    screenBtnDocExit.addEventListener('click', async () => {
      await fetch('/api/player/send_key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'ESC' })
      }).catch(() => {});
      await fetch('/api/player/close_ppt', { method: 'POST' }).catch(() => {});
      await fetch('/api/player/return_idle', { method: 'POST' }).catch(() => {});
      updateScreenDocTouchBar(false);
    });
  }

  // 2. 开机自启动读取与设置
  async function loadAutostartStatus() {
    if (!chkAutostart) return;
    try {
      const res = await fetch('/api/system/autostart');
      const data = await res.json();
      if (data.status === 'ok') {
        chkAutostart.checked = !!data.enabled;
      }
    } catch (e) {}
  }

  function showPlayerToast(msg, title = '系统通知') {
    const usbToast = document.getElementById('usb-toast');
    const usbDesc = document.getElementById('usb-desc');
    const usbTitle = usbToast ? usbToast.querySelector('.usb-title') : null;
    if (usbToast && usbDesc) {
      if (usbTitle) usbTitle.textContent = title;
      usbDesc.textContent = msg;
      usbToast.classList.remove('hidden');
      clearTimeout(window._playerToastTimer);
      window._playerToastTimer = setTimeout(() => {
        usbToast.classList.add('hidden');
      }, 3500);
    }
  }
  window.showPlayerToast = showPlayerToast;
  window.showToast = showPlayerToast;

  if (chkAutostart) {
    chkAutostart.addEventListener('change', async () => {
      try {
        const res = await fetch('/api/system/autostart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enable: chkAutostart.checked })
        });
        const data = await res.json();
        if (data.status === 'ok') {
          showPlayerToast(chkAutostart.checked ? '✅ 软件开机自启动已开启并永久固化' : '软件开机自启动已关闭', '自启动配置');
        } else {
          showPlayerToast('自启设置异常: ' + (data.message || '未知错误'), '配置失败');
        }
      } catch (e) {
        showPlayerToast('设置开机自启网络异常', '错误');
      }
    });
  }

  // 大屏端快捷上传素材 (按用户最新指令：所有上传素材无论类型强制直接存入待机文件夹并自动轮播)
  const btnPlayerUpload = document.getElementById('btn-player-upload-media');
  const playerFileInput = document.getElementById('player-file-input');
  if (btnPlayerUpload && playerFileInput) {
    btnPlayerUpload.addEventListener('click', (e) => {
      if (btnPlayerUpload.tagName.toLowerCase() !== 'label') {
        playerFileInput.click();
      }
    });

    playerFileInput.addEventListener('change', async (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const total = files.length;
      showPlayerToast(`📤 开始上传 ${total} 个素材至待机文件夹...`, '素材上传');

      let successCount = 0;
      let lastUploadedName = '';
      // 严格要求：播放端上传素材直接存入待机文件夹
      const folder = '待机';

      for (let i = 0; i < total; i++) {
        const f = files[i];
        try {
          const uploadUrl = `/api/media/upload_raw?folder=${encodeURIComponent(folder)}&filename=${encodeURIComponent(f.name)}`;
          const res = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Filename': encodeURIComponent(f.name),
              'X-Folder': encodeURIComponent(folder)
            },
            body: f
          });
          const ret = await res.json().catch(() => null);
          if (res.ok && ret && (ret.status === 'ok' || ret.filename || ret.name)) {
            successCount++;
            lastUploadedName = f.name;
          }
        } catch (err) {
          console.warn('[VisualCast] 大屏直传待机异常:', err);
        }
      }

      playerFileInput.value = '';
      if (successCount > 0) {
        showPlayerToast(`🎉 成功存入 ${successCount}/${total} 个素材至待机文件夹，正在自动起播...`, '上传成功');
        currentFolder = '待机';
        currentMode = 'ATTRACT';
        await updateMediaLibraryCache();
        refreshPlaylist();
        if (lastUploadedName && currentPlaylist.some(m => m.name === lastUploadedName)) {
          switchMedia(lastUploadedName, true, true);
        } else if (currentPlaylist.length > 0) {
          switchMedia(currentPlaylist[0], true, true);
        }
      } else {
        showPlayerToast(`❌ 素材上传失败，请检查网络或存储权限`, '错误');
      }
    });
  }

  // 3. 加载系统信息、网卡列表与第三方应用列表
  const selectNetCard = document.getElementById('select-network-card');
  const btnToggleOrientation = document.getElementById('btn-toggle-orientation');

  async function loadSystemInfo() {
    try {
      const res = await fetch('/api/system/info');
      const data = await res.json();
      if (data.status === 'ok') {
        const netInterfaces = data.network_interfaces || [];
        const savedIp = data.selected_ip || '';

        if (selectNetCard) {
          selectNetCard.innerHTML = '';
          if (netInterfaces.length > 0) {
            netInterfaces.forEach(net => {
              const opt = document.createElement('option');
              opt.value = net.ip;
              opt.textContent = net.display_name || `${net.name} (${net.ip})`;
              if (savedIp ? (net.ip === savedIp) : net.is_primary) {
                opt.selected = true;
              }
              selectNetCard.appendChild(opt);
            });
          } else {
            const ips = data.ips && data.ips.length > 0 ? data.ips : ['127.0.0.1'];
            ips.forEach(ip => {
              const opt = document.createElement('option');
              opt.value = ip;
              opt.textContent = `局域网: ${ip}`;
              if (ip === savedIp) opt.selected = true;
              selectNetCard.appendChild(opt);
            });
          }
        }

        const activeIp = selectNetCard && selectNetCard.value ? selectNetCard.value : (savedIp || (data.ips && data.ips.length > 0 ? data.ips[0] : '127.0.0.1'));
        updateConnectionUrls(activeIp);

        cachedApps = data.external_apps || [];
        renderAppsList(cachedApps);
      }
    } catch (e) {
      console.warn('获取系统信息失败:', e);
    }
  }

  function updateConnectionUrls(ip) {
    if (!ip) ip = '127.0.0.1';
    if (webUrlEl) webUrlEl.textContent = `http://${ip}:8088`;
    if (remoteUrlEl) remoteUrlEl.textContent = `http://${ip}:8088/remote`;
    const playerNetBadge = document.getElementById('player-net-badge');
    if (playerNetBadge) playerNetBadge.textContent = `${ip}:8088`;
  }

  if (selectNetCard) {
    selectNetCard.addEventListener('change', async (e) => {
      const selectedIp = e.target.value;
      updateConnectionUrls(selectedIp);
      try {
        await fetch('/api/system/select_network_interface', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ip: selectedIp })
        });
      } catch (err) {}
    });
  }

  function updatePlayerSysBadge() {
    const playerSysBadge = document.getElementById('player-sys-badge');
    if (!playerSysBadge) return;
    const isFs = !btnToggleFs || btnToggleFs.classList.contains('highlight');
    const isPort = currentOrientation && currentOrientation.startsWith('portrait');
    playerSysBadge.textContent = `${isFs ? '全屏置顶' : '窗口模式'} · ${isPort ? '竖屏' : '横屏'}`;
  }

  if (btnToggleOrientation) {
    btnToggleOrientation.addEventListener('click', async () => {
      const nextOri = currentOrientation.startsWith('portrait') ? 'landscape' : 'portrait';
      setScreenOrientation(nextOri);
      updatePlayerSysBadge();
      try {
        await fetch('/api/player/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'SET_ORIENTATION', params: { orientation: nextOri } })
        });
      } catch (e) {}
    });
  }

  function renderAppsList(apps) {
    const playerAppsBadge = document.getElementById('player-apps-badge');
    if (playerAppsBadge) {
      playerAppsBadge.textContent = (apps && apps.length > 0) ? `${apps.length} 个程序` : '0 个程序';
      playerAppsBadge.className = 'player-collapsible-badge ' + ((apps && apps.length > 0) ? 'online' : '');
    }
    regAppsList.innerHTML = '';
    if (!apps || apps.length === 0) {
      regAppsList.innerHTML = '<span style="font-size:11px;color:#64748b;padding:6px;">暂无配置外部程序</span>';
      return;
    }
    apps.forEach(app => {
      const item = document.createElement('div');
      item.className = 'app-item-card';
      item.innerHTML = `
        <div class="app-item-info" title="点击启动: ${app.path}">
          <span>🚀</span>
          <span class="app-item-name">${app.name}</span>
        </div>
        <div class="app-item-actions">
          <button class="app-action-btn kill" title="强行结束此程序进程" style="color:#ef4444;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);">⏹</button>
          <button class="app-action-btn edit" title="编辑应用">✏️</button>
          <button class="app-action-btn del" title="删除应用">🗑</button>
        </div>
      `;
      // 点击信息区域直接启动
      item.querySelector('.app-item-info').addEventListener('click', () => {
        fetch('/api/system/launch_app', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: app.path, args: app.args || '' })
        });
      });
      // 结束进程
      item.querySelector('.app-action-btn.kill').addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch('/api/system/kill_app', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: app.path, name: app.name })
        });
      });
      // 编辑
      item.querySelector('.app-action-btn.edit').addEventListener('click', (e) => {
        e.stopPropagation();
        inputAppId.value = app.id;
        inputAppName.value = app.name;
        inputAppPath.value = app.path;
        btnSaveApp.textContent = '确认修改应用';
        btnCancelAppEdit.classList.remove('hidden');
      });
      // 删除
      item.querySelector('.app-action-btn.del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`确定删除外部程序【${app.name}】吗？`)) {
          cachedApps = cachedApps.filter(a => a.id !== app.id);
          await saveAppsToServer();
          renderAppsList(cachedApps);
          if (inputAppId.value === app.id) resetAppForm();
        }
      });
      regAppsList.appendChild(item);
    });
  }

  async function saveAppsToServer() {
    await fetch('/api/system/save_apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apps: cachedApps })
    });
  }

  function resetAppForm() {
    inputAppId.value = '';
    inputAppName.value = '';
    inputAppPath.value = '';
    btnSaveApp.textContent = '确认保存应用';
    btnCancelAppEdit.classList.add('hidden');
  }

  // 浏览选择程序文件 (.exe / .lnk)
  if (btnBrowseApp) {
    btnBrowseApp.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/system/file_dialog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filter: 'exe' })
        });
        const data = await res.json();
        if (data.status === 'ok' && data.path) {
          inputAppPath.value = data.path;
          if (!inputAppName.value.trim() && data.name) {
            inputAppName.value = data.name;
          }
        }
      } catch (e) {
        console.warn('打开文件选择器失败:', e);
      }
    });
  }

  if (btnCancelAppEdit) {
    btnCancelAppEdit.addEventListener('click', resetAppForm);
  }

  // 保存或更新第三方应用
  btnSaveApp.addEventListener('click', async () => {
    const name = inputAppName.value.trim();
    const path = inputAppPath.value.trim();
    const editId = inputAppId.value;
    if (!name || !path) {
      alert('请输入应用显示名称和程序绝对路径（或点击浏览选择）！');
      return;
    }
    if (editId) {
      const idx = cachedApps.findIndex(a => a.id === editId);
      if (idx !== -1) {
        cachedApps[idx].name = name;
        cachedApps[idx].path = path;
      }
    } else {
      cachedApps.push({ id: `app_${Date.now()}`, name, path, args: '' });
    }
    await saveAppsToServer();
    resetAppForm();
    renderAppsList(cachedApps);
  });



  // 5. 全格式媒体切换与点对点渲染
  
    // 工业级全媒体异常与停滞卡死自愈保护 (真·无人值守 7x24h 守护)
    [videoA, videoB].forEach(function(v) {
      if (!v) return;
      v.addEventListener('error', function(err) {
        if (isSystemSleeping) return; // 待机卸载触发的 error 绝不切曲！
        console.warn('[VisualCast] 视频解码异常，启动平滑自愈切播:', err);
        setTimeout(function() {
          if (!isSystemSleeping && typeof playNextTrack === 'function') playNextTrack();
        }, 800);
      });
    });

    if (imgEl) {
      imgEl.addEventListener('error', function(err) {
        if (isSystemSleeping) return;
        console.warn('[VisualCast] 图片素材加载异常，启动平滑自愈切播:', err);
        setTimeout(function() {
          if (!isSystemSleeping && currentMediaType === 'image' && typeof playNextTrack === 'function') {
            playNextTrack();
          }
        }, 1200);
      });
    }

    // 视频硬件解码停滞看门狗守护：针对坏损宏块导致 currentTime 永久定格的视频执行平滑跳切
    let lastWatchdogTime = -1;
    let freezeStallCount = 0;
    setInterval(function() {
      if (isSystemSleeping) return; // 待机休眠中坚决停止看门狗切曲
      if (currentMediaType === 'video' && !isExplicitlyStopped && !isBlackout && !isFrozen) {
        if (activeVideoEl && !activeVideoEl.paused && !activeVideoEl.ended && activeVideoEl.readyState >= 2) {
          const cur = activeVideoEl.currentTime;
          if (lastWatchdogTime >= 0 && Math.abs(cur - lastWatchdogTime) < 0.05) {
            freezeStallCount++;
            if (freezeStallCount >= 3) { // 连续 9 秒 currentTime 未推进，触发自愈
              console.warn('[VisualCast] 硬件看门狗感知视频解码死锁定格，自动平滑切播下一项素材');
              freezeStallCount = 0;
              lastWatchdogTime = -1;
              if (typeof playNextTrack === 'function') playNextTrack();
            }
          } else {
            freezeStallCount = 0;
            lastWatchdogTime = cur;
          }
        } else {
          freezeStallCount = 0;
          lastWatchdogTime = -1;
        }
      } else {
        freezeStallCount = 0;
        lastWatchdogTime = -1;
      }
    }, 3000);

  function switchMedia(mediaItem, autoPlay = true, forceReload = false, forceWake = false) {
    if (typeof autoPlay === 'string' && typeof forceReload === 'string') {
      const f = mediaItem;
      const m = autoPlay;
      const l = forceReload;
      if (f) currentFolder = f;
      if (l) loopMode = l;
      mediaItem = m || f;
      autoPlay = true;
      forceReload = true;
    }
    if (!mediaItem) return;
    if (isSystemSleeping && !forceWake) {
      console.log('[VisualCast] 当前处于大屏待机休眠态，拦截非唤醒性切播请求:', mediaItem);
      return;
    }
    isExplicitlyStopped = false;
    if (isSystemSleeping) {
      isSystemSleeping = false;
      document.body.classList.remove('system-sleeping');
    }
    // 关键自愈：切播/点播任何新素材时，解除黑场遮罩，恢复画面可见
    if (isBlackout) {
      setBlackout(false);
    }
    let filename = typeof mediaItem === 'object' ? (mediaItem.name || '') : mediaItem;
    let customUrl = typeof mediaItem === 'object' ? (mediaItem.url || '') : '';
    let customType = typeof mediaItem === 'object' ? (mediaItem.type || '') : '';
    let customConfig = typeof mediaItem === 'object' ? (mediaItem.config || {}) : {};

    currentMediaName = filename;
    const ext = filename.split('.').pop().toLowerCase();
    // 核心优化：支持多级子文件夹安全路径，同时允许浏览器利用 HTTP Range 缓存
    let mediaUrl = customUrl;
    if (!mediaUrl || mediaUrl.startsWith('/media/')) {
      mediaUrl = '/media/' + filename.split('/').map(encodeURIComponent).join('/');
    }

    // 清理图片与文档轮播定时器
    if (imageTimer) {
      clearTimeout(imageTimer);
      imageTimer = null;
    }
    if (docTimer) {
      clearTimeout(docTimer);
      docTimer = null;
    }

    // 播放新媒体时自动关闭可能展示的投屏连接看板
    hideCastBoard();

    // 清理可能存在的旧 Hls 实例
    if (window.activeHls) {
      try {
        window.activeHls.destroy();
      } catch (e) {}
      window.activeHls = null;
    }

    // 隐藏主媒体图层，彻底暂停并重置音频
    if (mainAudioEl) {
      try {
        mainAudioEl.pause();
        mainAudioEl.currentTime = 0;
        mainAudioEl.removeAttribute('src');
        mainAudioEl.load();
      } catch (e) {}
    }
    // 仅在切换非视频类型时，才隐藏视频图层；若新切媒体是视频，由视频双缓冲流水线内部交接，严禁提前清空 active
    const isNewMediaVideo = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'flv'].includes(ext);
    if (!isNewMediaVideo) {
      videoA.pause();
      videoB.pause();
      videoA.classList.remove('active');
      videoB.classList.remove('active');
    }
    imgEl.classList.remove('active');
    frameEl.classList.remove('active');
    audioVisEl.classList.remove('active');
    updateScreenDocTouchBar(false);

    // 如果当前正在放映 PPT 且新切换的不是 PPT，自动联动关闭外部 PPT 窗口
    if (currentMediaType === 'ppt' && !['pptx', 'ppt'].includes(ext)) {
      fetch('/api/player/close_ppt', { method: 'POST' }).catch(() => {});
    }

    // 1. 跑马灯字幕 (独立悬浮覆盖层)
    if (customType === 'subtitle' || ext === 'srt' || ext === 'vtt') {
      const text = customUrl || filename;
      applySubtitleConfig({
        enabled: true,
        text: text,
        font_size: customConfig.fontSize || 42,
        color: customConfig.color || '#ffffff',
        speed: customConfig.speed || 20
      });
      return;
    }

    // 2. 网络直播流 (M3U8 / FLV / 直播流) - 必须优先于网页嵌入，防止 M3U8 被送入 iframe 唤起外部 PotPlayer 弹窗导致黑屏
    const isStream = (
      customType === 'stream' ||
      ext === 'm3u8' ||
      ext === 'flv' ||
      mediaUrl.includes('.m3u8') ||
      mediaUrl.includes('.flv') ||
      mediaUrl.startsWith('rtmp://') ||
      mediaUrl.startsWith('rtsp://')
    );

    if (isStream) {
      currentMediaType = 'stream';
      activeVideoEl.classList.add('active');
      activeVideoEl.loop = false;

      if (window.Hls && Hls.isSupported() && (mediaUrl.includes('.m3u8') || customType === 'stream')) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 20,
          manifestLoadingTimeOut: 15000,
          manifestLoadingMaxRetry: 8,
          levelLoadingTimeOut: 15000,
          levelLoadingMaxRetry: 8,
          fragLoadingTimeOut: 20000,
          fragLoadingMaxRetry: 8
        });
        window.activeHls = hls;
        hls.loadSource(mediaUrl);
        hls.attachMedia(activeVideoEl);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (autoPlay) activeVideoEl.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.warn('[VisualCast] 直播流网络抖动(可能受代理或网络波动影响)，自动重试加载分片...', data);
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.warn('[VisualCast] 直播流解码同步异常，自动恢复...', data);
                hls.recoverMediaError();
                break;
              default:
                console.error('[VisualCast] 直播流出现致命异常，2秒后自动平滑重连:', data);
                setTimeout(() => {
                  if (currentMediaType === 'stream' && window.activeHls === hls) {
                    hls.loadSource(mediaUrl);
                  }
                }, 2000);
                break;
            }
          }
        });
      } else {
        // 原生 HLS / HTTP 流播放兜底
        activeVideoEl.src = mediaUrl;
        if (autoPlay) activeVideoEl.play().catch(() => {});
      }
      return;
    }

// 3. 网页 / H5 展项全屏嵌入 (支持 customType === 'web'，或 .txt 存储的网页链接)
    if (customType === 'web' || ['html', 'htm'].includes(ext) || ext === 'txt') {
      currentMediaType = 'frame';
      let targetUrl = customUrl;
      
      // 若是 .txt 文件，通过 fetch 读取其中的网页地址或直播流
      if (!targetUrl && ext === 'txt') {
        fetch(mediaUrl).then(r => r.text()).then(txt => {
          let u = txt.trim();
          if (!u) return;
          const lines = u.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
          let effectiveUrl = lines.length > 0 ? lines[0] : u;
          if (effectiveUrl.toLowerCase().startsWith('url=')) effectiveUrl = effectiveUrl.substring(4).trim();
          
          const uLower = effectiveUrl.toLowerCase();
          const isStream = uLower.includes('.m3u8') || uLower.includes('.flv') || uLower.startsWith('rtsp://') || uLower.startsWith('rtmp://');
          if (isStream) {
            console.log('[VisualCast] 检测到 txt 文件内为直播流，转入流媒体解码管线:', effectiveUrl);
            switchMedia({ name: filename, url: effectiveUrl, type: 'stream' }, autoPlay, forceReload);
          } else {
            console.log('[VisualCast] 检测到 txt 文件内为网页链接，转入全屏网页嵌入:', effectiveUrl);
            if (!effectiveUrl.startsWith('http://') && !effectiveUrl.startsWith('https://')) {
              effectiveUrl = 'http://' + effectiveUrl;
            }
            frameEl.setAttribute('allow', 'fullscreen; autoplay; camera; microphone');
            frameEl.setAttribute('sandbox', 'allow-forms allow-scripts allow-same-origin allow-popups allow-downloads allow-presentation');
            frameEl.referrerPolicy = 'no-referrer';
            frameEl.src = effectiveUrl;
            frameEl.classList.add('active');
          }
        }).catch(err => {
          console.warn('[VisualCast] 读取 txt 网页/流码文件异常:', err);
        });
        videoA.pause();
        videoB.pause();
        return;
      } else {
        if (targetUrl && !targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
          targetUrl = 'http://' + targetUrl;
        }
        frameEl.setAttribute('allow', 'fullscreen; autoplay; camera; microphone');
        frameEl.setAttribute('sandbox', 'allow-forms allow-scripts allow-same-origin allow-popups allow-downloads allow-presentation');
        frameEl.referrerPolicy = 'no-referrer';
        frameEl.src = targetUrl || mediaUrl;
        frameEl.classList.add('active');
      }
      
      videoA.pause();
      videoB.pause();
      return;
    }

    lastActivityTime = Date.now();

    // 4. 本地视频 (广播级双缓冲无缝秒切流水线，大文件零黑闪)
    if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'flv'].includes(ext)) {
      currentMediaType = 'video';
      const targetVideo = (activeVideoEl === videoA) ? videoB : videoA;
      const oldVideo = activeVideoEl;

      // 如果是相同视频 (无论正在播还是刚播完)，原地重置时间继续播放，实现广播级 0 黑闪
      if (!forceReload && oldVideo.getAttribute('data-src') === mediaUrl && oldVideo.readyState >= 2) {
        oldVideo.classList.add('active');
        oldVideo.loop = (loopMode === 'SINGLE_LOOP');
        if (oldVideo.ended) {
          oldVideo.currentTime = 0;
        }
        if (oldVideo.paused && autoPlay) oldVideo.play().catch(() => {});
        return;
      }

      const activeUrl = forceReload ? (mediaUrl + (mediaUrl.includes('?') ? '&' : '?') + '_t=' + Date.now()) : mediaUrl;

      // 在备用底图层初始化新视频流 (旧视频画面保持显示，绝对零黑屏)
      targetVideo.volume = oldVideo.volume;
      targetVideo.muted = oldVideo.muted;
      targetVideo.loop = (loopMode === 'SINGLE_LOOP');
      targetVideo.setAttribute('data-src', mediaUrl);
      targetVideo.src = activeUrl;
      try { targetVideo.load(); } catch (e) {}

      let swapped = false;
      let swapTimer = null;
      const onReadyToSwap = () => {
        if (swapped) return;
        swapped = true;
        if (swapTimer) { clearTimeout(swapTimer); swapTimer = null; }
        targetVideo.classList.add('active');
        oldVideo.classList.remove('active');
        oldVideo.pause();
        oldVideo.removeAttribute('src'); // 彻底释放旧大文件连接与解码器显存
        oldVideo.load();
        activeVideoEl = targetVideo;
      };

      // 核心广播级：仅当新视频真正起播并开始输出图像帧时才交接，杜绝提前交接导致的屏幕黑屏断层
      const onVideoProgress = () => {
        if (targetVideo.currentTime > 0 || targetVideo.readyState >= 3) {
          onReadyToSwap();
        }
      };

      targetVideo.addEventListener('playing', onReadyToSwap, { once: true });
      // 如果当前没有正在活跃播放的旧视频 (例如从待机、休眠或图片切换过来)，立即激活目标图层，杜绝黑屏等待
      if (!oldVideo.classList.contains('active') || oldVideo.paused) {
        targetVideo.classList.add('active');
        activeVideoEl = targetVideo;
      }

      targetVideo.addEventListener('error', function onVidErr(e) {
        console.warn('[VisualCast] 视频解码或加载失败:', mediaUrl, e);
        targetVideo.removeEventListener('error', onVidErr);
        if (currentMediaType === 'video') {
          switchMedia({ name: 'default_standby.jpg', url: '/static/default_standby.jpg', type: 'image' }, true, true);
        }
      }, { once: true });

      // 安卓硬解环境放宽到 2200ms 安全兜底，杜绝过早斩断旧视频
      swapTimer = setTimeout(() => {
        if (!swapped) {
          console.log('[VisualCast] 执行保护性切流交接');
          onReadyToSwap();
        }
      }, 2200);

      if (autoPlay) {
        const p = targetVideo.play();
        if (p !== undefined) {
          p.catch((err) => {
            console.warn('[VisualCast] 自动播放尝试受限，尝试静音强起破壁:', err);
            const origMuted = targetVideo.muted;
            targetVideo.muted = true;
            targetVideo.play().then(() => {
              if (!origMuted) {
                setTimeout(() => { targetVideo.muted = false; }, 300);
              }
            }).catch(e2 => console.error('[VisualCast] 静音强起仍失败:', e2));
          });
        }
      }
      return;
    }

    // 4. 图片
    if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].includes(ext)) {
      currentMediaType = 'image';
      const activeImgUrl = forceReload ? (mediaUrl + (mediaUrl.includes('?') ? '&' : '?') + '_t=' + Date.now()) : mediaUrl;
      imgEl.src = activeImgUrl;
      imgEl.classList.add('active');
      videoA.pause();
      videoB.pause();
      scheduleImageNext();
      return;
    }

    // 5. 音频 (独立专属 mainAudioEl 播放，杜绝与视频流水线图层冲突)
    if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'wma', 'm4a'].includes(ext)) {
      currentMediaType = 'audio';
      videoA.pause();
      videoB.pause();
      audioVisEl.classList.add('active');
      const titleEl = document.getElementById('audio-title');
      if (titleEl) titleEl.textContent = filename;

      if (mainAudioEl) {
        const activeAudioUrl = forceReload ? (mediaUrl + (mediaUrl.includes('?') ? '&' : '?') + '_t=' + Date.now()) : mediaUrl;
        mainAudioEl.src = activeAudioUrl;
        mainAudioEl.volume = activeVideoEl.volume;
        mainAudioEl.muted = activeVideoEl.muted;
        const shouldLoopSingle = (loopMode === 'SINGLE_LOOP');
        mainAudioEl.loop = shouldLoopSingle;
        if (autoPlay) {
          mainAudioEl.play().catch((err) => {
            console.warn('[VisualCast] 音频自动播放受限:', err);
          });
        }
        mainAudioEl.onended = () => {
          if (loopMode === 'SINGLE_LOOP') {
            mainAudioEl.currentTime = 0;
            mainAudioEl.play().catch(() => {});
            return;
          }
          if (loopMode === 'PLAY_ONCE') {
            console.log('[VisualCast] 音频单次播放完毕，保持静止');
            mainAudioEl.pause();
            return;
          }
          playNextTrack();
        };
      }
      return;
    }

    // 6. PDF 文档 (全屏高保真呈现，支持自动定时轮播与触控翻页，杜绝因外部阅读器缺失导致卡死)
    if (ext === 'pdf') {
      currentMediaType = 'frame';
      currentDocPage = 1;
      currentDocBaseUrl = mediaUrl;
      docPageCountInSession = 0;
      frameEl.src = `${mediaUrl}?page=1&_t=${Date.now()}#page=1&view=FitH&toolbar=0`;
      frameEl.classList.add('active');
      imgEl.classList.remove('active');
      updateScreenDocTouchBar(true, 'PDF 演示: 第 1 页');
      videoA.pause();
      videoB.pause();
      if (currentMode === 'ATTRACT' || loopMode !== 'PLAY_ONCE') {
        schedulePdfNext();
      }
      return;
    }

    // 7. PPT 及办公演示文档 (Word/Excel/PPT/WPS)：使用放映引擎覆盖全屏
    if (['pptx', 'ppt', 'pps', 'ppsx', 'doc', 'docx', 'wps', 'dps', 'et', 'xls', 'xlsx'].includes(ext)) {
      currentMediaType = 'ppt';
      const docLabel = (ext.startsWith('ppt') || ext.startsWith('pps')) ? 'PPT 演示放映中' : '文档放映中';
      updateScreenDocTouchBar(true, docLabel);
      try {
        videoA.pause();
        videoB.pause();
      } catch (e) {}

      // 待机模式保护：若处于待机轮播 (ATTRACT 或 FOLDER_LOOP)，启动 30 秒自动放映超时守护，避免待机卡死在外部文档
      if (currentMode === 'ATTRACT' || loopMode === 'FOLDER_LOOP') {
        if (docTimer) clearTimeout(docTimer);
        docTimer = setTimeout(() => {
          if (currentMediaType === 'ppt') {
            console.log('[VisualCast] 待机文档演示达到轮播周期，自动收回前台并轮播下一项');
            fetch('/api/player/close_ppt', { method: 'POST' }).catch(() => {});
            playNextTrack();
          }
        }, 30000);
      }

      fetch('/api/player/open_ppt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: filename })
      }).then(r => r.json()).then(res => {
        console.log('[VisualCast] 文档启动放映响应:', res);
        if (res && res.status === 'ok') {
          // 外部放映已成功调起，隐藏大屏网页图层
          imgEl.classList.remove('active');
          frameEl.classList.remove('active');
        } else {
          showPlayerToast('⚠️ 未能调起外部放映：' + ((res && res.message) || '请确保已安装金山 WPS Office'), '文档放映');
          setTimeout(() => {
            if (currentMediaType === 'ppt') {
              playNextTrack();
            }
          }, 2500);
        }
      }).catch(err => {
        console.warn('[VisualCast] 文档启动放映异常:', err);
        setTimeout(() => {
          if (currentMediaType === 'ppt') {
            playNextTrack();
          }
        }, 2000);
      });
      return;
    }
  }

  // 6. 播控调度指令处理
function applyCommand(cmd, directParams) {
    let type = '';
    let params = {};
    if (typeof cmd === 'string') {
      type = cmd.toUpperCase();
      params = directParams || {};
    } else if (cmd && typeof cmd === 'object') {
      type = (cmd.type || cmd.action || cmd.command || '').toUpperCase();
      params = cmd.params || directParams || {};
    }
    lastActivityTime = Date.now();

    switch (type) {
      case 'SET_TOUCH_MODE':
        if (params.touch_mode !== undefined) setTouchModeUI(!!params.touch_mode);
        break;
      case 'SHOW_CAST_BOARD':
      case 'CAST_TRIGGER':
        if (params.action === 'close') {
          hideCastBoard();
        } else {
          showCastBoard(params.device_name || params.name);
        }
        break;
      case 'HIDE_CAST_BOARD':
      case 'STOP_CAST':
        hideCastBoard();
        break;
      case 'SLEEP':
      case 'SHUTDOWN':
      case 'POWEROFF':
        console.log('[VisualCast] 收到待机指令：执行停止放映并开启黑场');
        isSystemSleeping = true;
        isExplicitlyStopped = true;
        stopMedia();
        setBlackout(true);
        break;
      case 'WAKEUP':
      case 'BOOT':
      case 'POWERON':
        console.log('[VisualCast] 收到唤醒指令：解除黑场、解除静音并播放待机素材');
        isSystemSleeping = false;
        isExplicitlyStopped = false;
        setBlackout(false);
        videoA.muted = false;
        videoB.muted = false;
        if (mainAudioEl) mainAudioEl.muted = false;
        returnToStandby(true);
        break;
      case 'TOGGLE_MENU':
      case 'TOGGLE_PANEL':
      case 'OPEN_PANEL':
      case 'CLOSE_PANEL':
        console.log('[VisualCast] 收到大屏菜单控制指令:', cmd, params);
        let targetMenuOpen = undefined;
        if (cmd === 'OPEN_PANEL') targetMenuOpen = true;
        else if (cmd === 'CLOSE_PANEL') targetMenuOpen = false;
        else if (params && params.open !== undefined) targetMenuOpen = !!params.open;
        if (typeof togglePanel === 'function') {
          togglePanel(targetMenuOpen);
        }
        break;
      case 'REFRESH_STREAM':
      case 'RELOAD_CURRENT':
        console.log('[VisualCast] 执行流媒体与当前展项刷新重载');
        if (currentMediaType === 'stream' && window.activeHls) {
          try { window.activeHls.startLoad(); } catch (e) {}
        } else if (currentMediaType === 'frame' && frameEl) {
          const curSrc = frameEl.src;
          frameEl.src = 'about:blank';
          setTimeout(() => { frameEl.src = curSrc; }, 60);
        } else if (currentMediaName) {
          switchMedia(currentMediaName, true, true, true);
        }
        break;
      case 'CHECK_LICENSE':
        checkScreenLicense();
        break;
      case 'PLAY':
      case 'RESUME':
        playCurrentMedia();
        break;
      case 'PAUSE':
        pauseCurrentMedia();
        break;
      case 'STOP':
        stopMedia();
        break;
      case 'TOGGLE_PLAY':
      case 'PLAY_PAUSE':
        togglePlayPause();
        break;
      case 'SEEK':
        if (params.time !== undefined) {
          const t = parseFloat(params.time);
          if (currentMediaType === 'video') activeVideoEl.currentTime = t;
          if (currentMediaType === 'audio' && mainAudioEl) mainAudioEl.currentTime = t;
        }
        break;
      case 'VOLUME':
        if (params.volume !== undefined) {
          const v = Math.max(0, Math.min(1, params.volume / 100));
          videoA.volume = v;
          videoB.volume = v;
          if (mainAudioEl) mainAudioEl.volume = v;
          if (v > 0) {
            videoA.muted = false;
            videoB.muted = false;
            if (mainAudioEl) mainAudioEl.muted = false;
          }
        }
        break;
      case 'MUTE':
        videoA.muted = !!params.muted;
        videoB.muted = !!params.muted;
        if (mainAudioEl) mainAudioEl.muted = !!params.muted;
        break;
      case 'SET_LOOP':
        isLoopMode = !!params.loop;
        loopMode = isLoopMode ? (loopMode === 'PLAY_ONCE' ? 'FOLDER_LOOP' : loopMode) : 'PLAY_ONCE';
        videoA.loop = (loopMode === 'SINGLE_LOOP');
        videoB.loop = (loopMode === 'SINGLE_LOOP');
        break;
      case 'SET_LOOP_MODE':
        if (params.loop_mode) {
          loopMode = params.loop_mode;
          isLoopMode = (loopMode !== 'PLAY_ONCE');
          videoA.loop = (loopMode === 'SINGLE_LOOP');
          videoB.loop = (loopMode === 'SINGLE_LOOP');
          if (params.folder !== undefined) currentFolder = params.folder;
          refreshPlaylist();
        }
        break;
      case 'PLAY_FOLDER':
        isExplicitlyStopped = false;
        isSystemSleeping = false;
        isBlackout = false;
        setBlackout(false);
        currentFolder = params.folder || '';
        loopMode = params.loop_mode || 'FOLDER_LOOP';
        isLoopMode = true;
        videoA.loop = false;
        videoB.loop = false;
        refreshPlaylist();
        if (currentPlaylist.length > 0) {
          currentPlayIndex = 0;
          switchMedia(currentPlaylist[0], true, true, true);
        }
        break;
      case 'SET_ORIENTATION':
        if (params.orientation) {
          setScreenOrientation(params.orientation);
        }
        break;
      case 'UPDATE_SUBTITLE':
        applySubtitleConfig(params);
        break;
      case 'TOGGLE_SUBTITLE':
        if (currentSubtitleConfig) {
          currentSubtitleConfig.enabled = !currentSubtitleConfig.enabled;
          applySubtitleConfig(currentSubtitleConfig);
        }
        break;
      case 'NEXT':
        isExplicitlyStopped = false;
        setBlackout(false);
        setFreeze(false);
        playNextTrack(true);
        break;
      case 'PREV':
        isExplicitlyStopped = false;
        setBlackout(false);
        setFreeze(false);
        playPrevTrack(true);
        break;
      case 'DOC_PREV':
      case 'PAGE_PREV':
        if (currentMediaType === 'image') navImageTrack(-1);
        else if (currentMediaType === 'frame') navPdfPage(-1);
        break;
      case 'DOC_NEXT':
      case 'PAGE_NEXT':
        if (currentMediaType === 'image') navImageTrack(1);
        else if (currentMediaType === 'frame') navPdfPage(1);
        break;
      case 'DOC_EXIT':
        fetch('/api/player/close_ppt', { method: 'POST' }).catch(() => {});
        returnToStandby();
        break;
      case 'SHOW_TOAST':
        showPlayerToast(params.message || params.msg || '', params.title || '系统通知');
        break;
      case 'SET_SCALE_MODE':
        if (params.scale_mode) setScaleMode(params.scale_mode);
        break;
      case 'BLACKOUT':
        const wantBlackout = params.blackout !== undefined ? !!params.blackout : (params.enabled !== undefined ? !!params.enabled : true);
        setBlackout(wantBlackout);
        if (wantBlackout) {
          isExplicitlyStopped = true;
          videoA.pause(); videoB.pause();
          if (imageTimer) { clearTimeout(imageTimer); imageTimer = null; }
        } else {
          isExplicitlyStopped = false;
          if (currentMediaType === 'video' && activeVideoEl && activeVideoEl.paused) {
            activeVideoEl.play().catch(() => {});
          } else if (currentMediaType === 'image' && !imageTimer) {
            scheduleImageNext();
          }
        }
        break;
      case 'FREEZE':
        setFreeze(!!params.freeze);
        break;
      case 'RETURN_TO_IDLE':
      case 'RETURN_TO_STANDBY':
        isSystemSleeping = false;
        isExplicitlyStopped = false;
        isBlackout = false;
        returnToStandby(true);
        break;
      case 'USB_MEDIA_UPDATED':
      case 'REFRESH_LIBRARY_AND_PLAY':
        console.log('[VisualCast] 收到 U 盘素材热更/自动播放指令，立即强制刷新媒体库并自动开播！', params);
        if (params.is_usb || params.from_usb || params.message || (params.count && params.count > 0)) {
          const toastMsg = params.message || (params.count ? `💾 检测到 U 盘接入，已同步 ${params.count} 个素材并自动播放` : '💾 检测到 U 盘接入，已自动同步待机素材');
          showPlayerToast(toastMsg, 'U 盘热同步');
        }
        isExplicitlyStopped = false;
        const plRef = document.getElementById('power-transition-layer');
        if (plRef) {
          plRef.classList.remove('active');
          plRef.classList.add('hidden');
          const prog = plRef.querySelector('.wake-progress-fill');
          if (prog) prog.style.width = '0%';
        }
        setBlackout(false);
        setFreeze(false);
        currentMode = 'ATTRACT';
        currentFolder = params.folder || '待机';
        loopMode = params.loop_mode || 'FOLDER_LOOP';
        videoA.loop = false;
        videoB.loop = false;
        updateMediaLibraryCache().then(() => {
          refreshPlaylist();
          let target = null;
          if (params.media) {
            target = currentPlaylist.find(m => m.name === params.media) || params.media;
          }
          if (!target && currentPlaylist.length > 0) {
            target = currentPlaylist[0];
          }
          if (target) {
            currentPlayIndex = 0;
            switchMedia(target, true, true);
          }
        }).catch(err => {
          console.warn('[VisualCast] 刷新媒体库后播放失败:', err);
          if (params.media) switchMedia(params.media, true, true);
        });
        break;
      case 'PLAY_MEDIA':
      case 'LOAD_AND_PLAY':
        console.log('[VisualCast] 收到点播指令，立即切播目标素材:', params);
        isExplicitlyStopped = false;
        isSystemSleeping = false;
        const plPlay = document.getElementById('power-transition-layer');
        if (plPlay) {
          plPlay.classList.remove('active');
          plPlay.classList.add('hidden');
          plPlay.style.display = 'none';
          const prog = plPlay.querySelector('.wake-progress-fill');
          if (prog) prog.style.width = '0%';
        }
        setBlackout(false);
        setFreeze(false);
        currentMode = params.mode || 'ON_DEMAND';
        if (params.folder !== undefined && params.folder !== '') currentFolder = params.folder;
        if (params.loop_mode) loopMode = params.loop_mode;
        lastActivityTime = Date.now();
        const targetMedia = params.media_item || params.media || params.name;
        if (targetMedia) {
          switchMedia(targetMedia, true, true);
        }
        break;
      case 'LOAD':
        currentMode = params.mode || 'ON_DEMAND';
        if (params.folder !== undefined) currentFolder = params.folder;
        if (params.media) switchMedia(params.media_item || params.media, false);
        break;
    }
  }

  function returnToStandby(forceWake = false) {
    console.log('[VisualCast] 执行返回待机放映, forceWake:', forceWake);
    isExplicitlyStopped = false;
    isSystemSleeping = false;
    isBlackout = false;
    document.body.classList.remove('system-sleeping');
    currentMode = 'ATTRACT';
    currentFolder = '待机';
    loopMode = 'FOLDER_LOOP';
    setBlackout(false);
    setFreeze(false);

    // 唤醒与待机放映核心要求：强制解除静音，确保声音正常输出
    videoA.muted = false;
    videoB.muted = false;
    if (mainAudioEl) mainAudioEl.muted = false;
    if (activeVideoEl && activeVideoEl.volume <= 0.01) {
      activeVideoEl.volume = 0.85;
      if (mainAudioEl) mainAudioEl.volume = 0.85;
    }

    if (blackoutMask) {
      blackoutMask.classList.remove('active');
      blackoutMask.style.display = 'none';
      blackoutMask.style.opacity = '0';
      blackoutMask.style.pointerEvents = 'none';
    }

    refreshPlaylist();
    const targetItem = (currentPlaylist.length > 0) ? currentPlaylist[0] : (idleMedia ? idleMedia : (cachedMediaList && cachedMediaList.length > 0 ? cachedMediaList[0] : null));
    const targetName = typeof targetItem === 'object' ? (targetItem ? targetItem.name : '') : (targetItem || '');

    // 关键防抖防重：若大屏已在正常播映待机素材，且正在播放中，绝对不要粗暴切断进度重新从 0 秒播！
    const isAlreadyPlayingTarget = (currentMediaName === targetName && activeVideoEl && !activeVideoEl.paused && !activeVideoEl.ended && activeVideoEl.currentTime > 0.05);
    if (!isAlreadyPlayingTarget) {
      currentPlayIndex = 0;
      if (targetItem) {
        switchMedia(targetItem, true, false, true);
      } else {
        switchMedia({ name: 'default_standby.jpg', url: '/static/default_standby.jpg', type: 'image' }, true, false, true);
      }
    } else {
      console.log('[VisualCast] 待机素材正在放映中 (' + targetName + ')，保持播放进度不重置');
    }

    // 随后异步拉取最新媒体库做增量校验，仅在目标素材真实变更时才平滑切播
    updateMediaLibraryCache().then(() => {
      refreshPlaylist();
      const updatedTarget = (currentPlaylist && currentPlaylist.length > 0) ? currentPlaylist[0] : ((cachedMediaList && cachedMediaList.length > 0) ? cachedMediaList[0] : null);
      const updatedName = typeof updatedTarget === 'object' ? (updatedTarget ? updatedTarget.name : '') : (updatedTarget || '');
      if (updatedTarget && currentMediaName !== updatedName) {
        currentPlayIndex = 0;
        switchMedia(updatedTarget, true, false, true);
      }
    }).catch(() => {});
  }
  function setMuted(muted) {
    const isM = !!muted;
    videoA.muted = isM;
    videoB.muted = isM;
    if (mainAudioEl) mainAudioEl.muted = isM;
  }
  window.setMuted = setMuted;
  window.returnToStandby = returnToStandby;
  window.applyCommand = applyCommand;
  window.switchMedia = switchMedia;

// 监听视频播完事件：根据 loopMode 四种循环策略驱动下一曲或重播
  function handleVideoEnded(e) {
    const v = e.target;
    if (currentMediaType === 'stream') return;

    if (loopMode === 'SINGLE_LOOP') {
      console.log('[VisualCast] 视频播放完成：执行单个循环重播');
      v.currentTime = 0;
      v.play().catch(() => {});
      return;
    }

    if (loopMode === 'PLAY_ONCE') {
      console.log('[VisualCast] 视频播放完成：单次播放模式，保持末帧暂停');
      v.pause();
      return;
    }

    // 目录循环 (FOLDER_LOOP) 或 全局循环 (ALL_LOOP)
    // 关键优化：若当前待播列表中仅单文件，直接平滑复用原地重播，彻底杜绝切片黑闪！
    const effectiveList = (typeof getEffectivePlaylist === 'function') ? getEffectivePlaylist() : currentPlaylist;
    if (effectiveList && effectiveList.length <= 1) {
      console.log('[VisualCast] 轮播列表仅单素材，直接平滑复用重播 (0黑闪)');
      v.currentTime = 0;
      v.play().catch(() => {});
      return;
    }

    playNextTrack();
  }

  videoA.addEventListener('ended', handleVideoEnded);
  videoB.addEventListener('ended', handleVideoEnded);

  // 定期检测点播模式无操作空闲超时
  setInterval(() => {
    if (isSystemSleeping) return; // 待机休眠黑场中绝不下发空闲返回待机！
    if (currentMode === 'ON_DEMAND' && idleTimeout > 0) {
      if (currentMediaType === 'stream' || isLoopMode) {
        return; // 循环播放模式与直播流豁免空闲回退
      }
      const elapsedSec = (Date.now() - lastActivityTime) / 1000;
      if (currentMediaType !== 'video' || activeVideoEl.paused || activeVideoEl.ended) {
        if (elapsedSec >= idleTimeout) {
          console.log(`[VisualCast] 点播空闲达 ${Math.round(elapsedSec)} 秒，自动恢复待机`);
          lastActivityTime = Date.now();
          fetch('/api/player/return_idle', { method: 'POST' }).catch(() => {});
        }
      }
    }
  }, 2500);


  let powerOffTimer = null;
  function triggerSystemPowerOff() {
    console.log('[VisualCast] 执行待机休眠：停止放映并开启黑场');
    isSystemSleeping = true;
    isExplicitlyStopped = true;
    stopMedia();
    setBlackout(true);
    fetch('/api/system/sleep', { method: 'POST' }).catch(() => {});
  }
  window.triggerSystemPowerOff = triggerSystemPowerOff;

  function triggerSystemPowerOn() {
    console.log('[VisualCast] 执行唤醒：解除黑场、解除静音并播放待机素材');
    isSystemSleeping = false;
    isExplicitlyStopped = false;
    isBlackout = false;
    setBlackout(false);
    videoA.muted = false;
    videoB.muted = false;
    if (mainAudioEl) mainAudioEl.muted = false;
    if (activeVideoEl && activeVideoEl.volume <= 0.01) {
      activeVideoEl.volume = 0.85;
      if (mainAudioEl) mainAudioEl.volume = 0.85;
    }
    returnToStandby(true);
    // 严格斩断死循环回路：绝不再调用 fetch('/api/system/wakeup')！
  }
  window.triggerSystemPowerOn = triggerSystemPowerOn;

  // 7. ScreenStream 演播级高清实时回显抓帧 (640x360 智能节能按需流水线，零延时无卡顿，无监看时 0% 开销)
  let lastEchoTime = 0;
  let vinylAngle = 0;
  isEchoActive = false; // 严格默认静默：无后台监看时彻底休眠，0% CPU 占用
  let echoScheduledTimer = null;
  let isEchoPosting = false; // 飞传状态守卫：杜绝网络并发堆叠与请求排队
  let lastEchoMediaKey = '';

  function scheduleNextEcho() {
    if (echoScheduledTimer) {
      clearTimeout(echoScheduledTimer);
      echoScheduledTimer = null;
    }
    // 关键核心节能机制：若后台无管理员监看，彻底停止抓帧调度，0% CPU/GPU 占用！
    if (!isEchoActive) {
      return;
    }
    // 动态智能刷新节拍（仅在有监看时按需运行）：
    // - 黑场/待机：3500ms (单次上报黑场静态状态即可)
    // - 静态图片/文档/网页：1000ms (1 FPS 清晰省电)
    // - 动态视频/流媒体/音频：380ms (约 2.6 FPS，极速流畅且 CPU 占用暴降)
    let delay = 380;
    if (isBlackout || isSystemSleeping) {
      delay = 3500;
    } else if (currentMediaType === 'image' || currentMediaType === 'ppt' || currentMediaType === 'frame') {
      delay = 1000;
    } else {
      delay = 380;
    }
    echoScheduledTimer = setTimeout(() => {
      if (isEchoActive) {
        grabEchoFrame();
        scheduleNextEcho();
      }
    }, delay);
  }

  function grabEchoFrame() {
    if (!echoCanvas || !echoCtx || isEchoPosting || !isEchoActive) return;
    const now = Date.now();
    const minInterval = (isBlackout || isSystemSleeping) ? 2500 : 300;
    if (now - lastEchoTime < minInterval) return;

    try {
      const W = echoCanvas.width || 640;
      const H = echoCanvas.height || 360;
      let frameData = '';

      if (isBlackout || isSystemSleeping) {
        echoCtx.fillStyle = '#020617';
        echoCtx.fillRect(0, 0, W, H);
        echoCtx.fillStyle = '#64748b';
        echoCtx.font = 'bold 22px sans-serif';
        echoCtx.textAlign = 'center';
        echoCtx.fillText('🌙 大屏待机黑场中', W / 2, H / 2);
        echoCtx.textAlign = 'left';
        frameData = echoCanvas.toDataURL('image/jpeg', 0.52);
      } else if (currentMediaType === 'audio') {
        vinylAngle = (vinylAngle + 12) % 360;
        echoCtx.fillStyle = '#060b19';
        echoCtx.fillRect(0, 0, W, H);
        
        // 蓝光科技放射光晕
        const grad = echoCtx.createRadialGradient(W / 2, 140, 10, W / 2, 140, 200);
        grad.addColorStop(0, 'rgba(0, 240, 255, 0.32)');
        grad.addColorStop(1, 'rgba(6, 11, 25, 0)');
        echoCtx.fillStyle = grad;
        echoCtx.fillRect(0, 0, W, H);

        // 旋转黑胶唱片
        echoCtx.save();
        echoCtx.translate(W / 2, 130);
        echoCtx.rotate((vinylAngle * Math.PI) / 180);
        echoCtx.beginPath();
        echoCtx.arc(0, 0, 85, 0, Math.PI * 2);
        echoCtx.fillStyle = '#0b1120';
        echoCtx.fill();
        echoCtx.strokeStyle = 'rgba(255,255,255,0.18)';
        echoCtx.lineWidth = 2;
        echoCtx.stroke();

        [70, 56, 42, 30].forEach(r => {
          echoCtx.beginPath();
          echoCtx.arc(0, 0, r, 0, Math.PI * 2);
          echoCtx.strokeStyle = 'rgba(255,255,255,0.08)';
          echoCtx.lineWidth = 1;
          echoCtx.stroke();
        });

        echoCtx.beginPath();
        echoCtx.arc(0, 0, 24, 0, Math.PI * 2);
        echoCtx.fillStyle = '#0284c7';
        echoCtx.fill();
        echoCtx.strokeStyle = '#38bdf8';
        echoCtx.lineWidth = 2;
        echoCtx.stroke();
        echoCtx.restore();

        // 音乐标签与曲目名
        echoCtx.fillStyle = '#38bdf8';
        echoCtx.font = 'bold 15px sans-serif';
        echoCtx.textAlign = 'center';
        echoCtx.fillText('♪ 高保真音乐视窗 · 立体声播映中', W / 2, 245);

        echoCtx.fillStyle = '#ffffff';
        echoCtx.font = 'bold 18px sans-serif';
        const displayTitle = (currentMediaName && currentMediaName.length > 28) ? (currentMediaName.substring(0, 26) + '...') : (currentMediaName || '音频素材');
        echoCtx.fillText(displayTitle, W / 2, 275);

        // 频谱律动波形柱 (24 柱精简算力)
        const startX = (W - 24 * 16) / 2;
        for (let i = 0; i < 24; i++) {
          const h = 8 + Math.abs(Math.sin((now / 150) + i * 0.4)) * 26;
          const barGrad = echoCtx.createLinearGradient(0, 330 - h, 0, 330);
          barGrad.addColorStop(0, '#00f0ff');
          barGrad.addColorStop(1, '#0284c7');
          echoCtx.fillStyle = barGrad;
          echoCtx.fillRect(startX + i * 16, 330 - h, 10, h);
        }
        echoCtx.textAlign = 'left';
        frameData = echoCanvas.toDataURL('image/jpeg', 0.52);
      } else if (currentMediaType === 'image' && imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
        try {
          echoCtx.drawImage(imgEl, 0, 0, W, H);
          frameData = echoCanvas.toDataURL('image/jpeg', 0.52);
        } catch (err) {
          frameData = renderEchoFallback('🖼️ 图片展项放映中', currentMediaName);
        }
      } else if (currentMediaType === 'video' || currentMediaType === 'stream') {
        let ok = false;
        if (activeVideoEl && !activeVideoEl.paused && activeVideoEl.readyState >= 2) {
          try {
            echoCtx.drawImage(activeVideoEl, 0, 0, W, H);
            frameData = echoCanvas.toDataURL('image/jpeg', 0.52);
            ok = true;
          } catch (err) {}
        }
        if (!ok) {
          frameData = renderEchoFallback('🎬 视频高保真播映中', currentMediaName);
        }
      } else if (currentMediaType === 'ppt') {
        frameData = renderEchoDocWindow(currentMediaName || '演示文稿放映中', false);
      } else if (currentMediaType === 'frame') {
        const isPdf = (currentMediaName || '').toLowerCase().endsWith('.pdf');
        frameData = isPdf ? renderEchoDocWindow(currentMediaName || 'PDF 演示文稿', true) : renderEchoWebWindow(currentMediaName || currentDocBaseUrl || '网页交互展项');
      } else {
        frameData = renderEchoFallback('🏠 待机放映中', currentMediaName || 'VisualCast');
      }

      if (frameData && frameData.length > 50) {
        lastEchoTime = now;
        isEchoPosting = true;
        fetch('/api/player/echo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frame: frameData })
        }).catch(() => {}).finally(() => {
          isEchoPosting = false;
        });
      }
    } catch (e) {
      isEchoPosting = false;
    }
  }

  // 高保真文档演示放映视窗回显生成器 (960x540)
  function renderEchoDocWindow(name, isPdf = false) {
    try {
      const W = echoCanvas.width || 960;
      const H = echoCanvas.height || 540;
      echoCtx.fillStyle = '#050811';
      echoCtx.fillRect(0, 0, W, H);

      echoCtx.fillStyle = '#0f172a';
      echoCtx.fillRect(35, 25, W - 70, H - 50);
      echoCtx.strokeStyle = isPdf ? 'rgba(239, 68, 68, 0.55)' : 'rgba(249, 115, 22, 0.55)';
      echoCtx.lineWidth = 2;
      echoCtx.strokeRect(35, 25, W - 70, H - 50);

      echoCtx.fillStyle = isPdf ? '#ef4444' : '#f97316';
      echoCtx.fillRect(35, 25, W - 70, 48);
      echoCtx.fillStyle = '#ffffff';
      echoCtx.font = 'bold 20px sans-serif';
      echoCtx.fillText(isPdf ? '📑 PDF 演示文稿 · 全屏放映中' : '📊 PowerPoint / WPS 演示文稿 · 全屏放映中', 60, 56);

      echoCtx.fillStyle = '#ffffff';
      echoCtx.font = 'bold 30px sans-serif';
      const title = (name && name.length > 35) ? (name.substring(0, 33) + '...') : (name || '演示文稿');
      echoCtx.fillText(title, 75, 145);

      for (let i = 0; i < 3; i++) {
        const cardX = 90 + i * 260;
        echoCtx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        echoCtx.fillRect(cardX, 195, 235, 180);
        echoCtx.fillStyle = isPdf ? 'rgba(239, 68, 68, 0.35)' : 'rgba(249, 115, 22, 0.35)';
        echoCtx.fillRect(cardX + 15, 220, 65, 8);
        echoCtx.fillStyle = 'rgba(255, 255, 255, 0.25)';
        echoCtx.fillRect(cardX + 15, 245, 165, 8);
        echoCtx.fillRect(cardX + 15, 268, 195, 5);
        echoCtx.fillRect(cardX + 15, 288, 140, 5);
      }

      echoCtx.fillStyle = 'rgba(15, 23, 42, 0.95)';
      echoCtx.fillRect(35, H - 85, W - 70, 60);
      echoCtx.fillStyle = '#38bdf8';
      echoCtx.font = 'bold 18px sans-serif';
      echoCtx.fillText('✔ 外部演示引擎全屏呈现中 · 遥控切播任意素材即刻无感返回主视窗', 60, H - 48);

      return echoCanvas.toDataURL('image/jpeg', 0.52);
    } catch (e) {
      return renderEchoFallback('📑 演示放映中', name);
    }
  }

  // 高保真网页 / H5 展项全屏视窗回显生成器 (640x360 智能低耗)
  function renderEchoWebWindow(name) {
    try {
      const W = echoCanvas.width || 640;
      const H = echoCanvas.height || 360;
      echoCtx.fillStyle = '#050811';
      echoCtx.fillRect(0, 0, W, H);

      echoCtx.fillStyle = '#0f172a';
      echoCtx.fillRect(35, 25, W - 70, H - 50);
      echoCtx.strokeStyle = 'rgba(0, 240, 255, 0.4)';
      echoCtx.lineWidth = 2;
      echoCtx.strokeRect(35, 25, W - 70, H - 50);

      echoCtx.fillStyle = '#1e293b';
      echoCtx.fillRect(35, 25, W - 70, 48);

      echoCtx.fillStyle = '#ef4444';
      echoCtx.beginPath(); echoCtx.arc(60, 49, 7, 0, Math.PI * 2); echoCtx.fill();
      echoCtx.fillStyle = '#eab308';
      echoCtx.beginPath(); echoCtx.arc(82, 49, 7, 0, Math.PI * 2); echoCtx.fill();
      echoCtx.fillStyle = '#22c55e';
      echoCtx.beginPath(); echoCtx.arc(104, 49, 7, 0, Math.PI * 2); echoCtx.fill();

      echoCtx.fillStyle = '#0f172a';
      echoCtx.fillRect(135, 34, W - 280, 30);
      echoCtx.fillStyle = '#00f0ff';
      echoCtx.font = '16px sans-serif';
      const urlText = (name && name.length > 50) ? (name.substring(0, 48) + '...') : (name || 'https://visualcast.display');
      echoCtx.fillText('🔒 ' + urlText, 150, 55);

      echoCtx.fillStyle = '#ffffff';
      echoCtx.font = 'bold 26px sans-serif';
      echoCtx.fillText('🌐 交互式网页 / 流媒体展项 · 全屏交互中', 70, 140);

      echoCtx.fillStyle = 'rgba(0, 240, 255, 0.06)';
      echoCtx.fillRect(70, 170, W - 140, 270);
      echoCtx.strokeStyle = 'rgba(0, 240, 255, 0.25)';
      echoCtx.lineWidth = 1;
      echoCtx.strokeRect(70, 170, W - 140, 270);

      echoCtx.fillStyle = '#94a3b8';
      echoCtx.font = '20px sans-serif';
      echoCtx.fillText('正在以全屏沉浸模式渲染 Web 交互内容 · 实时触控与指令高速响应中', 110, 310);

      return echoCanvas.toDataURL('image/jpeg', 0.52);
    } catch (e) {
      return renderEchoFallback('🌐 网页呈现中', name);
    }
  }

  function renderEchoFallback(label, name) {
    try {
      const W = echoCanvas.width || 640;
      const H = echoCanvas.height || 360;
      echoCtx.fillStyle = '#060b19';
      echoCtx.fillRect(0, 0, W, H);

      echoCtx.fillStyle = 'rgba(0, 240, 255, 0.08)';
      echoCtx.fillRect(35, 25, W - 70, H - 50);
      echoCtx.strokeStyle = 'rgba(0, 240, 255, 0.35)';
      echoCtx.lineWidth = 2;
      echoCtx.strokeRect(35, 25, W - 70, H - 50);

      echoCtx.fillStyle = '#00f0ff';
      echoCtx.font = 'bold 28px sans-serif';
      echoCtx.fillText(label, 70, 95);

      echoCtx.fillStyle = '#ffffff';
      echoCtx.font = 'bold 32px sans-serif';
      const displayTitle = (name && name.length > 36) ? (name.substring(0, 34) + '...') : (name || '大屏视窗呈现中');
      echoCtx.fillText(displayTitle, 70, 185);

      echoCtx.fillStyle = '#94a3b8';
      echoCtx.font = '20px sans-serif';
      echoCtx.fillText('大屏窗口正在全屏渲染呈现 · 1080P 高清画面', 70, 250);

      echoCtx.fillStyle = 'rgba(56, 189, 248, 0.15)';
      echoCtx.fillRect(70, 390, W - 140, 65);
      echoCtx.fillStyle = '#38bdf8';
      echoCtx.font = 'bold 18px sans-serif';
      echoCtx.fillText('✔ ScreenStream 零延时动图流连通正常 · 演播级高清画面实时映射', 100, 430);

      return echoCanvas.toDataURL('image/jpeg', 0.52);
    } catch (err) {
      return '';
    }
  }

  // 节能设计：默认静默休眠，仅当后台监看建立时由 syncLoop 按需唤醒
  // 8. 检查 U 盘插入事件并触发气泡 (开机首次启动静默记录基准，绝不误弹历史气泡；仅在真实热插拔并有更新时留一个提醒)
  async function checkUsbStatus() {
    try {
      const res = await fetch('/api/system/usb_status');
      const data = await res.json();
      if (data.status === 'ok' && data.event && data.has_usb !== false && data.connected !== false) {
        const ev = data.event;
        if (lastHandledUsbTime === 0) {
          // 开机首次加载：仅记录基准时间戳，绝不误弹冷启动前的历史 U 盘气泡
          lastHandledUsbTime = ev.timestamp || Date.now();
          return;
        }
        if (ev.timestamp > lastHandledUsbTime) {
          lastHandledUsbTime = ev.timestamp;
          if (ev.count > 0) {
            usbDesc.textContent = `已从 U 盘自动更新同步 ${ev.count} 个素材文件！`;
            usbToast.classList.remove('hidden');
            setTimeout(() => {
              usbToast.classList.add('hidden');
            }, 4500);
          }
        }
      }
    } catch (e) {}
  }

  // 9. 指令拉取与状态上报合一通道 (智能自适应周期：放映时 650ms 黄金中控响应，黑场待机时 1800ms 深度节能休眠)
  async function syncLoop() {
    try {
      let state = 'PAUSED';
      let currTime = 0;
      let dur = 0;
      let vol = Math.round(activeVideoEl.volume * 100);
      let isMuted = activeVideoEl.muted;

      if (currentMediaType === 'audio' && mainAudioEl) {
        state = mainAudioEl.paused ? 'PAUSED' : 'PLAYING';
        currTime = mainAudioEl.currentTime || 0;
        dur = mainAudioEl.duration || 0;
        vol = Math.round(mainAudioEl.volume * 100);
        isMuted = mainAudioEl.muted;
      } else if (currentMediaType === 'video') {
        state = activeVideoEl.paused ? 'PAUSED' : 'PLAYING';
        currTime = activeVideoEl.currentTime || 0;
        dur = activeVideoEl.duration || 0;
        vol = Math.round(activeVideoEl.volume * 100);
        isMuted = activeVideoEl.muted;
      } else {
        state = 'PLAYING';
      }

      const reportData = {
        state: state,
        current_media: currentMediaName,
        current_time: currTime,
        duration: dur,
        volume: vol,
        muted: isMuted,
        loop: isLoopMode,
        loop_mode: loopMode,
        current_folder: currentFolder,
        scale_mode: currentScaleMode,
        blackout: isBlackout,
        freeze: isFrozen,
        media_type: currentMediaType,
        menu_open: !!isPanelOpen
      };

      const syncRes = await fetch('/api/player/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reportData)
      });
      const pullData = await syncRes.json();
      if (pullData.status === 'ok') {
        // 核心节能按需控制：无管理员监看时自动深度休眠，有管理员时无延时唤醒
        const needEcho = !!pullData.need_echo;
        if (needEcho !== isEchoActive) {
          isEchoActive = needEcho;
          if (isEchoActive) {
            console.log('[VisualCast 节能引擎] 后台监看上线，唤醒高清抓帧');
            scheduleNextEcho();
          } else {
            console.log('[VisualCast 节能引擎] 后台监看离线，抓帧流水线彻底休眠 (0% CPU/GPU)');
            if (echoScheduledTimer) {
              clearTimeout(echoScheduledTimer);
              echoScheduledTimer = null;
            }
          }
        }

        if (pullData.mode) currentMode = pullData.mode;
        if (pullData.idle_media) idleMedia = pullData.idle_media;
        if (pullData.idle_timeout !== undefined) idleTimeout = pullData.idle_timeout;
        if (pullData.fullscreen !== undefined) updateFullscreenBtn(pullData.fullscreen);
        
        // 同步画面拉伸模式
        if (pullData.scale_mode && pullData.scale_mode !== currentScaleMode) {
          setScaleMode(pullData.scale_mode);
        }
        
        // 同步屏幕方向
        if (pullData.orientation && pullData.orientation !== currentOrientation) {
          setScreenOrientation(pullData.orientation);
        }

        // 同步四种循环播放模式与当前文件夹
        if (pullData.loop_mode && pullData.loop_mode !== loopMode) {
          loopMode = pullData.loop_mode;
          isLoopMode = (loopMode !== 'PLAY_ONCE');
          videoA.loop = (loopMode === 'SINGLE_LOOP');
          videoB.loop = (loopMode === 'SINGLE_LOOP');
          refreshPlaylist();
        }
        if (pullData.current_folder !== undefined && pullData.current_folder !== currentFolder) {
          currentFolder = pullData.current_folder;
          refreshPlaylist();
        }

        // 同步触控翻页按钮
        if (pullData.touch_mode !== undefined) {
          setTouchModeUI(!!pullData.touch_mode);
        }

        // 同步无线投屏看板
        if (pullData.cast_active !== undefined) {
          if (pullData.cast_active) showCastBoard(pullData.cast_device_name);
          else hideCastBoard();
        }

        // 同步悬浮跑马灯字幕
        if (pullData.subtitle) {
          if (!currentSubtitleConfig || JSON.stringify(currentSubtitleConfig) !== JSON.stringify(pullData.subtitle)) {
            applySubtitleConfig(pullData.subtitle);
          }
        }

        if (pullData.commands && pullData.commands.length > 0) {
          pullData.commands.forEach(cmd => applyCommand(cmd));
        }
      }

    } catch (e) {
    } finally {
      // 自适应低功耗轮询：
      // - 黑场待机或休眠中：1800ms (大幅放缓轮询，彻底让 CPU/网卡进入节能休眠)
      // - 正常展厅放映中：650ms (保持黄金中控毫秒级响应)
      const delay = (isSystemSleeping || isBlackout) ? 1800 : 650;
      setTimeout(syncLoop, delay);
    }
  }

  // 初始化素材库、音量、全屏拉伸与开机自启循环播放
  async function initPlayerAudioAndConfig() {
    try {
      setBlackout(false);
      setFreeze(false);
      isExplicitlyStopped = false;
      if (!currentFolder) currentFolder = '待机';

      // 1. 预先加载素材库，构建待播队列
      try {
        const mRes = await fetch('/api/media?_t=' + Date.now(), { cache: 'no-store' });
        const mData = await mRes.json();
        if (mData.status === 'ok') {
          cachedMediaList = mData.media || mData.files || [];
        }
      } catch (me) {}

      // 2. 加载播控状态与启动策略
      const res = await fetch('/api/player/status');
      const data = await res.json();
      if (data.status === 'ok' && data.player) {
        const p = data.player;
        if (p.volume !== undefined) {
          const v = Math.max(0, Math.min(1, p.volume / 100));
          videoA.volume = v;
          videoB.volume = v;
          if (mainAudioEl) mainAudioEl.volume = v;
        }
        if (p.muted !== undefined) {
          videoA.muted = !!p.muted;
          videoB.muted = !!p.muted;
          if (mainAudioEl) mainAudioEl.muted = !!p.muted;
        }
        if (p.orientation) {
          setScreenOrientation(p.orientation);
        }
        if (p.scale_mode) {
          setScaleMode(p.scale_mode);
        }
        if (p.loop_mode) {
          loopMode = p.loop_mode;
        }
        if (p.current_folder !== undefined && p.current_folder !== '') {
          currentFolder = p.current_folder;
        }
        if (p.subtitle) {
          applySubtitleConfig(p.subtitle);
        }
        if (p.touch_mode !== undefined) {
          setTouchModeUI(!!p.touch_mode);
        }

        // 核心：开机默认循环播放逻辑 (可自定义开机模式与文件夹)
        if (p.startup_auto_play !== false) {
          if (p.startup_mode) loopMode = p.startup_mode;
          if (p.startup_folder !== undefined && p.startup_folder !== '') currentFolder = p.startup_folder;
          if (!currentFolder) currentFolder = '待机';
          isLoopMode = (loopMode !== 'PLAY_ONCE');
          videoA.loop = (loopMode === 'SINGLE_LOOP');
          videoB.loop = (loopMode === 'SINGLE_LOOP');
          refreshPlaylist();

          let startTarget = null;
          if (p.startup_media && currentPlaylist.some(m => m.name === p.startup_media)) {
            startTarget = p.startup_media;
          } else if (currentPlaylist.length > 0) {
            startTarget = currentPlaylist[0];
          } else if (cachedMediaList && cachedMediaList.length > 0) {
            // 待机目录若暂无，自动回退到第一个可用素材，确保绝不黑屏
            startTarget = cachedMediaList[0];
          } else if (p.current_media) {
            startTarget = p.current_media;
          }

          if (startTarget) {
            console.log('[VisualCast] 开机自启循环播放已就绪:', startTarget);
            switchMedia(startTarget, true);
            return;
          }
        }

        if (p.current_media) {
          switchMedia(p.current_media, true);
          return;
        }
      }
    } catch (e) {
      console.warn('initPlayerAudioAndConfig 异常:', e);
    }
    setScaleMode('fill');
    if (!currentFolder) currentFolder = '待机';
    refreshPlaylist();
    if (currentPlaylist.length > 0) {
      switchMedia(currentPlaylist[0], true);
    } else if (cachedMediaList && cachedMediaList.length > 0) {
      switchMedia(cachedMediaList[0], true);
    } else {
      switchMedia({ name: 'default_standby.jpg', url: '/static/default_standby.jpg', type: 'image' }, true);
    }
  }

  // 待机黑场遮罩为专业演播级纯黑场，禁用屏幕误触自动苏醒，统一由中控指令或管理后台安全唤醒
  if (blackoutMask) {
    // 杜绝商显红外框微弱触点或误触导致黑屏自动重新播放
  }

  // 定期检测 U 盘状态 (3.5秒低频轮询)
  setInterval(checkUsbStatus, 3500);

  // 全局键盘快捷键翻页与交互支持 (支持遥控器/翻页笔/实体键盘快捷键全支持)
  // 上一页: PageUp / Up / Left
  // 下一页: PageDown / Down / Right / Space
  // 结束放映返回待机: ESC / Q
  window.addEventListener('keydown', (e) => {
    if (isLicenseBlocked) {
      return;
    }
    const k = e.key;
    if (k === 'PageUp' || k === 'ArrowLeft' || k === 'ArrowUp') {
      e.preventDefault();
      if (currentMediaType === 'image') {
        navImageTrack(-1);
      } else if (currentMediaType === 'frame') {
        navPdfPage(-1);
        schedulePdfNext();
      } else if (currentMediaType === 'video' || currentMediaType === 'audio') {
        playPrevTrack();
      }
    } else if (k === 'PageDown' || k === 'ArrowRight' || k === 'ArrowDown' || k === ' ') {
      e.preventDefault();
      if (currentMediaType === 'image') {
        navImageTrack(1);
      } else if (currentMediaType === 'frame') {
        navPdfPage(1);
        schedulePdfNext();
      } else if (currentMediaType === 'video' || currentMediaType === 'audio') {
        playNextTrack();
      }
    } else if (k === 'Escape' || k === 'q' || k === 'Q') {
      const panel = document.getElementById('control-panel');
      if (panel && !panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        return;
      }
      console.log(`[VisualCast] 收到退出放映快捷键 (${k})，正在联动关闭放映并返回待机循环播放...`);
      fetch('/api/player/close_ppt', { method: 'POST' }).catch(() => {});
      fetch('/api/player/return_to_standby', { method: 'POST' }).catch(() => {});
      
      // 前端状态瞬间无缝切回待机文件夹循环
      loopMode = 'FOLDER_LOOP';
      currentFolder = '待机';
      isLoopMode = true;
      refreshPlaylist();
      if (currentPlaylist.length > 0) {
        switchMedia(currentPlaylist[0], true);
      } else if (idleMedia) {
        switchMedia(idleMedia, true);
      }
    }
  });

  // 启动服务 (通过 syncLoop 单通道合一完成状态上报与指令拉取)
  loadSystemInfo();
  initPlayerAudioAndConfig();
  syncLoop();

})();


// ===================== 抽屉菜单内定时开关机排程 =====================
const panelSchedEnable = document.getElementById('panel-sched-enable');
const panelSchedBootGroup = document.getElementById('panel-sched-boot-group');
const panelSchedBootEnable = document.getElementById('panel-sched-boot-enable');
const panelSchedBootTime = document.getElementById('panel-sched-boot-time');
const panelSchedShutdownTime = document.getElementById('panel-sched-shutdown-time');
const btnSavePanelSched = document.getElementById('btn-save-panel-sched');

function updatePlayerSchedBadge(cfg) {
  const badge = document.getElementById('player-sched-badge');
  if (!badge) return;
  const isAndroid = /Android/i.test(navigator.userAgent);
  if (cfg && cfg.enabled) {
    const shut = cfg.shutdown_time || cfg.time || '21:30';
    if (isAndroid && cfg.boot_enabled !== false) {
      const boot = cfg.boot_time || '08:30';
      badge.textContent = `开: ${boot} | 关: ${shut}`;
    } else {
      badge.textContent = `关机: ${shut}`;
    }
    badge.className = 'player-collapsible-badge online';
  } else {
    badge.textContent = '未启用';
    badge.className = 'player-collapsible-badge';
  }
}

async function loadPanelScheduledShutdown() {
  try {
    const isAndroid = /Android/i.test(navigator.userAgent);
    if (panelSchedBootGroup) {
      panelSchedBootGroup.style.display = isAndroid ? 'block' : 'none';
    }

    const res = await fetch('/api/system/scheduled_shutdown');
    const json = await res.json();
    if (json.status === 'ok' && json.data) {
      const cfg = json.data.config || {};
      updatePlayerSchedBadge(cfg);
      if (panelSchedEnable) panelSchedEnable.checked = !!cfg.enabled;
      if (panelSchedBootEnable) panelSchedBootEnable.checked = (cfg.boot_enabled !== false);
      if (panelSchedBootTime && cfg.boot_time) panelSchedBootTime.value = cfg.boot_time;
      if (panelSchedShutdownTime && (cfg.shutdown_time || cfg.time)) {
        panelSchedShutdownTime.value = cfg.shutdown_time || cfg.time;
      }
      const days = Array.isArray(cfg.weekdays) ? cfg.weekdays : [1,2,3,4,5,6,7];
      document.querySelectorAll('#panel-weekday-chips .weekday-tag').forEach(tag => {
        const d = parseInt(tag.getAttribute('data-day'));
        const chk = tag.querySelector('.panel-chk-day');
        const active = days.includes(d);
        if (chk) chk.checked = active;
        tag.classList.toggle('active', active);
      });
    }
  } catch (e) {}
}

document.querySelectorAll('#panel-weekday-chips .weekday-tag').forEach(tag => {
  tag.addEventListener('click', (e) => {
    e.preventDefault();
    const chk = tag.querySelector('.panel-chk-day');
    const willActive = !tag.classList.contains('active');
    tag.classList.toggle('active', willActive);
    if (chk) chk.checked = willActive;
  });
});

if (btnSavePanelSched) {
  btnSavePanelSched.addEventListener('click', async () => {
    const selectedDays = [];
    document.querySelectorAll('#panel-weekday-chips .weekday-tag').forEach(tag => {
      if (tag.classList.contains('active')) {
        selectedDays.push(parseInt(tag.getAttribute('data-day')));
      }
    });
    if (selectedDays.length === 0) {
      alert('请至少选择一天！');
      return;
    }
    const payload = {
      enabled: !!(panelSchedEnable && panelSchedEnable.checked),
      boot_enabled: !!(panelSchedBootEnable ? panelSchedBootEnable.checked : true),
      boot_time: panelSchedBootTime ? panelSchedBootTime.value : '08:30',
      shutdown_time: panelSchedShutdownTime ? panelSchedShutdownTime.value : '21:30',
      time: panelSchedShutdownTime ? panelSchedShutdownTime.value : '21:30',
      weekdays: selectedDays
    };
    try {
      const res = await fetch('/api/system/scheduled_shutdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.status === 'ok') {
        updatePlayerSchedBadge(payload);
        showPlayerToast('🎉 定时开关机排程已成功保存并永久固化！', '定时设置');
        alert('🎉 定时开关机排程已成功保存并永久固化，下次开机自动按固化参数运行！');
      } else {
        alert('保存失败: ' + (data.message || '未知错误'));
      }
    } catch (err) {
      alert('保存异常: ' + err);
    }
  });
}

// ===================== 未授权/到期强阻断全屏遮罩逻辑 =====================
const blockingLicOverlay = document.getElementById('blocking-license-overlay');
const blockingLicIcon = document.getElementById('blocking-lic-icon');
const blockingLicTitle = document.getElementById('blocking-lic-title');
const blockingLicSubtitle = document.getElementById('blocking-lic-subtitle');
const blockingReqCode = document.getElementById('blocking-req-code');
const btnBlockingCopyCode = document.getElementById('btn-blocking-copy-code');
const blockingKeyInput = document.getElementById('blocking-key-input');
const btnBlockingSubmit = document.getElementById('btn-blocking-submit');
const blockingErrorTip = document.getElementById('blocking-error-tip');

async function enforceLicenseProtection() {
  try {
    let data = null;
    try {
      const res = await fetch('/api/system/license?_t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) data = await res.json();
    } catch (e) {}
    if (!data) {
      try {
        const res = await fetch('/api/license/status?_t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) data = await res.json();
      } catch (e) {}
    }

    if (data && (!data.is_valid || data.status_code === 'NO_LICENSE' || data.status_code === 'EXPIRED')) {
      // 未激活授权或到期：强制弹出商业授权激活全屏阻断遮罩，暂停所有媒体放映
      isLicenseBlocked = true;
      isExplicitlyStopped = true;
      try { videoA.pause(); } catch (e) {}
      try { videoB.pause(); } catch (e) {}
      try { if (mainAudioEl) mainAudioEl.pause(); } catch (e) {}
      if (imageTimer) { clearTimeout(imageTimer); imageTimer = null; }
      if (docTimer) { clearTimeout(docTimer); docTimer = null; }

      const details = data.details || {};
      const reqCode = details.request_code || details.machine_code || '--------';
      if (blockingReqCode) blockingReqCode.textContent = reqCode;

      const sc = data.status_code || '';
      if (sc === 'EXPIRED') {
        if (blockingLicIcon) blockingLicIcon.textContent = '⏳';
        if (blockingLicTitle) blockingLicTitle.textContent = 'VisualCast 商业授权已到期';
        if (blockingLicSubtitle) blockingLicSubtitle.textContent = '当前设备商业授权已到期，播控功能已暂停，请输入新的 12 位商业激活码解锁系统';
      } else if (sc === 'MACHINE_MISMATCH') {
        if (blockingLicIcon) blockingLicIcon.textContent = '⚠️';
        if (blockingLicTitle) blockingLicTitle.textContent = '设备硬件特征不符';
        if (blockingLicSubtitle) blockingLicSubtitle.textContent = '当前授权凭据与本机硬件特征不匹配，请使用下方申请码重新签发激活码';
      } else if (sc === 'CLOCK_TAMPERED') {
        if (blockingLicIcon) blockingLicIcon.textContent = '🕒';
        if (blockingLicTitle) blockingLicTitle.textContent = '系统时钟被异常篡改';
        if (blockingLicSubtitle) blockingLicSubtitle.textContent = '检测到系统时钟发生倒流回拨，请将系统时间校准为标准北京时间';
      } else {
        if (blockingLicIcon) blockingLicIcon.textContent = '🔒';
        if (blockingLicTitle) blockingLicTitle.textContent = 'VisualCast 商业系统未授权';
        if (blockingLicSubtitle) blockingLicSubtitle.textContent = '请激活商业授权以解锁展厅大屏播控系统';
      }

      if (blockingLicOverlay) blockingLicOverlay.classList.remove('hidden');
    } else if (data && data.is_valid) {
      // 已授权：解锁放映
      const wasBlocked = isLicenseBlocked;
      isLicenseBlocked = false;
      if (blockingLicOverlay) blockingLicOverlay.classList.add('hidden');
      if (wasBlocked) {
        isExplicitlyStopped = false;
        refreshPlaylist();
        if (currentPlaylist.length > 0) switchMedia(currentPlaylist[0], true);
      }
    }
  } catch (e) {
    console.warn('[VisualCast] 授权校验异常:', e);
  }
}

// 激活码输入自动大写与格式化 (XXXX-XXXX-XXXX)
if (blockingKeyInput) {
  blockingKeyInput.addEventListener('input', (e) => {
    let raw = e.target.value.toUpperCase().replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g, '');
    if (raw.length > 12) raw = raw.slice(0, 12);
    let parts = [];
    if (raw.length > 8) {
      parts = [raw.slice(0, 4), raw.slice(4, 8), raw.slice(8)];
    } else if (raw.length > 4) {
      parts = [raw.slice(0, 4), raw.slice(4)];
    } else if (raw.length > 0) {
      parts = [raw];
    }
    e.target.value = parts.join('-');
  });
}

if (btnBlockingCopyCode) {
  btnBlockingCopyCode.addEventListener('click', () => {
    const code = blockingReqCode ? blockingReqCode.textContent : '';
    if (code && code !== '--------') {
      try {
        navigator.clipboard.writeText(code);
      } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = code; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      }
      btnBlockingCopyCode.textContent = '已复制！';
      setTimeout(() => { btnBlockingCopyCode.textContent = '📋 复制'; }, 2000);
    }
  });
}

if (btnBlockingSubmit) {
  btnBlockingSubmit.addEventListener('click', async () => {
    const key = blockingKeyInput ? blockingKeyInput.value.trim().toUpperCase() : '';
    const cleanKey = key.replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g, '');
    if (!cleanKey || cleanKey.length !== 12) {
      if (blockingErrorTip) {
        blockingErrorTip.textContent = '请输入完整的 12 位激活码 (例如: XXXX-XXXX-XXXX)';
        blockingErrorTip.classList.remove('hidden');
      }
      return;
    }

    btnBlockingSubmit.disabled = true;
    btnBlockingSubmit.textContent = '正在验证激活码...';
    if (blockingErrorTip) blockingErrorTip.classList.add('hidden');

    try {
      let data = null;
      try {
        const res = await fetch('/api/system/license', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: cleanKey, license_key: cleanKey })
        });
        if (res.ok) data = await res.json();
      } catch (e) {}

      if (!data || data.status !== 'success') {
        try {
          const res = await fetch('/api/license/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ license_key: cleanKey, code: cleanKey })
          });
          if (res.ok) data = await res.json();
        } catch (e) {}
      }

      if (data && (data.status === 'ok' || data.status === 'success' || data.is_valid)) {
        alert('🎉 商业授权验证通过！系统已成功解锁。');
        if (blockingLicOverlay) blockingLicOverlay.classList.add('hidden');
        isLicenseBlocked = false;
        isExplicitlyStopped = false;
        currentFolder = '待机';
        loopMode = 'FOLDER_LOOP';
        refreshPlaylist();
        if (currentPlaylist.length > 0) switchMedia(currentPlaylist[0], true);
      } else {
        if (blockingErrorTip) {
          blockingErrorTip.textContent = '⚠️ 激活失败：' + ((data && data.message) || '激活码不正确或设备硬件特征不符');
          blockingErrorTip.classList.remove('hidden');
        }
      }
    } catch (err) {
      if (blockingErrorTip) {
        blockingErrorTip.textContent = '请求异常: ' + err;
        blockingErrorTip.classList.remove('hidden');
      }
    } finally {
      btnBlockingSubmit.disabled = false;
      btnBlockingSubmit.textContent = '立即验证并解锁系统';
    }
  });
}

// 启动执行强阻断检测并在后台开启 10 秒常态心跳守护
setTimeout(enforceLicenseProtection, 500);
setInterval(enforceLicenseProtection, 10000);


// ===================== 定时开关机自动守护轮询 (重调用唤醒按钮标准逻辑) =====================
let lastExecutedBootMinuteStamp = '';
let lastExecutedShutdownMinuteStamp = '';
let isScheduledPowerOff = false;
async function checkScheduledPowerDaemon() {
  try {
    const now = new Date();
    const res = await fetch('/api/system/scheduled_shutdown');
    const json = await res.json();
    if (json.status !== 'ok' || !json.data || !json.data.config) return;
    const cfg = json.data.config;
    if (!cfg.enabled) {
      if (isScheduledPowerOff) {
        isScheduledPowerOff = false;
        triggerSystemPowerOn();
      }
      return;
    }

    const currentDay = now.getDay() === 0 ? 7 : now.getDay();
    const weekdays = Array.isArray(cfg.weekdays) ? cfg.weekdays : [1,2,3,4,5,6,7];
    if (!weekdays.includes(currentDay)) return;

    const pad = (n) => n < 10 ? '0' + n : '' + n;
    const curTimeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const shutdownTimeStr = cfg.shutdown_time || cfg.time || '21:30';
    const bootTimeStr = cfg.boot_time || '08:30';

    const todayDateStr = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;
    const curBootStamp = `${todayDateStr}_${bootTimeStr}`;
    const curShutdownStamp = `${todayDateStr}_${shutdownTimeStr}`;

    const bootEnabled = cfg.boot_enabled !== false;
    // 1. 定时关机到达：直接执行待机按钮动作 (停止放映 + 开启黑场)
    if (curTimeStr === shutdownTimeStr && curShutdownStamp !== lastExecutedShutdownMinuteStamp) {
      lastExecutedShutdownMinuteStamp = curShutdownStamp;
      console.log(`[VisualCast] ⏰ 定时闭馆关机时间到达 (${shutdownTimeStr})，重调用【待机按钮】标准逻辑！`);
      isScheduledPowerOff = true;
      triggerSystemPowerOff();
    }
    // 2. 定时开机到达：直接执行唤醒按钮动作 (解除黑场 + 播放待机素材 + 唤醒屏幕常亮)
    else if (bootEnabled && curTimeStr === bootTimeStr && curBootStamp !== lastExecutedBootMinuteStamp) {
      lastExecutedBootMinuteStamp = curBootStamp;
      console.log(`[VisualCast] ☀️ 定时开馆开机时间到达 (${bootTimeStr})，重调用【唤醒按钮】标准逻辑！`);
      isScheduledPowerOff = false;
      triggerSystemPowerOn();
    }
  } catch (e) {}
}
setInterval(checkScheduledPowerDaemon, 5000);

// ===================== 大屏端隐藏菜单折叠面板组件化 =====================
function initPlayerDrawerCollapsibles() {
  const collapsibles = [
    { boxId: 'player-hub-box-net', headerId: 'player-hub-header-net', btnId: 'btn-player-net-toggle', textId: 'player-net-toggle-text', defaultCollapsed: false },
    { boxId: 'player-hub-box-sys', headerId: 'player-hub-header-sys', btnId: 'btn-player-sys-toggle', textId: 'player-sys-toggle-text', defaultCollapsed: true },
    { boxId: 'player-hub-box-sched', headerId: 'player-hub-header-sched', btnId: 'btn-player-sched-toggle', textId: 'player-sched-toggle-text', defaultCollapsed: true },
    { boxId: 'player-hub-box-apps', headerId: 'player-hub-header-apps', btnId: 'btn-player-apps-toggle', textId: 'player-apps-toggle-text', defaultCollapsed: true },
    { boxId: 'player-hub-box-lic', headerId: 'player-hub-header-lic', btnId: 'btn-player-lic-toggle', textId: 'player-lic-toggle-text', defaultCollapsed: true }
  ];

  function setBoxState(item, collapsed) {
    const box = document.getElementById(item.boxId);
    const textSpan = document.getElementById(item.textId);
    if (!box) return;
    box.classList.toggle('collapsed', collapsed);
    if (textSpan) {
      textSpan.textContent = collapsed ? '展开' : '收起';
    }
  }

  function ensureCardInView(box) {
    if (!box) return;
    const panel = document.getElementById('control-panel');
    if (!panel) return;

    // 延时等待 DOM 展开渲染与高度计算就绪
    setTimeout(() => {
      const panelScrollTop = panel.scrollTop;
      const panelVisibleHeight = panel.clientHeight;
      const cardOffsetTop = box.offsetTop;
      const cardHeight = box.offsetHeight;

      // 如果卡片顶部在可视区域之上（被滚出去了）
      if (cardOffsetTop < panelScrollTop + 10) {
        panel.scrollTo({
          top: Math.max(0, cardOffsetTop - 12),
          behavior: 'smooth'
        });
      }
      // 如果卡片底部超出了可视区域底部
      else if (cardOffsetTop + cardHeight > panelScrollTop + panelVisibleHeight - 20) {
        // 如果卡片自身高度小于面板可视高度，向下滚动刚好完整展示卡片并留出安全间隙
        if (cardHeight < panelVisibleHeight - 40) {
          panel.scrollTo({
            top: Math.max(0, cardOffsetTop + cardHeight - panelVisibleHeight + 40),
            behavior: 'smooth'
          });
        } else {
          // 如果卡片极长（如包含多项输入或列表），优先将卡片顶部舒适对齐在抽屉上方，方便用户顺序操作
          panel.scrollTo({
            top: Math.max(0, cardOffsetTop - 12),
            behavior: 'smooth'
          });
        }
      }
    }, 80);
  }

  collapsibles.forEach(item => {
    const box = document.getElementById(item.boxId);
    const header = document.getElementById(item.headerId);
    const btn = document.getElementById(item.btnId);
    if (!box || !header) return;

    // 默认初始状态
    setBoxState(item, item.defaultCollapsed);

    let lastItemToggleTime = 0;
    function toggleThis(e) {
      if (e) {
        e.stopPropagation();
      }
      const now = Date.now();
      if (now - lastItemToggleTime < 350) return; // 350ms 冷却，彻底杜绝触屏/鼠标复合事件导致的闪烁问题
      lastItemToggleTime = now;

      const isCurrentlyCollapsed = box.classList.contains('collapsed');
      if (isCurrentlyCollapsed) {
        // 展开当前卡片
        setBoxState(item, false);
        // 触发智能视口平滑定位，杜绝截断或顶飞
        ensureCardInView(box);
      } else {
        // 再次点击则收起
        setBoxState(item, true);
      }
    }

    header.addEventListener('click', (e) => {
      // 避免如果点击的是 toggle 按钮自身时产生重复触发
      if (e.target.closest('.btn-player-collapsible-toggle')) return;
      toggleThis(e);
    });

    if (btn) {
      btn.addEventListener('click', (e) => {
        toggleThis(e);
      });
    }
  });
}

// ===================== 大屏端商业授权管理与显示 =====================
function initPlayerLicenseManager() {
  const badge = document.getElementById('player-lic-badge');
  const reqDisp = document.getElementById('player-req-code-disp');
  const btnCopy = document.getElementById('btn-player-copy-req');
  const inputCode = document.getElementById('player-lic-input');
  const btnAct = document.getElementById('btn-player-activate');
  const msgDiv = document.getElementById('player-lic-msg');

  async function checkLicense() {
    try {
      const res = await fetch('/api/system/license');
      const data = await res.json();
      const isValid = !!data.is_valid;
      const details = data.details || {};
      const reqCode = details.request_code || details.machine_code || '--------';

      if (reqDisp) reqDisp.textContent = reqCode;
      if (badge) {
        if (isValid) {
          badge.textContent = details.remaining_days || '已授权';
          badge.className = 'player-collapsible-badge online';
        } else {
          badge.textContent = '未授权/已到期';
          badge.className = 'player-collapsible-badge danger';
        }
      }
    } catch (e) {}
  }

  if (inputCode) {
    inputCode.addEventListener('input', (e) => {
      let raw = e.target.value.toUpperCase().replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g, '');
      if (raw.length > 12) raw = raw.slice(0, 12);
      let parts = [];
      if (raw.length > 8) {
        parts = [raw.slice(0, 4), raw.slice(4, 8), raw.slice(8)];
      } else if (raw.length > 4) {
        parts = [raw.slice(0, 4), raw.slice(4)];
      } else if (raw.length > 0) {
        parts = [raw];
      }
      e.target.value = parts.join('-');
    });
  }

  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      const mc = reqDisp ? reqDisp.textContent.trim() : '';
      if (!mc || mc === '--------') return;
      navigator.clipboard.writeText(mc).then(() => {
        alert('已复制 8 位申请码: ' + mc + '\n请填入国文创加密机签发激活码');
      }).catch(() => {
        prompt('请复制申请码：', mc);
      });
    });
  }

  if (btnAct && inputCode) {
    btnAct.addEventListener('click', async () => {
      const code = inputCode.value.trim().toUpperCase();
      const clean = code.replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g, '');
      if (clean.length !== 12) {
        if (msgDiv) {
          msgDiv.textContent = '❌ 请输入完整的 12 位激活码';
          msgDiv.style.color = '#f87171';
        }
        return;
      }
      btnAct.disabled = true;
      btnAct.textContent = '正在激活...';
      try {
        const res = await fetch('/api/system/license', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (data.status === 'success' || data.is_valid) {
          if (msgDiv) {
            msgDiv.textContent = '🎉 商业授权激活成功！';
            msgDiv.style.color = '#34d399';
          }
          await checkLicense();
        } else {
          if (msgDiv) {
            msgDiv.textContent = '❌ ' + (data.message || '激活码校验未通过');
            msgDiv.style.color = '#f87171';
          }
        }
      } catch (e) {
        if (msgDiv) {
          msgDiv.textContent = '❌ 网络请求异常';
          msgDiv.style.color = '#f87171';
        }
      } finally {
        btnAct.disabled = false;
        btnAct.textContent = '⚡ 验证并激活授权';
      }
    });
  }

  checkLicense();
  setInterval(checkLicense, 15000);
}

// 受控端现场定时关机管理器 (只保留定时关机)
function initPlayerSchedManager() {
  const chkEnable = document.getElementById('panel-sched-enable');
  const inputTime = document.getElementById('panel-sched-shutdown-time');
  const btnSave = document.getElementById('btn-save-panel-sched');
  const badge = document.getElementById('player-sched-badge');
  const weekdayTags = document.querySelectorAll('#panel-weekday-chips .weekday-tag');

  if (!chkEnable || !inputTime || !btnSave) return;

  // 星期勾选联动
  weekdayTags.forEach(tag => {
    tag.addEventListener('click', (e) => {
      e.preventDefault();
      const chk = tag.querySelector('input[type="checkbox"]');
      const willBeActive = !tag.classList.contains('active');
      if (willBeActive) {
        tag.classList.add('active');
        if (chk) chk.checked = true;
      } else {
        tag.classList.remove('active');
        if (chk) chk.checked = false;
      }
    });
  });

  function getSelectedDays() {
    const res = [];
    weekdayTags.forEach(tag => {
      const d = parseInt(tag.getAttribute('data-day'));
      const chk = tag.querySelector('input[type="checkbox"]');
      if ((chk && chk.checked) || tag.classList.contains('active')) {
        res.push(d);
      }
    });
    return res.length > 0 ? res.sort() : [1, 2, 3, 4, 5, 6, 7];
  }

  function setSelectedDays(days) {
    const list = Array.isArray(days) ? days.map(n => parseInt(n)) : [1, 2, 3, 4, 5, 6, 7];
    weekdayTags.forEach(tag => {
      const d = parseInt(tag.getAttribute('data-day'));
      const chk = tag.querySelector('input[type="checkbox"]');
      const isSelected = list.includes(d);
      if (chk) chk.checked = isSelected;
      if (isSelected) tag.classList.add('active');
      else tag.classList.remove('active');
    });
  }

  async function loadSched() {
    try {
      const res = await fetch('/api/system/scheduled_shutdown');
      const json = await res.json();
      if (json.status === 'ok' && json.data) {
        const cfg = json.data.config || {};
        const isEn = !!cfg.enabled;
        const shutTime = cfg.shutdown_time || cfg.time || '21:30';
        chkEnable.checked = isEn;
        inputTime.value = shutTime;
        setSelectedDays(cfg.weekdays || [1, 2, 3, 4, 5, 6, 7]);
        if (badge) {
          if (isEn) {
            badge.textContent = `关机: ${shutTime}`;
            badge.style.color = '#38bdf8';
            badge.style.borderColor = 'rgba(56,189,248,0.4)';
          } else {
            badge.textContent = '未启用';
            badge.style.color = '#94a3b8';
            badge.style.borderColor = 'rgba(255,255,255,0.15)';
          }
        }
      }
    } catch (e) {
      console.warn('[PlayerSched] 加载定时关机异常:', e);
    }
  }

  btnSave.addEventListener('click', async () => {
    const isEn = chkEnable.checked;
    const shutTime = inputTime.value || '21:30';
    const weekdays = getSelectedDays();
    btnSave.disabled = true;
    btnSave.textContent = '正在保存...';
    try {
      const res = await fetch('/api/system/scheduled_shutdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: isEn,
          time: shutTime,
          shutdown_time: shutTime,
          weekdays: weekdays
        })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        if (typeof showToast === 'function') showToast('已保存每日定时关机排程！');
        else alert('已保存每日定时关机排程！');
        await loadSched();
      } else {
        alert('保存失败: ' + (data.message || '未知错误'));
      }
    } catch (err) {
      alert('保存异常: ' + err);
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = '💾 保存定时关机排程';
    }
  });

  loadSched();
}

// 页面加载完成后初始化折叠面板、授权监控与定时关机排程
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initPlayerDrawerCollapsibles();
    initPlayerLicenseManager();
    initPlayerSchedManager();
  });
} else {
  initPlayerDrawerCollapsibles();
  initPlayerLicenseManager();
  initPlayerSchedManager();
}

