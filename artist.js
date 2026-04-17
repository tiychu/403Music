/**
 * 403MY — 歌手 & 专辑浏览页
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
    const m = s.src.match(/^(.+\/)artist\.js$/);
    if (m) return m[1] + 'api.php?action=';
  }
  return 'api.php?action=';
})();

// ======================== DOM 元素 ========================
const $ = (sel) => document.querySelector(sel);
const artistGrid = $('#artistGrid');
const artistMain = $('#artistMain');
const artistDetail = $('#artistDetail');
const artistDetailHeader = $('#artistDetailHeader');
const albumGrid = $('#albumGrid');
const detailSongList = $('#detailSongList');
const albumSectionTitle = $('#albumSectionTitle');
const songSectionTitle = $('#songSectionTitle');
const albumDetail = $('#albumDetail');
const albumDetailHeader = $('#albumDetailHeader');
const albumSongList = $('#albumSongList');

// ======================== API 请求封装 ========================
async function apiRequest(action, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API_BASE + action, opts);
  return res.json();
}

// ======================== 歌手列表 ========================
async function loadArtists() {
  try {
    const data = await apiRequest('artist_list');
    if (data.success && data.data.length > 0) {
      renderArtistGrid(data.data);
    } else {
      artistGrid.innerHTML = '<div class="browse-empty">暂无歌手数据</div>';
    }
  } catch (e) {
    artistGrid.innerHTML = '<div class="browse-empty">加载失败</div>';
  }
}

// 按首字母分组
function groupByLetter(artists) {
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
  // 排序：A-Z 在前，# 在后
  order.sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b);
  });
  return { groups, order };
}

function renderArtistGrid(artists) {
  const { groups, order } = groupByLetter(artists);

  let html = '';
  order.forEach(letter => {
    html += `<div class="letter-section" id="section-${letter}">
      <div class="letter-section-title">${letter}</div>
      <div class="artist-grid-inner">`;
    groups[letter].forEach(artist => {
      html += `
        <div class="artist-card" data-id="${artist.id}">
          <div class="artist-card-cover">
            <img src="${artist.cover || 'https://placehold.co/200x200/282828/535353?text=♪'}" alt="${artist.name}" onerror="this.src='https://placehold.co/200x200/282828/535353?text=♪'">
          </div>
          <div class="artist-card-name">${artist.name}</div>
          <div class="artist-card-count">${artist.song_count} 首</div>
        </div>`;
    });
    html += `</div></div>`;
  });
  artistGrid.innerHTML = html;

  // 点击歌手卡片
  artistGrid.querySelectorAll('.artist-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = parseInt(card.dataset.id);
      showArtistDetail(id);
    });
  });

  // 渲染字母索引
  renderLetterIndex('letterIndex', order);
}

// 渲染字母索引栏
function renderLetterIndex(containerId, letters) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const allLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  let html = '';
  allLetters.forEach(l => {
    const hasItems = letters.includes(l);
    html += `<span class="letter-index-item${hasItems ? ' has-items' : ''}" data-letter="${l}">${l}</span>`;
  });
  // # 组
  if (letters.includes('#')) {
    html += `<span class="letter-index-item has-items" data-letter="#">#</span>`;
  }
  container.innerHTML = html;

  // 点击/触摸快速定位
  container.querySelectorAll('.letter-index-item.has-items').forEach(item => {
    item.addEventListener('click', () => {
      const letter = item.dataset.letter;
      const section = document.getElementById('section-' + letter);
      if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // 触摸滑动快速定位（移动端）
  let touching = false;
  container.addEventListener('touchstart', (e) => {
    touching = true;
    handleTouchLetter(e, container);
  }, { passive: false });
  container.addEventListener('touchmove', (e) => {
    if (touching) {
      e.preventDefault();
      handleTouchLetter(e, container);
    }
  }, { passive: false });
  container.addEventListener('touchend', () => {
    touching = false;
  });
}

function handleTouchLetter(e, container) {
  const touch = e.touches[0];
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  if (el && el.classList.contains('letter-index-item') && el.classList.contains('has-items')) {
    const letter = el.dataset.letter;
    const section = document.getElementById('section-' + letter);
    if (section) {
      section.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }
}

// ======================== 歌手详情 ========================
async function showArtistDetail(artistId) {
  try {
    const data = await apiRequest('artist_detail&id=' + artistId);
    if (!data.success) return;

    const { artist, albums, songs } = data.data;

    // 渲染头部
    artistDetailHeader.innerHTML = `
      <button class="btn-detail-back" id="btnArtistBack" aria-label="返回">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12"></line>
          <polyline points="12 19 5 12 12 5"></polyline>
        </svg>
      </button>
      <div class="artist-detail-cover">
        <img src="${artist.cover || 'https://placehold.co/200x200/282828/535353?text=♪'}" alt="${artist.name}" onerror="this.src='https://placehold.co/200x200/282828/535353?text=♪'">
      </div>
      <div class="artist-detail-info">
        <h2 class="artist-detail-name">${artist.name}</h2>
        <p class="artist-detail-count">${artist.song_count} 首歌曲${albums.length > 0 ? ' · ' + albums.length + ' 张专辑' : ''}</p>
      </div>
    `;

    // 渲染专辑网格
    albumSectionTitle.style.display = albums.length > 0 ? '' : 'none';
    if (albums.length > 0) {
      albumGrid.innerHTML = albums.map(album => `
        <div class="album-card" data-id="${album.id}">
          <div class="album-card-cover">
            <img src="${album.cover || 'https://placehold.co/200x200/282828/535353?text=♪'}" alt="${album.name}" onerror="this.src='https://placehold.co/200x200/282828/535353?text=♪'">
          </div>
          <div class="album-card-name">${album.name}</div>
          <div class="album-card-count">${album.song_count} 首</div>
        </div>
      `).join('');

      albumGrid.querySelectorAll('.album-card').forEach(card => {
        card.addEventListener('click', () => {
          const id = parseInt(card.dataset.id);
          showAlbumDetail(id);
        });
      });
    } else {
      albumGrid.innerHTML = '';
    }

    // 渲染歌曲列表
    songSectionTitle.textContent = `全部歌曲 (${songs.length})`;
    renderSongList(detailSongList, songs);

    // 切换视图
    artistMain.style.display = 'none';
    albumDetail.style.display = 'none';
    artistDetail.style.display = '';

    // 返回按钮
    $('#btnArtistBack').addEventListener('click', () => {
      artistDetail.style.display = 'none';
      artistMain.style.display = '';
      window.scrollTo(0, 0);
    });
  } catch (e) {
    console.error('加载歌手详情失败', e);
  }
}

// ======================== 专辑详情 ========================
async function showAlbumDetail(albumId) {
  try {
    const data = await apiRequest('album_detail&id=' + albumId);
    if (!data.success) return;

    const { album, songs } = data.data;

    albumDetailHeader.innerHTML = `
      <button class="btn-detail-back" id="btnAlbumBack" aria-label="返回">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12"></line>
          <polyline points="12 19 5 12 12 5"></polyline>
        </svg>
      </button>
      <div class="album-detail-cover">
        <img src="${album.cover || 'https://placehold.co/200x200/282828/535353?text=♪'}" alt="${album.name}" onerror="this.src='https://placehold.co/200x200/282828/535353?text=♪'">
      </div>
      <div class="album-detail-info">
        <h2 class="album-detail-name">${album.name}</h2>
        <p class="album-detail-artist">${album.artist_name || '未知歌手'} · ${album.song_count} 首</p>
      </div>
    `;

    renderSongList(albumSongList, songs);

    // 切换视图
    artistDetail.style.display = 'none';
    artistMain.style.display = 'none';
    albumDetail.style.display = '';

    // 返回按钮
    $('#btnAlbumBack').addEventListener('click', () => {
      albumDetail.style.display = 'none';
      artistDetail.style.display = '';
      window.scrollTo(0, 0);
    });
  } catch (e) {
    console.error('加载专辑详情失败', e);
  }
}

// ======================== 歌曲列表渲染 ========================
function renderSongList(container, songs) {
  if (songs.length === 0) {
    container.innerHTML = '<div class="browse-empty">暂无歌曲</div>';
    return;
  }

  container.innerHTML = songs.map((song, i) => `
    <div class="detail-song-item" data-song='${JSON.stringify({id: song.id, title: song.title, artist: song.artist, album: song.album || "", url: song.url, cover: song.cover, lyrics: song.lyrics || ""}).replace(/'/g, "&#39;")}'>
      <img class="detail-song-cover" src="${song.cover || 'https://placehold.co/44x44/282828/535353?text=♪'}" alt="${song.title}" onerror="this.src='https://placehold.co/44x44/282828/535353?text=♪'">
      <div class="detail-song-info">
        <div class="detail-song-title">${song.title}</div>
        <div class="detail-song-artist">${song.album || song.artist || ''}</div>
      </div>
      <button class="btn-play-song" aria-label="播放" data-index="${i}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z"/>
        </svg>
      </button>
    </div>
  `).join('');

  // 点击播放：将歌曲加入 localStorage 并跳转到播放器
  container.querySelectorAll('.btn-play-song').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = btn.closest('.detail-song-item');
      const songData = JSON.parse(item.dataset.song);
      playInPlayer(songData);
    });
  });

  container.querySelectorAll('.detail-song-item').forEach(item => {
    item.addEventListener('click', () => {
      const songData = JSON.parse(item.dataset.song);
      playInPlayer(songData);
    });
  });
}

// 将歌曲发送到播放器播放
function playInPlayer(songData) {
  const inIframe = new URLSearchParams(location.search).has('iframe');
  if (inIframe) {
    window.parent.postMessage({ type: 'playSong', song: songData }, '*');
    return;
  }
  localStorage.setItem('403my_play_song', JSON.stringify(songData));
  window.location.href = 'index.html';
}

// ======================== 初始化 ========================
document.addEventListener('DOMContentLoaded', () => {
  loadArtists();

  // 检测是否在 iframe 中（通过 URL 参数）
  const inIframe = new URLSearchParams(location.search).has('iframe');

  if (inIframe) {
    const btnBack = document.getElementById('btnBack');
    if (btnBack) btnBack.style.display = 'none';
    const logoText = document.querySelector('.logo-text');
    if (logoText) {
      logoText.style.cursor = 'pointer';
      logoText.addEventListener('click', () => {
        window.parent.postMessage({ type: 'closeIframe' }, '*');
      });
    }
  }
});
