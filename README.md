# Adna Blueprint Studio

Integrated Web front-end workbench for the blueprint flywheel — combining the **Blueprint Reroll Editor** and the **Asset & Palette Tagger** into a unified, standalone studio.

## Features

- **🗺️ Blueprint Editor (Reroll)**:
  - Full Canvas 2D overlay-parity viewer with role→color rendering.
  - Terrain brush (paint/erase, multi-size, dynamic matrix expansion).
  - Layer & object manipulation (move, resize `FIXED_RECT`, lock, reorder).
  - Deep Undo/Redo stack (`Cmd/Ctrl+Z`, `Shift+Cmd/Ctrl+Z`).
  - Palette pack integration (`.adnapalettepack`) and real-tile rendering.
  - Export to engine-compatible `adna-web-lite` JSON save files.
- **🏷️ Asset Tagger**:
  - Human review tool for palette role & style tagging.
  - Slices swatches out of contact sheets in `.adnatags` bundles.
  - Cascading role hierarchy tree and style tag filters.
  - Local progress auto-save & export to `final_tags.json`.

## Self-Contained Architecture

This repository is **completely standalone** and depends on no external repos:

1. **Role Palette Sync**: `vendor/blueprint_palette.h` is a committed snapshot of the engine header. `npm run generate` parses it into `src/reroll/generated/roleColors.ts` automatically prior to `dev` and `build`.
2. **Procedural Algorithms**: Inlined FastNoiseLite (`noise.ts`) and PRNG (`rng.ts`) under `src/shared/`, mapped via `@lib/*`.
3. **Bundled Samples**: Includes test blueprints and palette packs in `public/sample/` for instant out-of-the-box exploration.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run local development server
npm run dev
# -> http://localhost:5173

# 3. Production build
npm run build
# -> dist/
```

## Project Layout

```
blueprint_studio/
├── vendor/
│   └── blueprint_palette.h       # Engine role palette header snapshot
├── scripts/
│   ├── gen-role-colors.mjs       # Code generator for roleColors.ts
│   └── publish-pages.sh          # One-click GitHub Pages deployment
├── docs/                         # Specification & architecture docs
│   ├── TILEMAP_EDITOR_EVOLUTION_PLAN.md  # 演进总方案 (Master Plan)
│   ├── WEB_LITE_REROLL_EDITOR.md
│   ├── WEB_LITE_SCHEMA.md
│   └── WEB_ASSET_TAGGER_PLAN.md
├── public/
│   └── sample/                   # Sample blueprints and palette packs
└── src/
    ├── shared/                   # Procedural algorithms (noise, PRNG)
    ├── reroll/                   # Blueprint Editor (Canvas 2D, brush, undo)
    ├── tagger/                   # Asset Tagger (bundle reader, swatches)
    ├── App.tsx                   # Unified workbench tab switcher shell
    ├── main.tsx
    └── styles.css
```

## AK 室外大地图调试

打开 Blueprint Studio，点「打开 AK 大地图」（可选择含海滩、神殿废墟、东南沙漠高地与 3D 套件的 `public/sample/ak-world-designed.bptilemap`，或未修改的原始 Godot 基线快照 `public/sample/ak-world.bptilemap`；单独的海岸/神殿/3D 套件素材包位于 `public/sample/ak-coast-kit.bppalette`）。旧工作台的入口是 `/?editor=legacy`。全图 200×160 格，每格 4 米。用「定位到」跳到地标，开启「3D 预览」后，上方默认显示全图。点击自由视角后，WASD 飞行，按住右键拖动转向，Shift 加速，Q/E 升降，F 回到全图。下方游戏视角跟随角色，点击后可用 WASD 移动。画笔改变素材，高程工具以米为单位写入绝对高度。Shift+点击记下测试落点。项目包用于继续编辑，「用于游戏 → 下载补丁」保存相对原始 Godot 基线快照（`public/sample/ak-world.bptilemap`）的格子差异及自定义贴图。

在 Blueprint Studio 根目录运行下列命令。默认读取同级的 `asterfell-scene` 及其已构建的 Godot Mono 环境。可用 `AK_PROJECT_DIR` 和 `GODOT_BIN` 指定位置。

```sh
./scripts/ak-world.sh check /path/to/ak-world-patch.json    # 核对快照版本、原地面和修改后的落点碰撞
./scripts/ak-world.sh preview /path/to/ak-world-patch.json  # 在原生场景里按补丁替换地面并试走
./scripts/ak-world.sh play /path/to/ak-world-patch.json     # 启动原版 AK 户外游戏并加载本次补丁
./scripts/ak-world.sh install /path/to/ak-world-patch.json  # 校验并正式启用，桌面项目下次 F5 / tools/run.sh 自动加载
./scripts/ak-world.sh disable                              # 下次启动恢复原始地图
./scripts/ak-world.sh restore                              # 回退上一份补丁（包括停用前的版本）
./scripts/ak-world.sh status                               # 查看启用状态
./scripts/ak-world.sh export                               # 从当前 Godot 场景重新生成浏览器快照
./scripts/ak-world.sh export-local                         # 为 Vite 开发服务器生成含原模型的本地快照
./scripts/ak-world.sh test                                 # 验证王都矮台阶、高台阶和降地
```

3D 预览使用原场景地形网格，并把 2D 的材质和高程改动应用到对应格子。桥梁、建筑、喷泉和桥边手轮以独立几何显示。发布快照按原场景尺寸生成简化模型。Vite 开发服务器优先使用 `export-local` 生成的 `ak-world.bptilemap.local`，其中包含供本地调试使用的 Kingdom 模型网格。两种快照都使用 Web 调试材质。

树木、灌木、石头及女神像使用原场景的面片位置、尺寸和透明贴图，在两个视角中分别朝向相机。点「选择」或按 V 可以在 2D 中拖动面片，选中后按 Delete 删除。拖动和删除支持撤销，两个 3D 视图同步更新。

从 Web 下载补丁后，`play` 用原版角色、镜头与分区加载在测试点开局，进度和设置使用本次运行的临时目录。高程修改会替换对应格子的碰撞和地面，面片会连同附带碰撞一起移动或删除。Godot 地表支持草地、雪地、道路、沙地和岩地的内置素材，也支持随补丁携带自定义 PNG、自动拼接顶面、侧面及面片装饰。Palette 的「游戏外观」可选原版素材或使用此图集。无法应用的地表改动会明确报错，启用失败时保留已有补丁。Web 游戏视角用原地形、王城矮墙和 0.35 米步高做通行预览。快照对应原始场景版本，更新快照前应先导出旧版本的修改。


### 保存与正式接入

「下载」或 Ctrl+S 保存 `.bptilemap`，包含 PNG、Palette 属性、地图图层、高程和装饰，打开文件即可继续编辑。页脚显示自动草稿是否写入成功，「恢复上一份」恢复前一次成功写入，恢复操作也可撤销。自动保存使用当前浏览器的 IndexedDB，项目文件用于跨浏览器和长期备份。

`install` 在同级 Godot 工程的 `.studio/active.json` 原子写入已验证补丁，每次替换保留历史和上一版本。正式启动沿用游戏进度，不把测试点当成新游戏入口。停用与回退均在重启游戏后生效。原始场景和购买素材不改写，`.studio` 被 Git 忽略。当前持久入口用于本机 Godot 桌面项目，不自动打包进 Android/APK。原始地图版本改变后，旧补丁会拒绝加载，需停用并基于新快照编辑。

### 自定义素材与编辑

素材区是当前项目的 Palette Pack，可以上传、移除图集，在「图集属性」修改名称、格子尺寸或替换 PNG。更换格子尺寸时保持已选区域的行列位置，缩小图片导致已有引用越界时拒绝修改。所有改动可撤销。「素材包」菜单导入/导出 `.bppalette`，包含当前全部图集和 Palette，导入时分配新 ID，不覆盖已有素材。

Palette 属性包含地表/高台/面片用途、顶面布局、侧面选区、外观映射和阻挡。面片宽高以地图格计量。高台的默认抬高量也是格数，在 AK 中 1 格等于 4 米；使用高程工具可以设置实际绝对高度并覆盖默认抬高量。面片采用直立朝向相机的透明贴图，可设置简化方形碰撞。补丁将拼接结果和贴图直接携带给游戏，不依赖本机上传文件路径。

R 框选当前图层，拖动选区移动，Ctrl+C/X/V 复制、剪切和粘贴，Delete 清除，Esc 取消选区。空格或中键拖地图，Shift+点击设置测试点并定位两个 3D 视图。选择工具 V 用于移动原场景树木等面片。图层格子选区不包含原场景面片或独立的绝对高程。
