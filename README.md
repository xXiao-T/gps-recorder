# 点迹 · GPS 经纬记录

在线地址：https://xxiao-t.github.io/gps-recorder/（GitHub Pages，HTTPS）

一个移动优先、纯本地的 GPS 单点与轨迹记录 PWA：

- **单点**：获取当前位置，显示十进制 / DMS、WGS-84 与 GCJ-02 双坐标，可复制、可地图选点、可保存备注。
- **轨迹**：按「时间间隔 + 最小距离 + 精度阈值」采样，实时统计距离、时长、平均速度；暂停或 GPS 中断自动分段；逐点落库，删除页面后仍可恢复草稿。
- **导出**：单点与轨迹均支持 GPX / KML / GeoJSON / CSV；单点额外支持纯文本。轨道按段导出，不会画出穿越暂停空档的假线。
- **PWA**：可添加到 Android 主屏幕，应用外壳离线可用（地图瓦片除外）。
- **本地优先**：无账号、无后端、无统计脚本；数据只存 IndexedDB，支持 JSON 全量备份/恢复。

目录：`/mnt/d/Desktop/worksapce/gps-recorder/`

---

## 关于高德底图与坐标系（重要）

本应用使用高德栅格瓦片（`webrd` / `webst` 的非官方接口），底图有两种：

| 底图 | URL 样式 |
|---|---|
| 矢量路网 | `webrd0{s}.is.autonavi.com/appmaptile?...style=8` |
| 卫星影像 | `webst0{s}.is.autonavi.com/appmaptile?style=6` |

**实测结论（2026-11，天安门，style 6 / 7 / 8 均验证）：**

> 这些栅格瓦片在 Leaflet 默认 Web Mercator 下与 **WGS-84 直接对齐**；把 GPS 原始坐标直接放到地图上，标记就落在真实位置。若先把 WGS-84 转成 GCJ-02 再显示，会向东北偏约 500 米。

因此本项目：

- 地图显示、轨迹折线、地图选点 → **全部使用 WGS-84**；
- 定位页仍显示一份 **GCJ-02** 坐标，导出时也可选 GCJ-02，方便粘贴到高德 App 或其他国内 GCJ 工具；
- 标准 GPX / KML / GeoJSON 约定为 WGS-84，默认导出 WGS-84。

> 如果接入高德 JS SDK / Key，或替换其他底图供应商，坐标系语义可能不同，必须重新验证。  
> 可用 `RUN_VISUAL=1 npx playwright test tests/e2e/visual-map.spec.js` 重新检查真实瓦片是否仍按 WGS-84 对齐。

高德瓦片为非官方接口，可能失效、限流或受高德条款约束；仅供个人使用。界面始终显示「© 高德地图（AMap）· 非官方瓦片」。瓦片请求是唯一的外部网络请求，会向高德暴露 IP 与地图视野范围。

---

## 快速开始（Android）

1. 用手机 Chrome 打开部署后的 HTTPS 地址（见下方 GitHub Pages 部署）。
2. 「定位」页点「获取当前位置」；首次会先显示授权说明，点「继续，允许定位」，再在浏览器弹窗选择「允许」，并开启**精确位置**。
3. 「定位」页获取当前位置 → 保存单点，或「地图选点」。
4. 「轨迹」页 → 开始记录 → 按需暂停/继续/结束；记录时建议保持页面在前台并开启屏幕常亮。
5. 「记录」页查看、导出、编辑或删除已保存的数据。
6. Chrome 菜单 →「添加到主屏幕」，即可像 App 一样启动。

> 局域网 HTTP IP 不是安全上下文，浏览器会拒绝定位。请使用 HTTPS 部署，或在电脑上 `adb reverse tcp:8080 tcp:8080` 后用手机访问 `http://localhost:8080/gps-recorder/`。

### 定位权限与等待兜底

- 「定位权限」卡片会显示 **已允许 / 未授权 / 已拒绝 / 未知**，并在从系统设置返回页面时自动刷新。
- 未授权时先弹出说明，再触发浏览器权限弹窗；拒绝过之后 Chrome 不会再自动弹窗，点「开启方法」查看 Android/Chrome 的站点与系统权限路径。
- 单点定位使用**可取消的短暂 `watchPosition`**，而不是会留下挂起请求的 `getCurrentPosition`；高精度 8 秒无结果时会自动尝试一次低精度网络定位。
- 等待定位时按钮会变成「取消等待」，取消会 `clearWatch`；另有 20 秒 JS 超时兜底。即使权限弹窗一直未处理，页面也会恢复，不会卡死。
- 轨迹记录在 20 秒内没有收到任何原始 GPS fix 时，会显示诊断提示与「重试定位 / 低精度重试 / 开启定位权限」入口，不会无限停留在“等待 GPS 信号”。
- 室内可勾选「室内低精度模式」，使用 Wi-Fi/基站定位；本次记录会自动关闭精度阈值，避免网络定位被 30 米阈值全部丢弃。
- 若等待期间浏览器弹窗仍在，取消后请先处理弹窗，再重新点「获取当前位置」。

### 记录持久化与切页

- 底部 Tab 切换不会卸载记录器；轨迹 Tab 上会出现红点/黄点表示“记录中/已暂停”。
- 页面刷新、PWA 被系统回收后：
  - **不依赖当前 Tab**：只要草稿处于“记录中”、10 分钟内且定位权限已允许，应用启动时就在后台自动恢复，并显示「已自动恢复记录中的轨迹」；定位页刷新也不会丢；
  - 暂停中的草稿不会被自动续录，需手动点「继续记录」；
  - 若自动恢复没有进行（权限未允许、草稿较旧或暂停），其他 Tab 顶部会出现「有未完成的轨迹记录」提示，点击直达轨迹页。
- 暂停/结束前每写一个点都会落 IndexedDB，断电或杀进程最多丢失尚未到达的样本。

---

## 轨迹采样规则

| 参数 | 默认值 | 说明 |
|---|---|---|
| 时间间隔 `minIntervalSec` | 5 秒 | 0 表示关闭该条件 |
| 最小移动距离 `minDistanceM` | 3 米 | 0 表示关闭该条件 |
| 精度阈值 `maxAccuracyM` | 30 米 | 精度差于此值的定位点丢弃；0 表示不限制 |

- 时间与距离条件**同时满足**才记录；段内首个有效点只需通过精度检查。
- 暂停、GPS 原始信号中断（超过 `max(30 秒, 3 × 时间间隔)`）或草稿恢复后的首个点会开启新的 **segment**。
- 距离只在同一段内累加；导出时 GPX 使用多个 `<trkseg>`，KML 用 `MultiGeometry`，GeoJSON 用 `MultiLineString`（含单点段时用 `GeometryCollection`）。
- 采样参数在「开始记录」时冻结进该轨迹，修改设置只影响下一条记录。
- 每个被接受的点立即写入 IndexedDB；页面被刷新/杀掉后，「轨迹」页会显示草稿恢复卡片。

### Android 后台限制（必须知道）

Web 端无法替代原生后台轨迹记录：

- 切到后台、锁屏或系统省电策略可能暂停 GPS / JS，轨迹会出现空档；
- 屏幕常亮（Screen Wake Lock）只在浏览器允许且页面可见时有效；
- 应用通过「逐点落库 + 中断分段 + 草稿恢复」尽量降低损失，但不承诺后台连续记录。

---

## 导出

| 数据 | GPX 1.1 | KML 2.2 | GeoJSON | CSV |
|---|---|---|---|---|
| 单点 | `<wpt>` | `Placemark/Point` | `Feature<Point>` | 一行 |
| 轨迹 | `<trk>` + 多段 `<trkseg>` | `LineString` / `MultiGeometry` | `LineString` / `MultiLineString` | 每个点一行 |

- 默认 WGS-84；可选 GCJ-02，文件名自动带 `-wgs84` / `-gcj02` 后缀。
- 时间使用 ISO 8601 UTC；坐标 7 位小数；海拔缺失不写 0。
- XML 全转义并剔除非法控制字符；CSV 使用 UTF-8 BOM、CRLF、RFC 4180 引号规则并防公式注入。
- Android Chrome 优先调用系统分享面板；其余浏览器回退为下载。

---

## 数据与备份

- 存储：IndexedDB（`gps-recorder-db`）中的 `waypoints`、`tracks`、`trackPoints`、`settings`。
- 设置页可导出 `/dianji-backup-YYYYMMDD-HHmmss.json`，包含所有单点、轨迹、轨迹点与偏好；恢复为**全量替换**，校验失败整体回滚。
- **清除站点数据、卸载 PWA 或更换设备不会自动同步**。设置页可申请持久存储，并显示占用/配额。
- 隐私：数据不上传；无第三方统计脚本、无外部字体。唯一外部请求是高德底图瓦片。

---

## GitHub Pages 部署

项目无构建步骤，直接把目录推到 GitHub，用 Pages 的 branch/root 部署即可。

```bash
cd /mnt/d/Desktop/worksapce/gps-recorder
git init
git add .
git commit -m "feat: GPS 点迹记录 PWA"
git branch -M main
git remote add origin https://github.com/<你的用户名>/gps-recorder.git
git push -u origin main
```

然后在 GitHub 仓库：

1. **Settings → Pages**
2. **Source:** Deploy from a branch
3. **Branch:** `main` / `/ (root)` → Save
4. 访问 `https://<你的用户名>.github.io/gps-recorder/`

说明：

- 已包含 `.nojekyll`，避免 GitHub Pages 的 Jekyll 处理；
- 全站使用相对路径与 Hash 路由，子路径部署可用；
- GitHub Pages 提供 HTTPS，满足 Geolocation、Clipboard、Service Worker、Wake Lock 的安全上下文要求；
- 部署后建议在手机上重新「添加到主屏幕」。

---

## 本地开发与测试

```bash
# 在项目目录
python3 -m http.server 8080 --directory ..
# 打开 http://localhost:8080/gps-recorder/

npm install
npm test                         # Node 单元测试（54 项）
npx playwright install chromium  # 首次运行需要
npx playwright test              # 移动端冒烟（定位/记录/导出/草稿/备份/PWA 离线）
RUN_VISUAL=1 npx playwright test tests/e2e/visual-map.spec.js
                                  # 真实高德瓦片截图，需要外网
```

- Playwright 默认拦截高德瓦片、模拟 Pixel 7 与 GPS，不依赖外网；`RUN_VISUAL=1` 时才加载真实瓦片，用于人工核对底图与 WGS-84 是否对齐。
- 截图输出到 `tests/artifacts/`（已被 `.gitignore` 忽略）。
- 测试覆盖：WGS/GCJ 固定向量与往返、DMS 进位、haversine、采样与分段、GPX/KML/GeoJSON/CSV 转义与文件名、备份校验、Service Worker 预缓存清单；单点/轨迹保存、地图选点、暂停分段、GPX 导出、刷新保留、草稿恢复/自动续录、**任意 Tab 刷新自动恢复**、备份下载/清除/恢复、PWA 离线外壳、定位权限拒绝/授权说明/等待取消与超时、高精度→低精度回退、轨迹首个 GPS fix 超时诊断、室内低精度记录与低精度重试、Tab 切页持续记录。

### 发布新版本时

1. 修改 `js/constants.js` 的 `APP_VERSION`；
2. 同步修改 `sw.js` 的 `APP_VERSION` 与缓存名（例如 `...-r2`）；
3. 部署后页面顶部会出现「新版本已就绪」，点击刷新后切换。

---

## 目录结构

```text
gps-recorder/
├── index.html                  # 单页骨架、底部导航、Leaflet 本地脚本
├── manifest.webmanifest        # PWA 清单
├── sw.js                       # 应用外壳缓存 + 更新协议
├── css/app.css                 # 移动优先、深浅色、地图/表单/弹层
├── js/
│   ├── app.js                  # 启动、Hash 路由、横幅、SW 注册
│   ├── constants.js            # 数据库/默认值/高德瓦片/格式注册
│   ├── db.js                   # IndexedDB 事务封装
│   ├── repository.js           # 单点/轨迹/轨迹点 CRUD 与统计
│   ├── prefs.js                # 设置读写与校验
│   ├── geo.js                  # WGS/GCJ、haversine、DMS（纯函数）
│   ├── sampling.js             # 采样、分段、统计（纯函数）
│   ├── format.js               # 界面格式化（纯函数）
│   ├── formats.js              # GPX/KML/GeoJSON/CSV/TXT（纯函数）
│   ├── location.js             # Geolocation 封装与错误映射
│   ├── recorder.js             # 记录状态机、Wake Lock、草稿恢复
│   ├── map-view.js             # Leaflet + 高德瓦片 + 地图选点
│   ├── coordinate-view.js      # WGS/GCJ 双坐标卡片
│   ├── export-dialog.js        # 导出弹层
│   ├── download.js             # 下载 / Web Share
│   ├── backup.js               # JSON 备份与恢复校验
│   ├── sw-register.js          # SW 注册/更新
│   ├── ui.js                   # DOM/Toast/弹层/表单/复制
│   └── pages/                  # locate / record / saved / track-detail / settings
├── vendor/leaflet/             # Leaflet 1.9.4 本地文件（含 LICENSE）
├── icons/                      # PWA 图标与 favicon
├── scripts/generate_icons.py   # Pillow 生成图标
└── tests/                      # Node 单测 + Playwright E2E
```

---

## 已知限制

- 不承诺 Android 后台连续定位（见上文）。
- 无云同步/账号；数据只在本机。
- 不含离线瓦片；离线时底图不可用，但定位、记录与导出可用。
- 不含逆地理编码（地址）、GPX 导入、轨迹回放动画。
- 多标签页同时记录不受支持；请只在一个页面记录。
- 高德瓦片是非官方接口，不保证长期可用。
- 适配目标为现代 Android Chrome；iOS Safari 未做专项验证（Wake Lock / 分享行为可能不同）。

---

## 许可

- 应用代码：个人项目，供自行使用与修改。
- Leaflet 1.9.4：BSD-2-Clause，见 `vendor/leaflet/LICENSE`。
- 地图数据与瓦片：© 高德地图（AMap），使用须遵守高德相关条款；本项目不缓存、不代理瓦片。
