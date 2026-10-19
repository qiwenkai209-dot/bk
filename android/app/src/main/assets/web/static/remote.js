/**
 * VisualCast 讲解员掌上手持无线手牌端交互逻辑
 * 专为手机/iPad 触摸屏优化，彻底剥离系统运维与高危配置
 */

(function() {
  // ===================== 1. 身份鉴权与安全令牌注入 =====================
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
        showAuthModal();
      }
    }
    return resp;
  };

  // 鉴权 DOM
  const modalRemoteAuth = document.getElementById('remote-auth-modal');
  const formRemoteLogin = document.getElementById('remote-login-form');
  const inputRemoteUser = document.getElementById('remote-username');
  const inputRemotePass = document.getElementById('remote-password');
  const errRemoteLogin = document.getElementById('remote-login-error');
  const btnRemoteLogout = document.getElementById('btn-remote-logout');

  let isAuthenticated = false;
  let pollTimer = null;

  function showAuthModal() {
    if (modalRemoteAuth) {
      modalRemoteAuth.classList.remove('hidden');
      if (errRemoteLogin) errRemoteLogin.classList.add('hidden');
      if (inputRemotePass) {
        inputRemotePass.value = '';
        setTimeout(() => inputRemotePass.focus(), 150);
      }
    }
  }

  function hideAuthModal() {
    if (modalRemoteAuth) modalRemoteAuth.classList.add('hidden');
  }

  function showAuthError(msg) {
    if (errRemoteLogin) {
      errRemoteLogin.textContent = msg;
      errRemoteLogin.classList.remove('hidden');
    }
  }

  // 账号密码登录表单提交
  if (formRemoteLogin) {
    formRemoteLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      const user = inputRemoteUser ? inputRemoteUser.value.trim() : '';
      const pass = inputRemotePass ? inputRemotePass.value.trim() : '';
      if (!pass) return;
      try {
        const res = await rawFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user, password: pass })
        });
        const ret = await res.json();
        if (res.ok && ret.status === 'ok') {
          if (ret.token) localStorage.setItem('vc_token', ret.token);
          isAuthenticated = true;
          hideAuthModal();
          startRemoteLoops();
        } else {
          showAuthError(ret.message || '密码错误，请重新输入');
        }
      } catch (err) {
        showAuthError('网络连接异常，请检查局域网通信');
      }
    });
  }

  // 安全退出手牌登录
  if (btnRemoteLogout) {
    btnRemoteLogout.addEventListener('click', async (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      if (confirm('确定要退出讲解员手牌登录吗？')) {
        try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (err) {}
        localStorage.removeItem('vc_token');
        isAuthenticated = false;
        if (pollTimer) clearTimeout(pollTimer);
        showAuthModal();
      }
    });
  }

  // DOM
  const connStatus = document.getElementById('conn-status');
  const btnReturnIdle = document.getElementById('btn-return-idle');
  const modeBadge = document.getElementById('mode-badge');
  const mediaTypeBadge = document.getElementById('media-type-badge');
  const currentTitle = document.getElementById('current-title');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const tcCurrent = document.getElementById('tc-current');
  const tcTotal = document.getElementById('tc-total');

  // 触觉轻震动反馈 (专为移动端打造真实硬件手感)
  function triggerHaptic(ms = 18) {
    try {
      if (window.navigator && window.navigator.vibrate) {
        window.navigator.vibrate(ms);
      }
    } catch (e) {}
  }

  // 控制组
  const ctrlVideo = document.getElementById('ctrl-video');
  const ctrlDoc = document.getElementById('ctrl-doc');
  const btnRemotePrev = document.getElementById('btn-remote-prev');
  const btnRemoteNext = document.getElementById('btn-remote-next');
  const btnPlayPause = document.getElementById('btn-play-pause');
  const playIcon = document.getElementById('play-icon');
  const playText = document.getElementById('play-text');
  const btnSeekBack = document.getElementById('btn-seek-back');
  const btnSeekFwd = document.getElementById('btn-seek-fwd');
  const btnRemoteLoop = document.getElementById('btn-remote-loop');
  const btnRemoteScale = document.getElementById('btn-remote-scale');
  const btnBlackout = document.getElementById('btn-blackout');
  const btnStop = document.getElementById('btn-stop');
  const btnVolDown = document.getElementById('btn-vol-down');
  const btnVolUp = document.getElementById('btn-vol-up');
  let currentScaleMode = 'fill';

  // 四种循环播放模式定义
  const REMOTE_LOOP_MODES = {
    'FOLDER_LOOP': { label: '🔁 目录循环', color: '#00f0ff', border: 'rgba(0, 240, 255, 0.4)' },
    'SINGLE_LOOP': { label: '🔂 单曲循环', color: '#a855f7', border: 'rgba(168, 85, 247, 0.4)' },
    'ALL_LOOP': { label: '🌐 全部循环', color: '#10b981', border: 'rgba(16, 185, 129, 0.4)' },
    'PLAY_ONCE': { label: '⏹ 播放一次', color: '#94a3b8', border: 'rgba(148, 163, 184, 0.3)' }
  };
  const REMOTE_LOOP_ORDER = ['FOLDER_LOOP', 'SINGLE_LOOP', 'ALL_LOOP', 'PLAY_ONCE'];
  let currentRemoteLoopMode = 'FOLDER_LOOP';
  let currentRemoteFolder = 'ALL';
  let foldersList = [];

  const btnDocPrev = document.getElementById('btn-doc-prev');
  const btnDocNext = document.getElementById('btn-doc-next');
  const btnDocExit = document.getElementById('btn-doc-exit');

  const volSlider = document.getElementById('vol-slider');
  const volText = document.getElementById('vol-text');
  const btnMuteToggle = document.getElementById('btn-mute-toggle');

  // 素材列表
  const mediaCountBadge = document.getElementById('media-count');
  const catTabs = document.getElementById('cat-tabs');
  const remoteMediaList = document.getElementById('remote-media-list');

  // 状态
  let currentStatus = null;
  let allMediaItems = [];
  let currentCategory = 'all';
  let isDraggingVolume = false;
  let isBlackout = false;

  // 格式化时间码
  function formatTime(sec) {
    if (!sec || isNaN(sec)) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // 1. 发送通用播控指令
  async function sendCommand(cmd, params = {}) {
    triggerHaptic(15);
    try {
      await fetch('/api/player/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, params: params })
      });
      pollStatus(); // 触发后立即刷新
    } catch (e) {
      console.warn('下发指令失败:', e);
    }
  }

  // 2. 轮询大屏状态
  async function pollStatus() {
    try {
      const res = await fetch('/api/player/status');
      const data = await res.json();
      if (data.status === 'ok' && data.player) {
        connStatus.textContent = '大屏在线';
        connStatus.className = 'conn-badge online';
        renderPlayerStatus(data.player);
      } else {
        connStatus.textContent = '大屏离线';
        connStatus.className = 'conn-badge offline';
      }
    } catch (e) {
      connStatus.textContent = '连接中断';
      connStatus.className = 'conn-badge offline';
    }
  }

  // 渲染大屏状态卡片
  function renderPlayerStatus(p) {
    currentStatus = p;
    currentTitle.textContent = p.current_media || 'VisualCast 待机中';

    // 模式徽章
    const isAttract = (p.mode === 'ATTRACT');
    modeBadge.textContent = isAttract ? '待机中' : '现场点播中';
    modeBadge.className = `mode-badge ${isAttract ? 'attract' : 'ondemand'}`;

    // 媒体类型与控制组动态切换 (PPT/PDF/图片均进入翻页控制组)
    const mediaName = (p.current_media || '').toLowerCase();
    const isDoc = mediaName.endsWith('.ppt') || mediaName.endsWith('.pptx') || mediaName.endsWith('.pdf');
    const isImage = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].some(ext => mediaName.endsWith('.' + ext));
    const isDocOrImg = isDoc || isImage;

    if (isDoc) mediaTypeBadge.textContent = 'DOC / PPT';
    else if (isImage) mediaTypeBadge.textContent = 'IMAGE';
    else mediaTypeBadge.textContent = 'VIDEO / AUDIO';

    if (isDocOrImg) {
      ctrlVideo.classList.add('hidden');
      ctrlDoc.classList.remove('hidden');
    } else {
      ctrlVideo.classList.remove('hidden');
      ctrlDoc.classList.add('hidden');
    }

    // 播放/暂停状态
    const isPlaying = (p.state === 'PLAYING');
    if (isPlaying) {
      btnPlayPause.classList.add('playing');
      playIcon.textContent = '⏸';
      playText.textContent = '暂停放映';
    } else {
      btnPlayPause.classList.remove('playing');
      playIcon.textContent = '▶';
      playText.textContent = '继续播放';
    }

    // 进度与时间码
    const cur = p.current_time || 0;
    const dur = p.duration || 0;
    tcCurrent.textContent = formatTime(cur);
    tcTotal.textContent = formatTime(dur);
    const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
    progressBarFill.style.width = `${pct}%`;

    // 音量
    if (!isDraggingVolume) {
      volSlider.value = p.volume !== undefined ? p.volume : 85;
      volText.textContent = `${volSlider.value}%`;
    }
    btnMuteToggle.textContent = p.muted ? '🔇' : '🔊';

    // 黑场状态
    isBlackout = !!p.blackout;
    btnBlackout.textContent = isBlackout ? '⬜ 解除黑场' : '⬛ 黑场遮罩';

    // 四种播放循环模式状态同步
    if (p.loop_mode) {
      currentRemoteLoopMode = p.loop_mode;
    } else if (p.loop !== undefined) {
      currentRemoteLoopMode = p.loop ? 'FOLDER_LOOP' : 'PLAY_ONCE';
    }
    const loopCfg = REMOTE_LOOP_MODES[currentRemoteLoopMode] || REMOTE_LOOP_MODES['FOLDER_LOOP'];
    btnRemoteLoop.textContent = loopCfg.label;
    btnRemoteLoop.style.color = loopCfg.color;
    btnRemoteLoop.style.borderColor = loopCfg.border;

    // 全屏拉伸/等比模式状态
    if (p.scale_mode) {
      currentScaleMode = p.scale_mode;
      const isFill = (currentScaleMode === 'fill');
      btnRemoteScale.textContent = isFill ? '⛶ 全屏拉伸' : '🔲 等比适应';
      btnRemoteScale.style.color = isFill ? '#38bdf8' : '#94a3b8';
      btnRemoteScale.style.borderColor = isFill ? 'rgba(56, 189, 248, 0.4)' : 'var(--border-color)';
    }

    // 高亮当前正在播出的素材卡片
    highlightPlayingCard(p.current_media);
  }

  // 3. 拉取并渲染展项素材列表与子文件夹
  async function loadMediaLibrary() {
    try {
      const res = await fetch('/api/media');
      const data = await res.json();
      if (data.status === 'ok') {
        allMediaItems = data.media || data.files || [];
        foldersList = data.folders || [];
        renderRemoteFolderOptions();
        renderMediaCards();
      }
    } catch (e) {
      remoteMediaList.innerHTML = '<div class="loading-hint">拉取素材失败，请检查网络</div>';
    }
  }

  function renderRemoteFolderOptions() {
    const sel = document.getElementById('remote-folder-select');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '';
    foldersList.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.folder;
      opt.textContent = `📁 ${f.name} (${f.count})`;
      sel.appendChild(opt);
    });
    if (cur && foldersList.some(f => f.folder === cur)) {
      sel.value = cur;
      currentRemoteFolder = cur;
    } else {
      sel.value = currentRemoteFolder || 'ALL';
    }
  }

  function renderMediaCards() {
    let filtered = allMediaItems;
    // 文件夹筛选
    if (currentRemoteFolder !== 'ALL') {
      filtered = filtered.filter(m => (m.folder || '') === currentRemoteFolder);
    }
    // 分类筛选
    if (currentCategory !== 'all') {
      filtered = filtered.filter(item => {
        if (currentCategory === 'video') return ['video'].includes(item.type);
        if (currentCategory === 'image') return ['image'].includes(item.type);
        if (currentCategory === 'doc') return ['ppt', 'pdf'].includes(item.type);
        if (currentCategory === 'web') return ['web', 'stream'].includes(item.type);
        return true;
      });
    }

    mediaCountBadge.textContent = `${filtered.length} 项`;
    remoteMediaList.innerHTML = '';

    if (filtered.length === 0) {
      remoteMediaList.innerHTML = '<div class="loading-hint">此分类下暂无展项素材</div>';
      return;
    }

    filtered.forEach(item => {
      const card = document.createElement('div');
      const isPlaying = currentStatus && currentStatus.current_media === item.name;
      card.className = `media-card ${isPlaying ? 'is-playing' : ''}`;
      card.dataset.mediaName = item.name;

      // 缩略图
      let thumbSrc = '/static/admin.css'; // fallback
      if (item.type === 'image') {
        thumbSrc = item.url || `/media/${encodeURIComponent(item.name)}`;
      }

      card.innerHTML = `
        <div class="media-thumb" style="display:flex;align-items:center;justify-content:center;background:#1e293b;font-size:22px;">
          ${getThumbIcon(item.type)}
        </div>
        <div class="media-info">
          <div class="media-name">${item.name}</div>
          <div class="media-meta">
            <span>${item.type.toUpperCase()}</span>
            ${isPlaying ? '<span class="media-playing-badge">▶ 正在大屏播映</span>' : '<span>点击切播</span>'}
          </div>
        </div>
      `;

      // 点击切播（点播插播模式）
      card.addEventListener('click', () => {
        sendCommand('LOAD_AND_PLAY', { media: item.name, media_item: item, folder: item.folder || '', mode: 'ON_DEMAND' });
      });

      remoteMediaList.appendChild(card);
    });
  }

  function getThumbIcon(type) {
    switch (type) {
      case 'video': return '🎬';
      case 'image': return '🖼️';
      case 'audio': return '🎵';
      case 'ppt': return '📊';
      case 'pdf': return '📑';
      case 'web': return '🌐';
      case 'stream': return '📡';
      default: return '📁';
    }
  }

  function highlightPlayingCard(playingName) {
    document.querySelectorAll('.media-card').forEach(c => {
      const isCur = c.dataset.mediaName === playingName;
      c.classList.toggle('is-playing', isCur);
      const meta = c.querySelector('.media-meta');
      if (meta) {
        if (isCur) {
          meta.innerHTML = `<span>${c.dataset.mediaName.split('.').pop().toUpperCase()}</span><span class="media-playing-badge">▶ 正在大屏播映</span>`;
        } else {
          meta.innerHTML = `<span>${c.dataset.mediaName.split('.').pop().toUpperCase()}</span><span>点击切播</span>`;
        }
      }
    });
  }

  // 4. 事件监听绑定
  // 一键回待机
  btnReturnIdle.addEventListener('click', async () => {
    try {
      await fetch('/api/player/return_idle', { method: 'POST' });
      pollStatus();
    } catch (e) {}
  });

  // 切上一个素材
  if (btnRemotePrev) {
    btnRemotePrev.addEventListener('click', () => {
      sendCommand('PREV');
    });
  }

  // 切下一个素材
  if (btnRemoteNext) {
    btnRemoteNext.addEventListener('click', () => {
      sendCommand('NEXT');
    });
  }

  // 播放/暂停切换
  btnPlayPause.addEventListener('click', () => {
    if (!currentStatus) return;
    if (currentStatus.state === 'PLAYING') {
      sendCommand('PAUSE');
    } else {
      sendCommand('PLAY');
    }
  });

  // 快退/快进 10 秒
  btnSeekBack.addEventListener('click', () => {
    if (!currentStatus) return;
    const t = Math.max(0, (currentStatus.current_time || 0) - 10);
    sendCommand('SEEK', { time: t });
  });

  btnSeekFwd.addEventListener('click', () => {
    if (!currentStatus) return;
    const t = Math.min((currentStatus.duration || 9999), (currentStatus.current_time || 0) + 10);
    sendCommand('SEEK', { time: t });
  });

  // 停止
  btnStop.addEventListener('click', () => {
    sendCommand('STOP');
  });

  // 黑场
  btnBlackout.addEventListener('click', () => {
    sendCommand('BLACKOUT', { blackout: !isBlackout });
  });

  // 大屏深度休眠 / 唤醒切换 (带 2 秒拟真安卓系统开关机过渡动画)
  const btnRemoteSleep = document.getElementById('btn-remote-sleep');
  let isRemoteSleeping = false;
  if (btnRemoteSleep) {
    btnRemoteSleep.addEventListener('click', async () => {
      const targetSleep = !isRemoteSleeping;
      try {
        const url = targetSleep ? '/api/system/sleep' : '/api/system/wakeup';
        const res = await fetch(url, { method: 'POST' });
        const d = await res.json();
        if (d.status === 'ok') {
          isRemoteSleeping = targetSleep;
          btnRemoteSleep.textContent = targetSleep ? '☀️ 唤醒放映' : '🌙 大屏休眠';
          btnRemoteSleep.style.color = targetSleep ? '#34d399' : '#38bdf8';
          btnRemoteSleep.style.borderColor = targetSleep ? 'rgba(52, 211, 153, 0.6)' : '#38bdf8';
        }
      } catch (e) {}
    });
  }

  // 四种循环播放模式按键点击轮转切换
  btnRemoteLoop.addEventListener('click', () => {
    const curIdx = REMOTE_LOOP_ORDER.indexOf(currentRemoteLoopMode);
    const nextMode = REMOTE_LOOP_ORDER[(curIdx + 1) % REMOTE_LOOP_ORDER.length];
    currentRemoteLoopMode = nextMode;
    const loopCfg = REMOTE_LOOP_MODES[nextMode];
    btnRemoteLoop.textContent = loopCfg.label;
    btnRemoteLoop.style.color = loopCfg.color;
    btnRemoteLoop.style.borderColor = loopCfg.border;
    sendCommand('SET_LOOP_MODE', {
      loop_mode: nextMode,
      folder: (currentRemoteFolder === 'ALL') ? '' : currentRemoteFolder
    });
  });

  // 全屏拉伸/等比适应切换
  btnRemoteScale.addEventListener('click', () => {
    const nextMode = (currentScaleMode === 'fill') ? 'contain' : 'fill';
    currentScaleMode = nextMode;
    btnRemoteScale.textContent = (nextMode === 'fill') ? '⛶ 全屏拉伸' : '🔲 等比适应';
    btnRemoteScale.style.color = (nextMode === 'fill') ? '#38bdf8' : '#94a3b8';
    sendCommand('SET_SCALE_MODE', { scale_mode: nextMode });
  });

  // 文档翻页与退出放映
  btnDocPrev.addEventListener('click', () => {
    sendCommand('DOC_PREV');
    fetch('/api/player/keystroke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'PGUP' })
    }).catch(() => {});
  });

  btnDocNext.addEventListener('click', () => {
    sendCommand('DOC_NEXT');
    fetch('/api/player/keystroke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'PGDN' })
    }).catch(() => {});
  });

  btnDocExit.addEventListener('click', () => {
    fetch('/api/player/keystroke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'ESC' })
    }).catch(() => {});
    fetch('/api/player/close_ppt', { method: 'POST' }).catch(() => {});
    sendCommand('STOP');
  });

  // 音量调节与步进
  if (btnVolDown) {
    btnVolDown.addEventListener('click', () => {
      const cur = parseInt(volSlider.value) || 85;
      const next = Math.max(0, cur - 5);
      volSlider.value = next;
      volText.textContent = `${next}%`;
      sendCommand('VOLUME', { volume: next });
    });
  }

  if (btnVolUp) {
    btnVolUp.addEventListener('click', () => {
      const cur = parseInt(volSlider.value) || 85;
      const next = Math.min(100, cur + 5);
      volSlider.value = next;
      volText.textContent = `${next}%`;
      sendCommand('VOLUME', { volume: next });
    });
  }

  volSlider.addEventListener('input', () => {
    isDraggingVolume = true;
    volText.textContent = `${volSlider.value}%`;
  });

  volSlider.addEventListener('change', () => {
    isDraggingVolume = false;
    sendCommand('VOLUME', { volume: parseInt(volSlider.value) });
  });

  btnMuteToggle.addEventListener('click', () => {
    if (!currentStatus) return;
    sendCommand('MUTE', { muted: !currentStatus.muted });
  });

  // 分类 Tab 切换
  catTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.cat-tab');
    if (!tab) return;
    document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentCategory = tab.dataset.cat;
    renderMediaCards();
  });

  // 6. 掌上手牌端子文件夹切换与即时循环播放
  const remoteFolderSelect = document.getElementById('remote-folder-select');
  const btnRemotePlayFolder = document.getElementById('btn-remote-play-folder');

  if (remoteFolderSelect) {
    remoteFolderSelect.addEventListener('change', (e) => {
      currentRemoteFolder = e.target.value;
      renderMediaCards();
    });
  }

  if (btnRemotePlayFolder) {
    btnRemotePlayFolder.addEventListener('click', () => {
      const targetFolder = (currentRemoteFolder === 'ALL') ? '' : currentRemoteFolder;
      currentRemoteLoopMode = 'FOLDER_LOOP';
      const loopCfg = REMOTE_LOOP_MODES['FOLDER_LOOP'];
      btnRemoteLoop.textContent = loopCfg.label;
      btnRemoteLoop.style.color = loopCfg.color;
      btnRemoteLoop.style.borderColor = loopCfg.border;
      sendCommand('PLAY_FOLDER', { folder: targetFolder, loop_mode: 'FOLDER_LOOP' });
    });
  }

  // 5. 智能低能耗自适应轮询 (链式调度，前台 1200ms，后台切出时 4000ms，杜绝资源堆积)
  async function pollStatusLoop() {
    if (!isAuthenticated) return;
    try {
      await pollStatus();
    } catch (e) {
    } finally {
      if (isAuthenticated) {
        const isHidden = (document.visibilityState === 'hidden');
        const delay = isHidden ? 4000 : 1200;
        pollTimer = setTimeout(pollStatusLoop, delay);
      }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isAuthenticated) {
      if (pollTimer) clearTimeout(pollTimer);
      pollStatusLoop();
    }
  });

  function startRemoteLoops() {
    loadMediaLibrary();
    if (pollTimer) clearTimeout(pollTimer);
    pollStatusLoop();
  }

  // 页面入口：检查鉴权状态
  async function initAuth() {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      if (data && data.authenticated) {
        isAuthenticated = true;
        hideAuthModal();
        startRemoteLoops();
      } else {
        isAuthenticated = false;
        showAuthModal();
      }
    } catch (e) {
      isAuthenticated = false;
      showAuthModal();
    }
  }

  initAuth();

})();
