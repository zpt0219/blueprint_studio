// download.ts — trigger a client-side file download (no server).

/** Download `obj` as a pretty-printed JSON file named `filename`. */
export function downloadJson(filename: string, obj: unknown): void {
  downloadBlob(filename, new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
