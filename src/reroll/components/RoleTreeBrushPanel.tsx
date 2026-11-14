import { useId, useMemo, useState, type DragEvent as ReactDragEvent } from "react";
import { displayName, roleOf, type LiteTileMap } from "../model";
import { colorForRole, rgbaCss } from "../generated/roleColors";
import { findRolePath, roleTree, rolesForTop, topRoleNode } from "../roleTree";
import { resolvePaletteForRole, roleTreeDistance } from "../pack/compile";
import type { Palette, PackRuntime } from "../pack/types";
import { PaletteSwatch } from "./PaletteSwatch";
import { downloadTilesetPack, TilesetImportDialog, TilesetMaterials } from "./TilesetMaterials";
import type { LoadedTileset, TilesetSource } from "../pack/tilesets";
import {
  targetLiteTypeForRole,
  type ActiveBrushConfig,
  type BrushToolId,
} from "../fastBrush";

type SidebarTab = "materials" | "layers";
const SIDEBAR_TABS: SidebarTab[] = ["materials", "layers"];
const ROAD_ROLE = "terrain_decoration/path/road";
const isRoadRole = (path: string) => path === ROAD_ROLE || path.startsWith(ROAD_ROLE + "/");
const MATERIAL_GROUPS = roleTree.categories.flatMap((category) => {
  const roles = rolesForTop(category.id).filter((role) => role.depth > 0);
  const group = { id: category.id, label: category.label ?? category.id, roles };
  if (category.id !== "terrain_decoration") return [group];
  return [
    { id: "roads", label: "道路", roles: roles.filter((role) => isRoadRole(role.path)) },
    { ...group, roles: roles.filter((role) => !isRoadRole(role.path)) },
  ];
});

function shortLabel(label: string): string {
  return label.split("(")[0].trim();
}

function roleLabel(path: string, lang: "zh" | "en"): string {
  const key = path.slice(path.lastIndexOf("/") + 1);
  if (lang === "en") return key.replace(/_/g, " ");
  const label = findRolePath(path)?.label.split(" / ").pop();
  return label ? shortLabel(label) : key;
}

function MaterialSwatch({ pack, palette, role }: { pack: PackRuntime | null; palette: Palette | null; role: string }) {
  return (
    <span className="rn-swatch" aria-hidden="true">
      {pack && palette ? <PaletteSwatch pack={pack} palette={palette} px={24} /> : (
        <span className="rn-color-fallback" style={{ background: rgbaCss(colorForRole(role), 1) }} />
      )}
    </span>
  );
}

function VisibilityToggle({ visible, label, onToggle }: { visible: boolean; label: string; onToggle: () => void }) {
  return (
    <button type="button" className="layer-visibility" aria-label={label} aria-pressed={visible} title={label} onClick={onToggle}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
        <circle cx="12" cy="12" r="2.5" />
        {!visible && <path d="m4 4 16 16" />}
      </svg>
    </button>
  );
}

export interface RoleTreeBrushPanelProps {
  map: LiteTileMap;
  pack: PackRuntime | null;
  builtInPack: PackRuntime | null;
  tilesets: LoadedTileset[];
  tilesetsReady: boolean;
  onImportTilesets: (sources: TilesetSource[]) => Promise<string>;
  onRemoveTileset: (id: string) => Promise<void>;
  lang: "zh" | "en";
  brushConfig: ActiveBrushConfig;
  activeBrushPalette: Palette | null;
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
  builtInPack,
  tilesets,
  tilesetsReady,
  onImportTilesets,
  onRemoveTileset,
  lang,
  brushConfig,
  activeBrushPalette,
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
  const [tab, setTab] = useState<SidebarTab>("materials");
  const tabsId = useId();
  const [openCategories, setOpenCategories] = useState(() => new Set(["terrain"]));
  const [showVariantsForRole, setShowVariantsForRole] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string>();
  const [importOpen, setImportOpen] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const currentSource = sourceId === ""
    ? undefined
    : tilesets.find((tileset) => tileset.source.id === (sourceId ?? activeBrushPalette?.tilesetId))
      ?? tilesets[0];

  const manageTilesets = async (action: () => Promise<void>) => {
    setLibraryBusy(true);
    setLibraryError("");
    try { await action(); }
    catch (cause) { setLibraryError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLibraryBusy(false); }
  };

  const toggleCategory = (catId: string) => {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  const materialsForRole = useMemo(() => {
    const cache = new Map<string, { variants: Palette[]; defaultPalette: Palette | null }>();
    if (!builtInPack) return cache;
    for (const group of MATERIAL_GROUPS) {
      for (const { path } of group.roles) {
        const exact = builtInPack.palettes.filter((p) => p.role === path);
        const variants = exact.length ? exact : builtInPack.palettes.filter((p) => roleTreeDistance(path, p.role) <= 2);
        const liteType = targetLiteTypeForRole(path, brushConfig.propStyle);
        const defaultPalette = resolvePaletteForRole(builtInPack.palettes, path, "", 1, liteType) ?? variants[0] ?? null;
        cache.set(path, { variants, defaultPalette });
      }
    }
    return cache;
  }, [builtInPack, brushConfig.propStyle]);

  const selectMaterial = (role: string, palette: Palette | null) => {
    const { tool } = brushConfig;
    onChangeBrushConfig({
      role,
      paletteHash: palette?.hash ?? null,
      tool: tool === "rect" || tool === "bucket" ? tool : "brush",
    });
    setShowVariantsForRole(null);
  };

  return (
    <aside className="layers role-tree-sidebar" aria-label={lang === "zh" ? "绘制侧栏" : "Painting sidebar"}>
      <div className="fast-brush-dock">
        <div className="fb-header">
          <MaterialSwatch pack={pack} palette={activeBrushPalette} role={brushConfig.role} />
          <div className="fb-current-material" title={brushConfig.role}>
            <span className="fb-label">{lang === "zh" ? "当前材质" : "Current material"}</span>
            <strong>{activeBrushPalette?.tilesetId
              ? activeBrushPalette.style || activeBrushPalette.label || roleLabel(brushConfig.role, lang)
              : roleLabel(brushConfig.role, lang)}</strong>
          </div>
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

      <div
        className="sidebar-tabs"
        role="tablist"
        aria-label={lang === "zh" ? "左栏面板" : "Sidebar panels"}
        onKeyDown={(event) => {
          let next: SidebarTab;
          if (event.key === "Home") next = "materials";
          else if (event.key === "End") next = "layers";
          else if (event.key === "ArrowLeft" || event.key === "ArrowRight") next = tab === "materials" ? "layers" : "materials";
          else return;
          event.preventDefault();
          event.stopPropagation();
          setTab(next);
          document.getElementById(tabsId + "-" + next)?.focus();
        }}
      >
        {SIDEBAR_TABS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            id={tabsId + "-" + item}
            aria-controls={tabsId + "-" + item + "-panel"}
            aria-selected={tab === item}
            tabIndex={tab === item ? 0 : -1}
            onClick={() => setTab(item)}
          >
            {item === "materials" ? (lang === "zh" ? "材质" : "Materials") : (lang === "zh" ? "图层" : "Layers")}
          </button>
        ))}
      </div>

      <div
        className="role-tree-scroll"
        role="tabpanel"
        id={tabsId + "-materials-panel"}
        aria-labelledby={tabsId + "-materials"}
        hidden={tab !== "materials"}
      >
        <div className="tileset-controls">
          <select value={currentSource?.source.id ?? ""} aria-label={lang === "zh" ? "素材来源" : "Material source"}
            onChange={(event) => { setSourceId(event.currentTarget.value); setLibraryError(""); }}>
            <option value="">{lang === "zh" ? "内置素材" : "Built-in materials"}</option>
            {tilesets.map(({ source }) => <option key={source.id} value={source.id}>{source.name}</option>)}
          </select>
          <div className="tileset-actions">
            <button type="button" disabled={!tilesetsReady || libraryBusy} onClick={() => setImportOpen(true)}>
              {lang === "zh" ? "＋ 添加 Tileset" : "+ Add Tileset"}
            </button>
            {currentSource && <button type="button" disabled={libraryBusy}
              onClick={() => void manageTilesets(() => onRemoveTileset(currentSource.source.id))}>
              {lang === "zh" ? "移除" : "Remove"}
            </button>}
            {tilesets.length > 0 && <button type="button" disabled={libraryBusy}
              onClick={() => void manageTilesets(() => downloadTilesetPack(tilesets))}>
              {lang === "zh" ? "导出包" : "Export pack"}
            </button>}
          </div>
        </div>
        {libraryError && <div className="error" role="alert">{libraryError}</div>}
        {currentSource ? (
          <TilesetMaterials key={currentSource.source.id} tileset={currentSource} activeHash={brushConfig.paletteHash} lang={lang}
            onSelect={(palette) => selectMaterial(palette.role, palette)} />
        ) : MATERIAL_GROUPS.map((group) => {
          const open = openCategories.has(group.id);
          const label = lang === "zh" ? shortLabel(group.label) : group.id.replace(/_/g, " ");
          return (
            <div key={group.id} className="cat-tree-card">
              <button type="button" className="cat-tree-header sidebar-row-button" aria-expanded={open} onClick={() => toggleCategory(group.id)}>
                <span className="cat-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
                <span className="cat-title">{label}</span>
              </button>
              {open && (
                <div className="cat-tree-body">
                  {group.roles.map(({ path, depth }) => {
                    const active = brushConfig.role === path && !activeBrushPalette?.tilesetId;
                    const label = roleLabel(path, lang);
                    const material = materialsForRole.get(path);
                    const preview = (active ? activeBrushPalette : null) ?? material?.defaultPalette ?? null;
                    const variants = material?.variants ?? [];
                    const variantsOpen = showVariantsForRole === path;
                    const variantLabel = lang === "zh" ? `${label}样式（${variants.length} 种）` : `${label} variants (${variants.length})`;

                    return (
                      <div key={path} className="role-node-group">
                        <div
                          className={`material-row${active ? " active" : ""}`}
                          style={{ paddingLeft: (depth - (group.id === "roads" ? 3 : 1)) * 8 }}
                        >
                          <button
                            type="button"
                            className="role-node-btn sidebar-row-button"
                            id={tabsId + "-" + path}
                            title={path}
                            aria-pressed={active}
                            onClick={() => selectMaterial(path, preview)}
                          >
                            <MaterialSwatch pack={pack} palette={preview} role={path} />
                            <span className="rn-label">{label}</span>
                          </button>
                          {variants.length > 1 && (
                            <button
                              type="button"
                              className="rn-variants-btn"
                              aria-expanded={variantsOpen}
                              aria-label={variantLabel}
                              title={variantLabel}
                              onClick={() => setShowVariantsForRole(variantsOpen ? null : path)}
                            >
                              {variants.length}{lang === "zh" ? " 款" : ""} {variantsOpen ? "▴" : "▾"}
                            </button>
                          )}
                        </div>
                        {variantsOpen && pack && variants.length > 1 && (
                          <div className="role-variants-drawer rv-swatches">
                            {variants.map((palette, index) => {
                              const variant = lang === "zh" ? `样式 ${index + 1}` : `Variant ${index + 1}`;
                              const name = palette.style ? `${variant} · ${palette.style}` : variant;
                              const picked = active && activeBrushPalette?.hash === palette.hash;
                              return (
                                <button
                                  key={palette.hash}
                                  type="button"
                                  className={`rv-swatch-btn${picked ? " active" : ""}`}
                                  aria-label={name}
                                  aria-pressed={picked}
                                  title={`${name} (${palette.size[0]}×${palette.size[1]})`}
                                  onClick={() => {
                                    selectMaterial(path, palette);
                                    document.getElementById(tabsId + "-" + path)?.focus();
                                  }}
                                >
                                  <PaletteSwatch pack={pack} palette={palette} px={30} />
                                  <span className="rv-style">{palette.style || variant}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div
        className="role-tree-scroll"
        role="tabpanel"
        id={tabsId + "-layers-panel"}
        aria-labelledby={tabsId + "-layers"}
        hidden={tab !== "layers"}
      >
        <div className="layers-actions sidebar-layer-actions">
          <button type="button" disabled={activeLayerId == null} onClick={onOpenCreateModal}>
            {lang === "zh" ? "＋ 对象" : "+ Object"}
          </button>
          <button type="button" disabled={selected.size === 0} onClick={onDuplicateSelection}>
            {lang === "zh" ? "复制" : "Duplicate"}
          </button>
          <button type="button" disabled={selected.size === 0} onClick={onDeleteSelection}>
            {lang === "zh" ? "删除" : "Delete"}
          </button>
        </div>
        {map.layers.map((layer) => {
          const root = layer.tags["role.root"] || layer.name;
          const categoryLabel = layer.tags["role.label"] || topRoleNode(root)?.label;
          const label = lang === "zh" && layer.name === root && categoryLabel ? shortLabel(categoryLabel) : layer.name;
          const hasObjects = layer.objects.length > 0;
          const open = hasObjects && expandedLayers.has(layer.id);
          const active = layer.id === activeLayerId;

          return (
            <div key={layer.id} className={`cat-tree-card${active ? " active" : ""}`}>
              <div className={`cat-tree-header sidebar-layer-row${layer.enabled ? "" : " is-hidden"}`}>
                <VisibilityToggle
                  visible={layer.enabled}
                  label={lang === "zh" ? `显示图层 ${label}` : `Show layer ${label}`}
                  onToggle={() => onToggleLayerEnabled(layer.id)}
                />
                <button
                  type="button"
                  className="sidebar-row-button layer-name-button"
                  title={layer.name}
                  aria-expanded={hasObjects ? open : undefined}
                  aria-current={active ? "true" : undefined}
                  onClick={() => {
                    onSelectLayer(layer.id);
                    if (hasObjects) onToggleExpandLayer(layer.id);
                  }}
                >
                  <span className="cat-caret" aria-hidden="true">{hasObjects ? (open ? "▾" : "▸") : ""}</span>
                  <span className="cat-title">{label}</span>
                  <span className="layer-count" aria-label={lang === "zh" ? `${layer.objects.length} 个对象` : `${layer.objects.length} objects`}>
                    {layer.objects.length}
                  </span>
                </button>
              </div>
              {open && (
                <div className="cat-objects-list">
                  {layer.objects.map((object) => {
                    const name = displayName(object);
                    const role = roleOf(object);
                    const picked = selected.has(object.id);
                    const dropSide = dropTarget?.layerId === layer.id && dropTarget.targetId === object.id ? dropTarget.side : null;
                    return (
                      <div
                        key={object.id}
                        className={`obj-row${picked ? " selected" : ""}${object.enabled ? "" : " hidden"}${draggingObjectId === object.id ? " dragging" : ""}${dropSide ? ` drop-${dropSide}` : ""}`}
                        draggable
                        onDragStart={onObjectDragStart(layer.id, object.id)}
                        onDragOver={onObjectDragOver(layer.id, object.id)}
                        onDrop={onObjectDrop(layer.id, object.id)}
                        onDragEnd={onObjectDragEnd}
                      >
                        <VisibilityToggle
                          visible={object.enabled}
                          label={lang === "zh" ? `显示对象 ${name}` : `Show object ${name}`}
                          onToggle={() => onToggleObjectEnabled(object.id)}
                        />
                        <button
                          type="button"
                          className="sidebar-row-button obj-name"
                          aria-pressed={picked}
                          title={`${name} (${role})`}
                          onClick={(e) => onObjectClick(object.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
                        >
                          <span className="obj-role-dot" style={{ background: rgbaCss(colorForRole(role), 1) }} aria-hidden="true" />
                          <span>{name}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {importOpen && <TilesetImportDialog lang={lang} onClose={() => setImportOpen(false)} onImport={async (sources) => {
        const id = await onImportTilesets(sources);
        setSourceId(id);
        setLibraryError("");
        return id;
      }} />}
    </aside>
  );
}
