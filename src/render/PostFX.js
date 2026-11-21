import * as THREE from 'three';
import { CONFIG } from '../config.js';

// Stylized renderer: dithered lighting + outlines.
//
// For both the world and the first-person gun it renders:
//   1. a normal lit pass   -> brightness, which gets ordered-dithered
//   2. an "info" pass      -> view normals (rgb) + outline brightness (a)
// A full-screen shader then draws outlines where depth jumps or normals
// change, and dithers everything else. Give any mesh an outline with
// `mesh.userData.outline = 0..1`. Meshes without it still show up dithered
// but never get outlines (tracers, flashes, particles).

const infoMaterials = new Map();
function infoMaterial(outline) {
  if (!infoMaterials.has(outline)) {
    infoMaterials.set(
      outline,
      new THREE.ShaderMaterial({
        uniforms: { outline: { value: outline } },
        vertexShader: /* glsl */ `
          varying vec3 vN;
          void main() {
            vN = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float outline;
          varying vec3 vN;
          void main() { gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, outline); }`,
      }),
    );
  }
  return infoMaterials.get(outline);
}

function makeTarget(depthTexture) {
  const t = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  if (depthTexture) t.depthTexture = new THREE.DepthTexture(1, 1);
  return t;
}

const compositeShader = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tWorld, tWorldDepth, tWorldInfo;
    uniform sampler2D tView, tViewDepth, tViewInfo;
    uniform vec2 resolution, worldClip, viewClip;
    uniform float depthEdge, normalEdge, ditherLevels, ditherGain;
    varying vec2 vUv;

    // 1 / linear depth: affine across flat surfaces, so its 2nd derivative
    // is ~0 everywhere except real depth discontinuities.
    float invDepth(sampler2D d, vec2 uv, vec2 clip) {
      float z = texture2D(d, uv).x;
      return (clip.y - z * (clip.y - clip.x)) / (clip.x * clip.y);
    }
    vec3 nrm(vec4 i) { return normalize(i.xyz * 2.0 - 1.0); }

    // Outline brightness at this pixel, or -1 if it's not on an edge.
    float edge(sampler2D dTex, sampler2D iTex, vec2 uv, vec2 clip) {
      vec2 px = 1.0 / resolution;
      vec2 dx = vec2(px.x, 0.0), dy = vec2(0.0, px.y);
      float wc = invDepth(dTex, uv, clip);
      float wl = invDepth(dTex, uv - dx, clip), wr = invDepth(dTex, uv + dx, clip);
      float wd = invDepth(dTex, uv - dy, clip), wu = invDepth(dTex, uv + dy, clip);
      vec4 ic = texture2D(iTex, uv);
      vec4 il = texture2D(iTex, uv - dx), ir = texture2D(iTex, uv + dx);
      vec4 id = texture2D(iTex, uv - dy), iu = texture2D(iTex, uv + dy);
      float result = -1.0;

      // Silhouette: this pixel is behind a neighbour. Draw the outline here
      // (just outside the object) in the nearest neighbour's outline colour.
      if (wl + wr - 2.0 * wc > depthEdge * wc || wd + wu - 2.0 * wc > depthEdge * wc) {
        float best = wl; float o = il.a;
        if (wr > best) { best = wr; o = ir.a; }
        if (wd > best) { best = wd; o = id.a; }
        if (wu > best) { best = wu; o = iu.a; }
        result = o;
      }
      // Crease: surface normal changes to the right or above (1px lines).
      if (ic.a > 0.0) {
        vec3 nc = nrm(ic);
        if ((ir.a > 0.0 && dot(nc, nrm(ir)) < normalEdge) || (iu.a > 0.0 && dot(nc, nrm(iu)) < normalEdge)) {
          result = max(result, max(ic.a, max(ir.a, iu.a)));
        }
      }
      return result;
    }

    float bayer(vec2 p) {
      const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0,
                                    3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
      int i = int(mod(p.x, 4.0)) + int(mod(p.y, 4.0)) * 4;
      return (m[i] + 0.5) / 16.0;
    }

    float dither(vec3 c, vec2 pix) {
      // Linear brightness (no gamma lift) so shadowed areas fall to black.
      float l = clamp(dot(c, vec3(0.299, 0.587, 0.114)) * ditherGain, 0.0, 1.0);
      return min(1.0, floor(l * ditherLevels + bayer(pix)) / ditherLevels);
    }

    void main() {
      vec2 pix = floor(vUv * resolution);
      vec2 uv = (pix + 0.5) / resolution;
      float v;
      float ve = edge(tViewDepth, tViewInfo, uv, viewClip);
      if (ve > 0.0) {
        v = ve;
      } else if (texture2D(tViewDepth, uv).x < 1.0) {
        v = dither(texture2D(tView, uv).rgb, pix);
      } else {
        float we = edge(tWorldDepth, tWorldInfo, uv, worldClip);
        v = we > 0.0 ? we : dither(texture2D(tWorld, uv).rgb, pix);
      }
      gl_FragColor = vec4(vec3(v), 1.0);
    }`,
};

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    this.targets = {
      world: makeTarget(true),
      worldInfo: makeTarget(false),
      view: makeTarget(true),
      viewInfo: makeTarget(false),
    };
    const T = this.targets;
    const r = CONFIG.render;
    this.material = new THREE.ShaderMaterial({
      ...compositeShader,
      uniforms: {
        tWorld: { value: T.world.texture },
        tWorldDepth: { value: T.world.depthTexture },
        tWorldInfo: { value: T.worldInfo.texture },
        tView: { value: T.view.texture },
        tViewDepth: { value: T.view.depthTexture },
        tViewInfo: { value: T.viewInfo.texture },
        resolution: { value: new THREE.Vector2(1, 1) },
        worldClip: { value: new THREE.Vector2(0.1, 100) },
        viewClip: { value: new THREE.Vector2(0.01, 10) },
        depthEdge: { value: r.depthEdge },
        normalEdge: { value: r.normalEdge },
        ditherLevels: { value: r.ditherLevels },
        ditherGain: { value: r.ditherGain },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.postScene = new THREE.Scene();
    this.postScene.add(quad);
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  setSize(width, height) {
    const s = CONFIG.render.pixelScale;
    const w = Math.max(1, Math.floor(width * s));
    const h = Math.max(1, Math.floor(height * s));
    for (const t of Object.values(this.targets)) t.setSize(w, h);
    this.material.uniforms.resolution.value.set(w, h);
  }

  render(scene, camera, viewScene, viewCamera) {
    const r = this.renderer;
    const T = this.targets;
    const u = this.material.uniforms;
    u.worldClip.value.set(camera.near, camera.far);
    u.viewClip.value.set(viewCamera.near, viewCamera.far);

    r.setClearColor(0x000000, 1);
    r.setRenderTarget(T.world);
    r.clear();
    r.render(scene, camera);
    r.setRenderTarget(T.view);
    r.clear();
    r.render(viewScene, viewCamera);

    // Info passes reuse the shadow maps from the lit pass.
    const autoShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.setClearColor(0x000000, 0);
    this.renderInfo(scene, camera, T.worldInfo);
    this.renderInfo(viewScene, viewCamera, T.viewInfo);
    r.shadowMap.autoUpdate = autoShadow;

    r.setClearColor(0x000000, 1);
    r.setRenderTarget(null);
    r.clear();
    r.render(this.postScene, this.postCamera);
  }

  renderInfo(scene, camera, target) {
    const swapped = [];
    const hidden = [];
    scene.traverseVisible((o) => {
      if (!(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return;
      if (o.isMesh && o.userData.outline != null) swapped.push(o, o.material);
      else hidden.push(o);
    });
    for (let i = 0; i < swapped.length; i += 2) swapped[i].material = infoMaterial(swapped[i].userData.outline);
    for (const o of hidden) o.visible = false;
    const { background, fog } = scene;
    scene.background = null;
    scene.fog = null;

    const r = this.renderer;
    r.setRenderTarget(target);
    r.clear();
    r.render(scene, camera);

    scene.background = background;
    scene.fog = fog;
    for (let i = 0; i < swapped.length; i += 2) swapped[i].material = swapped[i + 1];
    for (const o of hidden) o.visible = true;
  }
}
