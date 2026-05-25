import type { AssetManifest } from "@tranzmit/shared";

export async function preloadAssets(manifest: AssetManifest): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (manifest.images) {
    for (const url of Object.values(manifest.images)) {
      tasks.push(preloadImage(url));
    }
  }

  if (manifest.fonts) {
    for (const url of manifest.fonts) {
      tasks.push(preloadFont(url));
    }
  }

  await Promise.allSettled(tasks);
}

function preloadImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
  });
}

function preloadFont(url: string): Promise<void> {
  if (!document.fonts || !window.FontFace) {
    return preloadViaLink(url);
  }
  return fetch(url, { credentials: "omit" })
    .then((r) => r.arrayBuffer())
    .then((buf) => {
      const face = new FontFace("tranzmit-preload", `url(${url})`, {});
      return face.load().then(() => {
        document.fonts.add(face);
      });
    })
    .catch(() => {});
}

function preloadViaLink(url: string): Promise<void> {
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "font";
    link.href = url;
    link.crossOrigin = "anonymous";
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
}
