import { useState } from "react";
import RerollEditor from "./reroll/RerollEditor";
import AssetTagger from "./tagger/AssetTagger";
import "./reroll/reroll.css";
import "./tagger/tagger.css";
import "./styles.css";

type ActiveTab = "reroll" | "tagger";

export default function App() {
  const [tab, setTab] = useState<ActiveTab>("reroll");

  return (
    <div className="studio-container">
      <header className="studio-header">
        <div className="studio-brand">
          <span className="studio-logo">🗺️</span>
          <span className="studio-title">Blueprint Studio</span>
          <span className="studio-tag">v0.1.0</span>
        </div>

        <nav className="studio-tabs">
          <button
            type="button"
            className={`studio-tab-btn ${tab === "reroll" ? "active" : ""}`}
            onClick={() => setTab("reroll")}
          >
            <span>🗺️</span>
            <span>地图编辑 (Reroll)</span>
          </button>
          <button
            type="button"
            className={`studio-tab-btn ${tab === "tagger" ? "active" : ""}`}
            onClick={() => setTab("tagger")}
          >
            <span>🏷️</span>
            <span>资源标注 (Tagger)</span>
          </button>
        </nav>

        <div className="studio-meta">
          <span>Adna TileMap Toolchain</span>
        </div>
      </header>

      <main className="studio-body">
        <div className={`studio-pane ${tab === "reroll" ? "" : "hidden"}`}>
          <RerollEditor />
        </div>
        <div className={`studio-pane ${tab === "tagger" ? "" : "hidden"}`}>
          <AssetTagger />
        </div>
      </main>
    </div>
  );
}
