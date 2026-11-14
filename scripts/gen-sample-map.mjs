// gen-sample-map.mjs — Generate a clean 32x32 HD-2D test village sample for blueprint-studio
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, "../public/sample/hd2d_test_village_32x32.adnaweb.json");

// Hashes from palettes.adnapalettepack
const HASHES = {
  grass: "pack_61c97370371aca48",
  water: "pack_61c97870371ad2c7",
  area_path: "pack_61d3e4703723ded0",
  bridge: "pack_61d6f37037262e24",
  stair: "pack_61e17970372f665b",
  fence: "pack_6efc4a7aaacb1a5b",
  house: "pack_61d3e9703723e74f",
  house_wall: "pack_61d6e97037261d26",
  house_roof: "pack_61d079703720f328",
  well: "pack_5f0aa3adb20db82a",
  barrel: "pack_5f0712adb20a8bf0",
  lantern: "pack_5f008dadb2053e43",
  tree: "pack_5efd22adb202529b", // 32x32 lush oak tree
  pine: "pack_5f0396adb2078365", // 32x48 mountain pine tree
  bush: "pack_5ef9a4adb1ff46aa",
  flower: "pack_44312aada299d4fa",
};

// 1. Water pond cells on the west side [2, 10, 8, 12]
const waterCells = [];
for (let y = 11; y <= 20; y++) {
  for (let x = 3; x <= 8; x++) {
    if ((x === 3 || x === 8) && (y === 11 || y === 20)) continue;
    waterCells.push([x, y]);
  }
}
const waterSet = new Set(waterCells.map(([x, y]) => `${x},${y}`));

// 2. Terrain Ground (punched out water cells so pond sunken water is fully visible!)
const groundCells = [];
for (let y = 0; y < 32; y++) {
  for (let x = 0; x < 32; x++) {
    if (!waterSet.has(`${x},${y}`)) {
      groundCells.push([x, y]);
    }
  }
}

// 3. High plateau / mountain cliff cells on north-east [20, 2, 10, 8]
// Notch at (20, 6) and (20, 7) for stone stair entrance without wall clipping!
const cliffCells = [];
for (let y = 2; y <= 9; y++) {
  for (let x = 20; x <= 29; x++) {
    if (x === 20 && (y === 6 || y === 7)) continue;
    cliffCells.push([x, y]);
  }
}

// 4. T-shaped stone road
const pathCells = [];
// North-South main street (x = 15, 16; y = 7..28)
for (let y = 7; y <= 28; y++) {
  pathCells.push([15, y]);
  pathCells.push([16, y]);
}
// East-West cross street (x = 7..25; y = 16, 17)
for (let x = 7; x <= 25; x++) {
  if (x !== 15 && x !== 16) {
    pathCells.push([x, 16]);
    pathCells.push([x, 17]);
  }
}

const sampleMap = {
  format: "adna-web-lite",
  version: 3,
  name: "hd2d_test_village_32x32",
  width: 32,
  height: 32,
  tileResolution: 16,
  layers: [
    {
      name: "terrain",
      enabled: true,
      tags: { "role.root": "terrain", "role.stratum": "ground" },
      objects: [
        {
          type: "TERRAIN_2_CORNER",
          rect: [0, 0, 32, 32],
          enabled: true,
          tags: {
            "blueprint.role": "terrain/grass",
            "web.palette": HASHES.grass,
            "web.name": "草地平原",
            "web.baseName": "草地平原",
            "borderAsConnected": "true",
          },
          cells: groundCells,
        },
        {
          type: "TERRAIN_2_CORNER",
          rect: [2, 10, 8, 12],
          enabled: true,
          tags: {
            "blueprint.role": "terrain/water",
            "web.palette": HASHES.water,
            "web.name": "清澈池塘",
            "web.baseName": "清澈池塘",
            "borderAsConnected": "false",
          },
          cells: waterCells,
        },
        {
          type: "TERRAIN_2_CORNER",
          rect: [20, 2, 10, 8],
          enabled: true,
          tags: {
            "blueprint.role": "terrain/cliff",
            "web.palette": HASHES.grass,
            "web.name": "东北高台山体",
            "web.baseName": "东北高台山体",
            "borderAsConnected": "true",
          },
          cells: cliffCells,
        },
      ],
    },
    {
      name: "terrain_decoration",
      enabled: true,
      tags: { "role.root": "terrain_decoration", "role.stratum": "ground" },
      objects: [
        {
          type: "TERRAIN_2_CORNER",
          rect: [7, 7, 19, 22],
          enabled: true,
          tags: {
            "blueprint.role": "terrain_decoration/path/road/area_path",
            "web.palette": HASHES.area_path,
            "web.name": "T型石板主路",
            "web.baseName": "T型石板主路",
            "borderAsConnected": "true",
          },
          cells: pathCells,
        },
        {
          type: "FIXED_RECT",
          rect: [7, 16, 2, 2],
          enabled: true,
          tags: {
            "blueprint.role": "terrain_decoration/path/bridge/horizontal",
            "web.palette": HASHES.bridge,
            "web.name": "池畔木桥",
            "web.baseName": "池畔木桥",
          },
        },
        {
          type: "FIXED_RECT",
          rect: [19, 6, 2, 2],
          enabled: true,
          tags: {
            "blueprint.role": "terrain_decoration/traversal/stair/down",
            "web.palette": HASHES.stair,
            "web.name": "高台石梯",
            "web.baseName": "高台石梯",
          },
        },
      ],
    },
    {
      name: "boundary",
      enabled: true,
      tags: { "role.root": "boundary", "role.stratum": "vertical" },
      objects: [
        {
          type: "FIXED_RECT",
          rect: [10, 14, 4, 1],
          enabled: true,
          tags: {
            "blueprint.role": "boundary/fence",
            "web.palette": HASHES.fence,
            "web.name": "木屋南围栏",
            "web.baseName": "木屋南围栏",
          },
        },
      ],
    },
    {
      name: "building",
      enabled: true,
      tags: { "role.root": "building", "role.stratum": "vertical" },
      objects: [
        {
          type: "HOUSE",
          rect: [10, 9, 4, 4],
          enabled: true,
          tags: {
            "blueprint.role": "building/house",
            "web.palette": HASHES.house,
            "web.name": "平原村长木屋",
            "web.baseName": "平原村长木屋",
          },
          house: {
            wallHeight: 2,
            overlap: 1,
            wall: HASHES.house_wall,
            roof: HASHES.house_roof,
            decorations: [
              { kind: "door", cell: [1, 2] },
              { kind: "window", cell: [3, 2] },
              { kind: "chimney", cell: [0, 0] },
            ],
          },
        },
        {
          type: "HOUSE",
          rect: [23, 4, 4, 4],
          enabled: true,
          tags: {
            "blueprint.role": "building/house",
            "web.palette": HASHES.house,
            "web.name": "山顶观景木屋",
            "web.baseName": "山顶观景木屋",
          },
          house: {
            wallHeight: 2,
            overlap: 1,
            wall: HASHES.house_wall,
            roof: HASHES.house_roof,
            decorations: [
              { kind: "door", cell: [2, 2] },
              { kind: "window", cell: [1, 2] },
              { kind: "chimney", cell: [3, 0] },
            ],
          },
        },
      ],
    },
    {
      name: "outdoor_prop",
      enabled: true,
      tags: { "role.root": "outdoor_prop", "role.stratum": "vertical" },
      objects: [
        {
          type: "FIXED_RECT",
          rect: [18, 18, 2, 2],
          enabled: true,
          tags: {
            "blueprint.role": "outdoor_prop/facility/well",
            "web.palette": HASHES.well,
            "web.name": "路口石水井",
            "web.baseName": "路口石水井",
          },
        },
        {
          type: "FIXED_RECT",
          rect: [14, 13, 1, 1],
          enabled: true,
          tags: {
            "blueprint.role": "outdoor_prop/furniture/barrel",
            "web.palette": HASHES.barrel,
            "web.name": "门前木桶",
            "web.baseName": "门前木桶",
          },
        },
        {
          type: "FIXED_RECT",
          rect: [17, 15, 1, 1],
          enabled: true,
          tags: {
            "blueprint.role": "outdoor_prop/facility/lantern",
            "web.palette": HASHES.lantern,
            "web.name": "路口路灯",
            "web.baseName": "路口路灯",
          },
        },
        {
          type: "FIXED_RECT",
          rect: [20, 5, 1, 1],
          enabled: true,
          tags: {
            "blueprint.role": "outdoor_prop/facility/lantern",
            "web.palette": HASHES.lantern,
            "web.name": "高台阶梯灯",
            "web.baseName": "高台阶梯灯",
          },
        },
      ],
    },
    {
      name: "nature_prop",
      enabled: true,
      tags: { "role.root": "nature_prop", "role.stratum": "vertical" },
      objects: [
        {
          type: "FIXED_RECT",
          rect: [5, 6, 2, 2],
          enabled: true,
          tags: {
            "blueprint.role": "nature_prop/tree",
            "web.palette": HASHES.tree,
            "web.name": "池畔绿树",
            "web.baseName": "池畔绿树",
          },
        },
        {
          type: "FIXED_RECT",
          rect: [21, 2, 2, 2],
          enabled: true,
          tags: {
            "blueprint.role": "nature_prop/tree/pine",
            "web.palette": HASHES.pine,
            "web.name": "高台山顶松树",
            "web.baseName": "高台山顶松树",
          },
        },
        {
          type: "FIXED_RECT",
          rect: [27, 2, 2, 2],
          enabled: true,
          tags: {
            "blueprint.role": "nature_prop/tree/pine",
            "web.palette": HASHES.pine,
            "web.name": "高台东侧松树",
            "web.baseName": "高台东侧松树",
          },
        },
        {
          type: "FIXED_RECT",
          rect: [6, 24, 2, 2],
          enabled: true,
          tags: {
            "blueprint.role": "nature_prop/tree",
            "web.palette": HASHES.tree,
            "web.name": "西南草地树",
            "web.baseName": "西南草地树",
          },
        },
        {
          type: "FIXED_RECT",
          rect: [24, 23, 2, 2],
          enabled: true,
          tags: {
            "blueprint.role": "nature_prop/tree",
            "web.palette": HASHES.tree,
            "web.name": "东南草地树",
            "web.baseName": "东南草地树",
          },
        },
        {
          type: "FIXED_RECT",
          rect: [11, 18, 1, 1],
          enabled: true,
          tags: {
            "blueprint.role": "nature_prop/tree/bush",
            "web.palette": HASHES.bush,
            "web.name": "矮灌木",
            "web.baseName": "矮灌木",
          },
        },
        {
          type: "FIXED_RECT",
          rect: [18, 22, 1, 1],
          enabled: true,
          tags: {
            "blueprint.role": "nature_prop/plant/flower",
            "web.palette": HASHES.flower,
            "web.name": "路旁小花",
            "web.baseName": "路旁小花",
          },
        },
      ],
    },
    {
      name: "spawner",
      enabled: true,
      tags: { "role.root": "spawner", "role.stratum": "ground" },
      objects: [
        {
          type: "FIXED_RECT",
          rect: [15, 16, 1, 1],
          enabled: true,
          tags: {
            "blueprint.role": "spawner/player",
            "web.name": "玩家出生点",
            "web.baseName": "玩家出生点",
          },
        },
      ],
    },
  ],
};

fs.writeFileSync(outPath, JSON.stringify(sampleMap, null, 2), "utf-8");
console.log("Generated clean 32x32 village map with mountain & stairs:", outPath);
