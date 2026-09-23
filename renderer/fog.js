'use strict';

/**
 * Terra incognita: an opaque parchment sheet over the whole map, with soft-edged
 * holes punched wherever you have been — the EU4 fog-of-war look.
 *
 * It renders as a MapLibre custom layer. The sheet cannot simply be drawn over the
 * map and then erased, because erasing would reveal the page behind the map rather
 * than the map itself. So each frame we:
 *
 *   1. draw the parchment into our own framebuffer, cleared to an opaque colour
 *   2. draw every visited point into it with a blend that multiplies destination
 *      alpha by (1 - src), which eats holes out of the sheet
 *   3. composite that framebuffer over the map with premultiplied alpha
 *
 * Coordinates are Web Mercator (0..1), which is what `mainMatrix` expects. That
 * matrix is mercator-only, so the layer skips rendering under a globe projection.
 */

const PARCHMENT = [0.918, 0.886, 0.827]; // #eae2d3, pale map paper

/**
 * A seamless tile of repeated "TERRA INCOGNITA", drawn over the parchment so the
 * blank area reads as deliberately hidden rather than as an empty or broken map.
 * Two rows offset like brickwork, with the text drawn again past both edges so
 * the glyphs line up where the tile repeats.
 */
function patternTexture(gl) {
  const dpr = window.devicePixelRatio || 1;
  const label = 'Terra Incognita';
  const size = 164;

  // Old-style serifs, in rough order of how much they look like engraved map
  // lettering. Cochin and Hoefler Text ship with macOS; the rest are fallbacks
  // for Windows and Linux.
  const font = `italic ${size}px Cochin, "Hoefler Text", Baskerville, `
    + `"Palatino Linotype", Palatino, "Times New Roman", serif`;

  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const textWidth = measure.measureText(label).width;

  // The canvas holds exactly one label. Spacing is applied in the shader
  // instead, so widening the gaps costs nothing -- baking them into the artwork
  // would mean a canvas several thousand pixels across, most of it blank.
  const w = Math.ceil(textWidth + size * 0.3);
  const h = Math.ceil(size * 1.4);

  const canvas = document.createElement('canvas');
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.font = font;
  ctx.fillStyle = 'rgba(108, 88, 58, 0.30)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, w / 2, h / 2);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Centre-to-centre spacing between labels, as multiples of the text's own
  // dimensions -- so the layout holds if the font or size changes.
  const tile = [textWidth * 3.12, size * 8.89];

  return {
    texture,
    tile,
    // Label extent as a fraction of the spacing, so the shader knows where the
    // artwork sits inside each cell and how big a box to test against windows.
    half: [(w / tile[0]) * 0.5, (h / tile[1]) * 0.5],
  };
}

const VERT_POINTS = `
attribute vec2 a_corner;
attribute vec2 a_pos;
uniform mat4 u_matrix;
uniform float u_radius;   // metres expressed as a fraction of the equator
varying vec2 v_corner;
void main() {
  float psi = 3.141592653589793 * (1.0 - 2.0 * a_pos.y);
  float secLat = 0.5 * (exp(psi) + exp(-psi));
  gl_Position = u_matrix * vec4(a_pos + a_corner * u_radius * secLat, 0.0, 1.0);
  v_corner = a_corner;
}`;

// Alpha only: the blend mode uses it to subtract from the sheet. The smoothstep
// gives the revealed border the soft, hand-drawn edge the reference has.
const FRAG_POINTS = `
precision mediump float;
varying vec2 v_corner;
void main() {
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0 - smoothstep(0.55, 1.0, length(v_corner)));
}`;

// Plain Mercator vertices, used for the border lines traced onto the sheet.
const VERT_MESH = `
attribute vec2 a_pos;
uniform mat4 u_matrix;
void main() { gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0); }`;

// Serves double duty: opaque black to eat holes out of the sheet, and the ink
// colour when tracing borders onto it.
const FRAG_MESH = `
precision mediump float;
uniform vec4 u_color;
void main() { gl_FragColor = u_color; }`;

// Border ink, as r,g,b,a. Region boundaries stay faint; national ones carry
// roughly the weight the basemap itself gives country lines.
const BORDER_INK = {
  region: [0.424, 0.345, 0.227, 0.26],
  country: [0.310, 0.251, 0.161, 0.85],
};

const EQUATOR_METRES = 40075016.686;

// The lettering is anchored to the ground, so it grows as you zoom in. This is
// the zoom at which it appears at its drawn pixel size.
const REFERENCE_ZOOM = 6;

const VERT_QUAD = `
attribute vec2 a_quad;
varying vec2 v_uv;
void main() {
  v_uv = a_quad * 0.5 + 0.5;
  gl_Position = vec4(a_quad, 0.0, 1.0);
}`;

// Same full-screen triangle, but carrying the Mercator position of each corner
// so the lettering can be anchored to the ground instead of to the screen.
const VERT_PATTERN = `
precision highp float;
attribute vec2 a_quad;
uniform vec2 u_merc0;
uniform vec2 u_mercX;
uniform vec2 u_mercY;
varying vec2 v_merc;
void main() {
  vec2 uv = a_quad * 0.5 + 0.5;
  v_merc = u_merc0 + uv.x * u_mercX + uv.y * u_mercY;
  gl_Position = vec4(a_quad, 0.0, 1.0);
}`;

const FRAG_QUAD = `
precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
void main() { gl_FragColor = texture2D(u_tex, v_uv); }`;

// Tiled in screen space, so the lettering stays the same size at every zoom.
// gl_FragCoord counts up from the bottom while the canvas the texture came from
// is top-down, hence the negated y.
//
// The slant comes from rotating the sample coordinate rather than the text in
// the tile: rotating the drawn glyphs would break the seams, rotating the
// lookup turns the whole infinite tiling and stays seamless.
const FRAG_PATTERN = `
precision highp float;
uniform sampler2D u_pattern;
uniform sampler2D u_mask;
uniform vec2 u_tile;      // label-to-label spacing, in Mercator units
uniform vec2 u_half;      // label half-extent, as a fraction of the spacing
uniform vec2 u_merc0;     // Mercator at the bottom-left of the viewport
uniform vec2 u_mercX;     // Mercator change across the full viewport width
uniform vec2 u_mercY;     // ...and height
uniform mat2 u_toScreen;  // inverse of [u_mercX u_mercY]
varying vec2 v_merc;

const float ANGLE = 0.6981317;  // 40 degrees
const mat2 TURN = mat2(cos(ANGLE), sin(ANGLE), -sin(ANGLE), cos(ANGLE));
const mat2 BACK = mat2(cos(ANGLE), -sin(ANGLE), sin(ANGLE), cos(ANGLE));

// Is this Mercator position inside a revealed window?
bool revealed(vec2 merc) {
  vec2 uv = u_toScreen * (merc - u_merc0);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return false;
  return texture2D(u_mask, uv).a > 0.06;
}

void main() {
  // The slant comes from turning the lookup rather than the drawn glyphs:
  // rotating the artwork would break the seams where the tile repeats.
  vec2 tileSpace = (TURN * v_merc) / u_tile;
  vec2 cell = floor(tileSpace);
  vec2 f = tileSpace - cell;

  // Two rows per cell, offset like brickwork. Pick whichever this fragment is
  // nearer, then find where it falls inside that label.
  vec2 centre = abs(f.y - 0.25) < abs(f.y - 0.75)
    ? vec2(0.5, 0.25)
    : vec2(f.x < 0.5 ? 0.0 : 1.0, 0.75);

  vec2 local = (f - centre) / (2.0 * u_half) + 0.5;
  // Most of the sheet is the gap between labels. Leaving early here keeps the
  // window probing below down to the ~1% of pixels that carry lettering.
  if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) return;

  // Probe this label's whole box against the windows. If any of it is over a
  // window, drop the entire label rather than let the window slice it apart.
  for (int i = 0; i < 11; i++) {
    float u = float(i) / 10.0 * 2.0 - 1.0;
    for (int j = 0; j < 3; j++) {
      float v = float(j) - 1.0;
      vec2 probe = centre + vec2(u, v) * u_half;
      if (revealed(BACK * ((cell + probe) * u_tile))) return;
    }
  }

  gl_FragColor = texture2D(u_pattern, local);
}`;

function compile(gl, vertSrc, fragSrc) {
  const build = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`fog shader: ${gl.getShaderInfoLog(sh)}`);
    }
    return sh;
  };
  const program = gl.createProgram();
  gl.attachShader(program, build(gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(program, build(gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`fog program: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

/**
 * @param {object} opts
 * @param {Record<string, Float32Array>} opts.sets named point sets, each interleaved
 *   x,y in Web Mercator 0..1. All are uploaded once; only one is drawn at a time.
 * @param {() => string|null} opts.active which set to reveal with, null for none
 * @param {() => number} opts.radiusMeters how far you can "see" from a point
 */
function createFogLayer({ sets, active, radiusMeters, borders }) {
  let pointProgram, quadProgram, patternProgram, meshProgram;
  let cornerBuffer, quadBuffer, pattern;
  const borderBuffers = { region: null, country: null };
  const borderCounts = { region: 0, country: 0 };
  let pendingBorders = null;
  let texture, framebuffer, maskTexture, maskFramebuffer;
  let fboWidth = 0, fboHeight = 0;
  let map, supported = true;

  // name -> { buffer, vao, count }
  const geometry = Object.create(null);

  function ensureFramebuffer(gl) {
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (w === fboWidth && h === fboHeight) return;
    fboWidth = w;
    fboHeight = h;

    if (!texture) {
      texture = gl.createTexture();
      framebuffer = gl.createFramebuffer();
      maskTexture = gl.createTexture();
      maskFramebuffer = gl.createFramebuffer();
    }

    for (const [tex, fbo] of [[texture, framebuffer], [maskTexture, maskFramebuffer]]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    }
  }

  /**
   * Where the viewport sits in Mercator space. Read by unprojecting three screen
   * corners, which keeps it correct under rotation as well as pan and zoom.
   * (Pitch would make this non-affine; the layer is flat-map only anyway.)
   */
  function viewport() {
    const canvas = map.getCanvas();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const at = (x, y) => {
      const ll = map.unproject([x, y]);
      const m = maplibregl.MercatorCoordinate.fromLngLat([ll.lng, ll.lat]);
      return [m.x, m.y];
    };
    const origin = at(0, h);      // gl_FragCoord counts up from the bottom
    const right = at(w, h);
    const top = at(0, 0);
    const spanX = [right[0] - origin[0], right[1] - origin[1]];
    const spanY = [top[0] - origin[0], top[1] - origin[1]];

    // Inverse of the 2x2 [spanX spanY], to turn Mercator back into viewport uv.
    const det = spanX[0] * spanY[1] - spanY[0] * spanX[1];
    const inv = Math.abs(det) < 1e-20
      ? [0, 0, 0, 0]
      : [spanY[1] / det, -spanX[1] / det, -spanY[0] / det, spanX[0] / det];

    return { origin, spanX, spanY, inv };
  }

  return {
    id: 'fog',
    type: 'custom',
    renderingMode: '2d',

    /** Outlines as GL_LINES vertex pairs, keyed 'region' and 'country'. */
    setBorders(lines) {
      pendingBorders = lines;
    },

    onAdd(mapInstance, gl) {
      map = mapInstance;
      // Instancing needs WebGL2. MapLibre asks for it, but bail cleanly rather
      // than drawing something wrong if we ever land on a WebGL1 context.
      supported = typeof WebGL2RenderingContext !== 'undefined'
        && gl instanceof WebGL2RenderingContext;
      if (!supported) return;

      pointProgram = compile(gl, VERT_POINTS, FRAG_POINTS);
      quadProgram = compile(gl, VERT_QUAD, FRAG_QUAD);
      patternProgram = compile(gl, VERT_PATTERN, FRAG_PATTERN);
      meshProgram = compile(gl, VERT_MESH, FRAG_MESH);
      pattern = patternTexture(gl);

      cornerBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

      const aCorner = gl.getAttribLocation(pointProgram, 'a_corner');
      const aPos = gl.getAttribLocation(pointProgram, 'a_pos');

      for (const [name, points] of Object.entries(sets)) {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);

        // A VAO keeps the instancing divisors off MapLibre's own attribute state.
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
        gl.enableVertexAttribArray(aCorner);
        gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(aPos, 1);
        gl.bindVertexArray(null);

        geometry[name] = { buffer, vao, count: points.length / 2 };
      }

      quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    },

    onRemove(_map, gl) {
      for (const g of Object.values(geometry)) {
        gl.deleteBuffer(g.buffer);
        gl.deleteVertexArray(g.vao);
      }
      for (const key of ['region', 'country']) {
        if (borderBuffers[key]) gl.deleteBuffer(borderBuffers[key]);
        borderBuffers[key] = null;
        borderCounts[key] = 0;
      }
      [cornerBuffer, quadBuffer].forEach((b) => b && gl.deleteBuffer(b));
      if (texture) gl.deleteTexture(texture);
      if (maskTexture) gl.deleteTexture(maskTexture);
      if (pattern) gl.deleteTexture(pattern.texture);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (maskFramebuffer) gl.deleteFramebuffer(maskFramebuffer);
      texture = framebuffer = maskTexture = maskFramebuffer = null;
      fboWidth = fboHeight = 0;
    },

    render(gl, args) {
      if (!supported) return;

      if (pendingBorders) {
        for (const key of ['region', 'country']) {
          const data = pendingBorders[key];
          if (!data) continue;
          if (!borderBuffers[key]) borderBuffers[key] = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, borderBuffers[key]);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
          borderCounts[key] = data.length / 2;
        }
        pendingBorders = null;
      }

      const set = geometry[active()];
      if (!set || !set.count) return;
      // mainMatrix assumes mercator; under a globe the points would land wrong.
      if ((map.getProjection() || {}).type === 'globe') return;

      const matrix = args.defaultProjectionData && args.defaultProjectionData.mainMatrix;
      if (!matrix) return;

      const previousFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);

      // MapLibre leaves scissor/stencil/depth configured for its own tile clipping.
      // Inherited, that state silently clips our clear and our draws, so take a
      // clean slate here and hand back what we found.
      const had = {
        scissor: gl.isEnabled(gl.SCISSOR_TEST),
        depth: gl.isEnabled(gl.DEPTH_TEST),
        stencil: gl.isEnabled(gl.STENCIL_TEST),
        cull: gl.isEnabled(gl.CULL_FACE),
      };
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.CULL_FACE);
      gl.colorMask(true, true, true, true);
      gl.depthMask(false);

      ensureFramebuffer(gl);

      const view = viewport();
      const radius = radiusMeters() / EQUATOR_METRES;
      const drawHoles = () => {
        gl.useProgram(pointProgram);
        gl.uniformMatrix4fv(gl.getUniformLocation(pointProgram, 'u_matrix'), false, matrix);
        gl.uniform1f(gl.getUniformLocation(pointProgram, 'u_radius'), radius);
        gl.bindVertexArray(set.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, set.count);
        gl.bindVertexArray(null);
      };

      gl.enable(gl.BLEND);

      // 1: the windows, on their own, so the lettering can be tested against them.
      // MAX blending keeps the strongest coverage where holes overlap.
      gl.bindFramebuffer(gl.FRAMEBUFFER, maskFramebuffer);
      gl.viewport(0, 0, fboWidth, fboHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
      drawHoles();
      gl.blendEquation(gl.FUNC_ADD);

      // 2: parchment sheet.
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, fboWidth, fboHeight);
      gl.clearColor(PARCHMENT[0], PARCHMENT[1], PARCHMENT[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // 3: the lettering, anchored to the ground so it scales with the map, and
      // skipping any label that a window would cut through.
      const tile = Math.pow(2, -REFERENCE_ZOOM) / 512;
      gl.useProgram(patternProgram);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, pattern.texture);
      gl.uniform1i(gl.getUniformLocation(patternProgram, 'u_pattern'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, maskTexture);
      gl.uniform1i(gl.getUniformLocation(patternProgram, 'u_mask'), 1);
      gl.uniform2f(gl.getUniformLocation(patternProgram, 'u_tile'),
        pattern.tile[0] * tile, pattern.tile[1] * tile);
      gl.uniform2f(gl.getUniformLocation(patternProgram, 'u_half'),
        pattern.half[0], pattern.half[1]);
      gl.uniform2f(gl.getUniformLocation(patternProgram, 'u_merc0'),
        view.origin[0], view.origin[1]);
      gl.uniform2f(gl.getUniformLocation(patternProgram, 'u_mercX'),
        view.spanX[0], view.spanX[1]);
      gl.uniform2f(gl.getUniformLocation(patternProgram, 'u_mercY'),
        view.spanY[0], view.spanY[1]);
      gl.uniformMatrix2fv(gl.getUniformLocation(patternProgram, 'u_toScreen'),
        false, view.inv);
      const aPattern = gl.getAttribLocation(patternProgram, 'a_quad');
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(aPattern);
      gl.vertexAttribPointer(aPattern, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);

      // 4: region outlines, traced onto the sheet. Drawn before the windows are
      // cut, so the borders survive only over undiscovered ground.
      if (borders && borders()) {
        gl.useProgram(meshProgram);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniformMatrix4fv(gl.getUniformLocation(meshProgram, 'u_matrix'), false, matrix);
        const aBorder = gl.getAttribLocation(meshProgram, 'a_pos');
        // Regions first, so national lines sit on top where they coincide.
        for (const key of ['region', 'country']) {
          if (!borderCounts[key]) continue;
          const [r, g, b, a] = BORDER_INK[key];
          gl.uniform4f(gl.getUniformLocation(meshProgram, 'u_color'), r * a, g * a, b * a, a);
          gl.bindBuffer(gl.ARRAY_BUFFER, borderBuffers[key]);
          gl.enableVertexAttribArray(aBorder);
          gl.vertexAttribPointer(aBorder, 2, gl.FLOAT, false, 0, 0);
          gl.drawArrays(gl.LINES, 0, borderCounts[key]);
        }
      }

      // 5: eat the windows out of the sheet.
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      drawHoles();

      // 6: composite the sheet over the map. Contents are premultiplied.
      gl.bindFramebuffer(gl.FRAMEBUFFER, previousFbo);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(quadProgram);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(gl.getUniformLocation(quadProgram, 'u_tex'), 0);
      const aQuad = gl.getAttribLocation(quadProgram, 'a_quad');
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(aQuad);
      gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (had.scissor) gl.enable(gl.SCISSOR_TEST);
      if (had.depth) gl.enable(gl.DEPTH_TEST);
      if (had.stencil) gl.enable(gl.STENCIL_TEST);
      if (had.cull) gl.enable(gl.CULL_FACE);
    },
  };
}

window.createFogLayer = createFogLayer;
