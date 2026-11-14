import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";

const root = createRoot(document.getElementById("root")!);

function render(Editor: ComponentType) {
  root.render(<StrictMode><Editor /></StrictMode>);
}

const params = new URLSearchParams(window.location.search);
if (params.get("editor") === "legacy") {
  void import("./App").then(module => render(module.default));
} else {
  void import("./tilemap/TilemapEditor").then(module => render(module.default));
}
