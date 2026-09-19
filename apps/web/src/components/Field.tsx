"use client";

import { useEffect, useRef } from "react";

/**
 * The transfer field: a WebGL backdrop of packets streaming between two
 * endpoints.
 *
 * It is not decoration bolted on after the fact — `intensity` is driven by the
 * real transfer state, so the page visibly accelerates while bytes are moving
 * and settles when they stop. Hand-written GLSL rather than a 3D library: this
 * is a single full-screen fragment shader, so pulling in half a megabyte of
 * scene graph to draw two triangles would be absurd.
 */

const VERT = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;

uniform vec2  u_res;
uniform float u_time;
uniform float u_intensity;   // 0 = dormant, 1 = transferring
uniform float u_progress;    // 0..1, fills the path between endpoints
uniform vec2  u_pointer;     // -1..1, parallax
uniform vec3  u_signal;
uniform vec3  u_ink;
uniform vec3  u_bg;
uniform float u_dark;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  uv += u_pointer * 0.035;

  float t = u_time;
  float speed = mix(0.35, 2.6, u_intensity);

  // Endpoints sit left and right; everything flows between them.
  vec2 a = vec2(-0.78, 0.0);
  vec2 b = vec2(0.78, 0.0);

  // Lanes bend through a slow noise field so the streams are not a grid.
  float warp = (fbm(vec2(uv.x * 1.1 + t * 0.04, uv.y * 1.8 + t * 0.02)) - 0.5) * 0.5;
  float lane = uv.y + warp * mix(0.35, 0.6, u_intensity);

  float acc = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float scale = 9.0 + fi * 7.0;
    float id = floor(lane * scale);
    float rnd = hash(vec2(id, fi * 17.0));

    // Distance to the centre of this lane — thin bright filaments.
    float dLane = abs(fract(lane * scale) - 0.5) / scale;
    float line = smoothstep(0.014 / (1.0 + fi), 0.0, dLane);

    // Packets running along the lane.
    float ph = fract(uv.x * (0.35 + 0.2 * rnd) - t * speed * (0.05 + 0.09 * rnd) + rnd);
    float packet = smoothstep(0.42, 0.5, ph) * smoothstep(0.62, 0.5, ph);

    acc += line * (0.1 + packet * 1.5) * (0.45 + 0.55 * rnd);
  }

  // Fade the streams out vertically and near the two endpoints.
  float band = exp(-pow(abs(uv.y) * 2.6, 2.2));
  float corridor = smoothstep(0.92, 0.55, abs(uv.x));
  acc *= band * corridor;

  // Only light the corridor as far as the transfer has actually got.
  float front = mix(-0.85, 0.85, clamp(u_progress, 0.0, 1.0));
  float filled = smoothstep(front + 0.16, front - 0.06, uv.x);
  acc *= mix(1.0, mix(0.16, 1.0, filled), step(0.001, u_progress));

  // The endpoints themselves.
  float ga = exp(-length(uv - a) * 13.0) * (0.55 + 0.45 * sin(t * 1.6));
  float gb = exp(-length(uv - b) * 13.0) * mix(0.25, 1.0, clamp(u_progress * 1.4, 0.0, 1.0));

  float energy = acc * 0.75 + ga * 0.5 + gb * 0.6;
  float haze = fbm(uv * 2.2 + t * 0.015);

  // Composition has to flip with the theme. Adding light to black is what
  // makes the dark plate glow; doing the same on paper just washes it out and
  // buries the text, so in light mode the streams are laid *into* the ground
  // as tint instead.
  vec3 col;
  if (u_dark > 0.5) {
    col = u_bg + u_signal * energy + u_ink * haze * 0.045;
    col *= 1.0 - dot(uv, uv) * 0.28;
  } else {
    col = mix(u_bg, u_signal, clamp(energy * 0.55, 0.0, 0.5));
    col = mix(col, u_ink, haze * 0.035);
    col *= 1.0 - dot(uv, uv) * 0.05;
  }

  // Grain, to kill banding in the gradients.
  col += (hash(gl_FragCoord.xy + fract(t)) - 0.5) * 0.015;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function cssRGB(el: HTMLElement, name: string): [number, number, number] {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  const hex = raw.replace("#", "");
  if (hex.length !== 6) return [0.78, 0.94, 0.3];
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

export function Field({
  intensity = 0,
  progress = 0,
  className = "",
}: {
  intensity?: number;
  progress?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Targets the render loop eases toward, so state changes glide rather than
  // snap. Held in a ref so a progress tick never re-renders the tree, and
  // written in an effect rather than during render.
  const target = useRef({ intensity: 0, progress: 0 });
  useEffect(() => {
    target.current = { intensity, progress };
  }, [intensity, progress]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl =
      (canvas.getContext("webgl", { antialias: false, alpha: false }) as WebGLRenderingContext) ??
      (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);
    // No WebGL: the CSS background behind this canvas is the fallback.
    if (!gl) return;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return;

    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const u = {
      res: gl.getUniformLocation(prog, "u_res"),
      time: gl.getUniformLocation(prog, "u_time"),
      intensity: gl.getUniformLocation(prog, "u_intensity"),
      progress: gl.getUniformLocation(prog, "u_progress"),
      pointer: gl.getUniformLocation(prog, "u_pointer"),
      signal: gl.getUniformLocation(prog, "u_signal"),
      ink: gl.getUniformLocation(prog, "u_ink"),
      bg: gl.getUniformLocation(prog, "u_bg"),
      dark: gl.getUniformLocation(prog, "u_dark"),
    };

    const root = document.documentElement;
    let signal = cssRGB(root, "--signal");
    let ink = cssRGB(root, "--ink");
    let bg = cssRGB(root, "--ground-deep");
    let dark = matchMedia("(prefers-color-scheme: dark)").matches ? 1 : 0;

    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      signal = cssRGB(root, "--signal");
      ink = cssRGB(root, "--ink");
      bg = cssRGB(root, "--ground-deep");
      dark = scheme.matches ? 1 : 0;
    };
    scheme.addEventListener("change", onScheme);

    // Cap the pixel ratio: a full-screen fragment shader at 3x on a retina
    // display burns battery for detail nobody can see.
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMove = (e: PointerEvent) => {
      pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.ty = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Only run while actually on screen and the tab is visible.
    let onScreen = true;
    const io = new IntersectionObserver(([e]) => {
      onScreen = e?.isIntersecting ?? true;
    });
    io.observe(canvas);

    let raf = 0;
    let t = 0;
    let last = performance.now();
    const eased = { intensity: 0, progress: 0 };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      if (!onScreen || document.hidden) return;

      // Reduced motion: hold a still frame rather than freezing on nothing.
      if (!reduced) t += dt;

      eased.intensity += (target.current.intensity - eased.intensity) * Math.min(dt * 3, 1);
      eased.progress += (target.current.progress - eased.progress) * Math.min(dt * 4, 1);
      pointer.x += (pointer.tx - pointer.x) * Math.min(dt * 2.5, 1);
      pointer.y += (pointer.ty - pointer.y) * Math.min(dt * 2.5, 1);

      gl.uniform2f(u.res, canvas.width, canvas.height);
      gl.uniform1f(u.time, t);
      gl.uniform1f(u.intensity, eased.intensity);
      gl.uniform1f(u.progress, eased.progress);
      gl.uniform2f(u.pointer, reduced ? 0 : pointer.x, reduced ? 0 : pointer.y);
      gl.uniform3f(u.signal, signal[0], signal[1], signal[2]);
      gl.uniform3f(u.ink, ink[0], ink[1], ink[2]);
      gl.uniform3f(u.bg, bg[0], bg[1], bg[2]);
      gl.uniform1f(u.dark, dark);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      scheme.removeEventListener("change", onScheme);
      window.removeEventListener("pointermove", onMove);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
    />
  );
}
