"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SiriWaveformProps = {
  className?: string;
  /** Height class applied to the canvas container (defaults to h-20). */
  heightClassName?: string;

  /** "full" renders labels + toggle + placeholder; "minimal" renders only the animation canvas. */
  variant?: "full" | "minimal";

  label?: string;
  defaultEnabled?: boolean;

  /** Optional controlled enable state. When set, it overrides internal toggle state. */
  enabled?: boolean;

  /** Optional: pass data directly (0..255). If omitted, `getAudioData` can fill an internal buffer each frame. */
  audioData?: Uint8Array | number[] | null;

  /** Optional: pull-model for performance (avoids React re-renders). */
  getAudioData?: (buffer: Uint8Array) => void;

  /** How many samples to use when pulling audio via `getAudioData`. */
  bufferLength?: number;
};

const TAU = Math.PI * 2;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function rmsEnergyFromByteFrequency(data: Uint8Array): number {
  // Frequency-like data (0..255). Use RMS to keep quiet signals visible.
  if (data.length === 0) return 0;
  const maxBins = Math.min(data.length, 160);
  let sumSq = 0;
  for (let i = 0; i < maxBins; i++) {
    // Slight bias toward lower bins, but still include mids.
    const w = 0.65 + 0.35 * (1 - i / (maxBins - 1));
    const v = (data[i] / 255) * w;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / maxBins);
}

export default function SiriWaveform({
  className,
  heightClassName = "h-20",
  variant = "full",
  label = "Enable Animation",
  defaultEnabled = true,
  enabled: enabledProp,
  audioData,
  getAudioData,
  bufferLength = 128,
}: SiriWaveformProps) {
  const isMinimal = variant === "minimal";
  const [enabledState, setEnabledState] = useState(defaultEnabled);
  const enabled = isMinimal ? true : (enabledProp ?? enabledState);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const sizeRef = useRef({ w: 1, h: 1, dpr: 1 });
  const energyRef = useRef(0);
  const peakRef = useRef(0.15);

  const audioDataRef = useRef<SiriWaveformProps["audioData"]>(audioData);
  const getAudioDataRef = useRef<SiriWaveformProps["getAudioData"]>(getAudioData);
  const tickRef = useRef<((tMs: number) => void) | null>(null);

  const pullBuffer = useMemo(() => new Uint8Array(bufferLength), [bufferLength]);

  useEffect(() => {
    audioDataRef.current = audioData;
  }, [audioData]);

  useEffect(() => {
    getAudioDataRef.current = getAudioData;
  }, [getAudioData]);

  const waves = useMemo(
    () => [
      { amp: 1.0, speed: 0.85, freq: 1.25, opacity: 0.60, phase: 0.0 },
      { amp: 0.78, speed: 1.10, freq: 1.75, opacity: 0.45, phase: 1.4 },
      { amp: 0.62, speed: 1.35, freq: 2.25, opacity: 0.35, phase: 2.6 },
      { amp: 0.48, speed: 0.70, freq: 3.00, opacity: 0.28, phase: 3.8 },
      { amp: 0.40, speed: 1.55, freq: 3.60, opacity: 0.22, phase: 5.05 },
      { amp: 0.34, speed: 0.95, freq: 4.25, opacity: 0.18, phase: 6.15 },
      { amp: 0.28, speed: 1.85, freq: 5.10, opacity: 0.14, phase: 7.25 },
      { amp: 0.22, speed: 0.62, freq: 6.20, opacity: 0.10, phase: 8.35 },
    ],
    [],
  );

  const stopLoop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  // ResizeObserver: keep canvas resolution in sync with container.
  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;

    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));

      sizeRef.current = { w, h, dpr };

      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    });

    ro.observe(el);

    return () => ro.disconnect();
  }, [enabled]);

  // Cleanup on unmount.
  useEffect(() => stopLoop, [stopLoop]);

  const drawFrame = useCallback(
    (tMs: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const { w, h, dpr } = sizeRef.current;
      if (w <= 1 || h <= 1) return;

      // Pull or read audio energy.
      let raw = 0;
      const dataProp = audioDataRef.current;
      if (dataProp && (dataProp as Uint8Array).length != null) {
        const u8 = Array.isArray(dataProp)
          ? Uint8Array.from(dataProp)
          : (dataProp as Uint8Array);
        raw = rmsEnergyFromByteFrequency(u8);
      } else if (getAudioDataRef.current) {
        getAudioDataRef.current(pullBuffer);
        raw = rmsEnergyFromByteFrequency(pullBuffer);
      }

      // Adaptive normalization (auto-gain): keeps motion lively even for quiet input.
      // Peak decays slowly so the display doesn't jitter.
      const minPeak = 0.12;
      const peak = Math.max(raw, peakRef.current * 0.985, minPeak);
      peakRef.current = peak;

      // Normalize + compress to boost low levels.
      const normalized = clamp(raw / peak, 0, 1);
      const nextEnergy = Math.pow(normalized, 0.6);

      // Smooth energy so it feels organic.
      const smoothed = lerp(energyRef.current, nextEnergy, 0.12);
      energyRef.current = smoothed;

      const time = tMs / 1000;

      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      const baseLineWidth = Math.max(1, Math.floor(2.2 * dpr));
      const glow = 18 * dpr;

      // Color gradient (cyan -> deep blue/purple -> magenta).
      const gradient = ctx.createLinearGradient(0, 0, w, 0);
      gradient.addColorStop(0, "rgba(0, 210, 255, 0.95)"); // #00d2ff
      gradient.addColorStop(0.55, "rgba(58, 123, 213, 0.85)"); // #3a7bd5
      gradient.addColorStop(1, "rgba(183, 33, 255, 0.92)"); // deep magenta-ish

      // Amplitude: always drifting; stronger when energy present.
      const idle = h * 0.07;
      const active = h * 0.22;
      const ampPx = idle + active * Math.pow(smoothed, 0.85);

      const points = Math.max(80, Math.floor(w / (6 * dpr)));

      for (let wi = 0; wi < waves.length; wi++) {
        const wave = waves[wi];

        ctx.beginPath();

        // Slight per-wave glow tint.
        ctx.shadowBlur = glow;
        ctx.shadowColor = wi % 2 === 0 ? "rgba(0,210,255,0.25)" : "rgba(183,33,255,0.22)";

        ctx.lineWidth = baseLineWidth;
        ctx.strokeStyle = gradient;
        ctx.globalAlpha = wave.opacity;

        for (let i = 0; i < points; i++) {
          const x = (i / (points - 1)) * w;
          const nx = x / w;

          // Envelope keeps edges calmer, center more alive.
          const envelope = Math.pow(Math.sin(Math.PI * nx), 0.9);

          const drift = Math.sin(time * 0.55 + wave.phase) * (h * 0.012);

          // Two layered sines for that organic, "intelligent" look.
          const s1 = Math.sin(nx * TAU * wave.freq + time * wave.speed + wave.phase);
          const s2 = Math.sin(nx * TAU * (wave.freq * 0.5) - time * (wave.speed * 0.7) + wave.phase * 1.7);

          const y =
            h / 2 +
            drift +
            (s1 * 0.72 + s2 * 0.28) * ampPx * wave.amp * envelope;

          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }

        ctx.stroke();
      }

      ctx.restore();
    },
    [pullBuffer, waves],
  );

  useEffect(() => {
    if (!enabled) {
      stopLoop();
      return;
    }

    tickRef.current = (tMs: number) => {
      drawFrame(tMs);
      // Drive the loop through a ref to avoid self-referential callback issues.
      rafRef.current = requestAnimationFrame((next) => tickRef.current?.(next));
    };

    rafRef.current = requestAnimationFrame((t) => tickRef.current?.(t));
    return () => stopLoop();
  }, [drawFrame, enabled, stopLoop]);

  return (
    <div className={className}>
      {isMinimal ? null : (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-zinc-300">Live input</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">Siri-like (Canvas)</span>
          </div>
        </div>
      )}

      <div ref={containerRef} className={(isMinimal ? "" : "mt-2 ") + heightClassName + " w-full"}>
        {enabled ? (
          <canvas
            ref={canvasRef}
            className="h-full w-full rounded-lg"
            aria-label="Siri waveform visualization"
            role="img"
          />
        ) : (
          <div
            className="relative h-full w-full rounded-lg"
            aria-label="Waveform placeholder"
            role="img"
          >
            <div className="absolute inset-0 flex items-center">
              <div className="h-px w-full bg-white/25" />
            </div>
          </div>
        )}
      </div>

      {isMinimal ? null : (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-zinc-500">Tip: Speak close to the mic for a stronger signal.</p>

          <label className="inline-flex cursor-pointer items-center gap-3 select-none">
            <span className="text-sm text-zinc-100">{label}</span>
            <span className="relative inline-flex h-7 w-12 items-center">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={enabled}
                onChange={(e) => {
                  if (enabledProp != null) return;
                  setEnabledState(e.target.checked);
                }}
              />
              <span className="absolute inset-0 rounded-full bg-white/10 transition peer-checked:bg-sky-500/40" />
              <span className="absolute left-1 top-1 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
