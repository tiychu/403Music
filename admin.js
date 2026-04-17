/**
 * 403MY — 播放列表管理后台
 * PHP + SQLite 后端 | SHA-256 密码验证 | API CRUD 操作
 *
 * Copyright (C) 2026 403My
 * SPDX-License-Identifier: GPL-3.0-or-later
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

// ======================== API 基地址 ========================
const API_BASE = (() => {
  const scripts = document.querySelectorAll('script[src]');
  for (const s of scripts) {
    const m = s.src.match(/^(.+\/)admin\.js$/);
    if (m) return m[1] + 'api.php?action=';
  }
  return 'api.php?action=';
})();

// ======================== 密码哈希 ========================
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 认证 token（登录成功后缓存）
let authToken = '';

// ======================== DOM 元素 ========================
const $ = (sel) => document.querySelector(sel);
const adminLogin = $('#adminLogin');
const adminPanel = $('#adminPanel');
const loginForm = $('#loginForm');
const loginPassword = $('#loginPassword');
const loginError = $('#loginError');
const btnLogout = $('#btnLogout');
const adminSongList = $('#adminSongList');
const btnAddSong = $('#btnAddSong');
const btnExportData = $('#btnExportData');
const adminSearch = $('#adminSearch');
const adminFormOverlay = $('#adminFormOverlay');
const adminForm = $('#adminForm');
const formTitle = $('#formTitle');
const editIndex = $('#editIndex');
const editTitle = $('#editTitle');
const editArtist = $('#editArtist');
const editAlbum = $('#editAlbum');
const editUrl = $('#editUrl');
const editCover = $('#editCover');
const editLyrics = $('#editLyrics');
const btnFormClose = $('#btnFormClose');
const btnCancel = $('#btnCancel');

// ======================== API 请求封装 ========================
async function apiRequest(action, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (authToken) {
    opts.headers['X-Auth-Token'] = authToken;
  }
  if (body) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API_BASE + action, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error('API 返回非 JSON:', text.substring(0, 500));
    throw new Error('服务器返回了非 JSON 响应');
  }
}

// ======================== 登录逻辑 ========================
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = loginPassword.value;
  if (!password) return;

  try {
    const data = await apiRequest('login', 'POST', { password });
    if (data.success) {
      authToken = data.token;
      sessionStorage.setItem('403my_auth', authToken);
      localStorage.setItem('403my_token', authToken);
      showAdminPanel();
    } else {
      loginError.style.display = 'block';
      loginPassword.value = '';
      loginPassword.focus();
      setTimeout(() => { loginError.style.display = 'none'; }, 3000);
    }
  } catch (err) {
    loginError.textContent = '连接服务器失败';
    loginError.style.display = 'block';
    setTimeout(() => {
      loginError.textContent = '密码错误，请重试';
      loginError.style.display = 'none';
    }, 3000);
  }
});

btnLogout.addEventListener('click', () => {
  authToken = '';
  sessionStorage.removeItem('403my_auth');
  localStorage.removeItem('403my_token');
  showLoginPage();
});

function showAdminPanel() {
  adminLogin.style.display = 'none';
  adminPanel.style.display = 'block';
  renderSongList();
  renderArtistList();
  renderAlbumList();
}

function showLoginPage() {
  adminLogin.style.display = 'flex';
  adminPanel.style.display = 'none';
  loginPassword.value = '';
  loginError.style.display = 'none';
}

// ======================== 歌曲列表渲染 ========================
let playlistCache = [];

function getFilteredList() {
  const keyword = (adminSearch?.value || '').trim().toLowerCase();
  if (!keyword) return playlistCache;
  return playlistCache.filter(song =>
    song.title.toLowerCase().includes(keyword) ||
    song.artist.toLowerCase().includes(keyword) ||
    (song.album || '').toLowerCase().includes(keyword)
  );
}

async function renderSongList() {
  try {
    const data = await apiRequest('list');
    if (data.success) {
      playlistCache = data.data;
    }
  } catch (e) {
    console.warn('加载失败，使用缓存');
  }

  const list = getFilteredList();

  if (list.length === 0) {
    const keyword = (adminSearch?.value || '').trim();
    adminSongList.innerHTML = `<div class="admin-empty">${keyword ? '没有找到匹配的歌曲' : '暂无歌曲，点击上方按钮添加'}</div>`;
    return;
  }

  adminSongList.innerHTML = list.map((song, i) => {
    const cacheIndex = playlistCache.indexOf(song);
    return `
    <div class="admin-song-item" data-index="${cacheIndex}" data-id="${song.id}">
      <div class="admin-song-info">
        <img class="admin-song-cover" src="${song.cover || 'https://placehold.co/48x48/282828/535353?text=♪'}" alt="${song.title}" onerror="this.src='https://placehold.co/48x48/282828/535353?text=♪'">
        <div class="admin-song-text">
          <div class="admin-song-title">${song.title}</div>
          <div class="admin-song-artist">${song.artist}${song.album ? ' · ' + song.album : ''}</div>
          <div class="admin-song-url">${song.url}</div>
        </div>
      </div>
      <div class="admin-song-actions">
        ${song.lyrics ? '<span class="admin-song-badge">有歌词</span>' : ''}
        ${song.album ? '<span class="admin-song-badge">有专辑</span>' : ''}
        <button class="btn-edit-song" data-index="${cacheIndex}" aria-label="编辑">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button class="btn-delete-song" data-index="${cacheIndex}" aria-label="删除">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </div>
  `}).join('');

  // 绑定编辑/删除事件
  adminSongList.querySelectorAll('.btn-edit-song').forEach(btn => {
    btn.addEventListener('click', () => editSong(parseInt(btn.dataset.index)));
  });
  adminSongList.querySelectorAll('.btn-delete-song').forEach(btn => {
    btn.addEventListener('click', () => deleteSong(parseInt(btn.dataset.index)));
  });
}

// 搜索实时过滤
adminSearch?.addEventListener('input', () => renderSongList());

// ======================== 表单操作 ========================
function openForm(index) {
  if (index >= 0) {
    const song = playlistCache[index];
    formTitle.textContent = '编辑歌曲';
    editIndex.value = index;
    editTitle.value = song.title;
    editArtist.value = song.artist;
    editAlbum.value = song.album || '';
    editUrl.value = song.url;
    editCover.value = song.cover || '';
    editLyrics.value = song.lyrics || '';
  } else {
    formTitle.textContent = '添加歌曲';
    editIndex.value = -1;
    adminForm.reset();
  }
  adminFormOverlay.classList.add('open');
}

function closeForm() {
  adminFormOverlay.classList.remove('open');
  adminForm.reset();
}

btnAddSong.addEventListener('click', () => openForm(-1));
btnFormClose.addEventListener('click', closeForm);
btnCancel.addEventListener('click', closeForm);

adminForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const songData = {
    title: editTitle.value.trim(),
    artist: editArtist.value.trim(),
    album: editAlbum.value.trim(),
    url: editUrl.value.trim(),
    cover: editCover.value.trim() || `https://placehold.co/400x400/282828/535353?text=${encodeURIComponent(editTitle.value.trim())}`,
    lyrics: editLyrics.value
  };

  const idx = parseInt(editIndex.value);

  try {
    if (idx >= 0) {
      // 编辑
      songData.id = playlistCache[idx].id;
      await apiRequest('update', 'PUT', songData);
    } else {
      // 添加
      await apiRequest('add', 'POST', songData);
    }
    closeForm();
    await renderSongList();
  } catch (err) {
    alert('保存失败：' + err.message);
  }
});

function editSong(index) {
  openForm(index);
}

async function deleteSong(index) {
  const song = playlistCache[index];
  if (!confirm(`确定要删除「${song.title}」吗？`)) return;

  try {
    await apiRequest('delete', 'DELETE', { id: song.id });
    await renderSongList();
  } catch (err) {
    alert('删除失败：' + err.message);
  }
}

// ======================== 导出 localStorage 数据 ========================
btnExportData.addEventListener('click', async () => {
  // 尝试从 localStorage 读取旧数据
  let localData = null;
  try {
    const stored = localStorage.getItem('403my_playlist');
    if (stored) {
      localData = JSON.parse(stored);
    }
  } catch (e) { /* 忽略 */ }

  if (localData && Array.isArray(localData) && localData.length > 0) {
    // 导入到 SQLite
    if (confirm(`检测到浏览器中有 ${localData.length} 首歌曲的本地数据，是否导入到数据库？`)) {
      try {
        const result = await apiRequest('import', 'POST', { songs: localData });
        if (result.success) {
          alert(`成功导入 ${result.imported} 首歌曲！`);
          localStorage.removeItem('403my_playlist');
          await renderSongList();
        }
      } catch (err) {
        alert('导入失败：' + err.message);
      }
    }
  } else {
    // 导出当前数据库数据为 JSON
    const json = JSON.stringify(playlistCache, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'playlist.json';
    a.click();
    URL.revokeObjectURL(url);
  }
});

// ======================== Tab 切换 ========================
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.admin-tab');
  if (!tab) return;
  const target = tab.dataset.tab;
  if (!target) return;

  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
  tab.classList.add('active');
  const contentMap = { songs: 'tabSongs', artists: 'tabArtists', albums: 'tabAlbums' };
  const contentEl = document.getElementById(contentMap[target]);
  if (contentEl) contentEl.classList.add('active');
});

// ======================== 歌手管理 ========================
const adminArtistList = $('#adminArtistList');
const artistFormOverlay = $('#artistFormOverlay');
const artistForm = $('#artistForm');
const editArtistId = $('#editArtistId');
const editArtistName = $('#editArtistName');
const editArtistCover = $('#editArtistCover');
const btnArtistFormClose = $('#btnArtistFormClose');
const btnArtistCancel = $('#btnArtistCancel');

let artistCache = [];

// 按首字母分组
function groupArtistsByLetter(artists) {
  const groups = {};
  const order = [];
  artists.forEach(artist => {
    const letter = artist.letter || '#';
    if (!groups[letter]) {
      groups[letter] = [];
      order.push(letter);
    }
    groups[letter].push(artist);
  });
  order.sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b);
  });
  return { groups, order };
}

// 渲染字母索引栏（admin页面用）
function renderAdminLetterIndex(letters) {
  const container = document.getElementById('adminLetterIndex');
  if (!container) return;

  const allLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  let html = '';
  allLetters.forEach(l => {
    const hasItems = letters.includes(l);
    html += `<span class="letter-index-item${hasItems ? ' has-items' : ''}" data-letter="${l}">${l}</span>`;
  });
  if (letters.includes('#')) {
    html += `<span class="letter-index-item has-items" data-letter="#">#</span>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('.letter-index-item.has-items').forEach(item => {
    item.addEventListener('click', () => {
      const letter = item.dataset.letter;
      const section = document.getElementById('admin-section-' + letter);
      if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // 触摸滑动
  let touching = false;
  container.addEventListener('touchstart', (e) => {
    touching = true;
    handleAdminTouchLetter(e, container);
  }, { passive: false });
  container.addEventListener('touchmove', (e) => {
    if (touching) {
      e.preventDefault();
      handleAdminTouchLetter(e, container);
    }
  }, { passive: false });
  container.addEventListener('touchend', () => { touching = false; });
}

function handleAdminTouchLetter(e, container) {
  const touch = e.touches[0];
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  if (el && el.classList.contains('letter-index-item') && el.classList.contains('has-items')) {
    const letter = el.dataset.letter;
    const section = document.getElementById('admin-section-' + letter);
    if (section) {
      section.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }
}

async function renderArtistList() {
  try {
    const data = await apiRequest('artist_list');
    if (data.success) {
      artistCache = data.data;
    }
  } catch (e) {
    console.warn('加载歌手列表失败');
  }

  if (artistCache.length === 0) {
    adminArtistList.innerHTML = '<div class="admin-empty">暂无歌手数据</div>';
    const idx = document.getElementById('adminLetterIndex');
    if (idx) idx.innerHTML = '';
    return;
  }

  const { groups, order } = groupArtistsByLetter(artistCache);

  let html = '';
  order.forEach(letter => {
    html += `<div class="letter-section" id="admin-section-${letter}">
      <div class="letter-section-title">${letter}</div>`;
    groups[letter].forEach(artist => {
      html += `
      <div class="admin-song-item" data-id="${artist.id}">
        <div class="admin-song-info">
          <img class="admin-song-cover" src="${artist.cover || 'https://placehold.co/48x48/282828/535353?text=♪'}" alt="${artist.name}" onerror="this.src='https://placehold.co/48x48/282828/535353?text=♪'">
          <div class="admin-song-text">
            <div class="admin-song-title">${artist.name}</div>
            <div class="admin-song-artist">${artist.song_count} 首歌曲</div>
          </div>
        </div>
        <div class="admin-song-actions">
          <button class="btn-merge-artist" data-id="${artist.id}" data-name="${artist.name.replace(/"/g, '&quot;')}" aria-label="合并歌手" title="合并到其他歌手">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16 3h5v5"></path>
              <path d="M8 3H3v5"></path>
              <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"></path>
              <path d="m21 3-7.828 7.828"></path>
            </svg>
          </button>
          <button class="btn-edit-artist" data-id="${artist.id}" aria-label="编辑歌手">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
        </div>
      </div>`;
    });
    html += `</div>`;
  });
  adminArtistList.innerHTML = html;

  adminArtistList.querySelectorAll('.btn-edit-artist').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.id);
      const artist = artistCache.find(a => a.id === id);
      if (artist) openArtistForm(artist);
    });
  });

  adminArtistList.querySelectorAll('.btn-merge-artist').forEach(btn => {
    btn.addEventListener('click', () => {
      const sourceId = parseInt(btn.dataset.id);
      const sourceName = btn.dataset.name;
      openMergeDialog(sourceId, sourceName);
    });
  });

  renderAdminLetterIndex(order);
}

function openArtistForm(artist) {
  editArtistId.value = artist.id;
  editArtistName.value = artist.name;
  editArtistCover.value = artist.cover || '';
  artistFormOverlay.classList.add('open');
}

function closeArtistForm() {
  artistFormOverlay.classList.remove('open');
  artistForm.reset();
}

btnArtistFormClose?.addEventListener('click', closeArtistForm);
btnArtistCancel?.addEventListener('click', closeArtistForm);

artistForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = parseInt(editArtistId.value);
  if (!id) return;

  try {
    await apiRequest('artist_update', 'PUT', {
      id,
      name: editArtistName.value.trim(),
      cover: editArtistCover.value.trim()
    });
    closeArtistForm();
    await renderArtistList();
    await renderSongList();
  } catch (err) {
    alert('保存失败：' + err.message);
  }
});

// ======================== 歌手合并 ========================
function openMergeDialog(sourceId, sourceName) {
  // 构建目标歌手列表（排除自己）
  const targets = artistCache.filter(a => a.id !== sourceId);
  if (targets.length === 0) {
    alert('没有其他歌手可供合并');
    return;
  }

  const targetHtml = targets.map(a =>
    `<option value="${a.id}">${a.name} (${a.song_count}首)</option>`
  ).join('');

  const confirmed = confirm(
    `将「${sourceName}」的所有歌曲合并到其他歌手。\n\n请在确定后选择目标歌手。`
  );
  if (!confirmed) return;

  // 用 prompt 模拟选择
  const listStr = targets.map((a, i) => `${i + 1}. ${a.name} (${a.song_count}首)`).join('\n');
  const input = prompt(
    `将「${sourceName}」合并到以下哪位歌手？\n输入编号：\n\n${listStr}`
  );
  if (!input) return;

  const idx = parseInt(input) - 1;
  if (isNaN(idx) || idx < 0 || idx >= targets.length) {
    alert('无效的编号');
    return;
  }

  const target = targets[idx];
  if (!confirm(`确定将「${sourceName}」的所有歌曲合并到「${target.name}」吗？\n合并后「${sourceName}」将被删除。`)) return;

  mergeArtists(sourceId, target.id);
}

async function mergeArtists(sourceId, targetId) {
  try {
    const result = await apiRequest('merge_artists', 'POST', { source_id: sourceId, target_id: targetId });
    if (result.success) {
      alert(result.message || '合并成功');
      await renderArtistList();
      await renderSongList();
    } else {
      alert('合并失败：' + (result.error || '未知错误'));
    }
  } catch (err) {
    alert('合并失败：' + err.message);
  }
}

// ======================== 专辑管理 ========================
const adminAlbumList = $('#adminAlbumList');
const albumFormOverlay = $('#albumFormOverlay');
const albumForm = $('#albumForm');
const editAlbumId = $('#editAlbumId');
const editAlbumName = $('#editAlbumName');
const editAlbumCover = $('#editAlbumCover');
const btnAlbumFormClose = $('#btnAlbumFormClose');
const btnAlbumCancel = $('#btnAlbumCancel');

let albumCache = [];

async function renderAlbumList() {
  try {
    const data = await apiRequest('album_list');
    if (data.success) {
      albumCache = data.data;
    }
  } catch (e) {
    console.warn('加载专辑列表失败');
  }

  if (albumCache.length === 0) {
    adminAlbumList.innerHTML = '<div class="admin-empty">暂无专辑数据</div>';
    return;
  }

  adminAlbumList.innerHTML = albumCache.map(album => `
    <div class="admin-song-item" data-id="${album.id}">
      <div class="admin-song-info">
        <img class="admin-song-cover" src="${album.cover || 'https://placehold.co/48x48/282828/535353?text=♪'}" alt="${album.name}" onerror="this.src='https://placehold.co/48x48/282828/535353?text=♪'">
        <div class="admin-song-text">
          <div class="admin-song-title">${album.name}</div>
          <div class="admin-song-artist">${album.artist_name || '未知歌手'} · ${album.song_count} 首歌曲</div>
        </div>
      </div>
      <div class="admin-song-actions">
        <button class="btn-edit-album" data-id="${album.id}" aria-label="编辑专辑">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
      </div>
    </div>
  `).join('');

  adminAlbumList.querySelectorAll('.btn-edit-album').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.id);
      const album = albumCache.find(a => a.id === id);
      if (album) openAlbumForm(album);
    });
  });
}

function openAlbumForm(album) {
  editAlbumId.value = album.id;
  editAlbumName.value = album.name;
  editAlbumCover.value = album.cover || '';
  albumFormOverlay.classList.add('open');
}

function closeAlbumForm() {
  albumFormOverlay.classList.remove('open');
  albumForm.reset();
}

btnAlbumFormClose?.addEventListener('click', closeAlbumForm);
btnAlbumCancel?.addEventListener('click', closeAlbumForm);

albumForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = parseInt(editAlbumId.value);
  if (!id) return;

  try {
    await apiRequest('album_update', 'PUT', {
      id,
      name: editAlbumName.value.trim(),
      cover: editAlbumCover.value.trim()
    });
    closeAlbumForm();
    await renderAlbumList();
    await renderSongList();
  } catch (err) {
    alert('保存失败：' + err.message);
  }
});

// ======================== 初始化 ========================
function init() {
  // 检查是否已登录
  const savedToken = sessionStorage.getItem('403my_auth');
  if (savedToken) {
    authToken = savedToken;
    showAdminPanel();
  } else {
    showLoginPage();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  init();

  // 如果在 iframe 中，返回链接通知父页面关闭 iframe
  const inIframe = new URLSearchParams(location.search).has('iframe');
  if (inIframe) {
    document.querySelectorAll('a[href="index.html"]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        window.parent.postMessage({ type: 'closeIframe' }, '*');
      });
    });
  }
});
