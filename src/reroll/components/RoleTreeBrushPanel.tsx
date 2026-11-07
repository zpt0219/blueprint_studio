import { useMemo, useState, type DragEvent as ReactDragEvent } from "react";
import { displayName, roleOf, type Layer, type LiteObject, type LiteTileMap } from "../model";
import { colorForRole, rgbaCss } from "../generated/roleColors";
import { roleTree, type RoleTreeNode } from "../roleTree";
import { resolvePaletteForRole, roleTreeDistance } from "../pack/compile";
import type { Palette, PackRuntime } from "../pack/types";
import { PaletteSwatch } from "./PaletteSwatch";
import {
  targetLiteTypeForRole,
  type ActiveBrushConfig,
  type BrushToolId,
} from "../fastBrush";

interface FlatNodeItem {
  path: string;
  id: string;
  label: string;
  depth: number;
  stratum: string;
  objectType: string;
  isLeaf: boolean;
}

function flattenCategoryNodes(top: RoleTreeNode): FlatNodeItem[] {
  const out: FlatNodeItem[] = [];
  const walk = (node: RoleTreeNode, prefix: string, depth: number, inType: string, inStratum: string) => {
    const path = prefix ? `${prefix}/${node.id}` : node.id;
    const objectType = node.object_type ?? inType;
    const stratum = node.stratum ?? inStratum;
    const isLeaf = !node.children || node.children.length === 0;
    if (depth > 0) {
      out.push({
        path,
        id: node.id,
        label: (node.label ?? node.id).split("(")[0].trim(),
        depth,
        stratum,
        objectType,
        isLeaf,
      });
    }
    for (const c of node.children ?? []) {
      walk(c, path, depth + 1, objectType, stratum);
    }
  };
  walk(top, "", 0, top.object_type ?? "", top.stratum ?? "ground");
  return out;
}

export interface RoleTreeBrushPanelProps {
  map: LiteTileMap;
  pack: PackRuntime | null;
  lang: "zh" | "en";
  brushConfig: ActiveBrushConfig;
  onChangeBrushConfig: (patch: Partial<ActiveBrushConfig>) => void;
  activeLayerId: number | null;
  selected: Set<number>;
  expandedLayers: Set<number>;
  onSelectLayer: (layerId: number) => void;
  onToggleExpandLayer: (layerId: number) => void;
  onToggleLayerEnabled: (layerId: number) => void;
  onToggleObjectEnabled: (objectId: number) => void;
  onObjectClick: (objectId: number, mods: { ctrl: boolean; shift: boolean }) => void;
  onOpenCreateModal: () => void;
  onDuplicateSelection: () => void;
  onDeleteSelection: () => void;
  draggingObjectId: number | null;
  dropTarget: { layerId: number; targetId: number; side: "before" | "after" } | null;
  onObjectDragStart: (layerId: number, objectId: number) => (e: ReactDragEvent<HTMLDivElement>) => void;
  onObjectDragOver: (layerId: number, objectId: number) => (e: ReactDragEvent<HTMLDivElement>) => void;
  onObjectDrop: (layerId: number, objectId: number) => (e: ReactDragEvent<HTMLDivElement>) => void;
  onObjectDragEnd: () => void;
}

const TOOL_LIST: { id: BrushToolId; icon: string; zh: string; en: string; key: string }[] = [
  { id: "brush", icon: "🖌️", zh: "快刷", en: "Brush", key: "B" },
  { id: "eraser", icon: "🧽", zh: "橡皮", en: "Erase", key: "E" },
  { id: "rect", icon: "▭", zh: "矩形", en: "Rect", key: "U" },
  { id: "bucket", icon: "🪣", zh: "填充", en: "Fill", key: "G" },
  { id: "eyedropper", icon: "💧", zh: "吸管", en: "Pick", key: "I" },
  { id: "select", icon: "↖", zh: "选择", en: "Select", key: "M" },
];

export function RoleTreeBrushPanel({
  map,
  pack,
  lang,
  brushConfig,
  onChangeBrushConfig,
  activeLayerId,
  selected,
  expandedLayers,
  onSelectLayer,
  onToggleExpandLayer,
  onToggleLayerEnabled,
  onToggleObjectEnabled,
  onObjectClick,
  onOpenCreateModal,
  onDuplicateSelection,
  onDeleteSelection,
  draggingObjectId,
  dropTarget,
  onObjectDragStart,
  onObjectDragOver,
  onObjectDrop,
  onObjectDragEnd,
}: RoleTreeBrushPanelProps) {
  const [openCategories, setOpenCategories] = useState<Set<string>>(
    () => new Set(["terrain", "terrain_decoration", "nature_prop", "building"]),
  );
  const [showVariantsForRole, setShowVariantsForRole] = useState<string | null>(null);

  const toggleCategory = (catId: string) => {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  const layerByRoot = useMemo(() => {
    const m = new Map<string, Layer>();
    for (const l of map.layers) {
      const root = l.tags["role.root"] || l.name;
      m.set(root, l);
    }
    return m;
  }, [map, map.layers]);

  const palettesForRole = useMemo(() => {
    const cache = new Map<string, Palette[]>();
    if (!pack) return cache;
    for (const top of roleTree.categories) {
      const nodes = flattenCategoryNodes(top);
      for (const n of nodes) {
        const exact = pack.palettes.filter((p) => p.role === n.path);
        if (exact.length > 0) {
          cache.set(n.path, exact);
        } else {
          const near = pack.palettes.filter((p) => roleTreeDistance(n.path, p.role) <= 2);
          cache.set(n.path, near);
        }
      }
    }
    return cache;
  }, [pack]);

  const handleSelectRole = (rolePath: string, layerId?: number) => {
    if (layerId !== undefined) onSelectLayer(layerId);
    const candidates = palettesForRole.get(rolePath) ?? [];
    const liteType = targetLiteTypeForRole(rolePath, brushConfig.propStyle);
    const defaultPal =
      pack ? resolvePaletteForRole(pack.palettes, rolePath, "", 1, liteType) ?? candidates[0] ?? null : null;
    onChangeBrushConfig({
      role: rolePath,
      paletteHash: defaultPal?.hash ?? null,
      tool: brushConfig.tool === "select" || brushConfig.tool === "eraser" ? "brush" : brushConfig.tool,
    });
  };

  return (
    <aside className="layers role-tree-sidebar">
      {/* 1. Fast Brush Control Dock */}
      <div className="fast-brush-dock">
        <div className="fb-header">
          <span className="legend-title" style={{ marginBottom: 0 }}>
            {lang === "zh" ? "⚡ 快速 Tile 笔刷 (Fast Brush)" : "⚡ Fast Tile Brush"}
          </span>
          <code className="fb-active-role" title={brushConfig.role}>
            {brushConfig.role}
          </code>
        </div>

        {/* Tool buttons */}
        <div className="fb-tools">
          {TOOL_LIST.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`fb-tool-btn ${brushConfig.tool === t.id ? "active" : ""}`}
              onClick={() => onChangeBrushConfig({ tool: t.id })}
              title={`${lang === "zh" ? t.zh : t.en} (${t.key})`}
            >
              <span>{t.icon}</span>
              <span>{lang === "zh" ? t.zh : t.en}</span>
            </button>
          ))}
        </div>

        {/* Size + Shape + Stack/Replace */}
        <div className="fb-row">
          <span className="fb-label">{lang === "zh" ? "尺寸" : "Size"}</span>
          <span className="seg">
            {[1, 2, 3, 5, 7].map((sz) => (
              <button
                key={sz}
                type="button"
                className={brushConfig.size === sz ? "active" : ""}
                onClick={() => onChangeBrushConfig({ size: sz })}
              >
                {sz}
              </button>
            ))}
          </span>
          <span className="seg">
            <button
              type="button"
              className={brushConfig.shape === "square" ? "active" : ""}
              onClick={() => onChangeBrushConfig({ shape: "square" })}
              title={lang === "zh" ? "方形笔刷" : "Square Brush"}
            >
              ■
            </button>
            <button
              type="button"
              className={brushConfig.shape === "circle" ? "active" : ""}
              onClick={() => onChangeBrushConfig({ shape: "circle" })}
              title={lang === "zh" ? "圆形笔刷" : "Circle Brush"}
            >
              ●
            </button>
          </span>
        </div>

        <div className="fb-row">
          <span className="fb-label">{lang === "zh" ? "模式" : "Mode"}</span>
          <span className="seg" style={{ flex: 1 }}>
            <button
              type="button"
              style={{ flex: 1 }}
              className={!brushConfig.replaceSameLayer ? "active" : ""}
              onClick={() => onChangeBrushConfig({ replaceSameLayer: false })}
              title={
                lang === "zh"
                  ? "多图叠加：保留当前格已有的底层图片，在上方叠加新材质"
                  : "Stack: preserve underlying tile images and stack on top"
              }
            >
              📚 {lang === "zh" ? "多图叠加" : "Stack"}
            </button>
            <button
              type="button"
              style={{ flex: 1 }}
              className={brushConfig.replaceSameLayer ? "active" : ""}
              onClick={() => onChangeBrushConfig({ replaceSameLayer: true })}
              title={
                lang === "zh"
                  ? "同层互斥：涂抹时自动清除同一顶层分类下其它对象在该格的状态"
                  : "Replace: clear other objects in the same category at painted tiles"
              }
            >
              🔄 {lang === "zh" ? "同层替换" : "Replace"}
            </button>
          </span>
        </div>
      </div>

      {/* 2. 7 Top-Level Role Categories Tree */}
      <div className="layers-head" style={{ marginTop: 6 }}>
        <span className="legend-title" style={{ marginBottom: 0 }}>
          {lang === "zh" ? "🌳 7 大顶层分类树 & 图层" : "🌳 7 Role Categories & Layers"}
        </span>
        <div className="layers-actions">
          <button onClick={onOpenCreateModal} title="高级创建模态框">
            +Obj
          </button>
          <button disabled={selected.size === 0} onClick={onDuplicateSelection} title="复制选中对象">
            Dup
          </button>
          <button disabled={selected.size === 0} onClick={onDeleteSelection} title="删除选中对象">
            Del
          </button>
        </div>
      </div>

      <div className="role-tree-scroll">
        {roleTree.categories.map((cat, idx) => {
          const catOpen = openCategories.has(cat.id);
          const layer = layerByRoot.get(cat.id);
          const nodes = flattenCategoryNodes(cat);
          const isVertical = cat.stratum === "vertical";
          const objOpen = layer ? expandedLayers.has(layer.id) : false;

          return (
            <div key={cat.id} className="cat-tree-card">
              {/* Top-Level Category Header */}
              <div
                className={`cat-tree-header ${layer?.id === activeLayerId ? "active" : ""} ${layer && !layer.enabled ? "hidden" : ""}`}
                onClick={() => {
                  if (layer) onSelectLayer(layer.id);
                  toggleCategory(cat.id);
                }}
              >
                <button
                  type="button"
                  className="caret"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCategory(cat.id);
                  }}
                >
                  {catOpen ? "▾" : "▸"}
                </button>
                {layer && (
                  <input
                    className="row-check"
                    type="checkbox"
                    checked={layer.enabled}
                    title={layer.enabled ? "显示该层" : "隐藏该层"}
                    onChange={() => onToggleLayerEnabled(layer.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
                <span className="cat-index">{idx + 1}</span>
                <div className="cat-title-wrap">
                  <span className="cat-title">{ (cat.label ?? cat.id).split("(")[0] }</span>
                  <span className="cat-id-sub">{cat.id}</span>
                </div>
                <span className={`stratum-pill ${isVertical ? "vertical" : "ground"}`}>
                  {isVertical ? "Vertical" : "Ground"}
                </span>
                <span className="layer-count">{layer?.objects.length ?? 0}</span>
              </div>

              {/* Expanded Category Body: Role Brush Nodes + Layer Objects */}
              {catOpen && (
                <div className="cat-tree-body">
                  {/* Role Brush Palette Nodes */}
                  <div className="role-node-list">
                    {nodes.map((node) => {
                      const isActiveRole = brushConfig.role === node.path;
                      const rgb = colorForRole(node.path);
                      const candidates = palettesForRole.get(node.path) ?? [];
                      const activePal =
                        (isActiveRole && brushConfig.paletteHash
                          ? candidates.find((p) => p.hash === brushConfig.paletteHash)
                          : null) ?? candidates[0] ?? null;
                      const variantsOpen = showVariantsForRole === node.path;

                      return (
                        <div key={node.path} className="role-node-group">
                          <div
                            className={`role-node-btn ${isActiveRole ? "active" : ""}`}
                            style={{ paddingLeft: `${8 + (node.depth - 1) * 12}px` }}
                            onClick={() => handleSelectRole(node.path, layer?.id)}
                          >
                            {pack && activePal ? (
                              <PaletteSwatch pack={pack} palette={activePal} px={22} />
                            ) : (
                              <span
                                className="role-color-dot"
                                style={{ background: rgbaCss(rgb, 1) }}
                              />
                            )}
                            <span className="role-node-label" title={node.path}>
                              {node.label}
                            </span>
                            <code className="role-node-code">{node.id}</code>
                            {candidates.length > 1 && (
                              <button
                                type="button"
                                className={`variant-toggle-btn ${variantsOpen ? "active" : ""}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setShowVariantsForRole(variantsOpen ? null : node.path);
                                }}
                                title={lang === "zh" ? `选择图块样式 (${candidates.length} 种)` : `Pick variant (${candidates.length})`}
                              >
                                🎨{candidates.length}
                              </button>
                            )}
                          </div>

                          {/* Expandable Palette Swatch Drawer for this Role */}
                          {variantsOpen && pack && candidates.length > 0 && (
                            <div className="role-variants-drawer">
                              {candidates.map((pal) => {
                                const picked =
                                  isActiveRole &&
                                  (brushConfig.paletteHash === pal.hash ||
                                    (!brushConfig.paletteHash && activePal?.hash === pal.hash));
                                return (
                                  <button
                                    key={pal.hash}
                                    type="button"
                                    className={`variant-swatch-item ${picked ? "active" : ""}`}
                                    onClick={() => {
                                      if (layer) onSelectLayer(layer.id);
                                      onChangeBrushConfig({
                                        role: node.path,
                                        paletteHash: pal.hash,
                                        tool: brushConfig.tool === "select" ? "brush" : brushConfig.tool,
                                      });
                                    }}
                                    title={`${pal.style || pal.role} (${pal.size[0]}×${pal.size[1]})`}
                                  >
                                    <PaletteSwatch pack={pack} palette={pal} px={30} />
                                    <span>{pal.style || pal.hash.slice(0, 4)}</span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Layer Objects Sub-section */}
                  {layer && layer.objects.length > 0 && (
                    <div className="cat-objects-section">
                      <div
                        className="cat-objects-toggle"
                        onClick={() => onToggleExpandLayer(layer.id)}
                      >
                        <span>{objOpen ? "▾" : "▸"}</span>
                        <span>
                          {lang === "zh"
                            ? `已绘制图层对象 (${layer.objects.length})`
                            : `Layer Objects (${layer.objects.length})`}
                        </span>
                      </div>
                      {objOpen &&
                        layer.objects.map((o: LiteObject) => {
                          const label = displayName(o);
                          const oRgb = colorForRole(roleOf(o));
                          return (
                            <div
                              key={o.id}
                              className={`obj-row${selected.has(o.id) ? " selected" : ""}${o.enabled ? "" : " hidden"}${draggingObjectId === o.id ? " dragging" : ""}${dropTarget?.layerId === layer.id && dropTarget.targetId === o.id ? ` drop-${dropTarget.side}` : ""}`}
                              draggable
                              onClick={(e) =>
                                onObjectClick(o.id, {
                                  ctrl: e.ctrlKey || e.metaKey,
                                  shift: e.shiftKey,
                                })
                              }
                              onDragStart={onObjectDragStart(layer.id, o.id)}
                              onDragOver={onObjectDragOver(layer.id, o.id)}
                              onDrop={onObjectDrop(layer.id, o.id)}
                              onDragEnd={onObjectDragEnd}
                            >
                              <input
                                className="row-check"
                                type="checkbox"
                                checked={o.enabled}
                                title={o.enabled ? "显示" : "隐藏"}
                                onChange={() => onToggleObjectEnabled(o.id)}
                                onClick={(e) => e.stopPropagation()}
                              />
                              <span
                                className="role-color-dot"
                                style={{ background: rgbaCss(oRgb, 1), width: 8, height: 8 }}
                              />
                              <span className="obj-name" title={`${label} (${roleOf(o)})`}>
                                {label}
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
