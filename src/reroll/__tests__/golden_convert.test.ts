import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseBlueprint } from "../blueprint";
import { blueprintToLite } from "../convert";
import { normalizeToCategories } from "../normalize";
import { liteToWebSave } from "../saveFormat";

describe("Golden Convert Pipeline", () => {
  it("converts test_village_strict blueprint to normalized adna-web-lite format", () => {
    const samplePath = resolve(__dirname, "../../../public/sample/test_village_strict.blueprint.json");
    const jsonText = readFileSync(samplePath, "utf-8");

    const blueprint = parseBlueprint("test_village_strict", jsonText);
    expect(blueprint.width).toBe(100);
    expect(blueprint.height).toBe(80);

    const lite = blueprintToLite(blueprint);
    expect(lite.width).toBe(100);
    expect(lite.height).toBe(80);

    const normalized = normalizeToCategories(lite);
    expect(normalized.layers.length).toBeGreaterThan(0);

    const saved = liteToWebSave(normalized);
    expect(saved.format).toBe("adna-web-lite");
    expect(saved.version).toBe(3);
    expect(saved.width).toBe(100);
    expect(saved.height).toBe(80);
    expect(saved.tileResolution).toBe(16);

    // Count non-empty layers and objects
    const totalObjects = saved.layers.reduce((sum, l) => sum + l.objects.length, 0);
    expect(totalObjects).toBeGreaterThan(0);

    // Snapshot testing ensures deterministic conversion and guards against regressions
    expect(saved).toMatchSnapshot();
  });
});
