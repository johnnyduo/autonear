import React from 'react';
import { useCurrentFrame } from 'remotion';
import { ThreeCanvas } from '@remotion/three';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { FPS, H, W } from '../theme';
import { FLOOR_Y, IDEAS, PILLAR_R, pillarAngle, pillarHeight, stageAt } from './stage';

/* Persistent 3D world: one particle field that morphs between layouts + one liquid-metal hero that morphs between solids.
   Everything is a pure function of the global frame, so renders are deterministic. */
const N = 7000;
const rng = (() => { let a = 1337; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const PT = (() => {
  const f = (n: number) => new Float32Array(N * n);
  const cloud = f(3), dir = f(3), lane = f(4), ring = f(3), pill = f(4), cube = f(3), seed = f(1), tier = f(1);
  for (let i = 0; i < N; i++) {
    const u = rng(), v = rng(), w = rng(); const th = u * 6.2832, ph = Math.acos(2 * v - 1), r = Math.cbrt(w);
    cloud.set([r * Math.sin(ph) * Math.cos(th) * 9, r * Math.cos(ph) * 4.6, r * Math.sin(ph) * Math.sin(th) * 6.5], i * 3);
    const y = 1 - ((i + 0.5) / N) * 2, rr = Math.sqrt(1 - y * y), a = i * 2.399963;
    dir.set([rr * Math.cos(a), y, rr * Math.sin(a)], i * 3);
    lane.set([rng() * 18, (rng() - 0.5) * 5.4, (rng() - 0.5) * 8, 0.7 + rng() * 0.8], i * 4);
    ring.set([rng() * 6.2832, (rng() - 0.5) * 2, (rng() - 0.5)], i * 3);
    pill.set([i % 7, rng(), rng() * 6.2832, Math.sqrt(rng()) * 0.26], i * 4);
    const face = Math.floor(rng() * 6), s1 = rng() * 2 - 1, s2 = rng() * 2 - 1, sg = face % 2 ? -1 : 1, ax = face >> 1;
    const c3 = [0, 0, 0]; c3[ax] = sg; c3[(ax + 1) % 3] = s1; c3[(ax + 2) % 3] = s2; cube.set(c3, i * 3);
    seed[i] = rng(); const tr = rng(); tier[i] = tr < 0.6 ? 0 : tr < 0.88 ? 1 : tr < 0.98 ? 2 : 3;
  }
  return { cloud, dir, lane, ring, pill, cube, seed, tier };
})();
const SIZES = [0.035, 0.055, 0.09, 0.17];
const CY = new THREE.Color('#26e6ff'), MG = new THREE.Color('#ff38c8'), VI = new THREE.Color('#8f52ff'), LI = new THREE.Color('#c6f432'), OR = new THREE.Color('#ff6a3d'), WH = new THREE.Color('#ffffff');

const vert = `attribute float aSize; attribute vec3 aColor; varying vec3 vC; varying float vF; uniform float uScale; uniform float uFloor; uniform float uMir;
void main(){ vec4 wp = modelMatrix*vec4(position,1.); vec4 mv = viewMatrix*wp; gl_PointSize = max(1.5, aSize*uScale/-mv.z); vC=aColor; vF = uMir>0.5 ? exp(-abs(position.y-uFloor)*0.22) : 1.; gl_Position = projectionMatrix*mv; }`;
const frag = `varying vec3 vC; varying float vF; uniform float uAlpha; void main(){ float d=length(gl_PointCoord-.5); float a=smoothstep(.5,.0,d); a=a*a*(1.+ 2.*smoothstep(.25,.0,d)); gl_FragColor=vec4(vC*(1.+smoothstep(.18,.0,d)), a*uAlpha*vF); }`;

const World: React.FC = () => {
  const frame = useCurrentFrame();
  const tg = frame / FPS;
  const st = stageAt(tg);
  const { gl, scene, camera } = (require('@react-three/fiber') as typeof import('@react-three/fiber')).useThree();

  const geo = React.useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(N), 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return g;
  }, []);
  const hGeo = React.useMemo(() => new THREE.SphereGeometry(1, 120, 80), []);
  const hBase = React.useMemo(() => Float32Array.from(hGeo.attributes.position.array as Float32Array), [hGeo]);
  const mats = React.useMemo(() => {
    const mk = (mir: number) => new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uScale: { value: 500 }, uFloor: { value: FLOOR_Y }, uMir: { value: mir }, uAlpha: { value: 1 } } });
    return [mk(0), mk(1)];
  }, []);
  const heroMat = React.useMemo(() => new THREE.MeshPhysicalMaterial({ color: '#0a1c26', metalness: 1, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.08, iridescence: 1, iridescenceIOR: 1.6, envMapIntensity: 1.1, transparent: true }), []);
  const shockMat = React.useMemo(() => new THREE.MeshBasicMaterial({ color: '#c6f432', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), []);
  const floorTex = React.useMemo(() => {
    const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d')!;
    const g = x.createRadialGradient(128, 128, 0, 128, 128, 128); g.addColorStop(0, 'rgba(60,120,160,0.55)'); g.addColorStop(0.45, 'rgba(20,40,70,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256); return new THREE.CanvasTexture(c);
  }, []);
  React.useEffect(() => {
    const pm = new THREE.PMREMGenerator(gl); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; scene.fog = new THREE.Fog('#05070b', 14, 34);
    return () => { pm.dispose(); };
  }, [gl, scene]);

  React.useLayoutEffect(() => {
    // ----- camera
    const sh = st.shake * 0.12; const sx = Math.sin(tg * 61) * sh, sy = Math.cos(tg * 53) * sh;
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = st.fov; cam.aspect = W / H;
    cam.position.set(st.lx + st.dist * Math.cos(st.el) * Math.sin(st.az) + sx, st.ly + st.dist * Math.sin(st.el) + sy, st.lz + st.dist * Math.cos(st.el) * Math.cos(st.az));
    cam.lookAt(st.lx, st.ly, st.lz); cam.updateProjectionMatrix();
    // ----- particles
    const pos = geo.attributes.position.array as Float32Array, col = geo.attributes.aColor.array as Float32Array, siz = geo.attributes.aSize.array as Float32Array;
    const wsum = st.wCloud + st.wSphere + st.wField + st.wRing + st.wPillar + st.wCube || 1;
    const wc = st.wCloud / wsum, ws = st.wSphere / wsum, wf = st.wField / wsum, wr = st.wRing / wsum, wp = st.wPillar / wsum, wb = st.wCube / wsum;
    const yaw = tg * 0.18, cy = Math.cos(yaw), sy2 = Math.sin(yaw);
    const c = new THREE.Color(); const flash = st.flash;
    for (let i = 0; i < N; i++) {
      let x = 0, y = 0, z = 0; const sd = PT.seed[i];
      if (wc > 0.001) { x += wc * (PT.cloud[i * 3] + Math.sin(tg * 0.3 + sd * 20) * 0.5); y += wc * (PT.cloud[i * 3 + 1] + Math.cos(tg * 0.25 + sd * 17) * 0.4); z += wc * (PT.cloud[i * 3 + 2] + Math.sin(tg * 0.2 + sd * 9) * 0.5); }
      if (ws > 0.001) { const dx = PT.dir[i * 3], dy = PT.dir[i * 3 + 1], dz = PT.dir[i * 3 + 2]; const r = st.sphR * (1 + 0.05 * Math.sin(tg * 1.5 + sd * 30) + (PT.tier[i] === 3 ? 0.12 : 0)); x += ws * (cy * dx + sy2 * dz) * r; y += ws * dy * r; z += ws * (-sy2 * dx + cy * dz) * r; }
      if (wf > 0.001) { const fx = ((PT.lane[i * 4] + st.phase * PT.lane[i * 4 + 3]) % 18) - 9; x += wf * fx; y += wf * (PT.lane[i * 4 + 1] + 0.3 * Math.sin(fx * 0.7 + tg + sd * 9)); z += wf * PT.lane[i * 4 + 2]; }
      if (wr > 0.001) { const a = PT.ring[i * 3] + tg * 0.12 * (1 + sd), rr = st.ringR + PT.ring[i * 3 + 1] * (0.5 + st.ringR * 0.12); x += wr * Math.cos(a) * rr; y += wr * (PT.ring[i * 3 + 2] * 0.5 + 0.12 * Math.sin(a * 3 + tg)); z += wr * Math.sin(a) * rr; }
      if (wp > 0.001) { const cc = PT.pill[i * 4]; const ang = pillarAngle(cc), h = pillarHeight(cc) * st.pGrow; x += wp * (Math.cos(ang) * PILLAR_R + Math.cos(PT.pill[i * 4 + 2]) * PT.pill[i * 4 + 3]); y += wp * (FLOOR_Y + 0.05 + PT.pill[i * 4 + 1] * h); z += wp * (Math.sin(ang) * PILLAR_R + Math.sin(PT.pill[i * 4 + 2]) * PT.pill[i * 4 + 3]); }
      if (wb > 0.001) { const k = st.cubeS * (1 + 0.012 * Math.sin(tg * 2 + sd * 40)); const bx = PT.cube[i * 3] * k, by = PT.cube[i * 3 + 1] * k, bz = PT.cube[i * 3 + 2] * k; x += wb * (cy * bx + sy2 * bz); y += wb * by; z += wb * (-sy2 * bx + cy * bz); }
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      // colour: cyan -> magenta -> violet by height/seed; lime (go / approved), orange (refusal)
      const h = (sd * 0.6 + (y + 4) * 0.07 + tg * 0.02) % 1; if (h < 0.5) c.copy(CY).lerp(VI, h * 2); else c.copy(VI).lerp(MG, (h - 0.5) * 2);
      let lime = st.tint; if (wp > 0.5 && PT.pill[i * 4] === 0) lime = Math.max(lime, 0.95 * st.pGrow);
      if (lime > 0) c.lerp(LI, lime * (0.5 + 0.5 * (PT.tier[i] / 3)));
      if (st.warn > 0.01) c.lerp(OR, st.warn * 0.85);
      if (flash > 0.01) c.lerp(WH, flash * 0.6);
      const b = 0.55 + 0.45 * Math.sin(tg * 2 + sd * 40);
      col[i * 3] = c.r * b; col[i * 3 + 1] = c.g * b; col[i * 3 + 2] = c.b * b;
      siz[i] = SIZES[PT.tier[i]] * st.pSize * (1 + flash * 0.8);
    }
    geo.attributes.position.needsUpdate = true; geo.attributes.aColor.needsUpdate = true; geo.attributes.aSize.needsUpdate = true;
    const scale = H / (2 * Math.tan((st.fov * Math.PI) / 360));
    mats[0].uniforms.uScale.value = scale; mats[1].uniforms.uScale.value = scale;
    mats[0].uniforms.uAlpha.value = st.pVis; mats[1].uniforms.uAlpha.value = st.pVis * 0.42 * st.mirror;
    // ----- hero: superellipsoid + noise, recomputed per frame
    const hp = hGeo.attributes.position.array as Float32Array;
    const n = st.hn, amp = st.hnoise, ht = tg * 1.1;
    for (let i = 0; i < hp.length; i += 3) {
      const dx = hBase[i], dy = hBase[i + 1], dz = hBase[i + 2];
      const r = n <= 2.01 ? 1 : 1 / Math.pow(Math.pow(Math.abs(dx), n) + Math.pow(Math.abs(dy), n) + Math.pow(Math.abs(dz), n), 1 / n);
      const nz = Math.sin(dx * 2.6 + ht) * Math.sin(dy * 2.3 - ht * 0.8) * Math.sin(dz * 2.9 + ht * 1.2) + 0.5 * Math.sin(dx * 5.5 - ht * 1.7 + dy * 3);
      const q = r * (1 + amp * nz);
      hp[i] = dx * q; hp[i + 1] = dy * q; hp[i + 2] = dz * q;
    }
    hGeo.attributes.position.needsUpdate = true; hGeo.computeVertexNormals();
    heroMat.opacity = Math.min(1, st.hVis); heroMat.color.copy(new THREE.Color('#0b1d28')).lerp(new THREE.Color('#2a3d05'), st.tint * 0.8).lerp(new THREE.Color('#3a1208'), st.warn * 0.9);
    heroMat.emissive.copy(LI).multiplyScalar(st.tint * 0.12 + st.flash * 0.1);
    shockMat.opacity = Math.min(0.9, st.shock * 0.9);
    gl.render(scene, camera);
  });

  const heroVisible = st.hVis > 0.01;
  const hs = Math.max(0.0001, st.hs);
  return (
    <>
      <pointLight position={[6, 4, 5]} color="#26e6ff" intensity={60} distance={30} />
      <pointLight position={[-6, -1, 4]} color="#ff38c8" intensity={55} distance={30} />
      <pointLight position={[0, 6, -4]} color="#8f52ff" intensity={40} distance={30} />
      <points geometry={geo} material={mats[0]} frustumCulled={false} />
      <group position={[0, FLOOR_Y * 2, 0]} scale={[1, -1, 1]} visible={st.mirror > 0.01}>
        <points geometry={geo} material={mats[1]} frustumCulled={false} />
      </group>
      {heroVisible && (
        <group position={[st.hx, st.hy, st.hz]} rotation={[0.2, tg * st.hspin, 0]} scale={[hs, hs, hs]}>
          <mesh geometry={hGeo} material={heroMat} />
        </group>
      )}
      {heroVisible && st.mirror > 0.01 && (
        <group position={[st.hx, FLOOR_Y * 2 - st.hy, st.hz]} rotation={[-0.2, tg * st.hspin, 0]} scale={[hs, -hs, hs]}>
          <mesh geometry={hGeo} material={heroMat} />
        </group>
      )}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y, 0]} visible={st.mirror > 0.01}>
        <planeGeometry args={[40, 40]} /><meshBasicMaterial map={floorTex} transparent opacity={0.9 * st.mirror} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[st.hx, st.hy, st.hz]} visible={st.shock > 0.01} material={shockMat} scale={[1 + (1 - st.shock) * 7, 1 + (1 - st.shock) * 7, 1]}>
        <ringGeometry args={[1.0, 1.06, 128]} />
      </mesh>
    </>
  );
};

export const WorldLayer: React.FC = () => (
  <ThreeCanvas width={W} height={H} style={{ position: 'absolute', inset: 0 }} camera={{ fov: 38, near: 0.1, far: 80, position: [0, 0, 11] }} gl={{ antialias: true, alpha: true }}>
    <World />
  </ThreeCanvas>
);
