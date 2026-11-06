// WebGL2 renderer: instanced additive glow sprites + additive lines into an HDR target, a 3-level separable bloom, tone-mapped composite.
// It draws what scene.js hands over (flat typed arrays). If anything fails (no WebGL2, shader error, context loss) the caller falls back to render-2d.js.
import { LSTRIDE, PSTRIDE } from './scene.js';

const VS_P = `#version 300 es
layout(location=0) in vec2 i_pos; layout(location=1) in float i_size; layout(location=2) in vec3 i_col; layout(location=3) in float i_a; layout(location=4) in float i_blur;
uniform vec2 u_res; out vec2 v_uv; out vec3 v_col; out float v_a; out float v_blur;
void main(){
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec2 p = i_pos + c * i_size * 0.5;
  gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0);
  v_uv = c; v_col = i_col; v_a = i_a; v_blur = i_blur;
}`;
const FS_P = `#version 300 es
precision highp float; in vec2 v_uv; in vec3 v_col; in float v_a; in float v_blur; out vec4 o;
void main(){
  if (v_blur < -0.5) { float m = max(abs(v_uv.x), abs(v_uv.y)); float sq = 1.0 - smoothstep(0.52, 0.64, m); o = vec4(v_col * v_a * sq, 1.0); return; }
  float d = length(v_uv); if (d > 1.0) discard;
  float halo = pow(1.0 - d, 2.4);
  float coreR = mix(0.2, 0.06, v_blur);
  float core = 1.0 - smoothstep(coreR * 0.55, coreR, d);
  float bokeh = v_blur * smoothstep(1.0, 0.6, d) * 0.22;
  vec3 hot = mix(v_col, vec3(1.0), 0.7);
  vec3 c = v_col * (halo * 0.62 + bokeh) + hot * core * (1.0 - v_blur * 0.65);
  o = vec4(c * v_a, 1.0);
}`;
const VS_L = `#version 300 es
layout(location=0) in vec2 i_pos; layout(location=1) in vec4 i_col; uniform vec2 u_res; out vec4 v_col;
void main(){ gl_Position = vec4(i_pos.x / u_res.x * 2.0 - 1.0, 1.0 - i_pos.y / u_res.y * 2.0, 0.0, 1.0); v_col = i_col; }`;
const FS_L = `#version 300 es
precision highp float; in vec4 v_col; out vec4 o; void main(){ o = vec4(v_col.rgb * v_col.a, 1.0); }`;
const VS_Q = `#version 300 es
out vec2 v_uv; void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); v_uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const FS_DOWN = `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_t; uniform vec2 u_px; uniform float u_thr; out vec4 o;
void main(){
  vec3 c = texture(u_t, v_uv + u_px * vec2(-0.5,-0.5)).rgb + texture(u_t, v_uv + u_px * vec2(0.5,-0.5)).rgb + texture(u_t, v_uv + u_px * vec2(-0.5,0.5)).rgb + texture(u_t, v_uv + u_px * vec2(0.5,0.5)).rgb;
  c *= 0.25; o = vec4(max(c - u_thr, 0.0), 1.0);
}`;
const FS_BLUR = `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_t; uniform vec2 u_dir; out vec4 o;
void main(){
  vec3 c = texture(u_t, v_uv).rgb * 0.2270270270;
  c += (texture(u_t, v_uv + u_dir * 1.3846153846).rgb + texture(u_t, v_uv - u_dir * 1.3846153846).rgb) * 0.3162162162;
  c += (texture(u_t, v_uv + u_dir * 3.2307692308).rgb + texture(u_t, v_uv - u_dir * 3.2307692308).rgb) * 0.0702702703;
  o = vec4(c, 1.0);
}`;
const FS_COMP = `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_s; uniform sampler2D u_b1; uniform sampler2D u_b2; uniform sampler2D u_b3; uniform vec3 u_w; uniform float u_exp; uniform vec2 u_res; uniform float u_t; out vec4 o;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 q = v_uv - 0.5; float r2 = dot(q, q);
  vec2 ca = q * (0.0035 + 0.011 * r2);                       // chromatic aberration, stronger toward the edges
  vec3 c = vec3(texture(u_s, v_uv + ca).r, texture(u_s, v_uv).g, texture(u_s, v_uv - ca).b);
  vec3 bl = texture(u_b1, v_uv).rgb * u_w.x + texture(u_b2, v_uv).rgb * u_w.y + texture(u_b3, v_uv).rgb * u_w.z;
  c += bl * mix(vec3(1.0), vec3(1.0, 0.8, 0.55), 0.4);
  if (u_w.y > 0.0) { // anamorphic streak: a horizontal smear of the half-resolution bloom, cool-tinted
    vec3 st = vec3(0.0); for (int i = -6; i <= 6; i++) { float w = exp(-float(i * i) / 14.0); st += texture(u_b2, v_uv + vec2(float(i) * 0.011, 0.0)).rgb * w; }
    c += st * 0.05 * vec3(0.55, 0.8, 1.0);
  }
  c = 1.0 - exp(-c * u_exp);
  float vig = 1.0 - smoothstep(0.35, 0.95, length(q * vec2(1.0, 1.15)));
  c *= mix(0.55, 1.0, vig);
  vec3 aur = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + u_t * 0.015 + q.x * 0.5));   // slow colour-shifting aurora in the margins
  c += aur * aur * 0.055 * smoothstep(0.18, 0.85, length(q));
  float g = hash(gl_FragCoord.xy + floor(u_t * 24.0) * 17.0) - 0.5; c += g * 0.016 * (1.0 - min(1.0, max(c.r, max(c.g, c.b))) * 0.6);   // fine film grain
  float a = max(c.r, max(c.g, c.b));
  o = vec4(c, a);
}`;

function compile(gl, type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`); return s; }
function program(gl, vs, fs) { const p = gl.createProgram(); gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`); return p; }

export class GLRenderer {
  constructor(canvas, { onLost } = {}) {
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('no webgl2');
    this.gl = gl; this.canvas = canvas; this.kind = 'webgl2'; this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; onLost?.(); });
    this.hdr = Boolean(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.pP = program(gl, VS_P, FS_P); this.pL = program(gl, VS_L, FS_L);
    this.pDown = program(gl, VS_Q, FS_DOWN); this.pBlur = program(gl, VS_Q, FS_BLUR); this.pComp = program(gl, VS_Q, FS_COMP);
    this.u = {};
    const U = (p, names) => Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
    this.u.P = U(this.pP, ['u_res']); this.u.L = U(this.pL, ['u_res']); this.u.D = U(this.pDown, ['u_t', 'u_px', 'u_thr']); this.u.B = U(this.pBlur, ['u_t', 'u_dir']);
    this.u.C = U(this.pComp, ['u_s', 'u_b1', 'u_b2', 'u_b3', 'u_w', 'u_exp', 'u_res', 'u_t']);
    this.vaoP = gl.createVertexArray(); this.bufP = gl.createBuffer();
    gl.bindVertexArray(this.vaoP); gl.bindBuffer(gl.ARRAY_BUFFER, this.bufP);
    const sP = PSTRIDE * 4; [[0, 2, 0], [1, 1, 8], [2, 3, 12], [3, 1, 24], [4, 1, 28]].forEach(([loc, n, off]) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, sP, off); gl.vertexAttribDivisor(loc, 1); });
    this.vaoL = gl.createVertexArray(); this.bufL = gl.createBuffer();
    gl.bindVertexArray(this.vaoL); gl.bindBuffer(gl.ARRAY_BUFFER, this.bufL);
    const sL = LSTRIDE * 4; gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, sL, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, sL, 8);
    this.vaoQ = gl.createVertexArray();
    this.t = {}; this.w = 0; this.h = 0; this.bloom = 3;
  }
  target(w, h) {
    const gl = this.gl; const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.hdr ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, this.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('fbo incomplete');
    return { tex, fb, w, h };
  }
  freeTargets() { const gl = this.gl; for (const t of Object.values(this.t)) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); } this.t = {}; }
  resize(cssW, cssH, dpr) {
    const gl = this.gl; const w = Math.max(2, Math.round(cssW * dpr)); const h = Math.max(2, Math.round(cssH * dpr));
    this.canvas.width = w; this.canvas.height = h; this.cssW = cssW; this.cssH = cssH; this.w = w; this.h = h; this.dpr = dpr;
    this.freeTargets();
    this.t.s = this.target(w, h);
    for (let l = 1; l <= 3; l++) { const lw = Math.max(2, w >> l); const lh = Math.max(2, h >> l); this.t[`a${l}`] = this.target(lw, lh); this.t[`b${l}`] = this.target(lw, lh); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  quad(prog) { const gl = this.gl; gl.useProgram(prog); gl.bindVertexArray(this.vaoQ); gl.drawArrays(gl.TRIANGLES, 0, 3); }
  tex(unit, t) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t.tex); }
  draw(f) {
    const gl = this.gl; if (this.lost || gl.isContextLost()) return;
    const { P, nP, L, nL } = f; const S = this.t.s;
    gl.bindFramebuffer(gl.FRAMEBUFFER, S.fb); gl.viewport(0, 0, S.w, S.h); gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (nL > 0) { gl.useProgram(this.pL); gl.uniform2f(this.u.L.u_res, this.cssW, this.cssH); gl.bindVertexArray(this.vaoL); gl.bindBuffer(gl.ARRAY_BUFFER, this.bufL); gl.bufferData(gl.ARRAY_BUFFER, L.subarray(0, nL * 2 * LSTRIDE), gl.STREAM_DRAW); gl.drawArrays(gl.LINES, 0, nL * 2); }
    if (nP > 0) { gl.useProgram(this.pP); gl.uniform2f(this.u.P.u_res, this.cssW, this.cssH); gl.bindVertexArray(this.vaoP); gl.bindBuffer(gl.ARRAY_BUFFER, this.bufP); gl.bufferData(gl.ARRAY_BUFFER, P.subarray(0, nP * PSTRIDE), gl.STREAM_DRAW); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nP); }
    gl.disable(gl.BLEND);
    const lv = this.bloom;
    if (lv > 0) {
      let src = S;
      for (let l = 1; l <= lv; l++) { // bright-pass + downsample chain
        const a = this.t[`a${l}`]; gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb); gl.viewport(0, 0, a.w, a.h); this.tex(0, src);
        gl.useProgram(this.pDown); gl.uniform1i(this.u.D.u_t, 0); gl.uniform2f(this.u.D.u_px, 1 / src.w, 1 / src.h); gl.uniform1f(this.u.D.u_thr, l === 1 ? 0.16 : 0.0); this.quad(this.pDown); src = a;
      }
      for (let l = 1; l <= lv; l++) { // separable gaussian per level
        const a = this.t[`a${l}`]; const b = this.t[`b${l}`];
        gl.useProgram(this.pBlur); gl.uniform1i(this.u.B.u_t, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb); gl.viewport(0, 0, b.w, b.h); this.tex(0, a); gl.uniform2f(this.u.B.u_dir, 1 / a.w, 0); this.quad(this.pBlur);
        gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb); gl.viewport(0, 0, a.w, a.h); this.tex(0, b); gl.uniform2f(this.u.B.u_dir, 0, 1 / b.h); this.quad(this.pBlur);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.pComp); this.tex(0, S); this.tex(1, this.t.a1); this.tex(2, this.t.a2); this.tex(3, this.t.a3);
    gl.uniform1i(this.u.C.u_s, 0); gl.uniform1i(this.u.C.u_b1, 1); gl.uniform1i(this.u.C.u_b2, 2); gl.uniform1i(this.u.C.u_b3, 3);
    gl.uniform3f(this.u.C.u_w, lv >= 1 ? 0.6 : 0, lv >= 2 ? 0.8 : 0, lv >= 3 ? 1.0 : 0); gl.uniform1f(this.u.C.u_exp, 1.35); gl.uniform2f(this.u.C.u_res, this.w, this.h); gl.uniform1f(this.u.C.u_t, f.t || 0);
    this.quad(this.pComp);
  }
  destroy() { try { this.freeTargets(); this.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already gone */ } }
}
