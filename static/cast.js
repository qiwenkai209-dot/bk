/**
 * VisualCast 无线投屏发送端逻辑 (WebRTC 局域网极低延迟镜像 + 本地相册媒体直投)
 */
(function() {
  // DOM 元素
  const castConnBadge = document.getElementById('cast-conn-badge');
  const panelIdle = document.getElementById('panel-idle');
  const panelActive = document.getElementById('panel-active');
  const btnStartScreenCast = document.getElementById('btn-start-screen-cast');
  const btnStopCast = document.getElementById('btn-stop-cast');
  const selectResolution = document.getElementById('select-resolution');
  const chkAudio = document.getElementById('chk-audio');
  const inputCastFile = document.getElementById('input-cast-file');
  const castNotice = document.getElementById('cast-notice');
  const localPreview = document.getElementById('local-preview');
  const previewStreamInfo = document.getElementById('preview-stream-info');
  const previewTimer = document.getElementById('preview-timer');
  const pcSecureTip = document.getElementById('pc-secure-tip');
  const castDeviceTip = document.getElementById('cast-device-tip');
  const chromeFlagsCmd = document.getElementById('chrome-flags-cmd');

  // WebRTC 状态
  let pc = null;
  let localStream = null;
  let timerInterval = null;
  let castStartTime = 0;
  let pollAnswerTimer = null;
  let isCasting = false;

  // 检测是否为移动端设备 (iOS/Android/iPad)
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (window.innerWidth <= 768);

  function adaptDeviceUI() {
    if (isMobile) {
      if (castDeviceTip) {
        castDeviceTip.textContent = '📱 手机端已就绪，轻触下方【投送手机相册/视频】即可秒级上屏放映！';
      }
      if (btnStartScreenCast) {
        const sub = btnStartScreenCast.querySelector('.btn-sub-text');
        if (sub) sub.textContent = '整屏录屏建议使用 Windows / Mac 电脑 Chrome 浏览器';
      }
    }
    if (chromeFlagsCmd) {
      chromeFlagsCmd.textContent = `chrome://flags/#unsafely-treat-insecure-origin-as-secure (填入 http://${location.host})`;
    }
  }

  function showNotice(msg, isError = true) {
    if (!castNotice) return;
    castNotice.textContent = msg;
    castNotice.style.borderColor = isError ? 'rgba(239,68,68,0.4)' : 'rgba(16,185,129,0.4)';
    castNotice.style.background = isError ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)';
    castNotice.style.color = isError ? '#fca5a5' : '#86efac';
    castNotice.classList.remove('hidden');
  }

  function hideNotice() {
    if (castNotice) castNotice.classList.add('hidden');
  }

  // 1. 检查大屏在线状态
  async function checkServerStatus() {
    try {
      const res = await fetch('/api/cast/info');
      const data = await res.json();
      if (data.status === 'ok') {
        if (castConnBadge) {
          castConnBadge.textContent = '大屏在线';
          castConnBadge.className = 'conn-badge online';
        }
        if (data.is_active && !isCasting) {
          showNotice('当前大屏已有设备投屏中，您发起投送将进行无缝切换', false);
        }
      } else {
        if (castConnBadge) {
          castConnBadge.textContent = '大屏异常';
          castConnBadge.className = 'conn-badge offline';
        }
      }
    } catch (e) {
      if (castConnBadge) {
        castConnBadge.textContent = '连接中断';
        castConnBadge.className = 'conn-badge offline';
      }
    }
  }

  // 2. 发起电脑桌面屏幕共享
  async function startScreenCast() {
    hideNotice();
    if (pcSecureTip) pcSecureTip.classList.add('hidden');

    if (isMobile) {
      showNotice('手机移动端系统限制普通网页录制整机屏幕，请直接点击上方【投送手机相册/本地视频/照片】上屏放映！', false);
      return;
    }

    // 检查浏览器是否支持屏幕采集 API
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      const isHttps = (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
      if (!isHttps) {
        if (pcSecureTip) pcSecureTip.classList.remove('hidden');
        showNotice('当前浏览器在 HTTP 局域网下限制直接录屏。请参考下方免证书配置，或直接使用上方【投送本地文件】！');
      } else {
        showNotice('当前浏览器不支持屏幕采集接口，推荐使用电脑版 Chrome 或 Edge 浏览器。');
      }
      return;
    }

    // 分辨率约束
    let videoConstraints = { cursor: "always" };
    const resVal = selectResolution ? selectResolution.value : '1080p';
    if (resVal === '720p') {
      videoConstraints.width = { ideal: 1280, max: 1280 };
      videoConstraints.height = { ideal: 720, max: 720 };
      videoConstraints.frameRate = { ideal: 30, max: 30 };
    } else if (resVal === '1080p') {
      videoConstraints.width = { ideal: 1920, max: 1920 };
      videoConstraints.height = { ideal: 1080, max: 1080 };
      videoConstraints.frameRate = { ideal: 60, max: 60 };
    } else if (resVal === '4k') {
      videoConstraints.width = { ideal: 3840 };
      videoConstraints.height = { ideal: 2160 };
    }

    const needAudio = chkAudio ? chkAudio.checked : true;

    try {
      localStream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: needAudio
      });
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        showNotice('您取消了屏幕共享授权');
      } else {
        showNotice('屏幕捕获启动失败: ' + (err.message || err.name));
      }
      return;
    }

    // 绑定系统停止共享浮条事件
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        stopCast();
      };
    }

    // 显示本地小视窗预览
    if (localPreview) {
      localPreview.srcObject = localStream;
    }

    // 切换至投屏中控制面板
    isCasting = true;
    if (panelIdle) panelIdle.classList.add('hidden');
    if (panelActive) panelActive.classList.remove('hidden');
    startTimer();

    // 建立 WebRTC 对等连接
    try {
      pc = new RTCPeerConnection({ iceServers: [] });

      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          fetch('/api/cast/signal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              role: 'sender',
              type: 'candidate',
              candidate: event.candidate
            })
          }).catch(() => {});
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await fetch('/api/cast/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: 'sender',
          type: 'offer',
          sdp: offer.sdp
        })
      });

      pollAnswer();
    } catch (err) {
      showNotice('WebRTC 连接建立失败: ' + err.message);
      stopCast();
    }
  }

  // 3. 轮询接收端 Answer
  function pollAnswer() {
    let attempts = 0;
    if (pollAnswerTimer) clearInterval(pollAnswerTimer);

    pollAnswerTimer = setInterval(async () => {
      attempts++;
      if (attempts > 30) {
        clearInterval(pollAnswerTimer);
        showNotice('等待大屏端响应超时，请重试');
        stopCast();
        return;
      }

      try {
        const res = await fetch('/api/cast/signal?role=sender');
        const data = await res.json();
        if (data && data.answer) {
          clearInterval(pollAnswerTimer);
          pollAnswerTimer = null;
          if (pc && pc.signalingState !== 'stable') {
            await pc.setRemoteDescription(new RTCSessionDescription({
              type: 'answer',
              sdp: data.answer
            }));
          }
        }
      } catch (e) {}
    }, 500);
  }

  // 4. 计时器
  function startTimer() {
    castStartTime = Date.now();
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - castStartTime) / 1000);
      const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
      const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      if (previewTimer) previewTimer.textContent = `${h}:${m}:${s}`;
    }, 1000);
  }

  // 5. 停止投屏
  async function stopCast() {
    isCasting = false;
    if (pollAnswerTimer) clearInterval(pollAnswerTimer);
    if (timerInterval) clearInterval(timerInterval);

    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (localPreview) {
      localPreview.srcObject = null;
    }
    if (pc) {
      pc.close();
      pc = null;
    }

    try {
      await fetch('/api/cast/stop', { method: 'POST' });
    } catch (e) {}

    if (panelActive) panelActive.classList.add('hidden');
    if (panelIdle) panelIdle.classList.remove('hidden');
  }

  // 6. 手机相册/本地视频/图片/文档直投 (核心投送引擎)
  if (inputCastFile) {
    inputCastFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
      showNotice(`正在投送 [${file.name}] (${sizeMb} MB) 至大屏...`, false);

      const formData = new FormData();
      formData.append('file', file);

      try {
        const res = await fetch('/api/cast/upload_media', {
          method: 'POST',
          body: formData
        });
        const ret = await res.json();
        if (ret && ret.status === 'ok') {
          showNotice(`🎉 已成功将 [${file.name}] 投射至大屏全屏放映！`, false);
        } else {
          showNotice(ret.message || '投送未能完成，请检查文件格式');
        }
      } catch (err) {
        showNotice('网络传输异常: ' + (err.message || '请检查内网连接'));
      } finally {
        inputCastFile.value = '';
      }
    });
  }

  // 事件绑定
  if (btnStartScreenCast) btnStartScreenCast.addEventListener('click', startScreenCast);
  if (btnStopCast) btnStopCast.addEventListener('click', stopCast);

  // 初始化设备自适应和状态检测
  adaptDeviceUI();
  checkServerStatus();
  setInterval(checkServerStatus, 3000);

})();
