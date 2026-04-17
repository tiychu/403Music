/**
 * 403MY — 纯 HTML5 音乐播放器
 * 支持 .mp3 .flac 等格式 | 外链播放列表 | LRC歌词 | Media Session API 后台播放
 *
 * Copyright (C) 2026 403My
 * SPDX-License-Identifier: GPL-3.0-or-later
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

// ======================== 从 API 加载播放列表（SQLite 后端） ========================
// API 基地址（自动检测：有 api.php 用 API，否则回退 localStorage）
const API_BASE = (() => {
  const scripts = document.querySelectorAll('script[src]');
  for (const s of scripts) {
    const m = s.src.match(/^(.+\/)app\.js$/);
    if (m) return m[1] + 'api.php?action=';
  }
  return 'api.php?action=';
})();

// 兼容：localStorage 回退数据
const DEFAULT_PLAYLIST = [];

let PLAYLIST = [];

async function loadPlaylist() {
  try {
    const res = await fetch(API_BASE + 'list');
    const data = await res.json();
    if (data.success && Array.isArray(data.data) && data.data.length > 0) {
      PLAYLIST = data.data;
      return;
    }
  } catch (e) {
    console.warn('API 加载失败，尝试 localStorage 回退', e);
  }

  // 回退：尝试 localStorage
  try {
    const stored = localStorage.getItem('403my_playlist');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) {
        PLAYLIST = parsed;
        return;
      }
    }
  } catch (e) {
    console.warn('localStorage 也无数据', e);
  }

  PLAYLIST = DEFAULT_PLAYLIST;
}

// ======================== 状态管理 ========================
const state = {
  currentIndex: 0,
  isPlaying: false,
  repeatMode: 'none', // 'none' | 'all' | 'one'
  isShuffle: false,
  shuffleOrder: [],
  volume: 0.8,
  isMuted: false,
  isPlaylistOpen: false,
  isSeeking: false,
  isLyricsOpen: false,
  isSortMode: false,
  prevVolume: 0.8,
  currentLyrics: [],   // 解析后的 LRC 歌词数组
  activeLyricIndex: -1,  // 当前高亮歌词行索引
  pendingAutoPlay: false // 等待 canplay 后自动播放
};

// ======================== DOM 元素 ========================
const $ = (sel) => document.querySelector(sel);
const audio = $('#audioPlayer');
const coverImage = $('#coverImage');
const cdContainer = $('#cdContainer');
const cdDisc = document.querySelector('.cd-disc');
const coverGlow = $('#coverGlow');
const coverWrapper = $('#coverWrapper');
const playerGlow = $('#playerGlow');
const songTitle = $('#songTitle');
const songArtist = $('#songArtist');
const songAlbum = $('#songAlbum');
const timeCurrent = $('#timeCurrent');
const timeTotal = $('#timeTotal');
const progressRange = $('#progressRange');
const progressFill = $('#progressFill');
const progressBarWrapper = $('#progressBarWrapper');
const btnPlay = $('#btnPlay');
const btnPrev = $('#btnPrev');
const btnNext = $('#btnNext');
const btnShuffle = $('#btnShuffle');
const btnRepeat = $('#btnRepeat');
const volumeRange = $('#volumeRange');
const volumeFill = $('#volumeFill');
const btnVolumeIcon = $('#btnVolumeIcon');
const iconVolumeHigh = $('.icon-volume-high');
const iconVolumeMute = $('.icon-volume-mute');
const iconPlay = $('.icon-play');
const iconPause = $('.icon-pause');
const iconRepeat = $('.icon-repeat');
const iconRepeatOne = $('.icon-repeat-one');
const playlistPanel = $('#playlistPanel');
const playlistEl = $('#playlist');
const playlistCount = $('#playlistCount');
const btnPlaylistToggle = $('#btnPlaylistToggle');
const btnPlaylistClose = $('#btnPlaylistClose');
const btnPlaylistSort = $('#btnPlaylistSort');
const lyricsPanel = $('#lyricsPanel');
const lyricsScroll = $('#lyricsScroll');
const lyricsLines = $('#lyricsLines');
const lyricsEmpty = $('#lyricsEmpty');
const btnLyricsToggle = $('#btnLyricsToggle');
const btnLyricsClose = $('#btnLyricsClose');
const overlay = $('#overlay');
const iframeOverlay = $('#iframeOverlay');
const iframeContent = $('#iframeContent');
const btnIframeBack = $('#btnIframeBack');

// ======================== 设置持久化 ========================
const STORAGE_KEY = '403my_settings';

function saveSettings() {
  try {
    const data = {
      currentIndex: state.currentIndex,
      volume: state.volume,
      isMuted: state.isMuted,
      repeatMode: state.repeatMode,
      isShuffle: state.isShuffle,
      // 保存当前播放进度（用歌曲ID关联，避免索引错位）
      playbackPosition: audio.currentTime || 0,
      playbackSongId: PLAYLIST[state.currentIndex]?.id || null
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) { /* 静默 */ }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// 定期保存播放进度
let saveSettingsTimer = null;
function scheduleSaveSettings() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(saveSettings, 2000);
}

// ======================== 标签栏标题 ========================
const SITE_TITLE = '403Music';

function updateDocTitle() {
  if (state.isPlaying && PLAYLIST[state.currentIndex]) {
    const song = PLAYLIST[state.currentIndex];
    document.title = `${song.title} - ${song.artist} | ${SITE_TITLE}`;
  } else {
    document.title = SITE_TITLE;
  }
}

// ======================== 工具函数 ========================
function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// 文本溢出时hover滚动显示
function setScrollText(el, text) {
  el.textContent = '';
  const span = document.createElement('span');
  span.className = 'text-scroll';
  span.textContent = text;
  el.appendChild(span);
  // 延迟检测溢出（等DOM渲染）
  requestAnimationFrame(() => {
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflow = el.scrollWidth - el.clientWidth;
      span.style.setProperty('--scroll-distance', `-${overflow}px`);
      // 根据溢出长度计算动画时间，每100px约1秒
      const duration = Math.max(3, Math.round(overflow / 80));
      span.style.setProperty('--scroll-duration', `${duration}s`);
    } else {
      span.style.removeProperty('--scroll-distance');
      span.style.removeProperty('--scroll-duration');
    }
  });
}

// ======================== 音频频谱分析（光晕驱动） ========================
let audioCtx = null;
let analyser = null;
let glowAnimId = null;
const pulseRings = [];

function initAudioAnalyser() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    const source = audioCtx.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (e) {
    console.warn('Web Audio API 不可用:', e);
  }
}

function startGlowAnimation() {
  if (glowAnimId) return;
  if (!analyser) initAudioAnalyser();
  if (!analyser) return;

  // 缓存 pulse-ring 元素
  if (pulseRings.length === 0 && playerGlow) {
    const rings = playerGlow.querySelectorAll('.pulse-ring');
    rings.forEach(r => pulseRings.push(r));
  }
  if (pulseRings.length === 0) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  // 每层环的平滑值
  const smoothBass = [0, 0, 0];

  function updateGlow() {
    analyser.getByteFrequencyData(dataArray);

    // 取低频段平均值（节拍区）
    let sum = 0;
    const bassEnd = Math.min(24, bufferLength);
    for (let i = 0; i < bassEnd; i++) {
      sum += dataArray[i];
    }
    const rawBass = sum / bassEnd / 255; // 0~1

    // 3 层环：内层反应最大，外层最小，形成扩散感
    const ringConfigs = [
      { smooth: 0, sensitivity: 1.0, maxScale: 1.02, maxOpacity: 0.30 },
      { smooth: 1, sensitivity: 0.6, maxScale: 1.04, maxOpacity: 0.18 },
      { smooth: 2, sensitivity: 0.35, maxScale: 1.07, maxOpacity: 0.08 },
    ];

    ringConfigs.forEach((cfg, i) => {
      const target = rawBass * cfg.sensitivity;
      smoothBass[cfg.smooth] += (target - smoothBass[cfg.smooth]) * 0.2;
      const v = smoothBass[cfg.smooth];

      const scale = 1 + v * (cfg.maxScale - 1);
      const opacity = v * cfg.maxOpacity;

      pulseRings[i].style.setProperty('--ring-scale', scale.toFixed(4));
      pulseRings[i].style.setProperty('--ring-opacity', opacity.toFixed(3));
    });

    glowAnimId = requestAnimationFrame(updateGlow);
  }
  updateGlow();
}

function stopGlowAnimation() {
  if (glowAnimId) {
    cancelAnimationFrame(glowAnimId);
    glowAnimId = null;
  }
  // 归零：CSS transition 会平滑过渡
  pulseRings.forEach(r => {
    r.style.setProperty('--ring-scale', '1');
    r.style.setProperty('--ring-opacity', '0');
  });
}

// Toast 通知
let toastTimer = null;
let currentToast = null;
function showToast(message, anchorEl) {
  // 清除上一个toast
  if (currentToast) {
    currentToast.classList.remove('show');
    currentToast.classList.add('hide');
    const old = currentToast;
    setTimeout(() => old.remove(), 200);
    currentToast = null;
  }
  clearTimeout(toastTimer);

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  currentToast = toast;

  // 计算位置
  const position = () => {
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      const toastRect = toast.getBoundingClientRect();
      const gap = 10;
      let left = rect.left + rect.width / 2 - toastRect.width / 2;
      let top = rect.top - toastRect.height - gap;

      // 边界修正
      left = Math.max(8, Math.min(left, window.innerWidth - toastRect.width - 8));
      if (top < 8) top = rect.bottom + gap;

      toast.style.left = left + 'px';
      toast.style.top = top + 'px';
    } else {
      // 无锚点时居中显示在底部
      toast.style.left = '50%';
      toast.style.transform = 'translateX(-50%)';
      toast.style.bottom = '100px';
    }
  };

  // 先渲染以获取尺寸
  toast.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    position();
    toast.style.visibility = '';
    // 触发显示动画
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });
  });

  // 自动消失
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    toast.classList.add('hide');
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
      if (currentToast === toast) currentToast = null;
    }, 300);
  }, 1500);
}

// Fisher-Yates 洗牌
function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ======================== LRC 歌词解析 ========================
function parseLRC(lrcText) {
  if (!lrcText || !lrcText.trim()) return [];

  const lines = lrcText.split('\n');
  const result = [];
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/g;

  for (const line of lines) {
    const timestamps = [];
    let match;
    while ((match = timeRegex.exec(line)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3].length === 2 ? parseInt(match[3], 10) * 10 : parseInt(match[3], 10);
      timestamps.push(min * 60 + sec + ms / 1000);
    }

    // 提取歌词文本（去掉时间标签）
    const text = line.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();

    if (timestamps.length > 0 && text) {
      for (const time of timestamps) {
        result.push({ time, text });
      }
    }
  }

  // 按时间排序
  result.sort((a, b) => a.time - b.time);
  return result;
}

// 渲染歌词到 DOM
function renderLyrics(lyrics) {
  state.currentLyrics = lyrics;
  state.activeLyricIndex = -1;

  if (!lyrics || lyrics.length === 0) {
    lyricsLines.innerHTML = '';
    lyricsEmpty.style.display = 'flex';
    return;
  }

  lyricsEmpty.style.display = 'none';
  lyricsLines.innerHTML = lyrics.map((line, i) =>
    `<div class="lyrics-line" data-index="${i}" data-time="${line.time}">${line.text}</div>`
  ).join('');

  // 点击歌词跳转
  lyricsLines.querySelectorAll('.lyrics-line').forEach(el => {
    el.addEventListener('click', () => {
      const time = parseFloat(el.dataset.time);
      if (!isNaN(time)) {
        audio.currentTime = time;
      }
    });
  });

  // 初始滚动到面板中部偏上位置，使前几行歌词可见且居中
  requestAnimationFrame(() => {
    const firstLine = lyricsLines.querySelector('.lyrics-line');
    if (firstLine) {
      const containerRect = lyricsScroll.getBoundingClientRect();
      const lineRect = firstLine.getBoundingClientRect();
      const relativeTop = lineRect.top - containerRect.top + lyricsScroll.scrollTop;
      lyricsScroll.scrollTo({
        top: Math.max(0, relativeTop - containerRect.height * 0.35),
        behavior: 'instant'
      });
    }
  });
}

// 歌词同步滚动
function syncLyrics(currentTime) {
  const lyrics = state.currentLyrics;
  if (!lyrics || lyrics.length === 0) return;

  // 找到当前高亮行
  let newIndex = -1;
  for (let i = lyrics.length - 1; i >= 0; i--) {
    if (currentTime >= lyrics[i].time - 0.1) {
      newIndex = i;
      break;
    }
  }

  if (newIndex === state.activeLyricIndex) return;
  state.activeLyricIndex = newIndex;

  // 更新高亮样式
  const lineEls = lyricsLines.querySelectorAll('.lyrics-line');
  lineEls.forEach((el, i) => {
    el.classList.remove('active', 'nearby');
    if (i === newIndex) {
      el.classList.add('active');
    } else if (Math.abs(i - newIndex) <= 2) {
      el.classList.add('nearby');
    }
  });

  // 自动滚动到当前行（居中显示）
  if (newIndex >= 0 && lineEls[newIndex]) {
    const container = lyricsScroll;
    const lineEl = lineEls[newIndex];
    const containerRect = container.getBoundingClientRect();
    const lineRect = lineEl.getBoundingClientRect();
    // 当前行相对于容器可见区顶部的偏移
    const relativeTop = lineRect.top - containerRect.top + container.scrollTop;
    const lineHeight = lineRect.height;
    const containerHeight = containerRect.height;

    container.scrollTo({
      top: relativeTop - containerHeight / 2 + lineHeight / 2,
      behavior: 'smooth'
    });
  }
}

// ======================== 播放列表渲染 ========================
function renderPlaylist() {
  playlistEl.innerHTML = '';
  playlistEl.classList.toggle('sort-mode', state.isSortMode);
  PLAYLIST.forEach((song, i) => {
    const li = document.createElement('li');
    li.className = `playlist-item${i === state.currentIndex ? ' active' : ''}`;
    li.dataset.index = i;
    li.dataset.id = song.id;
    li.draggable = state.isSortMode;
    li.innerHTML = `
      <span class="drag-handle" title="拖拽排序">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="8" cy="6" r="2"/><circle cx="16" cy="6" r="2"/>
          <circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/>
          <circle cx="8" cy="18" r="2"/><circle cx="16" cy="18" r="2"/>
        </svg>
      </span>
      <span class="playlist-item-index">${i + 1}</span>
      <img class="playlist-item-cover" src="${song.cover}" alt="${song.title}" onerror="this.src='https://placehold.co/44x44/282828/535353?text=♪'">
      <div class="playlist-item-info">
        <div class="playlist-item-title"><span class="text-scroll">${song.title}</span></div>
        <div class="playlist-item-artist"><span class="text-scroll">${song.artist}${song.album ? ' · ' + song.album : ''}</span></div>
      </div>
    `;
    li.addEventListener('click', () => {
      if (!state.isSortMode) playSong(i);
    });
    playlistEl.appendChild(li);
  });
  playlistCount.textContent = `${PLAYLIST.length} 首`;

  // 检测播放列表项文本溢出，设置滚动参数
  playlistEl.querySelectorAll('.playlist-item-title, .playlist-item-artist').forEach(el => {
    const span = el.querySelector('.text-scroll');
    if (span && el.scrollWidth > el.clientWidth + 1) {
      const overflow = el.scrollWidth - el.clientWidth;
      span.style.setProperty('--scroll-distance', `-${overflow}px`);
      const duration = Math.max(3, Math.round(overflow / 80));
      span.style.setProperty('--scroll-duration', `${duration}s`);
    }
  });

  // 排序模式下绑定拖拽事件
  if (state.isSortMode) {
    bindDragEvents();
  }
}

function updatePlaylistHighlight() {
  const items = playlistEl.querySelectorAll('.playlist-item');
  items.forEach((item, i) => {
    item.classList.toggle('active', i === state.currentIndex);
  });
}

// ======================== 代理工具 ========================
// 生成代理 URL（绕过防盗链）
function proxyUrl(originalUrl) {
  if (!originalUrl || !API_BASE) return originalUrl;
  return API_BASE + 'proxy&url=' + encodeURIComponent(originalUrl);
}

// ======================== 核心播放逻辑 ========================
// 记录代理重试状态
const proxyRetried = {};

function loadSong(index, autoPlay = false) {
  const song = PLAYLIST[index];
  if (!song) return;

  state.currentIndex = index;
  // 重置代理重试状态
  proxyRetried[index] = false;
  // 标记是否需要自动播放
  state.pendingAutoPlay = autoPlay;
  audio.src = song.url;

  // 更新 UI（带文本溢出滚动效果）
  setScrollText(songTitle, song.title);
  setScrollText(songArtist, song.artist);
  setScrollText(songAlbum, song.album || '');
  songAlbum.style.display = song.album ? 'block' : 'none';
  // 封面也走代理（防止封面防盗链）
  coverImage.src = song.cover;

  // 重置进度
  progressRange.value = 0;
  progressFill.style.width = '0%';
  timeCurrent.textContent = '0:00';
  timeTotal.textContent = '0:00';

  updatePlaylistHighlight();

  // 加载歌词
  const lyrics = parseLRC(song.lyrics || '');
  renderLyrics(lyrics);

  // 更新 Media Session 元数据
  updateMediaSession();

  // 更新标签栏标题
  updateDocTitle();

  saveSettings();
}

function playSong(index) {
  if (index !== undefined) {
    loadSong(index, true);
    return; // 播放由 canplay 事件触发，避免在音频未就绪时调用 play()
  }
  audio.play().catch(err => {
    console.warn('播放失败:', err);
  });
}

function pauseSong() {
  audio.pause();
  state.isPlaying = false;
  updatePlayButton();
}

function togglePlay() {
  if (state.isPlaying) {
    pauseSong();
    showToast('已暂停', btnPlay);
  } else {
    playSong();
    showToast('正在播放', btnPlay);
  }
}

function playNext() {
  let nextIndex;
  if (state.isShuffle) {
    nextIndex = getShuffleNext();
  } else {
    nextIndex = state.currentIndex + 1;
    if (nextIndex >= PLAYLIST.length) {
      if (state.repeatMode === 'all') {
        nextIndex = 0;
      } else {
        pauseSong();
        return;
      }
    }
  }
  playSong(nextIndex);
}

function playPrev() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  let prevIndex;
  if (state.isShuffle) {
    prevIndex = getShufflePrev();
  } else {
    prevIndex = state.currentIndex - 1;
    if (prevIndex < 0) {
      prevIndex = state.repeatMode === 'all' ? PLAYLIST.length - 1 : 0;
    }
  }
  playSong(prevIndex);
}

// ======================== 随机播放逻辑 ========================
function generateShuffleOrder() {
  const indices = PLAYLIST.map((_, i) => i);
  state.shuffleOrder = shuffleArray(indices);
  const curIdx = state.shuffleOrder.indexOf(state.currentIndex);
  if (curIdx > 0) {
    [state.shuffleOrder[0], state.shuffleOrder[curIdx]] = [state.shuffleOrder[curIdx], state.shuffleOrder[0]];
  }
}

function getShuffleNext() {
  const curPos = state.shuffleOrder.indexOf(state.currentIndex);
  let nextPos = curPos + 1;
  if (nextPos >= state.shuffleOrder.length) {
    if (state.repeatMode === 'all') {
      generateShuffleOrder();
      nextPos = 0;
    } else {
      return state.currentIndex;
    }
  }
  return state.shuffleOrder[nextPos];
}

function getShufflePrev() {
  const curPos = state.shuffleOrder.indexOf(state.currentIndex);
  let prevPos = curPos - 1;
  if (prevPos < 0) {
    prevPos = state.repeatMode === 'all' ? state.shuffleOrder.length - 1 : 0;
  }
  return state.shuffleOrder[prevPos];
}

// ======================== 播放模式 ========================
function toggleShuffle() {
  state.isShuffle = !state.isShuffle;
  btnShuffle.classList.toggle('active', state.isShuffle);
  showToast(state.isShuffle ? '随机播放：开' : '随机播放：关', btnShuffle);
  if (state.isShuffle) {
    generateShuffleOrder();
  }
  saveSettings();
}

function toggleRepeat() {
  const modes = ['none', 'all', 'one'];
  const labels = ['循环模式：关', '列表循环', '单曲循环'];
  const curIdx = modes.indexOf(state.repeatMode);
  state.repeatMode = modes[(curIdx + 1) % modes.length];

  btnRepeat.classList.toggle('active', state.repeatMode !== 'none');
  showToast(labels[(curIdx + 1) % labels.length], btnRepeat);

  if (state.repeatMode === 'one') {
    iconRepeat.style.display = 'none';
    iconRepeatOne.style.display = 'block';
  } else {
    iconRepeat.style.display = 'block';
    iconRepeatOne.style.display = 'none';
  }
  saveSettings();
}

// ======================== UI 更新 ========================
function updatePlayButton() {
  iconPlay.style.display = state.isPlaying ? 'none' : 'block';
  iconPause.style.display = state.isPlaying ? 'block' : 'none';

  // CD 旋转控制
  if (cdDisc) {
    cdDisc.classList.toggle('spinning', state.isPlaying);
  }
  if (cdContainer) {
    cdContainer.classList.toggle('playing', state.isPlaying);
  }
}

let rafId = null;
function updateProgress() {
  if (state.isSeeking) return;

  const { currentTime, duration } = audio;
  if (duration) {
    const pct = (currentTime / duration) * 1000;
    progressRange.value = pct;
    progressFill.style.width = `${(pct / 10)}%`;
    timeCurrent.textContent = formatTime(currentTime);

    // 歌词同步
    syncLyrics(currentTime);
  }

  if (state.isPlaying) {
    rafId = requestAnimationFrame(updateProgress);
  }
}

function updateVolumeUI() {
  const vol = state.isMuted ? 0 : state.volume;
  volumeRange.value = vol * 100;
  volumeFill.style.width = `${vol * 100}%`;

  iconVolumeHigh.style.display = vol > 0 ? 'block' : 'none';
  iconVolumeMute.style.display = vol === 0 ? 'block' : 'none';
}

// ======================== 歌词面板 ========================
function openLyrics() {
  state.isLyricsOpen = true;
  lyricsPanel.classList.add('open');
  btnLyricsToggle.classList.add('active');
}

function closeLyrics() {
  state.isLyricsOpen = false;
  lyricsPanel.classList.remove('open');
  btnLyricsToggle.classList.remove('active');
}

function toggleLyrics() {
  state.isLyricsOpen ? closeLyrics() : openLyrics();
  showToast(state.isLyricsOpen ? '歌词面板' : '关闭歌词', btnLyricsToggle);
}

// ======================== 播放列表面板 ========================
// ======================== iframe 子页面导航 ========================
function openIframePage(href, title) {
  const sep = href.includes('?') ? '&' : '?';
  iframeContent.src = href + sep + 'iframe=1';
  iframeOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeIframePage() {
  iframeOverlay.classList.remove('active');
  // 清理 iframe，停止其中可能运行的媒体
  setTimeout(() => {
    iframeContent.src = 'about:blank';
  }, 400);
  document.body.style.overflow = '';
}

function isDesktop() {
  return window.matchMedia('(min-width: 1024px)').matches;
}

function openPlaylist() {
  state.isPlaylistOpen = true;
  playlistPanel.classList.add('open');
  if (!isDesktop()) {
    overlay.classList.add('active');
  }
}

function closePlaylist() {
  state.isPlaylistOpen = false;
  state.isSortMode = false;
  playlistPanel.classList.remove('open');
  overlay.classList.remove('active');
  btnPlaylistSort.classList.remove('active');
  renderPlaylist();
}

function togglePlaylist() {
  if (isDesktop()) return; // PC端播放列表常驻，不需要切换
  state.isPlaylistOpen ? closePlaylist() : openPlaylist();
}

// ======================== 排序模式 ========================
function toggleSortMode() {
  state.isSortMode = !state.isSortMode;
  btnPlaylistSort.classList.toggle('active', state.isSortMode);
  showToast(state.isSortMode ? '拖拽排序模式' : '退出排序', btnPlaylistSort);
  renderPlaylist();
}

// ======================== 拖拽排序 ========================
let dragSourceIndex = null;

function bindDragEvents() {
  const items = playlistEl.querySelectorAll('.playlist-item');
  items.forEach(item => {
    item.addEventListener('dragstart', onDragStart);
    item.addEventListener('dragover', onDragOver);
    item.addEventListener('dragenter', onDragEnter);
    item.addEventListener('dragleave', onDragLeave);
    item.addEventListener('drop', onDrop);
    item.addEventListener('dragend', onDragEnd);
  });
}

function onDragStart(e) {
  dragSourceIndex = parseInt(this.dataset.index);
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', this.dataset.index);
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function onDragEnter(e) {
  e.preventDefault();
  this.classList.add('drag-over');
}

function onDragLeave() {
  this.classList.remove('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');
  const targetIndex = parseInt(this.dataset.index);
  if (dragSourceIndex === null || dragSourceIndex === targetIndex) return;

  // 交换 PLAYLIST 数组中的位置
  const [moved] = PLAYLIST.splice(dragSourceIndex, 1);
  PLAYLIST.splice(targetIndex, 0, moved);

  // 更新当前播放索引
  if (state.currentIndex === dragSourceIndex) {
    state.currentIndex = targetIndex;
  } else if (dragSourceIndex < state.currentIndex && targetIndex >= state.currentIndex) {
    state.currentIndex--;
  } else if (dragSourceIndex > state.currentIndex && targetIndex <= state.currentIndex) {
    state.currentIndex++;
  }

  renderPlaylist();
  saveSortOrder();
}

function onDragEnd() {
  dragSourceIndex = null;
  playlistEl.querySelectorAll('.playlist-item').forEach(item => {
    item.classList.remove('dragging', 'drag-over');
  });
}

async function saveSortOrder() {
  const token = localStorage.getItem('403my_token') || '';
  if (!token) {
    console.warn('未登录，排序仅当前会话生效');
    return;
  }
  try {
    const orders = PLAYLIST.map((song, i) => ({ id: song.id, sort: i }));
    await fetch(API_BASE + 'reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
      body: JSON.stringify({ orders })
    });
  } catch (e) {
    console.warn('保存排序失败', e);
  }
}

// ======================== Media Session API ========================
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;

  const song = PLAYLIST[state.currentIndex];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: song.artist,
    album: song.album || '403MY',
    artwork: [
      { src: song.cover, sizes: '512x512', type: 'image/jpeg' }
    ]
  });

  navigator.mediaSession.setActionHandler('play', () => playSong());
  navigator.mediaSession.setActionHandler('pause', pauseSong);
  navigator.mediaSession.setActionHandler('previoustrack', playPrev);
  navigator.mediaSession.setActionHandler('nexttrack', playNext);
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime !== undefined) {
      audio.currentTime = details.seekTime;
    }
  });
}

// ======================== 事件绑定 ========================
function bindEvents() {
  // 播放控制
  btnPlay.addEventListener('click', togglePlay);
  btnNext.addEventListener('click', playNext);
  btnPrev.addEventListener('click', playPrev);
  btnShuffle.addEventListener('click', toggleShuffle);
  btnRepeat.addEventListener('click', toggleRepeat);

  // 进度条
  progressRange.addEventListener('input', () => {
    state.isSeeking = true;
    const pct = progressRange.value / 1000;
    progressFill.style.width = `${pct * 100}%`;
    if (audio.duration) {
      timeCurrent.textContent = formatTime(pct * audio.duration);
    }
  });

  progressRange.addEventListener('change', () => {
    const pct = progressRange.value / 1000;
    if (audio.duration) {
      audio.currentTime = pct * audio.duration;
    }
    state.isSeeking = false;
  });

  // 音量
  volumeRange.addEventListener('input', () => {
    state.volume = volumeRange.value / 100;
    state.isMuted = state.volume === 0;
    audio.volume = state.volume;
    audio.muted = false;
    updateVolumeUI();
    saveSettings();
  });

  btnVolumeIcon.addEventListener('click', () => {
    if (state.isMuted || state.volume === 0) {
      state.isMuted = false;
      state.volume = state.prevVolume || 0.5;
      audio.muted = false;
      audio.volume = state.volume;
      showToast('取消静音', btnVolumeIcon);
    } else {
      state.prevVolume = state.volume;
      state.isMuted = true;
      audio.muted = true;
      showToast('已静音', btnVolumeIcon);
    }
    updateVolumeUI();
    saveSettings();
  });

  // 播放列表
  btnPlaylistToggle.addEventListener('click', togglePlaylist);
  btnPlaylistClose.addEventListener('click', closePlaylist);
  btnPlaylistSort.addEventListener('click', toggleSortMode);
  overlay.addEventListener('click', closePlaylist);

  // 歌词面板
  btnLyricsToggle.addEventListener('click', toggleLyrics);
  btnLyricsClose.addEventListener('click', closeLyrics);

  // iframe 导航：子页面在 iframe 中打开，不中断播放
  document.querySelectorAll('.btn-nav-entry, .btn-admin-entry').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const href = link.getAttribute('href');
      const title = link.getAttribute('title') || '';
      openIframePage(href, title);
    });
  });

  // iframe 返回按钮
  btnIframeBack.addEventListener('click', closeIframePage);

  // 监听 iframe 中子页面发来的播放消息
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.type) return;
    if (e.data.type === 'playSong') {
      const songData = e.data.song;
      const idx = PLAYLIST.findIndex(s => s.id === songData.id);
      if (idx >= 0) {
        loadSong(idx, true);
      } else {
        PLAYLIST.push(songData);
        loadSong(PLAYLIST.length - 1, true);
        renderPlaylist();
      }
      closeIframePage();
    } else if (e.data.type === 'closeIframe') {
      closeIframePage();
    }
  });

  // 点击封面打开歌词（移动端）
  coverWrapper.addEventListener('click', () => {
    if (window.innerWidth < 768) {
      if (state.currentLyrics.length > 0) {
        toggleLyrics();
      }
    }
  });

  // Audio 事件
  audio.addEventListener('loadedmetadata', () => {
    if (audio.duration && isFinite(audio.duration)) {
      timeTotal.textContent = formatTime(audio.duration);
    }
  });

  audio.addEventListener('durationchange', () => {
    if (audio.duration && isFinite(audio.duration)) {
      timeTotal.textContent = formatTime(audio.duration);
    }
  });

  audio.addEventListener('timeupdate', () => {
    if (!state.isSeeking) {
      timeCurrent.textContent = formatTime(audio.currentTime);
    }
    if (audio.duration && isFinite(audio.duration) && timeTotal.textContent === '0:00') {
      timeTotal.textContent = formatTime(audio.duration);
    }
    // 定期保存播放进度（节流，每5秒一次）
    scheduleSaveSettings();
  });

  audio.addEventListener('play', () => {
    state.isPlaying = true;
    updatePlayButton();
    updateDocTitle();
    rafId = requestAnimationFrame(updateProgress);
    startGlowAnimation();
  });

  audio.addEventListener('pause', () => {
    state.isPlaying = false;
    updatePlayButton();
    updateDocTitle();
    if (rafId) cancelAnimationFrame(rafId);
    stopGlowAnimation();
  });

  audio.addEventListener('ended', () => {
    if (state.repeatMode === 'one') {
      audio.currentTime = 0;
      audio.play();
    } else {
      playNext();
    }
  });

  audio.addEventListener('error', () => {
    const song = PLAYLIST[state.currentIndex];
    console.error('音频加载失败:', song.url);

    // 如果还没有尝试代理，先走代理重试
    if (!proxyRetried[state.currentIndex]) {
      proxyRetried[state.currentIndex] = true;
      console.log('尝试代理转发:', song.url);
      audio.src = proxyUrl(song.url);
      audio.load();
      return;
    }

    // 代理也失败，跳下一首
    if (PLAYLIST.length > 1) {
      setTimeout(() => playNext(), 1000);
    }
  });

  // 音频可播放时自动开始（解决大文件/FLAC加载慢导致 play() 被中断的问题）
  audio.addEventListener('canplay', () => {
    if (state.pendingAutoPlay) {
      state.pendingAutoPlay = false;
      audio.play().catch(err => {
        console.warn('自动播放失败:', err);
      });
    }
  });

  // 封面加载失败时走代理
  coverImage.addEventListener('error', function onCoverError() {
    const song = PLAYLIST[state.currentIndex];
    if (song && song.cover && !this.dataset.proxied) {
      this.dataset.proxied = '1';
      this.src = proxyUrl(song.cover);
    }
  });

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        e.preventDefault();
        audio.currentTime = Math.min(audio.currentTime + 5, audio.duration || 0);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        audio.currentTime = Math.max(audio.currentTime - 5, 0);
        break;
      case 'ArrowUp':
        e.preventDefault();
        state.volume = Math.min(state.volume + 0.05, 1);
        audio.volume = state.volume;
        updateVolumeUI();
        break;
      case 'ArrowDown':
        e.preventDefault();
        state.volume = Math.max(state.volume - 0.05, 0);
        audio.volume = state.volume;
        updateVolumeUI();
        break;
      case 'KeyN':
        playNext();
        break;
      case 'KeyP':
        playPrev();
        break;
      case 'KeyL':
        toggleLyrics();
        break;
    }
  });

  // 定期从 API 同步播放列表（管理页修改后自动更新）
  setInterval(async () => {
    try {
      const res = await fetch(API_BASE + 'list');
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        // 检查是否有变化（比较长度和第一首标题）
        if (data.data.length !== PLAYLIST.length || 
            (data.data.length > 0 && data.data[0].title !== PLAYLIST[0]?.title)) {
          PLAYLIST = data.data;
          renderPlaylist();
          if (PLAYLIST.length > 0 && state.currentIndex >= PLAYLIST.length) {
            loadSong(0);
          }
        }
      }
    } catch (e) { /* 静默失败 */ }
  }, 30000); // 每30秒检查一次
}

// ======================== 初始化 ========================
async function init() {
  await loadPlaylist();

  // PC端播放列表常驻显示
  if (isDesktop()) {
    playlistPanel.classList.add('open');
  }

  // 检查是否有从歌手页面跳转来的待播放歌曲
  const pendingSong = localStorage.getItem('403my_play_song');
  if (pendingSong) {
    localStorage.removeItem('403my_play_song');
    try {
      const songData = JSON.parse(pendingSong);
      // 在播放列表中查找该歌曲
      const idx = PLAYLIST.findIndex(s => s.id === songData.id);
      if (idx >= 0) {
        // 找到了，直接播放
        loadSong(idx, true);
      } else {
        // 不在列表中，添加到列表末尾并播放
        PLAYLIST.push(songData);
        loadSong(PLAYLIST.length - 1, true);
        renderPlaylist();
      }
    } catch (e) {
      console.warn('解析待播放歌曲失败', e);
    }
  }

  // 恢复上次设置
  const saved = loadSettings();
  if (saved) {
    state.volume = saved.volume ?? 0.8;
    state.isMuted = saved.isMuted ?? false;
    state.repeatMode = saved.repeatMode ?? 'none';
    state.isShuffle = saved.isShuffle ?? false;

    audio.volume = state.isMuted ? 0 : state.volume;
    audio.muted = state.isMuted;

    // 恢复循环模式UI
    btnRepeat.classList.toggle('active', state.repeatMode !== 'none');
    if (state.repeatMode === 'one') {
      iconRepeat.style.display = 'none';
      iconRepeatOne.style.display = 'block';
    }

    // 恢复随机播放UI
    btnShuffle.classList.toggle('active', state.isShuffle);
    if (state.isShuffle) generateShuffleOrder();

    // 恢复当前歌曲（优先用ID匹配，其次用索引）
    if (PLAYLIST.length > 0) {
      let restoreIndex = 0;
      if (saved.playbackSongId) {
        const idx = PLAYLIST.findIndex(s => s.id === saved.playbackSongId);
        if (idx >= 0) restoreIndex = idx;
      } else if (typeof saved.currentIndex === 'number' && saved.currentIndex < PLAYLIST.length) {
        restoreIndex = saved.currentIndex;
      }
      loadSong(restoreIndex);

      // 恢复播放进度
      if (saved.playbackPosition > 0) {
        const pos = saved.playbackPosition;
        audio.addEventListener('loadedmetadata', function onMeta() {
          audio.removeEventListener('loadedmetadata', onMeta);
          if (pos < audio.duration) {
            audio.currentTime = pos;
          }
        }, { once: true });
      }
    }
  } else {
    audio.volume = state.volume;
    if (PLAYLIST.length > 0) {
      loadSong(0);
    }
  }

  renderPlaylist();
  updateVolumeUI();
  updatePlayButton();
  bindEvents();
}

document.addEventListener('DOMContentLoaded', init);
