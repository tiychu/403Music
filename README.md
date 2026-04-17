# 403MY 音乐播放器

纯 HTML5 音乐播放器，支持外链音乐、LRC歌词、CD旋转封面、代理转发绕过防盗链。

## 功能特性

- **播放器**：CD 旋转封面、播放进度、音量控制、播放模式切换
- **歌词同步**：LRC 格式歌词实时滚动高亮
- **播放列表**：歌曲增删改查、拖拽排序
- **歌手浏览**：按首字母分组、歌手详情页（专辑+歌曲）
- **专辑浏览**：专辑详情页（歌曲列表）
- **SPA 导航**：iframe 覆盖层切换页面，音乐不中断
- **音乐脉动光晕**：播放器容器随音乐节奏实时绽放动效（Web Audio API）
- **文本溢出滚动**：长歌名/歌手名鼠标悬浮时平移显示
- **全局美化滚动条**：统一的细窄半透明滚动条风格
- **管理后台**：歌曲/歌手/专辑 CRUD、歌手合并、数据导入导出
- **代理转发**：自动绕过音频/封面防盗链，支持 Range 请求与 24h 缓存

## 部署到宝塔面板

### 1. 上传文件
将 `music/` 文件夹内所有文件上传到宝塔网站目录，文件结构：
```
网站根目录/
└── music/
    ├── index.html      — 播放器主页
    ├── artist.html     — 歌手浏览页
    ├── artist.js       — 歌手页逻辑
    ├── admin.html      — 管理页面
    ├── admin.js        — 管理逻辑
    ├── style.css       — 全局样式
    ├── app.js          — 播放器逻辑
    ├── api.php         — PHP + SQLite 后端 API（含代理转发）
    ├── .403my.db       — SQLite 数据库（自动生成，勿手动修改）
```

### 2. PHP 配置
- 宝塔 → 网站 → 设置 → PHP版本：选择 **PHP 7.4+**（推荐 8.x）
- 确保 PHP 启用了以下扩展（宝塔默认已启用）：
  - `pdo_sqlite` 和 `sqlite3` — 数据库
  - `curl` — 代理转发防盗链
- 首次访问 `api.php?action=list` 会自动创建数据库并导入初始数据

### 3. Nginx 配置（如使用 Nginx）

在网站设置的**伪静态**中添加（仅此一条即可）：
```nginx
# 禁止访问数据库文件
location ~ /\.403my\.db$ {
    deny all;
    return 404;
}
```
> **说明**：宝塔自带的 PHP 处理规则已能处理 `music/` 子目录中的 `.php` 文件，  
> 无需额外配置。伪静态只需禁止外部直接访问数据库文件即可。

### 4. 使用
- 播放器：`https://你的域名/music/index.html`
- 歌手浏览：`https://你的域名/music/artist.html`
- 管理页面：`https://你的域名/music/admin.html`（密码：789123）
- 播放器右上角齿轮图标可进入管理页面

### 5. 从旧版迁移数据
如果你之前使用 localStorage 保存过数据：
1. 在浏览器打开管理页面
2. 点击"导出"按钮
3. 如果浏览器有旧数据，会提示导入到数据库

### 6. 代理转发（防盗链）
播放器加载音频/封面失败时，会自动通过后端代理转发请求，绕过防盗链限制。
- 仅代理播放列表中已存在的 URL（防滥用）
- 支持 Range 请求（可拖拽进度条）
- 代理内容缓存 24 小时

## API 接口

| 操作 | 方法 | 路径 | 认证 |
|------|------|------|------|
| 获取歌曲列表 | GET | `api.php?action=list` | 不需要 |
| 歌手列表 | GET | `api.php?action=artist_list` | 不需要 |
| 歌手详情 | GET | `api.php?action=artist_detail&id=N` | 不需要 |
| 专辑列表 | GET | `api.php?action=album_list` | 不需要 |
| 专辑详情 | GET | `api.php?action=album_detail&id=N` | 不需要 |
| 登录验证 | POST | `api.php?action=login` | 不需要 |
| 添加歌曲 | POST | `api.php?action=add` | 需要 |
| 编辑歌曲 | PUT | `api.php?action=update` | 需要 |
| 删除歌曲 | DELETE | `api.php?action=delete` | 需要 |
| 歌曲排序 | PUT | `api.php?action=reorder` | 需要 |
| 批量导入 | POST | `api.php?action=import` | 需要 |
| 更新歌手 | PUT | `api.php?action=artist_update` | 需要 |
| 合并歌手 | POST | `api.php?action=merge_artists` | 需要 |
| 更新专辑 | PUT | `api.php?action=album_update` | 需要 |
| 代理转发 | GET | `api.php?action=proxy&url=原URL` | 不需要 |

认证方式：登录成功后获取 token，后续请求通过 `X-Auth-Token` 请求头传递。

## 许可证

本项目基于 [GPL-3.0](./LICENSE) 许可证开源。
