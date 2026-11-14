// draft.ts — autosave the in-memory edit session to localStorage so an
// interrupted session can resume. Unlike the adna-web-lite *export* format
// (saveFormat.ts, for disk/desktop handoff), this keeps the editor's live model,
// including object IDs, draw strata and terrain matrices. New drafts use a map
// ID. Legacy name-based drafts remain available through manual recovery.

import { DEFAULT_TILE_RESOLUTION, type LiteTileMap } from "./model";
import { normalizeHouseData } from "./house";

const PREFIX = "reroll_draft:";
const LEGACY_PREFIX = "reroll_draft_";
const ACTIVE_KEY = "reroll_active_draft";
const VERSION = 4;

export const draftKey = (id: string) => PREFIX + id;

export interface DraftSummary {
  key: string;
  name: string;
  savedAt: number;
}

interface Envelope {
  v: number;
  savedAt: number;
  name?: string;
  map: unknown; // LiteTileMap with terrain.data as number[] (Int16Array isn't JSON-safe)
}

// terrain.data (Int16Array) → number[] for JSON, and back on load.
function toJSON(map: LiteTileMap): unknown {
  return {
    ...map,
    layers: map.layers.map((l) => ({
      ...l,
      objects: l.objects.map((o) => (o.terrain ? { ...o, terrain: { ...o.terrain, data: Array.from(o.terrain.data) } } : o)),
    })),
  };
}

function fromJSON(m: any): LiteTileMap {
  m.tileResolution ??= DEFAULT_TILE_RESOLUTION;
  for (const l of m.layers ?? []) {
    for (const o of l.objects ?? []) {
      if (o.terrain && Array.isArray(o.terrain.data)) o.terrain.data = Int16Array.from(o.terrain.data);
      if (o.type === "HOUSE" && o.rect) o.house = normalizeHouseData(o.house, o.rect);
    }
  }
  return m as LiteTileMap;
}

export function saveDraft(map: LiteTileMap): DraftSummary | null {
  if (!map.id) return null;
  try {
    const key = draftKey(map.id);
    const summary = { key, name: map.name, savedAt: Date.now() };
    const env: Envelope = { v: VERSION, name: summary.name, savedAt: summary.savedAt, map: toJSON(map) };
    localStorage.setItem(key, JSON.stringify(env));
    return summary;
  } catch { return null; }
}

function readDraft(key: string) {
  if (!key.startsWith(PREFIX) && !key.startsWith(LEGACY_PREFIX)) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope;
    const map = env.map as LiteTileMap | null;
    if ((env.v !== VERSION && env.v !== 3 && env.v !== 2) || !Number.isFinite(env.savedAt) ||
      !map || typeof map.name !== "string" || !Array.isArray(map.layers)) return null;
    if (key.startsWith(PREFIX) && (!map.id || draftKey(map.id) !== key)) return null;
    return { key, name: env.name ?? map.name, savedAt: env.savedAt, map };
  } catch { return null; }
}

export function loadDraft(key: string): { map: LiteTileMap; savedAt: number } | null {
  const draft = readDraft(key);
  if (!draft) return null;
  try {
    return { map: fromJSON(draft.map), savedAt: draft.savedAt };
  } catch { return null; }
}

export function listDrafts(): DraftSummary[] {
  const drafts: DraftSummary[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const draft = key ? readDraft(key) : null;
      if (draft) drafts.push({ key: draft.key, name: draft.name, savedAt: draft.savedAt });
    }
  } catch { /* Draft storage may be disabled. */ }
  return drafts.sort((a, b) => b.savedAt - a.savedAt);
}

export function clearDraft(key: string): void {
  try { localStorage.removeItem(key); } catch { /* Draft storage may be disabled. */ }
}

export function getActiveDraftKey(): string | null {
  try { return sessionStorage.getItem(ACTIVE_KEY); } catch { return null; }
}

export function setActiveDraftKey(key: string): void {
  try { sessionStorage.setItem(ACTIVE_KEY, key); } catch { /* Draft storage may be disabled. */ }
}
