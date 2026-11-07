import { useState } from "react";

export interface NewMapModalProps {
  open: boolean;
  lang: "zh" | "en";
  onClose: () => void;
  onCreate: (name: string, width: number, height: number, baseRole: string | null) => void;
}

const BASE_TERRAIN_OPTIONS = [
  { role: "terrain/grass", zh: "草地铺满 (terrain/grass)", en: "Full Grass (terrain/grass)" },
  { role: "terrain/sand", zh: "沙地铺满 (terrain/sand)", en: "Full Sand (terrain/sand)" },
  { role: "terrain/dirt", zh: "泥土铺满 (terrain/dirt)", en: "Full Dirt (terrain/dirt)" },
  { role: "terrain/snow", zh: "雪地铺满 (terrain/snow)", en: "Full Snow (terrain/snow)" },
  { role: "terrain/water", zh: "水面铺满 (terrain/water)", en: "Full Water (terrain/water)" },
  { role: "", zh: "完全空白画布", en: "Empty Canvas" },
];

export function NewMapModal({ open, lang, onClose, onCreate }: NewMapModalProps) {
  const [name, setName] = useState("new_village");
  const [width, setWidth] = useState(48);
  const [height, setHeight] = useState(36);
  const [baseRole, setBaseRole] = useState("terrain/grass");

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card lifecycle-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{lang === "zh" ? "🗺️ 新建地图 (7层树结构)" : "🗺️ New Map (7-Layer Role Tree)"}</div>
            <div className="modal-subtitle">
              {lang === "zh"
                ? "初始化 7 大顶层分类图层，支持直接用快速笔刷涂抹与 3D 多图叠加预览"
                : "Initializes the 7 top-level Role category layers for fast brushing and 3D stacking"}
            </div>
          </div>
          <button type="button" onClick={onClose}>✕</button>
        </div>

        <div className="lifecycle-form">
          <label className="lf-field">
            <span>{lang === "zh" ? "地图名称" : "Map Name"}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="new_village"
            />
          </label>

          <div className="lf-row-2">
            <label className="lf-field">
              <span>{lang === "zh" ? "宽度 (Tiles)" : "Width (Tiles)"}</span>
              <input
                type="number"
                min={8}
                max={256}
                value={width}
                onChange={(e) => setWidth(Math.max(8, Math.min(256, Number(e.target.value) || 32)))}
              />
            </label>
            <label className="lf-field">
              <span>{lang === "zh" ? "高度 (Tiles)" : "Height (Tiles)"}</span>
              <input
                type="number"
                min={8}
                max={256}
                value={height}
                onChange={(e) => setHeight(Math.max(8, Math.min(256, Number(e.target.value) || 32)))}
              />
            </label>
          </div>

          <label className="lf-field">
            <span>{lang === "zh" ? "初始底层地表 (terrain)" : "Initial Base Terrain"}</span>
            <select value={baseRole} onChange={(e) => setBaseRole(e.target.value)}>
              {BASE_TERRAIN_OPTIONS.map((opt) => (
                <option key={opt.role} value={opt.role}>
                  {lang === "zh" ? opt.zh : opt.en}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="modal-foot">
          <button type="button" onClick={onClose}>
            {lang === "zh" ? "取消" : "Cancel"}
          </button>
          <button
            type="button"
            className="active"
            onClick={() => {
              onCreate(name || "new_map", width, height, baseRole || null);
              onClose();
            }}
          >
            {lang === "zh" ? "创建地图" : "Create Map"}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ResizeMapModalProps {
  open: boolean;
  currentWidth: number;
  currentHeight: number;
  lang: "zh" | "en";
  onClose: () => void;
  onResize: (width: number, height: number, anchorX: -1 | 0 | 1, anchorY: -1 | 0 | 1) => void;
}

const ANCHOR_GRID: { ax: -1 | 0 | 1; ay: -1 | 0 | 1; icon: string }[] = [
  { ax: -1, ay: -1, icon: "↖" },
  { ax: 0, ay: -1, icon: "↑" },
  { ax: 1, ay: -1, icon: "↗" },
  { ax: -1, ay: 0, icon: "←" },
  { ax: 0, ay: 0, icon: "●" },
  { ax: 1, ay: 0, icon: "→" },
  { ax: -1, ay: 1, icon: "↙" },
  { ax: 0, ay: 1, icon: "↓" },
  { ax: 1, ay: 1, icon: "↘" },
];

export function ResizeMapModal({
  open,
  currentWidth,
  currentHeight,
  lang,
  onClose,
  onResize,
}: ResizeMapModalProps) {
  const [width, setWidth] = useState(currentWidth);
  const [height, setHeight] = useState(currentHeight);
  const [anchorX, setAnchorX] = useState<-1 | 0 | 1>(0);
  const [anchorY, setAnchorY] = useState<-1 | 0 | 1>(0);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card lifecycle-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{lang === "zh" ? "📐 调整画布尺寸" : "📐 Resize Map Canvas"}</div>
            <div className="modal-subtitle">
              {lang === "zh"
                ? `当前尺寸: ${currentWidth} × ${currentHeight} (支持 Ctrl+Z 撤销)`
                : `Current: ${currentWidth} × ${currentHeight} (Undoable)`}
            </div>
          </div>
          <button type="button" onClick={onClose}>✕</button>
        </div>

        <div className="lifecycle-form">
          <div className="lf-row-2">
            <label className="lf-field">
              <span>{lang === "zh" ? "新宽度 (Tiles)" : "New Width"}</span>
              <input
                type="number"
                min={8}
                max={512}
                value={width}
                onChange={(e) => setWidth(Math.max(8, Math.min(512, Number(e.target.value) || currentWidth)))}
              />
            </label>
            <label className="lf-field">
              <span>{lang === "zh" ? "新高度 (Tiles)" : "New Height"}</span>
              <input
                type="number"
                min={8}
                max={512}
                value={height}
                onChange={(e) => setHeight(Math.max(8, Math.min(512, Number(e.target.value) || currentHeight)))}
              />
            </label>
          </div>

          <div className="lf-field">
            <span>{lang === "zh" ? "9 宫格对齐锚点" : "9-Grid Alignment Anchor"}</span>
            <div className="anchor-grid-9">
              {ANCHOR_GRID.map((cell) => {
                const active = cell.ax === anchorX && cell.ay === anchorY;
                return (
                  <button
                    key={`${cell.ax},${cell.ay}`}
                    type="button"
                    className={active ? "active" : ""}
                    onClick={() => {
                      setAnchorX(cell.ax);
                      setAnchorY(cell.ay);
                    }}
                  >
                    {cell.icon}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" onClick={onClose}>
            {lang === "zh" ? "取消" : "Cancel"}
          </button>
          <button
            type="button"
            className="active"
            onClick={() => {
              onResize(width, height, anchorX, anchorY);
              onClose();
            }}
          >
            {lang === "zh" ? "应用尺寸" : "Apply Resize"}
          </button>
        </div>
      </div>
    </div>
  );
}
