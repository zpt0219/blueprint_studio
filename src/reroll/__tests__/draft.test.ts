import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDraft, draftKey, listDrafts, loadDraft, saveDraft } from "../draft";
import { createBlankMap } from "../loadSave";

function stubDraftStorage() {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("map drafts", () => {
  it("keeps same-name maps separate when saving, restoring, and clearing", () => {
    stubDraftStorage();
    const first = { ...createBlankMap("village", 8, 8), id: "first" };
    const second = { ...createBlankMap("village", 10, 10), id: "second" };
    saveDraft(first);
    saveDraft(second);

    expect(loadDraft(draftKey("first"))?.map).toEqual(first);
    expect(loadDraft(draftKey("second"))?.map).toEqual(second);
    clearDraft(draftKey("first"));
    expect(listDrafts().map((draft) => draft.key)).toEqual([draftKey("second")]);
  });

  it("lists legacy drafts for manual recovery without matching a new map ID", () => {
    stubDraftStorage();
    const key = "reroll_draft_village";
    const legacyMap = { ...createBlankMap("village", 8, 8, null), tileResolution: undefined };
    localStorage.setItem(key, JSON.stringify({ v: 3, savedAt: 1, map: legacyMap }));

    expect(listDrafts()).toEqual([{ key, name: "village", savedAt: 1 }]);
    expect(loadDraft(key)?.map.tileResolution).toBe(16);
    expect(loadDraft(draftKey("village"))).toBeNull();
  });
});
