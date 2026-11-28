#!/usr/bin/env node
/**
 * Blueprint Studio AK World Project Tooling:
 *   node scripts/ak-project.mjs bake
 *       Upgrades temple artwork, applies southern beach landmarks & Lake Temple Boss trigger,
 *       packs compact delta public/sample/ak-world-designed.bptilemap (~520 KB) and
 *       standalone public/sample/ak-coast-kit.bppalette (~500 KB), and verifies round-trip + patch.
 *
 *   node scripts/ak-project.mjs rebase <in.bptilemap> <out.bptilemap> \
 *       [--baseline=public/sample/ak-world.bptilemap] [--old-baseline=...] [--delta]
 *       Migrates an existing AK .bptilemap project onto a newly exported Godot baseline snapshot.
 *
 *   node scripts/ak-project.mjs pack-delta <full.bptilemap> <delta.bptilemap> \
 *       [--baseline=public/sample/ak-world.bptilemap]
 *       Converts a full standalone AK .bptilemap (~9 MB) into a compact delta .bptilemap (~520 KB).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studioDir = path.resolve(__dirname, "..");
const chromeBin = process.env.CHROME_BIN || "/usr/bin/google-chrome";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => resolve(addr.port));
    });
    server.on("error", reject);
  });
}

async function waitForHttp(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { try { ws.close(); } catch { /* ignore */ } },
      });
    });
    ws.addEventListener("message", ev => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.addEventListener("error", reject);
  });
}

async function runInStudioBrowser(filesToServe, outputTargets, browserExprFactory) {
  if (!fs.existsSync(chromeBin)) throw new Error(`Chrome binary not found: ${chromeBin}`);
  const vitePort = await getFreePort();
  const cdpPort = await getFreePort();
  const ioPort = await getFreePort();
  const chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), "ak-proj-cdp-"));

  const ioServer = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, `http://127.0.0.1:${ioPort}`);
    const name = url.searchParams.get("name");
    if (req.method === "GET" && name && filesToServe[name]) {
      const buf = fs.readFileSync(filesToServe[name]);
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(buf);
      return;
    }
    if (req.method === "POST" && name && outputTargets[name]) {
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const buf = Buffer.concat(chunks);
        fs.mkdirSync(path.dirname(outputTargets[name]), { recursive: true });
        fs.writeFileSync(outputTargets[name], buf);
        res.writeHead(200);
        res.end(String(buf.length));
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise(resolve => ioServer.listen(ioPort, "127.0.0.1", resolve));

  const viteBin = path.join(studioDir, "node_modules", ".bin", "vite");
  const vite = spawn(viteBin, ["--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: studioDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let chrome = null;
  let cdp = null;
  try {
    const baseUrl = `http://127.0.0.1:${vitePort}`;
    await waitForHttp(`${baseUrl}/`);
    chrome = spawn(chromeBin, [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      `--user-data-dir=${chromeProfile}`, `--remote-debugging-port=${cdpPort}`, `${baseUrl}/`,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let page = null;
    for (let i = 0; !page && i < 50; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl);
      } catch { /* retry */ }
      if (!page) await new Promise(r => setTimeout(r, 150));
    }
    if (!page) throw new Error("No headless Chrome page target.");

    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: `${baseUrl}/` });
    await cdp.send("Runtime.evaluate", {
      expression: `new Promise(resolve => {
        const check = () => {
          if (location.origin === ${JSON.stringify(baseUrl)} && document.readyState === 'complete') resolve(true);
          else setTimeout(check, 80);
        };
        check();
      })`,
      awaitPromise: true,
    });

    const expr = browserExprFactory(baseUrl, `http://127.0.0.1:${ioPort}`);
    const evalRes = await cdp.send("Runtime.evaluate", {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (evalRes.exceptionDetails) {
      throw new Error(evalRes.exceptionDetails.exception?.description || evalRes.exceptionDetails.text);
    }
    return evalRes.result?.value;
  } finally {
    ioServer.close();
    if (cdp) cdp.close();
    if (chrome) try { chrome.kill("SIGTERM"); } catch { /* ignore */ }
    try { vite.kill("SIGTERM"); } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 250));
    if (chrome && chrome.exitCode === null) try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
    if (vite.exitCode === null) try { vite.kill("SIGKILL"); } catch { /* ignore */ }
    try { fs.rmSync(chromeProfile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Browser-side procedural artwork renderer for upgraded Rows 3–4 (Lake Temple Ruins).
 * Replaces simple placeholder rectangles with layered weathered stonework, chiseled bevels,
 * creeping moss clusters, glowing arcane Boss Seal sigils, and fluted stone columns.
 */
const UPGRADED_TEMPLE_ART_FN = `
function drawUpgradedTempleArt(ctx) {
  let seed = 133742;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const speckle = (ox, oy, w, h, count, lightRgba, darkRgba) => {
    for (let i = 0; i < count; i++) {
      const px = ox + Math.floor(rand() * w);
      const py = oy + Math.floor(rand() * h);
      const sz = rand() > 0.72 ? 3 : 2;
      ctx.fillStyle = rand() > 0.48 ? lightRgba : darkRgba;
      ctx.fillRect(px, py, sz, sz);
    }
  };
  const drawMossCluster = (cx, cy, rx, ry) => {
    ctx.fillStyle = "#2f4a27";
    ctx.beginPath(); ctx.ellipse(cx + 1, cy + 2, rx + 2, ry + 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#486e37";
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 8; i++) {
      const a = rand() * Math.PI * 2;
      const d = rand() * 0.75;
      ctx.fillStyle = i % 2 === 0 ? "#68924d" : "#80aa5f";
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rx * d, cy + Math.sin(a) * ry * d, 2 + rand() * 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  // Clear Rows 3–4 (y = 384..639) before redrawing upgraded temple stonework & columns
  ctx.clearRect(0, 384, 512, 256);

  // 1 & 2. [0, 384] ruin-flagstone & [128, 384] ruin-moss-stone
  const drawAshlar = (ox, oy, mossy) => {
    ctx.fillStyle = "#4b4942";
    ctx.fillRect(ox, oy, 128, 128);
    const stones = [
      [3, 3, 59, 59, "#959185", "#7f7b70"],
      [66, 3, 59, 59, "#89867b", "#757268"],
      [3, 66, 39, 59, "#848176", "#706d63"],
      [46, 66, 79, 59, "#918d82", "#7b786d"],
    ];
    for (const [sx, sy, sw, sh, topC, botC] of stones) {
      const g = ctx.createLinearGradient(ox + sx, oy + sy, ox + sx + sw, oy + sy + sh);
      g.addColorStop(0, topC);
      g.addColorStop(1, botC);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(ox + sx, oy + sy, sw, sh, 3);
      ctx.fill();
      // Chiseled sunlit NW bevel & deep SE edge
      ctx.fillStyle = "rgba(255,250,235,0.24)";
      ctx.fillRect(ox + sx + 2, oy + sy + 1, sw - 4, 3);
      ctx.fillRect(ox + sx + 1, oy + sy + 2, 3, sh - 4);
      ctx.fillStyle = "rgba(22,20,16,0.34)";
      ctx.fillRect(ox + sx + 2, oy + sy + sh - 4, sw - 4, 3);
      ctx.fillRect(ox + sx + sw - 4, oy + sy + 2, 3, sh - 4);
      speckle(ox + sx + 4, oy + sy + 4, sw - 8, sh - 8, 28, "rgba(255,252,240,0.12)", "rgba(35,32,26,0.16)");
    }
    // Weathered chisel fractures
    ctx.strokeStyle = "rgba(38,35,30,0.68)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ox + 16, oy + 12); ctx.lineTo(ox + 34, oy + 29); ctx.lineTo(ox + 29, oy + 49);
    ctx.moveTo(ox + 34, oy + 29); ctx.lineTo(ox + 48, oy + 34);
    ctx.moveTo(ox + 78, oy + 76); ctx.lineTo(ox + 98, oy + 94); ctx.lineTo(ox + 114, oy + 89);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,250,235,0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox + 17, oy + 11); ctx.lineTo(ox + 35, oy + 28);
    ctx.stroke();
    if (mossy) {
      drawMossCluster(ox + 64, oy + 64, 18, 13);
      drawMossCluster(ox + 20, oy + 63, 17, 9);
      drawMossCluster(ox + 104, oy + 63, 19, 10);
      drawMossCluster(ox + 64, oy + 18, 10, 15);
      drawMossCluster(ox + 44, oy + 108, 14, 12);
      drawMossCluster(ox + 14, oy + 16, 11, 9);
    }
  };
  drawAshlar(0, 384, false);
  drawAshlar(128, 384, true);

  // 3. [256, 384] ruin-altar-rune: Basalt Boss Seal Dais with luminous arcane inlay
  {
    const ox = 256, oy = 384;
    const bg = ctx.createRadialGradient(ox + 64, oy + 64, 8, ox + 64, oy + 64, 86);
    bg.addColorStop(0, "#4c5464");
    bg.addColorStop(0.55, "#3b404c");
    bg.addColorStop(1, "#2a2d36");
    ctx.fillStyle = bg;
    ctx.fillRect(ox, oy, 128, 128);
    speckle(ox + 4, oy + 4, 120, 120, 95, "rgba(180,210,230,0.08)", "rgba(10,12,18,0.22)");
    // Beveled temple border
    ctx.strokeStyle = "#1f2229"; ctx.lineWidth = 6; ctx.strokeRect(ox + 3, oy + 3, 122, 122);
    ctx.strokeStyle = "#7b7464"; ctx.lineWidth = 2.5; ctx.strokeRect(ox + 9, oy + 9, 110, 110);
    ctx.strokeStyle = "#b59656"; ctx.lineWidth = 1.5; ctx.strokeRect(ox + 14, oy + 14, 100, 100);
    // Soft arcane glow aura
    const glow = ctx.createRadialGradient(ox + 64, oy + 64, 4, ox + 64, oy + 64, 52);
    glow.addColorStop(0, "rgba(116, 232, 248, 0.42)");
    glow.addColorStop(0.55, "rgba(80, 198, 224, 0.14)");
    glow.addColorStop(1, "rgba(80, 198, 224, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(ox + 64, oy + 64, 52, 0, Math.PI * 2); ctx.fill();
    // Outer engraved golden circle & octagonal seal
    ctx.strokeStyle = "#dfb558"; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.arc(ox + 64, oy + 64, 45, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#6ce4f4"; ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const x = ox + 64 + Math.cos(a) * 41;
      const y = oy + 64 + Math.sin(a) * 41;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ox + 64, oy + 64, 27, 0, Math.PI * 2);
    ctx.moveTo(ox + 64, oy + 15); ctx.lineTo(ox + 64, oy + 113);
    ctx.moveTo(ox + 15, oy + 64); ctx.lineTo(ox + 113, oy + 64);
    ctx.moveTo(ox + 30, oy + 30); ctx.lineTo(ox + 98, oy + 98);
    ctx.moveTo(ox + 98, oy + 30); ctx.lineTo(ox + 30, oy + 98);
    ctx.stroke();
    // Core crystal medallion
    ctx.fillStyle = "#f7d478";
    ctx.beginPath(); ctx.arc(ox + 64, oy + 64, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#aef7ff";
    ctx.beginPath(); ctx.arc(ox + 64, oy + 64, 6, 0, Math.PI * 2); ctx.fill();
  }

  // 4. [384, 384] ruin-wall-block: Heavy coursed temple masonry
  {
    const ox = 384, oy = 384;
    ctx.fillStyle = "#3a3832";
    ctx.fillRect(ox, oy, 128, 128);
    const rows = [0, 32, 64, 96];
    rows.forEach((ry, rIdx) => {
      const shift = (rIdx % 2) * 32;
      for (let bx = -shift; bx < 128; bx += 64) {
        const x0 = Math.max(2, bx + 2), x1 = Math.min(126, bx + 62);
        if (x1 <= x0) continue;
        const g = ctx.createLinearGradient(ox + x0, oy + ry + 2, ox + x0, oy + ry + 30);
        const warm = (rIdx + Math.floor((bx + 64) / 64)) % 2 === 0;
        g.addColorStop(0, warm ? "#8b867a" : "#7e7a70");
        g.addColorStop(1, warm ? "#69655c" : "#5e5b53");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.roundRect(ox + x0, oy + ry + 2, x1 - x0, 28, 2); ctx.fill();
        ctx.fillStyle = "rgba(255,250,235,0.22)";
        ctx.fillRect(ox + x0 + 2, oy + ry + 3, x1 - x0 - 4, 3);
        ctx.fillStyle = "rgba(18,16,12,0.34)";
        ctx.fillRect(ox + x0 + 2, oy + ry + 26, x1 - x0 - 4, 3);
        speckle(ox + x0 + 3, oy + ry + 5, Math.max(4, x1 - x0 - 6), 20, 14, "rgba(255,250,238,0.12)", "rgba(24,22,18,0.18)");
      }
    });
    drawMossCluster(ox + 26, oy + 98, 18, 8);
    drawMossCluster(ox + 94, oy + 65, 16, 7);
    drawMossCluster(ox + 60, oy + 32, 12, 6);
  }

  // 5. [0, 512] ruin-pillar: Tall Fluted Temple Column with cylindrical shading
  {
    const ox = 0, oy = 512;
    // Molded stepped plinth
    const plinthG = ctx.createLinearGradient(ox + 22, oy, ox + 106, oy);
    plinthG.addColorStop(0, "#7f7b70"); plinthG.addColorStop(0.4, "#a39f93"); plinthG.addColorStop(1, "#4e4b43");
    ctx.fillStyle = plinthG;
    ctx.fillRect(ox + 22, oy + 112, 84, 16);
    ctx.fillRect(ox + 28, oy + 101, 72, 12);
    // Cylindrical fluted shaft
    const shaftG = ctx.createLinearGradient(ox + 36, oy, ox + 92, oy);
    shaftG.addColorStop(0, "#8f8b80"); shaftG.addColorStop(0.32, "#bbb6a8");
    shaftG.addColorStop(0.68, "#8c887d"); shaftG.addColorStop(1, "#55524a");
    ctx.fillStyle = shaftG;
    ctx.fillRect(ox + 36, oy + 22, 56, 80);
    for (let fx = 42; fx <= 84; fx += 9) {
      ctx.fillStyle = "rgba(32,29,24,0.32)";
      ctx.fillRect(ox + fx, oy + 24, 3, 76);
      ctx.fillStyle = "rgba(255,252,240,0.22)";
      ctx.fillRect(ox + fx + 3, oy + 24, 2, 76);
    }
    // Ornate weathered capital
    ctx.fillStyle = plinthG;
    ctx.fillRect(ox + 28, oy + 13, 72, 11);
    ctx.fillRect(ox + 22, oy + 4, 80, 10);
    // Cracks & shadow outline
    ctx.strokeStyle = "#3a3731"; ctx.lineWidth = 2.5;
    ctx.strokeRect(ox + 36, oy + 22, 56, 80);
    ctx.beginPath(); ctx.moveTo(ox + 36, oy + 54); ctx.lineTo(ox + 68, oy + 61); ctx.lineTo(ox + 92, oy + 57); ctx.stroke();
    speckle(ox + 38, oy + 26, 50, 74, 40, "rgba(255,252,240,0.14)", "rgba(30,28,22,0.18)");
    drawMossCluster(ox + 42, oy + 105, 16, 8);
    drawMossCluster(ox + 82, oy + 114, 15, 7);
    drawMossCluster(ox + 38, oy + 14, 11, 5);
  }

  // 6. [128, 512] ruin-broken-pillar: Fractured fluted half-column
  {
    const ox = 128, oy = 512;
    const plinthG = ctx.createLinearGradient(ox + 22, oy, ox + 106, oy);
    plinthG.addColorStop(0, "#7c786d"); plinthG.addColorStop(0.4, "#9e9a8e"); plinthG.addColorStop(1, "#4d4a42");
    ctx.fillStyle = plinthG;
    ctx.fillRect(ox + 22, oy + 112, 84, 16);
    ctx.fillRect(ox + 28, oy + 100, 72, 13);
    const shaftG = ctx.createLinearGradient(ox + 36, oy, ox + 92, oy);
    shaftG.addColorStop(0, "#8c887d"); shaftG.addColorStop(0.32, "#b5b0a2");
    shaftG.addColorStop(0.7, "#858176"); shaftG.addColorStop(1, "#524f47");
    ctx.fillStyle = shaftG;
    ctx.beginPath();
    ctx.moveTo(ox + 36, oy + 101);
    ctx.lineTo(ox + 36, oy + 46);
    ctx.lineTo(ox + 50, oy + 32);
    ctx.lineTo(ox + 64, oy + 48);
    ctx.lineTo(ox + 77, oy + 37);
    ctx.lineTo(ox + 92, oy + 44);
    ctx.lineTo(ox + 92, oy + 101);
    ctx.closePath();
    ctx.fill();
    for (let fx = 42; fx <= 84; fx += 9) {
      ctx.fillStyle = "rgba(32,29,24,0.32)";
      ctx.fillRect(ox + fx, oy + 50, 3, 50);
      ctx.fillStyle = "rgba(255,252,240,0.2)";
      ctx.fillRect(ox + fx + 3, oy + 50, 2, 50);
    }
    ctx.strokeStyle = "#3a3731"; ctx.lineWidth = 2.5;
    ctx.stroke();
    speckle(ox + 38, oy + 48, 50, 52, 34, "rgba(255,252,240,0.14)", "rgba(30,28,22,0.18)");
    drawMossCluster(ox + 48, oy + 98, 17, 9);
    drawMossCluster(ox + 64, oy + 48, 10, 6);
  }

  // 7. [256, 512] ruin-fallen-column: Collapsed cylindrical drum & scattered rubble
  {
    const ox = 256, oy = 512;
    const drumG = ctx.createLinearGradient(ox, oy + 72, ox, oy + 124);
    drumG.addColorStop(0, "#aca79a"); drumG.addColorStop(0.45, "#8b877b"); drumG.addColorStop(1, "#4d4a42");
    ctx.fillStyle = drumG;
    ctx.beginPath(); ctx.roundRect(ox + 12, oy + 74, 104, 46, 12); ctx.fill();
    ctx.strokeStyle = "#3a3731"; ctx.lineWidth = 2.5; ctx.stroke();
    // Horizontal fluting & crack rings
    for (let fy = 82; fy <= 112; fy += 9) {
      ctx.fillStyle = "rgba(30,28,22,0.28)";
      ctx.fillRect(ox + 32, oy + fy, 80, 2.5);
    }
    // Exposed oval cross-section
    ctx.fillStyle = "#b7b2a4";
    ctx.beginPath(); ctx.ellipse(ox + 24, oy + 97, 12, 22, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#3a3731"; ctx.stroke();
    ctx.fillStyle = "#7a766b";
    ctx.beginPath(); ctx.ellipse(ox + 24, oy + 97, 4, 8, 0, 0, Math.PI * 2); ctx.fill();
    // Rubble chips & mossy mantle
    ctx.fillStyle = "#858176";
    ctx.beginPath(); ctx.roundRect(ox + 88, oy + 114, 24, 12, 4); ctx.fill();
    ctx.beginPath(); ctx.roundRect(ox + 6, oy + 112, 18, 13, 4); ctx.fill();
    drawMossCluster(ox + 58, oy + 78, 22, 9);
    drawMossCluster(ox + 92, oy + 82, 12, 7);
  }

  // 8. [384, 512] ruin-stele: Tapered basalt Boss Seal obelisk with luminous glyphs
  {
    const ox = 384, oy = 512;
    ctx.fillStyle = "#31343c";
    ctx.fillRect(ox + 22, oy + 111, 84, 17);
    ctx.fillStyle = "#484c57";
    ctx.fillRect(ox + 28, oy + 104, 72, 9);
    const bodyG = ctx.createLinearGradient(ox + 34, oy, ox + 94, oy);
    bodyG.addColorStop(0, "#4b4f5c"); bodyG.addColorStop(0.4, "#676c7c"); bodyG.addColorStop(1, "#32353f");
    ctx.fillStyle = bodyG;
    ctx.beginPath();
    ctx.moveTo(ox + 34, oy + 105);
    ctx.lineTo(ox + 42, oy + 20);
    ctx.lineTo(ox + 64, oy + 5);
    ctx.lineTo(ox + 86, oy + 20);
    ctx.lineTo(ox + 94, oy + 105);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#22242b"; ctx.lineWidth = 2.5; ctx.stroke();
    speckle(ox + 40, oy + 22, 48, 80, 42, "rgba(210,225,240,0.1)", "rgba(15,17,22,0.22)");
    // Luminous rune glow
    const rg = ctx.createRadialGradient(ox + 64, oy + 48, 2, ox + 64, oy + 48, 28);
    rg.addColorStop(0, "rgba(116, 232, 248, 0.55)");
    rg.addColorStop(1, "rgba(116, 232, 248, 0)");
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(ox + 64, oy + 48, 28, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#70e5f5"; ctx.lineWidth = 2.8;
    ctx.beginPath();
    ctx.arc(ox + 64, oy + 46, 13, 0, Math.PI * 2);
    ctx.moveTo(ox + 64, oy + 22); ctx.lineTo(ox + 64, oy + 96);
    ctx.moveTo(ox + 50, oy + 72); ctx.lineTo(ox + 78, oy + 72);
    ctx.moveTo(ox + 53, oy + 85); ctx.lineTo(ox + 75, oy + 85);
    ctx.stroke();
    ctx.fillStyle = "#f7d478";
    ctx.beginPath(); ctx.arc(ox + 64, oy + 46, 5.5, 0, Math.PI * 2); ctx.fill();
    drawMossCluster(ox + 38, oy + 111, 13, 6);
  }
}
`;

// Southern beach landmark additions (placed strictly on verified open sand tiles using the 18-piece 3D Scene Kit!)
const SOUTH_BEACH_LANDMARKS = {
  roads: [
    // Spur into Southern Cove Camp (connecting to main road x=46)
    [44, 151], [45, 151],
    // Spur into Cape Watchtower / Lighthouse Point (connecting to road x=76)
    [77, 150], [78, 150],
    // Spur into Old Road Well & Ruined Arch Waystation (connecting to road x=18)
    [15, 147], [16, 147], [17, 147],
  ],
  decos: [
    // 1. Southern Cove Expedition Camp (x=39..45, z=149..150)
    [41, 149, "scene-camp-tent"],
    [43, 149, "scene-camp-tent"],
    [42, 150, "scene-brazier"],
    [40, 150, "scene-supply-crates"],
    [44, 150, "scene-supply-crates"],
    [45, 149, "scene-signpost"],
    [39, 149, "scene-wood-fence"],
    [39, 150, "scene-wood-fence"],
    // 2. Cape Watchtower / Lighthouse Point (x=78..83, z=149..150)
    [81, 149, "ruin-watchtower"],
    [80, 150, "scene-brazier"],
    [82, 150, "scene-lamp-post"],
    [78, 149, "scene-lamp-post"],
    [79, 150, "scene-supply-crates"],
    [83, 149, "scene-stone-fence"],
    [83, 150, "scene-stone-fence"],
    // 3. Old Road Well & Ruined Arch Waystation (x=12..16, z=146..148)
    [16, 147, "ruin-arch"],
    [13, 147, "scene-stone-well"],
    [14, 146, "scene-lamp-post"],
    [12, 146, "scene-supply-crates"],
    [14, 148, "scene-signpost"],
  ],
  markers: [
    { id: "lake-temple-ruins", name: "湖心神殿废墟", position: [58, 3.9, 34] },
    { id: "beach-cove-camp", name: "南湾探险营地", position: [-230, 1, 282] },
    { id: "beach-cape-watchtower", name: "南角灯塔哨塔", position: [-74, 1, 278] },
    { id: "beach-well-waystation", name: "西滩古井驿站", position: [-342, 1, 270] },
  ],
  encounters: [
    {
      id: "lake-temple-boss",
      name: "湖心神殿 Boss 祭坛",
      kind: "boss",
      position: [58, 3.9, 34],
      radius: 14,
      tag: "lake_temple_boss",
    },
  ],
};

async function cmdBake() {
  const baselinePath = path.join(studioDir, "public/sample/ak-world.bptilemap");
  const designedPath = path.join(studioDir, "public/sample/ak-world-designed.bptilemap");
  const kitPath = path.join(studioDir, "public/sample/ak-coast-kit.bppalette");
  const result = await runInStudioBrowser(
    { baseline: baselinePath, current: designedPath },
    { designed: designedPath, kit: kitPath },
    (origin, ioUrl) => `(async () => {
      ${UPGRADED_TEMPLE_ART_FN}
      const { decodeProject, encodeProject, tilesetImage } = await import(${JSON.stringify(origin)} + '/src/tilemap/files.ts');
      const { makeMap } = await import(${JSON.stringify(origin)} + '/src/tilemap/model.ts');
      const { packDeltaProject, materializeDeltaProject } = await import(${JSON.stringify(origin)} + '/src/tilemap/worldRebase.ts');
      const { buildPortablePatch } = await import(${JSON.stringify(origin)} + '/src/tilemap/patchAssets.ts');
      const { AK_COAST_LAYER_ID, AK_COAST_TILESET_ID } = await import(${JSON.stringify(origin)} + '/src/tilemap/akBeachDesign.ts');

      const fetchBytes = async name => new Uint8Array(await (await fetch(${JSON.stringify(ioUrl)} + '/?name=' + name)).arrayBuffer());
      const baseline = await decodeProject(await fetchBytes('baseline'));
      let designed = await decodeProject(await fetchBytes('current'));
      if (designed.world?.delta) designed = materializeDeltaProject(designed, baseline);

      // 1. Upgrade rows 3–4 (Lake Temple Ruins) artwork inside ak-coast.png while keeping rows 0–2 & 5–7 intact
      const coastAsset = designed.tilesets.find(t => t.id === AK_COAST_TILESET_ID);
      if (!coastAsset) throw new Error('Missing ak-coast tileset');
      const img = await tilesetImage(coastAsset.png);
      const canvas = document.createElement('canvas');
      canvas.width = coastAsset.width;
      canvas.height = coastAsset.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      drawUpgradedTempleArt(ctx);
      const upgradedPng = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!upgradedPng) throw new Error('Failed to encode upgraded ak-coast.png');
      const nextCoast = { ...coastAsset, png: upgradedPng };
      designed = {
        ...designed,
        tilesets: designed.tilesets.map(t => t.id === AK_COAST_TILESET_ID ? nextCoast : t),
      };

      // 2. Apply southern beach landmarks (roads + 3D Scene Kit props) cleanly
      const spec = ${JSON.stringify(SOUTH_BEACH_LANDMARKS)};
      const width = designed.width;
      designed = {
        ...designed,
        layers: designed.layers.map(layer => {
          if (layer.id === 'ak-roads') {
            const cells = { ...layer.cells };
            for (const [x, z] of spec.roads) cells[z * width + x] = { palette: 'road' };
            return { ...layer, cells };
          }
          if (layer.id === AK_COAST_LAYER_ID) {
            const cells = { ...layer.cells };
            for (const [x, z, pal] of spec.decos) cells[z * width + x] = { palette: pal };
            return { ...layer, cells };
          }
          return layer;
        }),
      };

      // 3. Register Boss encounter trigger & landmark quick-jump markers
      const existingMarkers = designed.world.markers.filter(m => !spec.markers.some(s => s.id === m.id));
      const nextMarkers = [
        ...existingMarkers,
        ...spec.markers.map(m => {
          const tx = Math.floor((m.position[0] - designed.world.origin[0]) / designed.world.metresPerTile);
          const tz = Math.floor((m.position[2] - designed.world.origin[1]) / designed.world.metresPerTile);
          const idx = tz * width + tx;
          const y = designed.world.elevations?.[idx] ?? designed.world.heights[idx] ?? m.position[1];
          return { ...m, position: [m.position[0], Number(y.toFixed(3)), m.position[2]] };
        }),
      ];
      const existingEncounters = (designed.world.encounters ?? []).filter(e => !spec.encounters.some(s => s.id === e.id));
      designed = {
        ...designed,
        world: {
          ...designed.world,
          markers: nextMarkers,
          encounters: [...existingEncounters, ...spec.encounters],
        },
      };

      // 4. Pack compact delta project (~520 KB instead of 9.2 MB!) and verify lossless round-trip + patch
      const delta = packDeltaProject(designed, baseline);
      const deltaBytes = await encodeProject(delta);
      const decodedDelta = await decodeProject(deltaBytes);
      const rematerialized = materializeDeltaProject(decodedDelta, baseline);
      const patchDirect = JSON.stringify(await buildPortablePatch(designed, baseline));
      const patchFromDelta = JSON.stringify(await buildPortablePatch(rematerialized, baseline));
      if (patchDirect !== patchFromDelta) {
        throw new Error('Delta round-trip patch mismatch!');
      }

      // 5. Export updated standalone palette pack (.bppalette)
      const kitMap = {
        ...makeMap(1, 1),
        tilesets: [nextCoast],
        palettes: designed.palettes.filter(p => p.tileset === AK_COAST_TILESET_ID),
      };
      const kitBytes = await encodeProject(kitMap);
      await decodeProject(kitBytes);

      const post = async (name, body) => {
        const res = await fetch(${JSON.stringify(ioUrl)} + '/?name=' + name, { method: 'POST', body });
        if (!res.ok) throw new Error('Upload failed for ' + name);
      };
      await post('designed', deltaBytes);
      await post('kit', kitBytes);

      const p = JSON.parse(patchDirect);
      return JSON.stringify({
        deltaBytes: deltaBytes.length,
        kitBytes: kitBytes.length,
        coastPngBytes: upgradedPng.size,
        encounters: p.encounters?.length ?? 0,
        changes: p.changes.length,
        elevations: p.elevations.length,
        decorations: p.decorations.length,
        props: p.props.length,
        atlas: p.atlas ? { pixels: p.atlas.pixels, columns: p.atlas.columns, count: p.atlas.count } : null,
      });
    })()`,
  );
  console.log("AK_PROJECT_BAKED", result);
}

async function cmdRebase(argv) {
  const positional = argv.filter(a => !a.startsWith("--"));
  if (positional.length < 2) {
    console.error("Usage: node scripts/ak-project.mjs rebase <in.bptilemap> <out.bptilemap> [--baseline=...] [--old-baseline=...] [--delta]");
    process.exit(2);
  }
  const inputPath = path.resolve(positional[0]);
  const outputPath = path.resolve(positional[1]);
  const getOpt = prefix => argv.find(a => a.startsWith(prefix))?.slice(prefix.length);
  const baselinePath = path.resolve(getOpt("--baseline=") || path.join(studioDir, "public/sample/ak-world.bptilemap"));
  const oldBaselineOpt = getOpt("--old-baseline=");
  const oldBaselinePath = oldBaselineOpt ? path.resolve(oldBaselineOpt) : "";
  const writeDelta = argv.includes("--delta");

  const files = { input: inputPath, baseline: baselinePath };
  if (oldBaselinePath) files.oldBaseline = oldBaselinePath;

  const result = await runInStudioBrowser(
    files,
    { output: outputPath },
    (origin, ioUrl) => `(async () => {
      const { decodeProject, encodeProject } = await import(${JSON.stringify(origin)} + '/src/tilemap/files.ts');
      const { packDeltaProject, rebaseWorldSnapshot } = await import(${JSON.stringify(origin)} + '/src/tilemap/worldRebase.ts');
      const fetchBytes = async name => new Uint8Array(await (await fetch(${JSON.stringify(ioUrl)} + '/?name=' + name)).arrayBuffer());
      const input = await decodeProject(await fetchBytes('input'));
      const newBase = await decodeProject(await fetchBytes('baseline'));
      const oldBase = ${JSON.stringify(Boolean(oldBaselinePath))} ? await decodeProject(await fetchBytes('oldBaseline')) : undefined;
      const { map, report } = rebaseWorldSnapshot(input, newBase, oldBase);
      const outDoc = ${JSON.stringify(writeDelta)} ? packDeltaProject(map, newBase) : map;
      const outBytes = await encodeProject(outDoc);
      await decodeProject(outBytes);
      const res = await fetch(${JSON.stringify(ioUrl)} + '/?name=output', { method: 'POST', body: outBytes });
      if (!res.ok) throw new Error('Failed writing output');
      return JSON.stringify({ bytes: outBytes.length, delta: ${JSON.stringify(writeDelta)}, report });
    })()`,
  );
  console.log("AK_PROJECT_REBASED", result);
}

async function cmdPackDelta(argv) {
  const positional = argv.filter(a => !a.startsWith("--"));
  if (positional.length < 2) {
    console.error("Usage: node scripts/ak-project.mjs pack-delta <full.bptilemap> <delta.bptilemap> [--baseline=...]");
    process.exit(2);
  }
  const inputPath = path.resolve(positional[0]);
  const outputPath = path.resolve(positional[1]);
  const baselineOpt = argv.find(a => a.startsWith("--baseline="))?.slice("--baseline=".length);
  const baselinePath = path.resolve(baselineOpt || path.join(studioDir, "public/sample/ak-world.bptilemap"));

  const result = await runInStudioBrowser(
    { input: inputPath, baseline: baselinePath },
    { output: outputPath },
    (origin, ioUrl) => `(async () => {
      const { decodeProject, encodeProject } = await import(${JSON.stringify(origin)} + '/src/tilemap/files.ts');
      const { packDeltaProject, materializeDeltaProject } = await import(${JSON.stringify(origin)} + '/src/tilemap/worldRebase.ts');
      const fetchBytes = async name => new Uint8Array(await (await fetch(${JSON.stringify(ioUrl)} + '/?name=' + name)).arrayBuffer());
      const raw = await fetchBytes('input');
      const input = await decodeProject(raw);
      const base = await decodeProject(await fetchBytes('baseline'));
      const full = input.world?.delta ? materializeDeltaProject(input, base) : input;
      const delta = packDeltaProject(full, base);
      const outBytes = await encodeProject(delta);
      await decodeProject(outBytes);
      const res = await fetch(${JSON.stringify(ioUrl)} + '/?name=output', { method: 'POST', body: outBytes });
      if (!res.ok) throw new Error('Failed writing delta output');
      return JSON.stringify({ inputBytes: raw.length, outputBytes: outBytes.length });
    })()`,
  );
  console.log("AK_PROJECT_DELTA_PACKED", result);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "bake") cmdBake().catch(err => { console.error(err); process.exit(1); });
else if (cmd === "rebase") cmdRebase(rest).catch(err => { console.error(err); process.exit(1); });
else if (cmd === "pack-delta") cmdPackDelta(rest).catch(err => { console.error(err); process.exit(1); });
else {
  console.error("Usage: node scripts/ak-project.mjs <bake | rebase | pack-delta> [args...]");
  process.exit(2);
}
