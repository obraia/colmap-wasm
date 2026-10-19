// three.js view of a reconstruction: the sparse points in their colours and a
// frustum per registered camera, coloured along the sequence.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Reconstruction } from "../dist/index.js";

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  private controls: OrbitControls;
  private content = new THREE.Group();

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.scene.background = new THREE.Color(0x0e1217);
    this.scene.add(this.content);
    const grid = new THREE.GridHelper(12, 24, 0x2a3440, 0x1a222c);
    grid.position.y = -1.6;
    this.scene.add(grid);
    this.camera.position.set(0, 6.5, 8.5);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.8;
    this.controls.addEventListener("start", () => (this.controls.autoRotate = false));
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  private resize() {
    const el = this.canvas.parentElement!;
    const w = el.clientWidth, h = el.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  show(rec: Reconstruction) {
    for (const c of [...this.content.children]) {
      this.content.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    const cams = rec.images.filter((im) => im.registered && im.R && im.t);
    if (!cams.length) return;
    // camera centres, viewing directions and "up" (COLMAP: y points down)
    const centres = cams.map((im) => {
      const R = im.R!, t = im.t!;
      return new THREE.Vector3(
        -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
        -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
        -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
      );
    });
    const up = new THREE.Vector3();
    for (const im of cams) up.add(new THREE.Vector3(-im.R![3], -im.R![4], -im.R![5]));
    up.normalize();
    // the point cloud's centre (median) and the cameras' spread give the scale
    const med = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
    const centre = rec.points.length
      ? new THREE.Vector3(med(rec.points.map((p) => p.xyz[0])), med(rec.points.map((p) => p.xyz[1])), med(rec.points.map((p) => p.xyz[2])))
      : centres.reduce((s, c) => s.add(c), new THREE.Vector3()).divideScalar(centres.length);
    const spread = centres.reduce((s, c) => s + c.distanceTo(centre), 0) / centres.length || 1;
    const k = 4 / spread;
    const align = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
    const place = (v: THREE.Vector3) => v.clone().sub(centre).multiplyScalar(k).applyQuaternion(align);

    // points (outliers far from the cameras are dropped from the view)
    const pos: number[] = [], col: number[] = [];
    for (const p of rec.points) {
      const v = place(new THREE.Vector3(...p.xyz));
      if (v.length() > 12) continue;
      pos.push(v.x, v.y, v.z);
      col.push(p.color[0] / 255, p.color[1] / 255, p.color[2] / 255);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const colors = new THREE.Float32BufferAttribute(col, 3);
    pg.setAttribute("color", colors);
    const pointsMaterial = new THREE.PointsMaterial({ size: 0.045, vertexColors: true, sizeAttenuation: true });
    this.content.add(new THREE.Points(pg, pointsMaterial));

    // frustums: apex at the centre, image corners one unit ahead
    const { width: w, height: h, focal: f } = rec.camera;
    const corners = [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ].map(([x, y]) => new THREE.Vector3(x / f, y / f, 1));
    const lines: number[] = [], lineCol: number[] = [];
    const depth = 0.35;
    cams.forEach((im, n) => {
      const R = im.R!;
      const toWorld = (d: THREE.Vector3) =>
        new THREE.Vector3(R[0] * d.x + R[3] * d.y + R[6] * d.z, R[1] * d.x + R[4] * d.y + R[7] * d.z, R[2] * d.x + R[5] * d.y + R[8] * d.z);
      const apex = place(centres[n]);
      const ends = corners.map((c) => apex.clone().add(toWorld(c).applyQuaternion(align).multiplyScalar(depth)));
      const color = new THREE.Color().setHSL((n / cams.length) * 0.8, 0.75, 0.6);
      const seg = (a: THREE.Vector3, b: THREE.Vector3) => {
        lines.push(a.x, a.y, a.z, b.x, b.y, b.z);
        lineCol.push(color.r, color.g, color.b, color.r, color.g, color.b);
      };
      for (let i = 0; i < 4; i++) {
        seg(apex, ends[i]);
        seg(ends[i], ends[(i + 1) % 4]);
      }
    });
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
    lg.setAttribute("color", new THREE.Float32BufferAttribute(lineCol, 3));
    this.content.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true })));
    this.controls.autoRotate = true;
  }
}
