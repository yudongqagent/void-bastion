// WebGL2 renderer for VOID BASTION.
//
// Everything the game draws is one instanced quad evaluated by a signed
// distance function in the fragment shader — no textures, no image assets, no
// sprite atlas. That keeps the whole game a few dozen KB, lets shapes stay
// razor sharp at any DPR, and means the entire frame is a single draw call
// regardless of how many thousand enemies, bullets and sparks are on screen.
//
// Colours are written to an RGBA16F target with values deliberately pushed
// above 1.0, then a bright-pass + separable gaussian blur + additive composite
// turns that overshoot into bloom. That HDR overshoot is where the neon look
// comes from: a colour of 3.5 does not just clamp to white, it *spills*.

export const SHAPE = {
  GLOW: 0,  // soft radial falloff — particles, muzzle flash, aura
  DISC: 1,  // crisp filled circle with a glowing rim
  RING: 2,  // annulus — shields, shockwaves, range indicator
  POLY: 3,  // regular n-gon — enemies (param.x = sides)
  BEAM: 4,  // soft-edged rectangle — lasers, tracers
  SPARK:5,  // elongated glow — debris streaks
};

const FLOATS_PER_INSTANCE = 14;
const MAX_INSTANCES = 24000;

const QUAD_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec2 a_pos;
layout(location=2) in vec2 a_size;
layout(location=3) in float a_rot;
layout(location=4) in vec4 a_color;
layout(location=5) in vec2 a_param;
layout(location=6) in float a_shape;
layout(location=7) in vec2 a_mat;   // (material layer, world px per repeat); layer < 0 = untextured

uniform vec2 u_res;

out vec2 v_local;
out vec4 v_color;
out vec2 v_param;
flat out int v_shape;
flat out float v_rot;
out vec2 v_uv;
flat out float v_layer;

void main() {
  v_local = a_corner;
  v_color = a_color;
  v_param = a_param;
  v_shape = int(a_shape + 0.5);
  v_rot = a_rot;
  v_layer = a_mat.x;
  // uv is derived from WORLD SIZE, not from the quad's normalised corner.
  // a_mat.y is "world pixels per texture repeat", so texel density is the same
  // on a small fighter and a large island, and a long thin slab no longer
  // squashes its texture down to the shape's aspect ratio — which is exactly
  // what turned convoy hulls into smeared planks.
  v_uv = (a_corner * 0.5 + 0.5) * (a_size * 2.0) / max(a_mat.y, 1.0);

  float c = cos(a_rot), s = sin(a_rot);
  vec2 p = a_corner * a_size;
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) + a_pos;

  vec2 clip = (p / u_res) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const QUAD_FS = `#version 300 es
precision highp float;

in vec2 v_local;
in vec4 v_color;
in vec2 v_param;
flat in int v_shape;
flat in float v_rot;
in vec2 v_uv;
flat in float v_layer;
out vec4 outColor;

// Material layers. sampler2DArray rather than an atlas: each material wraps and
// mips independently, so REPEAT works and coarse mip levels cannot bleed one
// material into its neighbour the way an atlas would.
precision highp sampler2DArray;
uniform sampler2DArray u_mat;    // RGB albedo detail, A ambient occlusion
uniform sampler2DArray u_surf;   // RG tangent normal, B roughness, A metalness
uniform float u_texOn;           // 0 until the atlases have loaded

// Albedo was stored divided by this so values above 1.0 survive an 8-bit PNG.
const float ALBEDO_SCALE = 1.6;
// Compensates for albedo*AO averaging below 1, so enabling materials does not
// darken the whole game.
const float MATERIAL_GAIN = 1.18;

// Fixed world-space key light, up and slightly left. Rotated into each shape's
// local frame so a craft banking through a turn lights correctly instead of
// carrying its highlight around with it. This one term is most of what makes
// the difference between "glowing sprite" and "solid object under a sun".
const vec2 KEY_LIGHT = vec2(-0.42, -0.91);

float shading(vec2 p, float amount) {
  if (amount <= 0.0) return 1.0;
  float c = cos(-v_rot), s = sin(-v_rot);
  vec2 L = vec2(KEY_LIGHT.x * c - KEY_LIGHT.y * s, KEY_LIGHT.x * s + KEY_LIGHT.y * c);
  float lambert = clamp(dot(normalize(p + vec2(1e-4)), L), -1.0, 1.0);
  // Ambient floor so the unlit side reads as shadow, never as a hole.
  return mix(1.0, 0.58 + 0.52 * lambert, amount);
}

/**
 * Shading from a real surface normal.
 *
 * This is the payoff for the whole material pipeline: a scratch or a panel
 * seam now catches the light and slides across the hull as the craft banks,
 * because the highlight comes from the surface itself rather than from the
 * fragment's distance to the shape's centre.
 */
vec3 material(vec3 tint, float amount) {
  vec3 alb = texture(u_mat, vec3(v_uv, v_layer)).rgb * ALBEDO_SCALE;
  float ao = texture(u_mat, vec3(v_uv, v_layer)).a;
  vec4 srf = texture(u_surf, vec3(v_uv, v_layer));

  vec3 N = normalize(vec3((srf.rg * 2.0 - 1.0) * 1.35, 1.0));
  float c = cos(-v_rot), s = sin(-v_rot);
  vec2 L2 = vec2(KEY_LIGHT.x * c - KEY_LIGHT.y * s, KEY_LIGHT.x * s + KEY_LIGHT.y * c);
  vec3 L = normalize(vec3(L2, 0.62));

  float rough = max(srf.b, 0.04);
  float metal = srf.a;
  float diff = 0.56 + 0.56 * max(dot(N, L), 0.0);

  // Blinn-Phong: cheap, and at these sizes indistinguishable from anything
  // more principled. View direction is straight down the z axis.
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float shin = mix(90.0, 5.0, rough);
  float spec = pow(max(dot(N, H), 0.0), shin) * (1.0 - rough) * mix(0.5, 1.6, metal);

  vec3 base = tint * alb * ao * mix(1.0, diff, amount) * MATERIAL_GAIN;
  // Dielectrics glint white; metals tint their highlight with their own colour.
  return base + spec * mix(vec3(1.0), tint, metal) * amount;
}

const float TAU = 6.28318530718;

// Regular n-gon with circumradius 1, negative inside.
float sdPoly(vec2 p, float n) {
  float an = 3.14159265 / n;
  float a = atan(p.y, p.x);
  float k = mod(a + an, 2.0 * an) - an;
  return length(p) * cos(k) - cos(an);
}

// Screen-space antialiasing width for a distance field.
float edge(float d) {
  float w = max(fwidth(d), 1e-5);
  return 1.0 - smoothstep(-w, w, d);
}

void main() {
  vec2 p = v_local;
  float r = length(p);
  float alpha;
  vec3 rgb = v_color.rgb;

  if (v_shape == 0) {                       // GLOW
    float falloff = max(v_param.x, 0.35);
    alpha = pow(max(0.0, 1.0 - r), falloff);
  } else if (v_shape == 1) {                // DISC
    float d = r - 1.0;
    alpha = edge(d);
    if (v_param.y > 0.0) {
      if (u_texOn > 0.5 && v_layer >= 0.0) rgb = material(rgb, v_param.y);
      else rgb *= shading(p, v_param.y);
    } else {
      // Rim light: brighten the outer 25% so unshaded discs read as emissive.
      rgb *= 1.0 + 1.9 * smoothstep(0.68, 1.0, r);
    }
  } else if (v_shape == 2) {                // RING
    float t = max(v_param.x, 0.01);
    float d = abs(r - (1.0 - t)) - t;
    alpha = edge(d);
    rgb *= 1.25;
  } else if (v_shape == 3) {                // POLY
    float sides = max(v_param.x, 3.0);
    float d = sdPoly(p, sides);
    alpha = edge(d);
    // Hollow-core look: bright edge, dimmer middle. Reads as a wireframe hull.
    // The rim boost is deliberately modest — at 2.1x a small enemy's edge is
    // most of its area, so it clipped to white and every archetype looked the
    // same colour once the additive glow was stacked on top.
    if (v_param.y > 0.0) {
      // Solid, lit hull plate with a darker edge line for definition.
      if (u_texOn > 0.5 && v_layer >= 0.0) rgb = material(rgb, v_param.y);
      else rgb *= shading(p, v_param.y);
      rgb *= 1.0 - 0.30 * smoothstep(-0.16, 0.0, d);
    } else {
      float rim = smoothstep(-0.42, -0.02, d);
      rgb *= 0.60 + 1.15 * rim;
    }
  } else if (v_shape == 4) {                // BEAM
    float ax = abs(p.x), ay = abs(p.y);
    float soft = clamp(v_param.x, 0.02, 1.0);
    alpha = (1.0 - smoothstep(1.0 - soft, 1.0, ay)) * (1.0 - smoothstep(0.82, 1.0, ax));
    if (v_param.y > 0.0) {
      if (u_texOn > 0.5 && v_layer >= 0.0) rgb = material(rgb, v_param.y);
      else rgb *= shading(vec2(p.x * 0.25, p.y), v_param.y);
    } else {
      rgb *= 1.0 + 1.3 * (1.0 - ay);
    }
  } else {                                  // SPARK
    float d = length(vec2(p.x, p.y * 2.2));
    alpha = pow(max(0.0, 1.0 - d), 1.6);
  }

  alpha *= v_color.a;
  if (alpha <= 0.002) discard;
  outColor = vec4(rgb * alpha, alpha);
}`;

const FULLSCREEN_VS = `#version 300 es
out vec2 v_uv;
void main() {
  // Oversized triangle covering the viewport — no vertex buffer needed.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_threshold;
out vec4 outColor;
void main() {
  vec3 c = texture(u_tex, v_uv).rgb;
  float l = max(max(c.r, c.g), c.b);
  outColor = vec4(c * smoothstep(u_threshold, u_threshold + 0.55, l), 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;      // texel-sized step, horizontal or vertical
out vec4 outColor;
// 9-tap gaussian, weights folded to 5 samples via linear filtering offsets.
const float O[3] = float[](0.0, 1.3846153846, 3.2307692308);
const float W[3] = float[](0.2270270270, 0.3162162162, 0.0702702703);
void main() {
  vec3 c = texture(u_tex, v_uv).rgb * W[0];
  for (int i = 1; i < 3; i++) {
    c += texture(u_tex, v_uv + u_dir * O[i]).rgb * W[i];
    c += texture(u_tex, v_uv - u_dir * O[i]).rgb * W[i];
  }
  outColor = vec4(c, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform sampler2D u_bloom2;
uniform float u_intensity;
uniform vec3 u_flash;
uniform float u_vignette;
out vec4 outColor;
void main() {
  vec3 scene = texture(u_scene, v_uv).rgb;
  vec3 bloom = texture(u_bloom, v_uv).rgb + texture(u_bloom2, v_uv).rgb * 0.45;
  vec3 c = scene + bloom * u_intensity + u_flash;

  // Soft shoulder rather than a hard clamp: highlights roll off to white
  // instead of banding, which is what keeps the neon from looking flat.
  c = c / (1.0 + c * 0.42) * 1.42;

  vec2 d = v_uv - 0.5;
  c *= 1.0 - u_vignette * dot(d, d) * 1.8;

  outColor = vec4(c, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(sh) + '\n' + src);
  }
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

function uniforms(gl, prog) {
  const out = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(prog, i).name.replace(/\[0\]$/, '');
    out[name] = gl.getUniformLocation(prog, name);
  }
  return out;
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.canvas = canvas;

    // Float render targets are what make the bloom HDR. If the extension is
    // missing we fall back to 8-bit targets: bloom still works, it just cannot
    // represent overshoot, so the glow is tamer. Better than not running.
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');

    this.progQuad = program(gl, QUAD_VS, QUAD_FS);
    this.progBright = program(gl, FULLSCREEN_VS, BRIGHT_FS);
    this.progBlur = program(gl, FULLSCREEN_VS, BLUR_FS);
    this.progComposite = program(gl, FULLSCREEN_VS, COMPOSITE_FS);
    this.uQuad = uniforms(gl, this.progQuad);
    this.uBright = uniforms(gl, this.progBright);
    this.uBlur = uniforms(gl, this.progBlur);
    this.uComposite = uniforms(gl, this.progComposite);

    this.materialsReady = false;
    this.matTex = null;
    this.surfTex = null;

    this.data = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
    this.count = 0;

    this._initGeometry();
    this.emptyVao = gl.createVertexArray();

    this.targets = null;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    // Scene resolution scale. The bloom chain is fill-rate bound — a full-screen
    // water plane, big terrain plates and hundreds of oversized glow quads add up
    // to heavy overdraw, and every one of those fragments is shaded again by each
    // blur pass. Rendering the world slightly below native and letting the
    // composite upscale is by far the cheapest lever, and bloom hides the
    // softness almost completely.
    this.quality = 1;
    this.wideBloom = true;

    this.flash = [0, 0, 0];
    this.bloomIntensity = 0.62;
    this.bloomThreshold = 0.95;
    this.vignette = 0.55;
  }

  _initGeometry() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    const corners = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_INSTANCE * 4;
    // loc, size, byte offset
    const attrs = [[1, 2, 0], [2, 2, 8], [3, 1, 16], [4, 4, 20], [5, 2, 36], [6, 1, 44], [7, 2, 48]];
    for (const [loc, size, offset] of attrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }

  _makeTarget(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const internal = this.hdr ? gl.RGBA16F : gl.RGBA8;
    const type = this.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  resize(cssWidth, cssHeight, dpr) {
    const w = Math.max(2, Math.floor(cssWidth * dpr));
    const h = Math.max(2, Math.floor(cssHeight * dpr));
    if (w === this.width && h === this.height) return;

    this.width = w; this.height = h; this.dpr = dpr;
    this.cssWidth = cssWidth; this.cssHeight = cssHeight;
    this.canvas.width = w;
    this.canvas.height = h;
    this._buildTargets();
  }

  /**
   * @param {number} q 1 = native, lower renders the world smaller and upscales
   *   in the composite. Quantised so a hovering frame rate cannot thrash
   *   framebuffer reallocation every second.
   */
  setQuality(q) {
    const next = Math.max(0.5, Math.min(1, Math.round(q * 20) / 20));
    if (next === this.quality) return;
    this.quality = next;
    if (this.width) this._buildTargets();
  }

  _buildTargets() {
    const gl = this.gl;
    if (this.targets) {
      for (const t of Object.values(this.targets)) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      }
    }
    const rw = this.renderW = Math.max(2, Math.floor(this.width * this.quality));
    const rh = this.renderH = Math.max(2, Math.floor(this.height * this.quality));
    const hw = Math.max(1, rw >> 1), hh = Math.max(1, rh >> 1);
    const qw = Math.max(1, rw >> 2), qh = Math.max(1, rh >> 2);
    this.targets = {
      scene: this._makeTarget(rw, rh),
      bright: this._makeTarget(hw, hh),
      blurA: this._makeTarget(hw, hh),
      blurB: this._makeTarget(qw, qh),
      blurC: this._makeTarget(qw, qh),
    };
  }

  /**
   * Upload the two material atlases as texture arrays.
   *
   * Each source is a GRID x GRID sheet of square tiles; every tile becomes one
   * array layer. Slicing is done on a 2D canvas because texSubImage3D from a
   * sub-rectangle of an image would need UNPACK_SKIP_* juggling for no gain at
   * load time, and this runs exactly once.
   *
   * Safe to never call: the shader keeps u_texOn at 0 and every surface falls
   * back to the original position-based shading, so a missing or failed
   * download costs detail and nothing else.
   */
  setMaterials(albedoImage, surfaceImage, grid = 4) {
    const gl = this.gl;
    const tile = Math.floor(albedoImage.width / grid);
    const layers = grid * grid;

    const cvs = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(tile, tile)
      : Object.assign(document.createElement('canvas'), { width: tile, height: tile });
    const ctx = cvs.getContext('2d', { willReadFrequently: true });

    const upload = (image, srgb) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, Math.floor(Math.log2(tile)) + 1,
        srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, tile, tile, layers);
      for (let i = 0; i < layers; i++) {
        const sx = (i % grid) * tile, sy = Math.floor(i / grid) * tile;
        ctx.clearRect(0, 0, tile, tile);
        ctx.drawImage(image, sx, sy, tile, tile, 0, 0, tile, tile);
        const px = ctx.getImageData(0, 0, tile, tile).data;
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, tile, tile, 1,
          gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(px.buffer));
      }
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) {
        gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
          Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      }
      return tex;
    };

    // Albedo is colour and wants sRGB decode; the surface map is raw data
    // (normals, roughness, metalness) and must NOT be gamma-converted.
    this.matTex = upload(albedoImage, true);
    this.surfTex = upload(surfaceImage, false);
    this.materialsReady = true;
    return layers;
  }

  begin() { this.count = 0; }

  /**
   * Queue one shape. Colour components may exceed 1.0 — that overshoot is what
   * drives the bloom, so a "hot" core is just a big number, not a special case.
   */
  push(shape, x, y, sx, sy, rot, r, g, b, a, param = 0, param2 = 0, mat = -1, repeatPx = 48) {
    if (this.count >= MAX_INSTANCES) return;
    const i = this.count * FLOATS_PER_INSTANCE;
    const d = this.data;
    d[i] = x; d[i + 1] = y;
    d[i + 2] = sx; d[i + 3] = sy;
    d[i + 4] = rot;
    d[i + 5] = r; d[i + 6] = g; d[i + 7] = b; d[i + 8] = a;
    d[i + 9] = param; d[i + 10] = param2;
    d[i + 11] = shape;
    d[i + 12] = mat; d[i + 13] = repeatPx;
    this.count++;
  }

  glow(x, y, radius, r, g, b, a, falloff = 1.6) {
    this.push(SHAPE.GLOW, x, y, radius, radius, 0, r, g, b, a, falloff);
  }
  disc(x, y, radius, r, g, b, a) {
    this.push(SHAPE.DISC, x, y, radius, radius, 0, r, g, b, a);
  }
  ring(x, y, radius, thickness, r, g, b, a) {
    this.push(SHAPE.RING, x, y, radius, radius, 0, r, g, b, a, Math.min(0.98, thickness / radius));
  }
  poly(x, y, radius, sides, rot, r, g, b, a) {
    this.push(SHAPE.POLY, x, y, radius, radius, rot, r, g, b, a, sides);
  }
  /** Same shapes, lit by the key light — for anything meant to read as solid. */
  polyLit(x, y, radius, sides, rot, r, g, b, a, shade = 1, mat = -1, uv = 48) {
    this.push(SHAPE.POLY, x, y, radius, radius, rot, r, g, b, a, sides, shade, mat, uv);
  }
  discLit(x, y, radius, r, g, b, a, shade = 1, mat = -1, uv = 48) {
    this.push(SHAPE.DISC, x, y, radius, radius, 0, r, g, b, a, 0, shade, mat, uv);
  }
  /** Non-uniform lit quad — hulls, decks, runways. */
  slabLit(x, y, hw, hh, rot, r, g, b, a, shade = 1, mat = -1, uv = 48) {
    this.push(SHAPE.BEAM, x, y, hw, hh, rot, r, g, b, a, 0.06, shade, mat, uv);
  }
  beamLit(x1, y1, x2, y2, width, r, g, b, a, shade = 1, mat = -1, uv = 48) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 0.001;
    this.push(SHAPE.BEAM, (x1 + x2) / 2, (y1 + y2) / 2, len / 2, width,
      Math.atan2(dy, dx), r, g, b, a, 0.06, shade, mat, uv);
  }
  /** Beam between two points, `width` thick, with soft edges. */
  beam(x1, y1, x2, y2, width, r, g, b, a, soft = 0.6) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 0.001;
    this.push(SHAPE.BEAM, (x1 + x2) / 2, (y1 + y2) / 2, len / 2, width,
      Math.atan2(dy, dx), r, g, b, a, soft);
  }
  spark(x, y, sx, sy, rot, r, g, b, a) {
    this.push(SHAPE.SPARK, x, y, sx, sy, rot, r, g, b, a);
  }

  /** Upload the batch, draw the scene, then run the bloom chain. */
  flush(clearRGB = [0.017, 0.021, 0.043]) {
    const gl = this.gl;
    const T = this.targets;
    if (!T) return;

    // --- scene pass, additive, into the HDR target -------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fbo);
    gl.viewport(0, 0, this.renderW, this.renderH);
    gl.clearColor(clearRGB[0], clearRGB[1], clearRGB[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.count > 0) {
      gl.enable(gl.BLEND);
      // Premultiplied additive: shapes stack into brighter cores where they
      // overlap, which is exactly the behaviour neon wants.
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.blendEquation(gl.FUNC_ADD);

      gl.useProgram(this.progQuad);
      gl.uniform2f(this.uQuad.u_res, this.cssWidth, this.cssHeight);
      gl.uniform1f(this.uQuad.u_texOn, this.materialsReady ? 1 : 0);
      gl.uniform1i(this.uQuad.u_mat, 0);
      gl.uniform1i(this.uQuad.u_surf, 1);
      if (this.materialsReady) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.matTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.surfTex);
        gl.activeTexture(gl.TEXTURE0);
      }

      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0,
        this.data.subarray(0, this.count * FLOATS_PER_INSTANCE));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }

    // --- bloom chain --------------------------------------------------------
    gl.bindVertexArray(this.emptyVao);

    const pass = (target, prog, setup) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, target ? target.w : this.width, target ? target.h : this.height);
      gl.useProgram(prog);
      setup();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const bind = (unit, tex, loc) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, unit);
    };

    pass(T.bright, this.progBright, () => {
      bind(0, T.scene.tex, this.uBright.u_tex);
      gl.uniform1f(this.uBright.u_threshold, this.bloomThreshold);
    });

    // Half-res blur, then optionally a quarter-res pass for a wider halo. The
    // wide chain is two more full-screen passes for a subtle effect, so it is
    // the first thing dropped when frames get expensive.
    pass(T.blurA, this.progBlur, () => {
      bind(0, T.bright.tex, this.uBlur.u_tex);
      gl.uniform2f(this.uBlur.u_dir, 1 / T.bright.w, 0);
    });
    pass(T.bright, this.progBlur, () => {
      bind(0, T.blurA.tex, this.uBlur.u_tex);
      gl.uniform2f(this.uBlur.u_dir, 0, 1 / T.blurA.h);
    });
    if (this.wideBloom) {
      pass(T.blurB, this.progBlur, () => {
        bind(0, T.bright.tex, this.uBlur.u_tex);
        gl.uniform2f(this.uBlur.u_dir, 1.6 / T.bright.w, 0);
      });
      pass(T.blurC, this.progBlur, () => {
        bind(0, T.blurB.tex, this.uBlur.u_tex);
        gl.uniform2f(this.uBlur.u_dir, 0, 1.6 / T.blurB.h);
      });
    }

    pass(null, this.progComposite, () => {
      bind(0, T.scene.tex, this.uComposite.u_scene);
      bind(1, T.bright.tex, this.uComposite.u_bloom);
      bind(2, (this.wideBloom ? T.blurC : T.bright).tex, this.uComposite.u_bloom2);
      gl.uniform1f(this.uComposite.u_intensity, this.bloomIntensity);
      gl.uniform3f(this.uComposite.u_flash, this.flash[0], this.flash[1], this.flash[2]);
      gl.uniform1f(this.uComposite.u_vignette, this.vignette);
    });

    gl.bindVertexArray(null);
  }
}
