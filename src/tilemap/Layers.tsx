import type { Edit } from "./history";
import { makeLayer, MAX_LAYERS, type Layer } from "./model";

export default function Layers({ layers, active, onSelect, onEdit, onRemove }: {
  layers: Layer[]; active: Layer; onSelect: (id: string) => void;
  onEdit: (edit: Edit) => void; onRemove: () => void;
}) {
  const index = layers.indexOf(active);
  function changeActive(fields: Partial<Pick<Layer, "name" | "visible">>) {
    onEdit(map => ({ ...map, layers: map.layers.map(layer => layer.id === active.id ? { ...layer, ...fields } : layer) }));
  }

  function reorder(offset: number) {
    onEdit(map => {
      const next = [...map.layers];
      const at = next.findIndex(layer => layer.id === active.id);
      const to = at + offset;
      if (at < 0 || to < 0 || to >= next.length) return map;
      [next[at], next[to]] = [next[to], next[at]];
      return { ...map, layers: next };
    });
  }

  return <details className="tm-layers">
    <summary aria-label="图层">{active.name}{active.visible ? "" : "（隐藏）"}</summary>
    <div className="tm-layer-panel">
      <strong>图层</strong>
      <div className="tm-layer-list">
        {[...layers].reverse().map(layer => <button type="button" key={layer.id}
          aria-pressed={layer === active} onClick={() => onSelect(layer.id)}>
          {layer.name}{layer.visible ? "" : "（隐藏）"}
        </button>)}
      </div>
      <input key={active.id + active.name} aria-label="图层名称" defaultValue={active.name} maxLength={128}
        onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
        onBlur={event => {
          const value = event.currentTarget.value.trim();
          if (value && value !== active.name) changeActive({ name: value });
          else event.currentTarget.value = active.name;
        }} />
      <label className="tm-layer-visible">
        <input type="checkbox" checked={active.visible} onChange={event => changeActive({ visible: event.target.checked })} />
        显示当前图层
      </label>
      <div className="tm-layer-buttons">
        <button type="button" disabled={index === layers.length - 1} onClick={() => reorder(1)}>上移</button>
        <button type="button" disabled={index === 0} onClick={() => reorder(-1)}>下移</button>
        <button type="button" disabled={layers.length < 2} className="tm-danger" onClick={onRemove}>删除</button>
      </div>
      <button type="button" disabled={layers.length >= MAX_LAYERS} onClick={() => {
        const layer = makeLayer(`图层 ${layers.length + 1}`);
        onEdit(map => ({ ...map, layers: [...map.layers, layer] }));
        onSelect(layer.id);
      }}>添加图层</button>
    </div>
  </details>;
}
