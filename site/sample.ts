// A synthetic orbit rendered here with three.js: textured objects on a
// textured ground, seen by a camera circling them. Something to try the
// pipeline on without any file.

import * as THREE from "three";
import type { Frame } from "./frames.ts";

/** Seeded pseudo-random numbers, so every visitor gets the same scene. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** A busy texture (blotches, lines, dots) that gives SIFT plenty to find. */
function texture(seed: number, hue: number) {
  const r = rng(seed);
  const size = 512;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = `hsl(${hue}, 35%, 45%)`;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `hsla(${(hue + r() * 120 - 60 + 360) % 360}, ${40 + r() * 50}%, ${20 + r() * 65}%, ${0.5 + r() * 0.5})`;
    const x = r() * size, y = r() * size, s = 4 + r() * 38;
    if (r() < 0.5) g.fillRect(x, y, s, s * (0.3 + r()));
    else {
      g.beginPath();
      g.arc(x, y, s / 2, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.lineWidth = 2;
  for (let i = 0; i < 60; i++) {
    g.strokeStyle = `hsla(${r() * 360}, 60%, ${r() < 0.5 ? 15 : 85}%, 0.8)`;
    g.beginPath();
    g.moveTo(r() * size, r() * size);
    g.lineTo(r() * size, r() * size);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export async function sampleOrbit(count: number, width: number, height: number, progress: (done: number, total: number) => void): Promise<Frame[]> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1f27);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(4, 8, 3);
  scene.add(sun);

  const mat = (seed: number, hue: number) => new THREE.MeshStandardMaterial({ map: texture(seed, hue), roughness: 0.85 });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(5, 64), mat(1, 30));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.75, 0.28, 220, 32), mat(2, 200));
  knot.position.set(0, 1.25, 0);
  scene.add(knot);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat(3, 120));
  box.position.set(1.8, 0.5, 0.6);
  box.rotation.y = 0.5;
  scene.add(box);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.6, 48, 32), mat(4, 300));
  ball.position.set(-1.5, 0.6, -0.9);
  scene.add(ball);
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.8, 40), mat(5, 50));
  pillar.position.set(-0.4, 0.9, 1.7);
  scene.add(pillar);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height, false);
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
  const frames: Frame[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      camera.position.set(5.2 * Math.cos(a), 2.4 + 0.3 * Math.sin(2 * a), 5.2 * Math.sin(a));
      camera.lookAt(0, 0.8, 0);
      renderer.render(scene, camera);
      const data = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.92));
      const t = document.createElement("canvas");
      t.width = 96;
      t.height = Math.round((96 * height) / width);
      t.getContext("2d")!.drawImage(canvas, 0, 0, t.width, t.height);
      frames.push({ name: `${String(i).padStart(5, "0")}.jpg`, data, thumb: t.toDataURL("image/jpeg", 0.7) });
      progress(i + 1, count);
    }
  } finally {
    renderer.dispose();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const material = m.material as THREE.MeshStandardMaterial | undefined;
      material?.map?.dispose();
      material?.dispose();
    });
  }
  return frames;
}
