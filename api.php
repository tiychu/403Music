<?php
/**
 * 403MY — PHP + SQLite 后端 API
 * 自动建库建表 | 密码哈希验证 | CRUD 操作
 * 宝塔部署：直接放在网站目录即可，无需额外配置
 *
 * Copyright (C) 2026 403My
 * SPDX-License-Identifier: GPL-3.0-or-later
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

// 全局错误处理，确保所有错误输出 JSON
set_error_handler(function($errno, $errstr, $errfile, $errline) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'error' => "PHP Error: $errstr in $errfile:$errline"], JSON_UNESCAPED_UNICODE);
    exit;
});

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Auth-Token');

// 预检请求
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ======================== 配置 ========================
// 密码 "789123" 的 SHA-256 哈希值
define('PASSWORD_HASH', 'c0034605ea413370d5ad022b8d2f7fe33461bf6d7e5f4ac78f02c27b793673c9');
// 数据库文件路径（与 api.php 同目录，数据库文件名以点开头隐藏）
define('DB_PATH', __DIR__ . '/.403my.db');

// ======================== 数据库初始化 ========================
function getDB() {
    $db = new SQLite3(DB_PATH);
    $db->busyTimeout(5000);
    $db->exec('PRAGMA journal_mode=WAL');
    $db->exec('PRAGMA foreign_keys=ON');

    // 建表（如不存在）
    $db->exec('CREATE TABLE IF NOT EXISTS songs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        url TEXT NOT NULL,
        cover TEXT DEFAULT "",
        lyrics TEXT DEFAULT "",
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )');

    // 新建歌手表
    $db->exec('CREATE TABLE IF NOT EXISTS artists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        cover TEXT DEFAULT "",
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )');

    // 新建专辑表
    $db->exec('CREATE TABLE IF NOT EXISTS albums (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        artist_id INTEGER DEFAULT 0,
        cover TEXT DEFAULT "",
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )');
    $db->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_name_artist ON albums(name, artist_id)');

    // 新建歌曲-歌手关联表（支持多歌手）
    $db->exec('CREATE TABLE IF NOT EXISTS song_artists (
        song_id INTEGER NOT NULL,
        artist_id INTEGER NOT NULL,
        PRIMARY KEY (song_id, artist_id)
    )');

    // 自动迁移：为 songs 表添加 album 和 artist_id 列（如不存在）
    $columns = [];
    $colResult = $db->query("PRAGMA table_info(songs)");
    while ($row = $colResult->fetchArray(SQLITE3_ASSOC)) {
        $columns[] = $row['name'];
    }
    if (!in_array('album', $columns)) {
        $db->exec('ALTER TABLE songs ADD COLUMN album TEXT DEFAULT ""');
    }
    if (!in_array('artist_id', $columns)) {
        $db->exec('ALTER TABLE songs ADD COLUMN artist_id INTEGER DEFAULT 0');
    }
    if (!in_array('album_id', $columns)) {
        $db->exec('ALTER TABLE songs ADD COLUMN album_id INTEGER DEFAULT 0');
    }

    // 自动迁移：从现有 songs 表提取歌手，插入 artists 表并关联
    $distinctArtists = $db->query('SELECT DISTINCT artist FROM songs WHERE artist != "" AND artist_id = 0');
    while ($row = $distinctArtists->fetchArray(SQLITE3_ASSOC)) {
        $names = parseArtists($row['artist']);
        foreach ($names as $name) {
            $stmt = $db->prepare('INSERT OR IGNORE INTO artists (name) VALUES (:name)');
            $stmt->bindValue(':name', $name, SQLITE3_TEXT);
            $stmt->execute();
        }
    }
    // 更新 songs 表的 artist_id 关联（取第一个歌手作为主歌手）
    $db->exec('UPDATE songs SET artist_id = (SELECT id FROM artists WHERE artists.name = songs.artist) WHERE artist_id = 0 AND artist != ""');
    // 对于多歌手，用第一个歌手作为 artist_id
    $multiArtistSongs = $db->query('SELECT id, artist FROM songs WHERE artist_id = 0 AND artist != ""');
    while ($row = $multiArtistSongs->fetchArray(SQLITE3_ASSOC)) {
        $names = parseArtists($row['artist']);
        if (!empty($names)) {
            $aid = ensureArtist($db, $names[0]);
            $stmt = $db->prepare('UPDATE songs SET artist_id = :aid WHERE id = :id');
            $stmt->bindValue(':aid', $aid, SQLITE3_INTEGER);
            $stmt->bindValue(':id', $row['id'], SQLITE3_INTEGER);
            $stmt->execute();
        }
    }

    // 同步 song_artists 关联表
    $allSongs = $db->query('SELECT id, artist FROM songs WHERE artist != ""');
    while ($row = $allSongs->fetchArray(SQLITE3_ASSOC)) {
        // 检查是否已有关联
        $cnt = $db->querySingle("SELECT COUNT(*) FROM song_artists WHERE song_id=" . $row['id']);
        if ($cnt == 0) {
            syncSongArtists($db, $row['id'], $row['artist']);
        }
    }

    // 清理：删除没有关联歌曲的多歌手组合记录
    $db->exec("DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM song_artists) AND (name LIKE '%/%' OR name LIKE '%&%' OR name LIKE '%、%')");

    // 自动迁移：从现有 songs 表提取专辑，插入 albums 表并关联
    $distinctAlbums = $db->query('SELECT DISTINCT album, artist_id, cover FROM songs WHERE album != "" AND album_id = 0');
    while ($row = $distinctAlbums->fetchArray(SQLITE3_ASSOC)) {
        $albumName = $row['album'];
        $artistId = $row['artist_id'] ?: 0;
        $cover = $row['cover'] ?: '';
        $stmt = $db->prepare('INSERT OR IGNORE INTO albums (name, artist_id, cover) VALUES (:name, :artist_id, :cover)');
        $stmt->bindValue(':name', $albumName, SQLITE3_TEXT);
        $stmt->bindValue(':artist_id', $artistId, SQLITE3_INTEGER);
        $stmt->bindValue(':cover', $cover, SQLITE3_TEXT);
        $stmt->execute();
    }
    // 更新 songs 表的 album_id 关联
    $db->exec('UPDATE songs SET album_id = (SELECT id FROM albums WHERE albums.name = songs.album AND albums.artist_id = songs.artist_id) WHERE album_id = 0 AND album != ""');

    // 检查是否需要初始化默认数据
    $count = $db->querySingle('SELECT COUNT(*) FROM songs');
    if ($count == 0) {
        initDefaultData($db);
    }

    return $db;
}

// 初始化默认歌曲数据（从浏览器 localStorage 导入的数据）
function initDefaultData($db) {
    $defaults = [
        [
            'title' => '那天下雨了',
            'artist' => '周杰伦',
            'album' => '最伟大的作品',
            'url' => 'https://file.icve.com.cn/file_doc/qdqqd/Fx9PUVSU_vip.flac',
            'cover' => 'https://img10.360buyimg.com/ddimg/jfs/t1/420141/34/4093/123385/69de5bdcF755ee5c0/00155a032a1068a9.jpg',
            'lyrics' => "[00:00.864]那天下雨了 - 周杰伦\n[00:02.287]词：周杰伦\n[00:02.888]曲：周杰伦\n[00:29.145]车子缓缓的开 你慢慢走来\n[00:32.385]我竟然看着你发呆\n[00:35.595]你尴尬Say个Hi 没位坐下来\n[00:38.900]我想叫旁边的离开\n[00:41.979]我车票都还在 心却在窗外\n[00:45.407]因为你已下了站台\n[00:48.548]远远的看着你点点头车已开\n[00:51.771]你一句话我爬窗离开\n[00:55.035]你证件掉了出来 我才明白\n[00:58.371]是那隔壁班的女孩\n[01:01.538]这么多年彼此竟然没认出来\n[01:04.690]是你变美还是我变帅\n[01:07.953]你经过花就开 离开雨就来\n[01:11.303]这里适合谈个恋爱\n[01:14.352]如果我要一个梦幻的开场白\n[01:17.648]没有比你更美的对白\n[01:21.424]雪白的天空等待彩虹出现\n[01:26.362]（彩虹出现）\n[01:27.966]你我的遇见是谁许的愿\n[01:32.791]（谁许的愿）\n[01:34.516]黑黑的夜空繁星变得耀眼\n[01:39.371]（变得耀眼）\n[01:40.659]因为你出现在我身边\n[01:46.831]你老家有点远 但我有点闲\n[01:50.276]也许能陪你走一圈\n[01:53.297]把你的父母都见 吃几口麻酱面\n[01:56.686]也许还能打个几圈 （我胡了）\n[02:00.012]乡间的麦芽田 害羞的脸\n[02:03.199]你提到多年前的暗恋\n[02:06.278]你剪下校园毕业册的那一页\n[02:09.535]是因为我在照片里面\n[02:13.391]雪白的天空等待彩虹出现\n[02:18.224]（彩虹出现）\n[02:19.888]你我的遇见是谁许的愿\n[02:24.688]（谁许的愿）\n[02:26.413]黑黑的夜空繁星变得耀眼\n[02:31.225]（变得耀眼）\n[02:32.559]因为你出现在我身边\n[02:39.008]原来多年前在那个书店\n[02:42.248]借我课本的是你\n[02:45.341]原来看我被雨淋的那天\n[02:48.628]帮我撑伞也是你\n[02:58.244]翘课的那一天 花落那一天\n[03:01.601]教室那间我已看见\n[03:04.639]消失的下雨天 我想再淋一遍\n[03:08.002]我应该对你唱着晴天\n[03:11.248]送你到家门外 我才明白\n[03:14.521]原来你早已有人疼爱\n[03:17.584]如果回到过去那一个下雨天\n[03:20.889]我会为了你把伞撑开\n[03:24.225]如果回到过去那一个下雨天\n[03:27.393]我绝不再 转身离开"
        ],
        [
            'title' => '女儿殿下',
            'artist' => '周杰伦',
            'album' => '最伟大的作品',
            'url' => 'https://file.icve.com.cn/file_doc/qdqqd/7DXB8qlu_vip.flac',
            'cover' => 'https://img10.360buyimg.com/ddimg/jfs/t1/420141/34/4093/123385/69de5bdcF755ee5c0/00155a032a1068a9.jpg',
            'lyrics' => "[00:00.000]女儿殿下 - 周杰伦\n[00:00.865]词：周杰伦\n[00:01.406]曲：周杰伦\n[00:01.947]我要你 拜托拜托嘛\n[00:07.182]我不跟你玩啰 爱你喔\n[00:10.706]我想你 我不要\n[00:14.738]我还没讲完捏 爸爸要迟到啰\n[00:20.205]上学要迟到啰\n[00:45.007]（哎呦不错哦）\n[00:46.233]一早带娃出门上学七点半\n[00:48.765]一路上车外一堆人们回头看\n[00:51.450]我心想今天我也没有特别打扮\n[00:54.150]原来是我把奶瓶忘在车顶上（噢）Ha\n[00:57.381]疯疯癫癫 Hey 风度翩翩 Hey\n[00:59.902]陪我家公主玩变化万千 Hey\n[01:02.605]唱都她唱 Hey 歌都她点 Hey\n[01:05.316]车里放的全是冰雪奇缘 Hey\n[01:08.137]懵懵懂懂是我陪你走过\n[01:11.529]（我美吗？）\n[01:13.007]你怎么动不动就生气说你不爱我\n[01:17.045]（我不要）\n[01:18.453]放学后要我穿精灵装接你在门口\n[01:22.637]（我美吗？）\n[01:23.900]要我跟你的好朋友们一起手牵手\n[01:27.706]（嘻嘻嘻）\n[01:28.802]我疯了吗（你说这才叫生活）\n[01:34.140]去找妈妈（你说我比较温柔）\n[01:38.905]拜托拜托嘛\n[01:39.678]我疯了吗（到底有没有听错）\n[01:44.950]去找妈妈（能不能不要烦我）\n[01:49.631]拜托拜托嘛\n[02:13.221]（哎呦不错哦）\n[02:15.133]你开心 就说等我老了会照顾我\n[02:17.403]（嘻嘻嘻）\n[02:17.923]不开心 就把我满脸都涂上口红\n[02:20.118]（噢）\n[02:20.466]你下指令 我只能够顺着顺着毛摸\n[02:23.119]就当作我上辈子真的欠你太多 Ha\n[02:26.310]疯疯癫癫 Hey\n[02:27.588]风度翩翩 Hey\n[02:28.910]我切换自如是一种训练 Hey\n[02:31.624]在你面前 Hey\n[02:32.885]只能笑脸 Hey\n[02:34.260]惹你不高兴就天崩地裂\n[02:36.688]Hey\n[02:37.073]懵懵懂懂是我陪你走过\n[02:40.789]（我美吗？）\n[02:42.093]你怎么动不动就生气说你不爱我\n[02:45.988]（我不要）\n[02:47.348]放学后要我穿精灵装接你在门口\n[02:51.712]（我美吗？）\n[02:52.783]要我跟你的好朋友们一起手牵手\n[02:57.817]我疯了吗（你说这才叫生活）\n[03:02.999]去找妈妈（你说我比较温柔）\n[03:07.704]拜托拜托嘛\n[03:08.556]我疯了吗（到底有没有听错）\n[03:13.935]去找妈妈（能不能不要烦我）\n[03:18.462]拜托拜托嘛\n[03:23.297]我可以打给你吗\n[03:27.001]可以吗 我可以打给你吗\n[03:33.371]爱你喔 我想你\n[03:38.200]我想你现在就回家了"
        ],
        [
            'title' => '圣徒',
            'artist' => '周杰伦',
            'album' => '最伟大的作品',
            'url' => 'https://file.icve.com.cn/file_doc/qdqqd/8Czsh5ve_vip.flac',
            'cover' => 'https://img10.360buyimg.com/ddimg/jfs/t1/420141/34/4093/123385/69de5bdcF755ee5c0/00155a032a1068a9.jpg',
            'lyrics' => "[00:00.000]圣徒 - 周杰伦\n[00:04.812]词：黄俊郎\n[00:08.823]曲：周杰伦\n[00:12.833]你看老子身上半个刺青都没\n[00:16.204]却将音符纹满这个世界\n[00:19.282]我的脚步根本从未后退\n[00:22.339]好让旋律跟上你的岁月\n[00:25.436]不屈是彩绘玻璃的光辉\n[00:28.517]迎向阳光色彩最为浓烈\n[00:31.588]懦弱是无人同情的枯叶\n[00:34.653]刚强才是你该有的季节\n[00:36.654]远方黎明蒸晒出 麦田的香味\n[00:38.585]群蝶飞舞翩翩\n[00:39.691]穹顶之下轻拭着 微尘的台阶\n[00:41.714]石墙繁花点点\n[00:42.788]文思泉涌般的我 写下那完美\n[00:44.669]老天给予智慧\n[00:45.798]如不是大师之作 空白的词汇\n[00:47.846]怎能问心无愧\n[00:48.943]骤雨阵阵 没让 桔梗低垂\n[00:51.983]夜莺穿梭 林梢 余音不绝\n[00:55.010]老车厢里 仍有 旅人的空位\n[00:58.126]我们一起 写下 仲夏夜的诗篇\n[01:02.059]你看老子身上半个刺青都没\n[01:05.438]却将音符纹满这个世界\n[01:08.462]我的脚步根本从未后退\n[01:11.543]好让旋律跟上你的岁月\n[01:14.638]不屈是彩绘玻璃的光辉\n[01:17.729]迎向阳光色彩最为浓烈\n[01:20.801]懦弱是无人同情的枯叶\n[01:23.846]刚强才是你该有的季节\n[01:38.367]歌声捎来力量 唱出希望\n[01:40.048]用本领凿光\n[01:41.199]笑语驱散忧伤 解开迷惘\n[01:43.097]我指引方向\n[01:44.280]困境的斗士不沮丧\n[01:45.865]胆怯的内心更坚强\n[01:47.401]带领迷途的星芒 大声的欢唱\n[01:49.369]曙光就在前方\n[01:50.458]骤雨阵阵 没让 桔梗低垂\n[01:53.500]夜莺穿梭 林梢 余音不绝\n[01:56.490]老车厢里 仍有 旅人的空位\n[01:59.619]我们一起 写下 仲夏夜的诗篇\n[02:03.605]你看老子身上半个刺青都没\n[02:06.943]却将音符纹满这个世界\n[02:10.003]我的脚步根本从未后退\n[02:13.110]好让旋律跟上你的岁月\n[02:16.174]不屈是彩绘玻璃的光辉\n[02:19.270]迎向阳光色彩最为浓烈\n[02:22.310]懦弱是无人同情的枯叶\n[02:25.384]刚强才是你该有的季节\n[02:27.670]跟着唱 哈里路亚 跟着唱 哈里路亚\n[02:27.676]跟着唱 Hallelujah 跟着唱 Hallelujah\n[02:33.570]跟着唱 哈里路亚 跟着唱 哈里路亚\n[02:33.577]跟着唱 Hallelujah 跟着唱 Hallelujah\n[02:39.850]跟着唱 哈里路亚 跟着唱 哈里路亚\n[02:39.853]跟着唱 Hallelujah 跟着唱 Hallelujah\n[02:45.930]跟着唱 哈里路亚 跟着唱 哈里路亚\n[02:45.932]跟着唱 Hallelujah 跟着唱 Hallelujah"
        ],
        [
            'title' => '湘女多情',
            'artist' => '周杰伦',
            'album' => '最伟大的作品',
            'url' => 'https://file.icve.com.cn/file_doc/qdqqd/SuMvdNUJ_vip.flac',
            'cover' => 'https://img10.360buyimg.com/ddimg/jfs/t1/420141/34/4093/123385/69de5bdcF755ee5c0/00155a032a1068a9.jpg',
            'lyrics' => "[00:00.000]湘女多情 - 周杰伦\n[00:07.932]词：方文山\n[00:12.890]曲：周杰伦\n[00:17.723]湘女多情 暮色已落地\n[00:25.042]檐下满园鸟啼\n[00:28.061]你却倚窗锁眉不语\n[00:32.335]锣腔唱起 一出花鼓戏\n[00:39.543]惆怅又添几许\n[00:42.543]是谁离去你不愿提\n[00:45.327]落花雨不停 湘女总是多情\n[00:49.585]凋谢却将爱 铺满了地\n[00:53.252]你说你愿意 静静留在原地\n[00:56.844]只为可能的 再次相遇\n[00:59.849]秋不舍花季 湘女总是多情\n[01:04.047]在梦中浓郁 所有秘密\n[01:07.767]微笑等风起 你说缘会如期\n[01:11.375]等盛开的菊 带来消息\n[01:30.537]湘女多情 暮色已落地\n[01:37.776]檐下满园鸟啼\n[01:40.775]你却倚窗锁眉不语\n[01:45.039]锣腔唱起 一出花鼓戏\n[01:52.287]惆怅又添几许\n[01:55.277]是谁离去你不愿提\n[01:58.028]落花雨不停 湘女总是多情\n[02:02.303]凋谢却将爱 铺满了地\n[02:05.929]你说你愿意 静静留在原地\n[02:09.600]只为可能的 再次相遇\n[02:12.508]秋不舍花季 湘女总是多情\n[02:16.829]在梦中浓郁 所有秘密\n[02:20.510]微笑等风起 你说缘会如期\n[02:24.140]等盛开的菊 带来消息\n[02:28.455]纷飞细雨 料峭春意\n[02:30.279]别离已美成了回忆\n[02:32.074]含泪的你永不老去\n[02:33.606]停格了那过去\n[02:35.710]我跟苍天下了盘棋\n[02:37.493]你愁绪在酝酿秘密\n[02:39.317]连感伤都轻如柳絮\n[02:41.616]落花雨不停 湘女总是多情\n[02:45.873]凋谢却将爱 铺满了地\n[02:49.528]你说你愿意 静静留在原地\n[02:53.185]只为可能的 再次相遇\n[02:56.184]秋不舍花季 湘女总是多情\n[03:00.425]在梦中浓郁 所有秘密\n[03:04.057]落泪如琴音 碎了一地谁听\n[03:07.736]繁华归浮云 你归爱情\n[03:11.375]娘子 娘子却依旧每日 折一枝杨柳\n[03:14.753]你在那里\n[03:15.722]在小村外的溪边河口 默默等着我\n[03:19.338]娘子依旧每日折一枝杨柳 你在那里\n[03:22.963]在小村外的溪边 默默等着 娘子\n[03:26.473]啦～啦～啦～湘女多情\n[03:40.898]啦～啦～啦～湘女多情"
        ],
        [
            'title' => '西西里',
            'artist' => '周杰伦',
            'album' => '最伟大的作品',
            'url' => 'https://file.icve.com.cn/file_doc/qdqqd/rPizYIMf_vip.flac',
            'cover' => 'https://img10.360buyimg.com/ddimg/jfs/t1/420141/34/4093/123385/69de5bdcF755ee5c0/00155a032a1068a9.jpg',
            'lyrics' => "[00:00.610]西西里 - 周杰伦\n[00:01.683]词：方文山\n[00:02.451]曲：周杰伦\n[00:23.487]海风刮过了 无人的街道\n[00:25.859]西西里的夜色 谁在那祷告\n[00:28.531]港边的渔船 灯火在闪耀\n[00:31.230]一闪一闪像谁 在那打暗号\n[00:33.886]柠檬树的香气 掩盖不了\n[00:36.529]弥漫在人群中的 火药味道\n[00:39.160]暗巷谁已经倒下 停止了喧闹\n[00:42.518]枪浅浅的笑 默默的走掉\n[00:45.231]城市漆黑 脚步声 谁追\n[00:47.848]岸边浪花 陪了我 一夜\n[00:50.929]子弹穿越有时比誓言 更直接\n[00:53.543]让这善恶难辨的世界 更明确\n[00:56.234]交给风用沉默解决\n[00:58.880]佩尔古萨湖边道离别\n[01:06.660]别动 别动 谁对准了枪口\n[01:09.220]你懂 你懂 听我冷静的说\n[01:12.283]枪声起总有人 在不远处叹息\n[01:14.870]私下的正义在 夜里维持秩序\n[01:17.439]未干 的血 还有那烟硝味\n[01:19.844]关于 荣耀 我转身拒绝再写\n[01:22.870]这雨后似乎安静了一切\n[01:25.646]这画面似乎完整了一些\n[01:28.029]别动 别动 谁对准了枪口\n[01:30.558]你懂 你懂 听我冷静的说\n[01:33.582]没有风的午后 秘密要藏多久\n[01:36.229]酒窖里的红酒 举杯是谁的手\n[01:38.539]故事 了结 庄园落叶纷飞\n[01:41.207]谁去 谁回 没有名字的季节\n[02:09.912]海风刮过了 无人的街道\n[02:12.509]西西里的夜色 谁在那祷告\n[02:15.237]港边的渔船 灯火在闪耀\n[02:17.857]一闪一闪像谁 在那打暗号\n[02:20.561]柠檬树的香气 掩盖不了\n[02:23.217]弥漫在人群中的 火药味道\n[02:25.895]暗巷谁已经倒下 停止了喧闹\n[02:29.187]枪浅浅的笑 默默的走掉\n[02:32.067]城市漆黑 脚步声 谁追\n[02:34.539]岸边浪花 陪了我 一夜\n[02:37.579]子弹穿越有时比誓言 更直接\n[02:40.219]让这善恶难辨的世界 更明确\n[02:42.859]交给风用沉默解决\n[02:45.533]佩尔古萨湖边道离别\n[02:53.235]别动 别动 谁对准了枪口\n[02:55.862]你懂 你懂 听我冷静的说\n[02:58.859]枪声起总有人 在不远处叹息\n[03:01.500]私下的正义在 夜里维持秩序\n[03:03.891]未干 的血 还有那烟硝味\n[03:06.507]关于 荣耀 我转身拒绝再写\n[03:09.502]这雨后似乎安静了一切\n[03:12.278]这画面似乎完整了一些\n[03:14.565]别动 别动 谁对准了枪口\n[03:17.182]你懂 你懂 听我冷静的说\n[03:20.198]没有风的午后 秘密要藏多久\n[03:22.830]酒窖里的红酒 举杯是谁的手\n[03:25.198]故事 了结 庄园落叶纷飞\n[03:27.870]谁去 谁回 没有名字的季节"
        ]
    ];

    $stmt = $db->prepare('INSERT INTO songs (title, artist, album, url, cover, lyrics, sort_order) VALUES (:title, :artist, :album, :url, :cover, :lyrics, :sort)');
    foreach ($defaults as $i => $song) {
        $stmt->bindValue(':title', $song['title'], SQLITE3_TEXT);
        $stmt->bindValue(':artist', $song['artist'], SQLITE3_TEXT);
        $stmt->bindValue(':album', $song['album'] ?? '', SQLITE3_TEXT);
        $stmt->bindValue(':url', $song['url'], SQLITE3_TEXT);
        $stmt->bindValue(':cover', $song['cover'], SQLITE3_TEXT);
        $stmt->bindValue(':lyrics', $song['lyrics'], SQLITE3_TEXT);
        $stmt->bindValue(':sort', $i, SQLITE3_INTEGER);
        $stmt->execute();
        $stmt->reset();
    }

    // 初始化歌手表（从默认数据中提取，支持多歌手拆分）
    foreach ($defaults as $song) {
        $names = parseArtists($song['artist']);
        foreach ($names as $name) {
            $stmt2 = $db->prepare('INSERT OR IGNORE INTO artists (name) VALUES (:name)');
            $stmt2->bindValue(':name', $name, SQLITE3_TEXT);
            $stmt2->execute();
        }
    }
    // 更新 artist_id 关联（取第一个歌手）
    $allSongs = $db->query('SELECT id, artist FROM songs WHERE artist_id = 0 AND artist != ""');
    while ($row = $allSongs->fetchArray(SQLITE3_ASSOC)) {
        $names = parseArtists($row['artist']);
        if (!empty($names)) {
            $aid = ensureArtist($db, $names[0]);
            $stmt3 = $db->prepare('UPDATE songs SET artist_id = :aid WHERE id = :id');
            $stmt3->bindValue(':aid', $aid, SQLITE3_INTEGER);
            $stmt3->bindValue(':id', $row['id'], SQLITE3_INTEGER);
            $stmt3->execute();
        }
    }
    // 同步 song_artists 关联
    $allSongs2 = $db->query('SELECT id, artist FROM songs WHERE artist != ""');
    while ($row = $allSongs2->fetchArray(SQLITE3_ASSOC)) {
        syncSongArtists($db, $row['id'], $row['artist']);
    }

    // 初始化专辑表（从默认数据中提取）
    foreach ($defaults as $song) {
        if (!empty($song['album'])) {
            $artistId = $db->querySingle("SELECT id FROM artists WHERE name='" . $db->escapeString($song['artist']) . "'");
            $stmt3 = $db->prepare('INSERT OR IGNORE INTO albums (name, artist_id, cover) VALUES (:name, :artist_id, :cover)');
            $stmt3->bindValue(':name', $song['album'], SQLITE3_TEXT);
            $stmt3->bindValue(':artist_id', $artistId ?: 0, SQLITE3_INTEGER);
            $stmt3->bindValue(':cover', $song['cover'] ?? '', SQLITE3_TEXT);
            $stmt3->execute();
        }
    }
    // 更新 album_id 关联
    $db->exec('UPDATE songs SET album_id = (SELECT id FROM albums WHERE albums.name = songs.album AND albums.artist_id = songs.artist_id) WHERE album_id = 0 AND album != ""');
}

// ======================== 密码验证 ========================
function verifyAuth() {
    $token = $_SERVER['HTTP_X_AUTH_TOKEN'] ?? '';
    if (!$token) {
        return false;
    }
    // token 格式：sha256(password)
    return $token === PASSWORD_HASH;
}

// ======================== 读取请求体 ========================
function getJsonInput() {
    $raw = file_get_contents('php://input');
    return json_decode($raw, true);
}

// ======================== 输出 JSON ========================
function jsonResponse($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

// ======================== 拼音首字母 ========================
function getFirstLetter($str) {
    if (empty($str)) return '';
    $first = mb_substr($str, 0, 1, 'UTF-8');
    // 如果是英文字母，直接返回大写
    if (preg_match('/^[A-Za-z]/', $first)) {
        return strtoupper($first);
    }
    // 如果不是汉字也不是字母，返回 #
    if (!preg_match('/^[\x{4e00}-\x{9fff}]/u', $first)) {
        return '#';
    }
    // 汉字转拼音首字母（基于 GB2312 编码区间映射）
    $py = iconv('UTF-8', 'GB2312//IGNORE', $first);
    if ($py === false || strlen($py) < 2) return '#';
    $code = ord($py[0]) * 256 + ord($py[1]);
    // GB2312 拼音首字母区间表
    $pytable = [
        [0xB0A1, 'A'], [0xB0C5, 'B'], [0xB2C1, 'C'], [0xB4EE, 'D'],
        [0xB6EA, 'E'], [0xB7A2, 'F'], [0xB8C1, 'G'], [0xB9FE, 'H'],
        [0xBBF7, 'J'], [0xBFA6, 'K'], [0xC0AC, 'L'], [0xC2E8, 'M'],
        [0xC4C3, 'N'], [0xC5B6, 'O'], [0xC5BE, 'P'], [0xC6DA, 'Q'],
        [0xC8BB, 'R'], [0xC8F6, 'S'], [0xCBFA, 'T'], [0xCDDA, 'W'],
        [0xCEF4, 'X'], [0xD1B9, 'Y'], [0xD4D1, 'Z']
    ];
    $letter = '#';
    for ($i = count($pytable) - 1; $i >= 0; $i--) {
        if ($code >= $pytable[$i][0]) {
            $letter = $pytable[$i][1];
            break;
        }
    }
    return $letter;
}

// ======================== 歌手辅助函数 ========================
// 拆分多歌手字符串（支持 / & 、, 等分隔符）
function parseArtists($artistStr) {
    if (empty($artistStr)) return [];
    // 按 / 、 & , 分割，去除空白和空项
    $names = preg_split('/\s*[\/&、,]\s*/u', trim($artistStr));
    return array_values(array_filter($names, function($n) { return $n !== ''; }));
}

// 查找或创建歌手，返回 artist_id
function ensureArtist($db, $artistName) {
    if (empty($artistName)) return 0;
    // 查找现有歌手
    $stmt = $db->prepare('SELECT id FROM artists WHERE name=:name');
    $stmt->bindValue(':name', $artistName, SQLITE3_TEXT);
    $result = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
    if ($result) return $result['id'];
    // 创建新歌手
    $stmt = $db->prepare('INSERT INTO artists (name) VALUES (:name)');
    $stmt->bindValue(':name', $artistName, SQLITE3_TEXT);
    $stmt->execute();
    return $db->lastInsertRowID();
}

// 为一首歌同步 song_artists 关联（先删后插）
function syncSongArtists($db, $songId, $artistStr) {
    $db->exec("DELETE FROM song_artists WHERE song_id=$songId");
    $names = parseArtists($artistStr);
    foreach ($names as $name) {
        $aid = ensureArtist($db, $name);
        if ($aid) {
            $stmt = $db->prepare('INSERT OR IGNORE INTO song_artists (song_id, artist_id) VALUES (:sid, :aid)');
            $stmt->bindValue(':sid', $songId, SQLITE3_INTEGER);
            $stmt->bindValue(':aid', $aid, SQLITE3_INTEGER);
            $stmt->execute();
        }
    }
}

// ======================== 专辑辅助函数 ========================
// 查找或创建专辑，返回 album_id
function ensureAlbum($db, $albumName, $artistId, $cover = '') {
    if (empty($albumName)) return 0;
    // 查找现有专辑（同名专辑可能属于不同歌手）
    $stmt = $db->prepare('SELECT id FROM albums WHERE name=:name AND artist_id=:artist_id');
    $stmt->bindValue(':name', $albumName, SQLITE3_TEXT);
    $stmt->bindValue(':artist_id', $artistId, SQLITE3_INTEGER);
    $result = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
    if ($result) {
        // 如果专辑没有封面但歌曲有封面，更新专辑封面
        if ($cover) {
            $stmt2 = $db->prepare('UPDATE albums SET cover=:cover WHERE id=:id AND (cover IS NULL OR cover = "")');
            $stmt2->bindValue(':cover', $cover, SQLITE3_TEXT);
            $stmt2->bindValue(':id', $result['id'], SQLITE3_INTEGER);
            $stmt2->execute();
        }
        return $result['id'];
    }
    // 创建新专辑
    $stmt = $db->prepare('INSERT INTO albums (name, artist_id, cover) VALUES (:name, :artist_id, :cover)');
    $stmt->bindValue(':name', $albumName, SQLITE3_TEXT);
    $stmt->bindValue(':artist_id', $artistId, SQLITE3_INTEGER);
    $stmt->bindValue(':cover', $cover, SQLITE3_TEXT);
    $stmt->execute();
    return $db->lastInsertRowID();
}

// ======================== 路由 ========================
$method = $_SERVER['REQUEST_METHOD'];
$path = $_GET['action'] ?? '';

try {
    $db = getDB();

    switch ($path) {
        // 获取播放列表（公开，无需认证）
        case 'list':
            $result = $db->query('SELECT s.id, s.title, s.artist, s.album, s.url, s.cover, s.lyrics, s.artist_id, s.album_id, a.name AS artist_name, a.cover AS artist_cover, al.name AS album_name, al.cover AS album_cover FROM songs s LEFT JOIN artists a ON s.artist_id = a.id LEFT JOIN albums al ON s.album_id = al.id ORDER BY s.sort_order ASC, s.id ASC');
            $songs = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $songs[] = $row;
            }
            jsonResponse(['success' => true, 'data' => $songs]);
            break;

        // 验证密码
        case 'login':
            if ($method !== 'POST') jsonResponse(['success' => false, 'error' => '方法不允许'], 405);
            $input = getJsonInput();
            $password = $input['password'] ?? '';
            $hash = hash('sha256', $password);
            if ($hash === PASSWORD_HASH) {
                jsonResponse(['success' => true, 'token' => $hash]);
            } else {
                jsonResponse(['success' => false, 'error' => '密码错误'], 401);
            }
            break;

        // 添加歌曲（需认证）
        case 'add':
            if ($method !== 'POST') jsonResponse(['success' => false, 'error' => '方法不允许'], 405);
            if (!verifyAuth()) jsonResponse(['success' => false, 'error' => '未授权'], 401);

            $input = getJsonInput();
            $title = trim($input['title'] ?? '');
            $artist = trim($input['artist'] ?? '');
            $album = trim($input['album'] ?? '');
            $url = trim($input['url'] ?? '');
            $cover = trim($input['cover'] ?? '');
            $lyrics = $input['lyrics'] ?? '';

            if (!$title || !$artist || !$url) {
                jsonResponse(['success' => false, 'error' => '歌名、歌手、音频链接为必填'], 400);
            }

            // 自动查找或创建歌手（取第一个歌手作为主歌手）
            $artistNames = parseArtists($artist);
            $artistId = !empty($artistNames) ? ensureArtist($db, $artistNames[0]) : 0;

            // 自动查找或创建专辑
            $albumId = ensureAlbum($db, $album, $artistId, $cover);

            // 获取最大 sort_order
            $maxSort = $db->querySingle('SELECT MAX(sort_order) FROM songs') ?? 0;

            $stmt = $db->prepare('INSERT INTO songs (title, artist, album, artist_id, album_id, url, cover, lyrics, sort_order) VALUES (:title, :artist, :album, :artist_id, :album_id, :url, :cover, :lyrics, :sort)');
            $stmt->bindValue(':title', $title, SQLITE3_TEXT);
            $stmt->bindValue(':artist', $artist, SQLITE3_TEXT);
            $stmt->bindValue(':album', $album, SQLITE3_TEXT);
            $stmt->bindValue(':artist_id', $artistId, SQLITE3_INTEGER);
            $stmt->bindValue(':album_id', $albumId, SQLITE3_INTEGER);
            $stmt->bindValue(':url', $url, SQLITE3_TEXT);
            $stmt->bindValue(':cover', $cover, SQLITE3_TEXT);
            $stmt->bindValue(':lyrics', $lyrics, SQLITE3_TEXT);
            $stmt->bindValue(':sort', $maxSort + 1, SQLITE3_INTEGER);
            $stmt->execute();

            // 同步 song_artists 多歌手关联
            $newSongId = $db->lastInsertRowID();
            syncSongArtists($db, $newSongId, $artist);

            jsonResponse(['success' => true, 'id' => $newSongId]);
            break;

        // 更新歌曲（需认证）
        case 'update':
            if ($method !== 'PUT') jsonResponse(['success' => false, 'error' => '方法不允许'], 405);
            if (!verifyAuth()) jsonResponse(['success' => false, 'error' => '未授权'], 401);

            $input = getJsonInput();
            $id = intval($input['id'] ?? 0);
            if (!$id) jsonResponse(['success' => false, 'error' => '缺少歌曲ID'], 400);

            $title = trim($input['title'] ?? '');
            $artist = trim($input['artist'] ?? '');
            $album = trim($input['album'] ?? '');
            $url = trim($input['url'] ?? '');
            $cover = trim($input['cover'] ?? '');
            $lyrics = $input['lyrics'] ?? '';

            if (!$title || !$artist || !$url) {
                jsonResponse(['success' => false, 'error' => '歌名、歌手、音频链接为必填'], 400);
            }

            // 自动查找或创建歌手（取第一个歌手作为主歌手）
            $artistNames = parseArtists($artist);
            $artistId = !empty($artistNames) ? ensureArtist($db, $artistNames[0]) : 0;

            // 自动查找或创建专辑
            $albumId = ensureAlbum($db, $album, $artistId, $cover);

            $stmt = $db->prepare('UPDATE songs SET title=:title, artist=:artist, album=:album, artist_id=:artist_id, album_id=:album_id, url=:url, cover=:cover, lyrics=:lyrics WHERE id=:id');
            $stmt->bindValue(':title', $title, SQLITE3_TEXT);
            $stmt->bindValue(':artist', $artist, SQLITE3_TEXT);
            $stmt->bindValue(':album', $album, SQLITE3_TEXT);
            $stmt->bindValue(':artist_id', $artistId, SQLITE3_INTEGER);
            $stmt->bindValue(':album_id', $albumId, SQLITE3_INTEGER);
            $stmt->bindValue(':url', $url, SQLITE3_TEXT);
            $stmt->bindValue(':cover', $cover, SQLITE3_TEXT);
            $stmt->bindValue(':lyrics', $lyrics, SQLITE3_TEXT);
            $stmt->bindValue(':id', $id, SQLITE3_INTEGER);
            $stmt->execute();

            // 同步 song_artists 多歌手关联
            syncSongArtists($db, $id, $artist);

            if ($db->changes() === 0) {
                jsonResponse(['success' => false, 'error' => '歌曲不存在'], 404);
            }
            jsonResponse(['success' => true]);
            break;

        // 删除歌曲（需认证）
        case 'delete':
            if ($method !== 'DELETE') jsonResponse(['success' => false, 'error' => '方法不允许'], 405);
            if (!verifyAuth()) jsonResponse(['success' => false, 'error' => '未授权'], 401);

            $input = getJsonInput();
            $id = intval($input['id'] ?? 0);
            if (!$id) jsonResponse(['success' => false, 'error' => '缺少歌曲ID'], 400);

            $stmt = $db->prepare('DELETE FROM songs WHERE id=:id');
            $stmt->bindValue(':id', $id, SQLITE3_INTEGER);
            $stmt->execute();

            if ($db->changes() === 0) {
                jsonResponse(['success' => false, 'error' => '歌曲不存在'], 404);
            }
            jsonResponse(['success' => true]);
            break;

        // 排序（需认证）
        case 'reorder':
            if ($method !== 'POST') jsonResponse(['success' => false, 'error' => '方法不允许'], 405);
            if (!verifyAuth()) jsonResponse(['success' => false, 'error' => '未授权'], 401);

            $input = getJsonInput();
            $orders = $input['orders'] ?? []; // [{id: 1, sort: 0}, {id: 2, sort: 1}, ...]

            $stmt = $db->prepare('UPDATE songs SET sort_order=:sort WHERE id=:id');
            foreach ($orders as $item) {
                $stmt->bindValue(':sort', intval($item['sort'] ?? 0), SQLITE3_INTEGER);
                $stmt->bindValue(':id', intval($item['id'] ?? 0), SQLITE3_INTEGER);
                $stmt->execute();
                $stmt->reset();
            }
            jsonResponse(['success' => true]);
            break;

        // 批量导入（需认证）
        case 'import':
            if ($method !== 'POST') jsonResponse(['success' => false, 'error' => '方法不允许'], 405);
            if (!verifyAuth()) jsonResponse(['success' => false, 'error' => '未授权'], 401);

            $input = getJsonInput();
            $songs = $input['songs'] ?? [];
            if (!is_array($songs) || empty($songs)) {
                jsonResponse(['success' => false, 'error' => '无有效数据'], 400);
            }

            $maxSort = $db->querySingle('SELECT MAX(sort_order) FROM songs') ?? 0;
            $stmt = $db->prepare('INSERT INTO songs (title, artist, album, artist_id, album_id, url, cover, lyrics, sort_order) VALUES (:title, :artist, :album, :artist_id, :album_id, :url, :cover, :lyrics, :sort)');

            $count = 0;
            foreach ($songs as $song) {
                $title = trim($song['title'] ?? '');
                $artist = trim($song['artist'] ?? '');
                $url = trim($song['url'] ?? '');
                if (!$title || !$artist || !$url) continue;

                $album = trim($song['album'] ?? '');
                $artistNames = parseArtists($artist);
                $artistId = !empty($artistNames) ? ensureArtist($db, $artistNames[0]) : 0;
                $albumId = ensureAlbum($db, $album, $artistId, trim($song['cover'] ?? ''));

                $maxSort++;
                $stmt->bindValue(':title', $title, SQLITE3_TEXT);
                $stmt->bindValue(':artist', $artist, SQLITE3_TEXT);
                $stmt->bindValue(':album', $album, SQLITE3_TEXT);
                $stmt->bindValue(':artist_id', $artistId, SQLITE3_INTEGER);
                $stmt->bindValue(':album_id', $albumId, SQLITE3_INTEGER);
                $stmt->bindValue(':url', $url, SQLITE3_TEXT);
                $stmt->bindValue(':cover', trim($song['cover'] ?? ''), SQLITE3_TEXT);
                $stmt->bindValue(':lyrics', $song['lyrics'] ?? '', SQLITE3_TEXT);
                $stmt->bindValue(':sort', $maxSort, SQLITE3_INTEGER);
                $stmt->execute();
                $stmt->reset();

                // 同步 song_artists 多歌手关联
                syncSongArtists($db, $db->lastInsertRowID(), $artist);
                $count++;
            }
            jsonResponse(['success' => true, 'imported' => $count]);
            break;

        // 获取歌手列表（公开，无需认证）
        case 'artist_list':
            $result = $db->query('SELECT a.id, a.name, a.cover, COUNT(sa.song_id) AS song_count FROM artists a LEFT JOIN song_artists sa ON a.id = sa.artist_id GROUP BY a.id ORDER BY a.name ASC');
            $artists = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                // 过滤掉多歌手组合（名称中包含分隔符的）
                if (preg_match('/[\/&、,]/u', $row['name'])) continue;
                $row['letter'] = getFirstLetter($row['name']);
                $artists[] = $row;
            }
            // 合并名称相同的歌手（去除首尾空白后比较）
            $merged = [];
            $nameMap = []; // normalizedName => index in merged
            foreach ($artists as $a) {
                $norm = trim($a['name']);
                if (isset($nameMap[$norm])) {
                    $idx = $nameMap[$norm];
                    // 保留第一个出现的 id 和 cover，累加 song_count
                    $merged[$idx]['song_count'] += $a['song_count'];
                    // 记录被合并的 id 供详情查询使用
                    if (!isset($merged[$idx]['_merged_ids'])) {
                        $merged[$idx]['_merged_ids'] = [$merged[$idx]['id']];
                    }
                    $merged[$idx]['_merged_ids'][] = $a['id'];
                    // 优先保留有封面的
                    if (empty($merged[$idx]['cover']) && !empty($a['cover'])) {
                        $merged[$idx]['cover'] = $a['cover'];
                    }
                } else {
                    $nameMap[$norm] = count($merged);
                    $merged[] = $a;
                }
            }
            $artists = $merged;
            // 按首字母排序
            usort($artists, function($a, $b) {
                $la = $a['letter'] ?: 'Z';
                $lb = $b['letter'] ?: 'Z';
                if ($la === $lb) return strcmp($a['name'], $b['name']);
                return strcmp($la, $lb);
            });
            // 清除内部字段
            foreach ($artists as &$a) {
                unset($a['_merged_ids']);
            }
            unset($a);
            jsonResponse(['success' => true, 'data' => $artists]);
            break;

        // 合并重复歌手（需认证）- 将 source_id 的歌曲关联迁移到 target_id，然后删除 source_id
        case 'merge_artists':
            if ($method !== 'POST') jsonResponse(['success' => false, 'error' => '方法不允许'], 405);
            if (!verifyAuth()) jsonResponse(['success' => false, 'error' => '未授权'], 401);

            $input = getJsonInput();
            $sourceId = intval($input['source_id'] ?? 0);
            $targetId = intval($input['target_id'] ?? 0);
            if (!$sourceId || !$targetId) jsonResponse(['success' => false, 'error' => '缺少歌手ID'], 400);
            if ($sourceId === $targetId) jsonResponse(['success' => false, 'error' => '不能合并相同歌手'], 400);

            // 验证两个歌手都存在
            $srcName = $db->querySingle("SELECT name FROM artists WHERE id=$sourceId");
            $tgtName = $db->querySingle("SELECT name FROM artists WHERE id=$targetId");
            if (!$srcName) jsonResponse(['success' => false, 'error' => '源歌手不存在'], 404);
            if (!$tgtName) jsonResponse(['success' => false, 'error' => '目标歌手不存在'], 404);

            // 迁移 song_artists 关联
            $db->exec("UPDATE OR IGNORE song_artists SET artist_id=$targetId WHERE artist_id=$sourceId");
            // 删除可能因重复而产生的无效关联
            $db->exec("DELETE FROM song_artists WHERE artist_id=$sourceId");

            // 迁移 songs.artist_id
            $db->exec("UPDATE songs SET artist_id=$targetId WHERE artist_id=$sourceId");

            // 更新 songs.artist 字段中的歌手名
            $songsWithSrc = $db->query("SELECT id, artist FROM songs WHERE artist LIKE '%" . $db->escapeString($srcName) . "%'");
            while ($srow = $songsWithSrc->fetchArray(SQLITE3_ASSOC)) {
                $newArtist = str_replace($srcName, $tgtName, $srow['artist']);
                $stmt2 = $db->prepare('UPDATE songs SET artist=:artist WHERE id=:id');
                $stmt2->bindValue(':artist', $newArtist, SQLITE3_TEXT);
                $stmt2->bindValue(':id', $srow['id'], SQLITE3_INTEGER);
                $stmt2->execute();
            }

            // 迁移专辑关联
            $db->exec("UPDATE albums SET artist_id=$targetId WHERE artist_id=$sourceId");

            // 如果目标歌手没有封面，使用源歌手的封面
            $srcCover = $db->querySingle("SELECT cover FROM artists WHERE id=$sourceId");
            $tgtCover = $db->querySingle("SELECT cover FROM artists WHERE id=$targetId");
            if (empty($tgtCover) && !empty($srcCover)) {
                $stmt3 = $db->prepare('UPDATE artists SET cover=:cover WHERE id=:id');
                $stmt3->bindValue(':cover', $srcCover, SQLITE3_TEXT);
                $stmt3->bindValue(':id', $targetId, SQLITE3_INTEGER);
                $stmt3->execute();
            }

            // 删除源歌手
            $db->exec("DELETE FROM artists WHERE id=$sourceId");

            jsonResponse(['success' => true, 'message' => "已将 '$srcName' 合并到 '$tgtName'"]);
            break;

        // 更新歌手信息（需认证）
        case 'artist_update':
            if ($method !== 'PUT') jsonResponse(['success' => false, 'error' => '方法不允许'], 405);
            if (!verifyAuth()) jsonResponse(['success' => false, 'error' => '未授权'], 401);

            $input = getJsonInput();
            $id = intval($input['id'] ?? 0);
            if (!$id) jsonResponse(['success' => false, 'error' => '缺少歌手ID'], 400);

            $cover = trim($input['cover'] ?? '');
            $name = trim($input['name'] ?? '');

            if ($name) {
                $stmt = $db->prepare('UPDATE artists SET name=:name, cover=:cover WHERE id=:id');
                $stmt->bindValue(':name', $name, SQLITE3_TEXT);
            } else {
                $stmt = $db->prepare('UPDATE artists SET cover=:cover WHERE id=:id');
            }
            $stmt->bindValue(':cover', $cover, SQLITE3_TEXT);
            $stmt->bindValue(':id', $id, SQLITE3_INTEGER);
            $stmt->execute();

            // 如果更新了歌手名，同步更新 songs 表的 artist 字段和 song_artists 关联
            if ($name) {
                // 查找旧歌手名
                $oldName = $db->querySingle("SELECT name FROM artists WHERE id=$id");
                // 更新 songs.artist 中包含该歌手名的记录（支持多歌手格式如 "王赫野/黄霄雲"）
                $songsWithArtist = $db->query("SELECT id, artist FROM songs WHERE artist_id=$id");
                while ($srow = $songsWithArtist->fetchArray(SQLITE3_ASSOC)) {
                    $newArtistStr = str_replace($oldName, $name, $srow['artist']);
                    $stmt2 = $db->prepare('UPDATE songs SET artist=:artist WHERE id=:id');
                    $stmt2->bindValue(':artist', $newArtistStr, SQLITE3_TEXT);
                    $stmt2->bindValue(':id', $srow['id'], SQLITE3_INTEGER);
                    $stmt2->execute();
                }
                // 重新同步 song_artists 关联
                $songsWithArtist2 = $db->query("SELECT id, artist FROM songs WHERE artist_id=$id");
                while ($srow = $songsWithArtist2->fetchArray(SQLITE3_ASSOC)) {
                    syncSongArtists($db, $srow['id'], $srow['artist']);
                }
            }

            if ($db->changes() === 0) {
                jsonResponse(['success' => false, 'error' => '歌手不存在'], 404);
            }
            jsonResponse(['success' => true]);
            break;

        // 获取歌手详情及其专辑和歌曲（公开，无需认证）
        case 'artist_detail':
            $artistId = intval($_GET['id'] ?? 0);
            if (!$artistId) jsonResponse(['success' => false, 'error' => '缺少歌手ID'], 400);

            // 歌手信息
            $stmt = $db->prepare('SELECT id, name, cover FROM artists WHERE id=:id');
            $stmt->bindValue(':id', $artistId, SQLITE3_INTEGER);
            $artist = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
            if (!$artist) jsonResponse(['success' => false, 'error' => '歌手不存在'], 404);

            // 查找所有同名歌手（去除首尾空白后匹配），合并展示
            $normName = trim($artist['name']);
            $sameNameResult = $db->query("SELECT id FROM artists WHERE TRIM(name)='" . $db->escapeString($normName) . "'");
            $artistIds = [];
            while ($r = $sameNameResult->fetchArray(SQLITE3_ASSOC)) {
                $artistIds[] = $r['id'];
            }
            $idList = implode(',', $artistIds);

            // 该歌手的专辑列表（包含所有同名歌手）
            $albumResult = $db->query("SELECT al.id, al.name, al.cover, COUNT(DISTINCT sa.song_id) AS song_count FROM albums al INNER JOIN songs s ON al.id = s.album_id INNER JOIN song_artists sa ON s.id = sa.song_id WHERE sa.artist_id IN ($idList) GROUP BY al.id ORDER BY al.name ASC");
            $albums = [];
            while ($row = $albumResult->fetchArray(SQLITE3_ASSOC)) {
                $albums[] = $row;
            }

            // 该歌手的所有歌曲（包含所有同名歌手，通过 song_artists 关联）
            $songResult = $db->query("SELECT DISTINCT s.id, s.title, s.artist, s.album, s.album_id, s.url, s.cover, s.lyrics FROM songs s INNER JOIN song_artists sa ON s.id = sa.song_id WHERE sa.artist_id IN ($idList) ORDER BY s.sort_order ASC, s.id ASC");
            $songs = [];
            while ($row = $songResult->fetchArray(SQLITE3_ASSOC)) {
                $songs[] = $row;
            }

            $artist['song_count'] = count($songs);
            jsonResponse(['success' => true, 'data' => ['artist' => $artist, 'albums' => $albums, 'songs' => $songs]]);
            break;

        // 获取专辑列表（公开，无需认证）
        case 'album_list':
            $result = $db->query('SELECT al.id, al.name, al.cover, al.artist_id, a.name AS artist_name, COUNT(s.id) AS song_count FROM albums al LEFT JOIN artists a ON al.artist_id = a.id LEFT JOIN songs s ON al.id = s.album_id GROUP BY al.id ORDER BY al.name ASC');
            $albums = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $albums[] = $row;
            }
            jsonResponse(['success' => true, 'data' => $albums]);
            break;

        // 获取专辑详情及其歌曲（公开，无需认证）
        case 'album_detail':
            $albumId = intval($_GET['id'] ?? 0);
            if (!$albumId) jsonResponse(['success' => false, 'error' => '缺少专辑ID'], 400);

            $stmt = $db->prepare('SELECT al.id, al.name, al.cover, al.artist_id, a.name AS artist_name FROM albums al LEFT JOIN artists a ON al.artist_id = a.id WHERE al.id=:id');
            $stmt->bindValue(':id', $albumId, SQLITE3_INTEGER);
            $album = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
            if (!$album) jsonResponse(['success' => false, 'error' => '专辑不存在'], 404);

            $stmt2 = $db->prepare('SELECT id, title, artist, album, url, cover, lyrics, artist_id FROM songs WHERE album_id=:album_id ORDER BY sort_order ASC, id ASC');
            $stmt2->bindValue(':album_id', $albumId, SQLITE3_INTEGER);
            $songResult = $stmt2->execute();
            $songs = [];
            while ($row = $songResult->fetchArray(SQLITE3_ASSOC)) {
                $songs[] = $row;
            }

            $album['song_count'] = count($songs);
            jsonResponse(['success' => true, 'data' => ['album' => $album, 'songs' => $songs]]);
            break;

        // 更新专辑信息（需认证）
        case 'album_update':
            if ($method !== 'PUT') jsonResponse(['success' => false, 'error' => '方法不允许'], 405);
            if (!verifyAuth()) jsonResponse(['success' => false, 'error' => '未授权'], 401);

            $input = getJsonInput();
            $id = intval($input['id'] ?? 0);
            if (!$id) jsonResponse(['success' => false, 'error' => '缺少专辑ID'], 400);

            $name = trim($input['name'] ?? '');
            $cover = trim($input['cover'] ?? '');

            if ($name) {
                $stmt = $db->prepare('UPDATE albums SET name=:name, cover=:cover WHERE id=:id');
                $stmt->bindValue(':name', $name, SQLITE3_TEXT);
            } else {
                $stmt = $db->prepare('UPDATE albums SET cover=:cover WHERE id=:id');
            }
            $stmt->bindValue(':cover', $cover, SQLITE3_TEXT);
            $stmt->bindValue(':id', $id, SQLITE3_INTEGER);
            $stmt->execute();

            // 如果更新了专辑名，同步更新 songs 表的 album 字段
            if ($name) {
                $stmt2 = $db->prepare('UPDATE songs SET album=:name WHERE album_id=:aid');
                $stmt2->bindValue(':name', $name, SQLITE3_TEXT);
                $stmt2->bindValue(':aid', $id, SQLITE3_INTEGER);
                $stmt2->execute();
            }

            if ($db->changes() === 0) {
                jsonResponse(['success' => false, 'error' => '专辑不存在'], 404);
            }
            jsonResponse(['success' => true]);
            break;

        // 代理转发音频/封面（绕过防盗链）
        case 'proxy':
            $targetUrl = $_GET['url'] ?? '';
            if (!$targetUrl) {
                http_response_code(400);
                exit('Missing url');
            }

            // 安全：仅允许 http/https
            if (!preg_match('/^https?:\/\//i', $targetUrl)) {
                http_response_code(400);
                exit('Invalid url');
            }

            // 检查该 URL 是否在本站播放列表中（防滥用）
            $stmt = $db->prepare('SELECT COUNT(*) FROM songs WHERE url=:url OR cover=:url');
            $stmt->bindValue(':url', $targetUrl, SQLITE3_TEXT);
            $exists = $stmt->execute()->fetchArray()[0];
            if (!$exists) {
                http_response_code(403);
                exit('URL not in playlist');
            }

            // 使用 cURL 代理请求
            $ch = curl_init();
            curl_setopt_array($ch, [
                CURLOPT_URL => $targetUrl,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS => 5,
                CURLOPT_CONNECTTIMEOUT => 15,
                CURLOPT_TIMEOUT => 300,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_SSL_VERIFYPEER => false,
                CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ]);

            // 传递 Range 头（支持拖拽进度条）
            $requestHeaders = [];
            foreach (['Range', 'If-Range', 'If-None-Match', 'If-Modified-Since'] as $h) {
                $key = 'HTTP_' . str_replace('-', '_', strtoupper($h));
                if (isset($_SERVER[$key])) {
                    $requestHeaders[] = "$h: $_SERVER[$key]";
                }
            }
            if (!empty($requestHeaders)) {
                curl_setopt($ch, CURLOPT_HTTPHEADER, $requestHeaders);
            }

            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
            $totalSize = curl_getinfo($ch, CURLINFO_CONTENT_LENGTH_DOWNLOAD);
            $error = curl_error($ch);
            curl_close($ch);

            if ($error) {
                http_response_code(502);
                exit('Proxy error: ' . $error);
            }

            // 返回响应头
            http_response_code($httpCode);
            if ($contentType) {
                header("Content-Type: $contentType");
            } else {
                // 根据扩展名猜测
                $ext = strtolower(pathinfo(parse_url($targetUrl, PHP_URL_PATH), PATHINFO_EXTENSION));
                $mimeMap = [
                    'mp3' => 'audio/mpeg', 'flac' => 'audio/flac', 'wav' => 'audio/wav',
                    'ogg' => 'audio/ogg', 'aac' => 'audio/aac', 'm4a' => 'audio/mp4',
                    'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png',
                    'gif' => 'image/gif', 'webp' => 'image/webp',
                ];
                header("Content-Type: " . ($mimeMap[$ext] ?? 'application/octet-stream'));
            }
            if ($totalSize > 0) {
                header("Content-Length: " . strlen($response));
            }
            header("Cache-Control: public, max-age=86400");
            header("Accept-Ranges: bytes");

            echo $response;
            exit;
            break;

        default:
            jsonResponse(['success' => false, 'error' => '未知操作'], 400);
    }
} catch (Exception $e) {
    jsonResponse(['success' => false, 'error' => '服务器错误: ' . $e->getMessage()], 500);
}
