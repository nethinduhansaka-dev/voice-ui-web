"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SiriWaveform from "../components/SiriWaveform";

function pickSupportedMimeType(): string | null {
  if (typeof window === "undefined") return null;
  if (typeof MediaRecorder === "undefined") return null;

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];

  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // ignore
    }
  }

  return null;
}

export default function SiriPage() {
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const liveRef = useRef(true);
  const stopTimerRef = useRef<number | null>(null);

  const analyserScratchRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const voiceGateRef = useRef(0);

  const [transcript, setTranscript] = useState<string>("");
  const [transcribing, setTranscribing] = useState<boolean>(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);

  const backendWsUrl = useMemo(() => {
    return process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? "ws://localhost:8000/ws/transcribe";
  }, []);

  const connectWs = useCallback(() => {
    setTranscribeError(null);

    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }

    const ws = new WebSocket(backendWsUrl);
    ws.binaryType = "arraybuffer";

    ws.onmessage = (evt) => {
      const text = String(evt.data ?? "").trim();
      if (!text) return;
      setTranscript((prev) => (prev ? `${prev} ${text}`.replace(/\s+/g, " ").trim() : text));
    };

    ws.onerror = () => {
      setTranscribeError("WebSocket error connecting to backend.");
    };

    ws.onclose = () => {
      // If we are still live, show an error; user can refresh to reconnect.
      if (liveRef.current) setTranscribeError("Disconnected from backend transcription service.");
    };

    wsRef.current = ws;
  }, [backendWsUrl]);

  const sendBlobForTranscription = useCallback(async (blob: Blob) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    try {
      setTranscribing(true);
      const data = await blob.arrayBuffer();
      ws.send(data);
    } catch {
      setTranscribeError("Failed to send audio to backend.");
    } finally {
      setTranscribing(false);
    }
  }, []);

  const startRecorderLoop = useCallback(
    (stream: MediaStream) => {
      const mimeType = pickSupportedMimeType();
      const options: MediaRecorderOptions = {};
      if (mimeType) options.mimeType = mimeType;

      const CLIP_MS = 2500;

      const stopTimer = () => {
        if (stopTimerRef.current) {
          window.clearTimeout(stopTimerRef.current);
          stopTimerRef.current = null;
        }
      };

      const stopRecorder = () => {
        const recorder = recorderRef.current;
        if (!recorder) return;
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          // ignore
        }
      };

      const startOneClip = () => {
        stopTimer();

        if (!liveRef.current) return;
        if (typeof MediaRecorder === "undefined") {
          setTranscribeError("This browser does not support MediaRecorder.");
          return;
        }

        chunksRef.current = [];

        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(stream, options);
        } catch {
          setTranscribeError("Could not start recording.");
          return;
        }

        recorderRef.current = recorder;

        recorder.ondataavailable = (e: BlobEvent) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };

        recorder.onerror = () => {
          setTranscribeError("Recording error.");
        };

        recorder.onstop = () => {
          const blob = new Blob(chunksRef.current, {
            type: mimeType || recorder.mimeType || "audio/webm",
          });
          chunksRef.current = [];

          if (blob.size > 0) void sendBlobForTranscription(blob);

          // Immediately start next clip to keep it “live”.
          if (liveRef.current) startOneClip();
        };

        try {
          recorder.start();
        } catch {
          setTranscribeError("Could not start recording.");
          return;
        }

        stopTimerRef.current = window.setTimeout(() => {
          stopRecorder();
        }, CLIP_MS);
      };

      startOneClip();
    },
    [sendBlobForTranscription],
  );

  const teardown = useCallback(async () => {
    liveRef.current = false;

    if (stopTimerRef.current) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }

    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // ignore
      }
    }

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }

    try {
      sourceNodeRef.current?.disconnect();
    } catch {
      // ignore
    }
    sourceNodeRef.current = null;

    try {
      analyserRef.current?.disconnect();
    } catch {
      // ignore
    }
    analyserRef.current = null;

    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        // ignore
      }
    }

    const stream = mediaStreamRef.current;
    mediaStreamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    }
  }, []);

  const startMic = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!navigator.mediaDevices?.getUserMedia) return;

    await teardown();

    liveRef.current = true;
    setTranscript("");
    setTranscribeError(null);
    connectWs();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    mediaStreamRef.current = stream;

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const audioCtx = new AudioCtx();
    audioContextRef.current = audioCtx;

    if (audioCtx.state === "suspended") {
      try {
        await audioCtx.resume();
      } catch {
        // ignore
      }
    }

    const source = audioCtx.createMediaStreamSource(stream);
    sourceNodeRef.current = source;

    const analyser = audioCtx.createAnalyser();
    analyserRef.current = analyser;

    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.85;

    source.connect(analyser);

    // Start live transcription loop.
    startRecorderLoop(stream);
  }, [connectWs, startRecorderLoop, teardown]);

  // Auto-start microphone on entry.
  useEffect(() => {
    void startMic();
    return () => {
      void teardown();
    };
  }, [startMic, teardown]);

  const getVoiceOnlyAudioData = useCallback((buffer: Uint8Array) => {
    const analyser = analyserRef.current;
    if (!analyser) {
      buffer.fill(0);
      return;
    }

    const audioCtx = audioContextRef.current;
    const sampleRate = audioCtx?.sampleRate ?? 48000;

    const required = analyser.frequencyBinCount;
    if (!analyserScratchRef.current || analyserScratchRef.current.length !== required) {
      analyserScratchRef.current = new Uint8Array(new ArrayBuffer(required));
    }

    const src = analyserScratchRef.current;
    analyser.getByteFrequencyData(src);

    // Enhanced voice detection: Human speech spans 80Hz to 8kHz with formants in characteristic ranges.
    // - Male voices: fundamental ~85-180Hz, formants at specific intervals
    // - Female voices: fundamental ~165-255Hz, generally higher energy
    const binHz = sampleRate / analyser.fftSize;
    const lo = Math.max(1, Math.floor(80 / binHz));
    const hi = Math.min(src.length - 1, Math.floor(8000 / binHz));

    // Additional detection: focus on core voice band (200Hz-3.5kHz) where most speech energy concentrates
    const voiceCoreLo = Math.max(1, Math.floor(200 / binHz));
    const voiceCoreHi = Math.min(src.length - 1, Math.floor(3500 / binHz));

    let bandSq = 0;
    let coreBandSq = 0;
    let totalSq = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i] / 255;
      const vv = v * v;
      totalSq += vv;
      if (i >= lo && i <= hi) bandSq += vv;
      if (i >= voiceCoreLo && i <= voiceCoreHi) coreBandSq += vv;
    }

    const bandRms = Math.sqrt(bandSq / Math.max(1, hi - lo + 1));
    const coreBandRms = Math.sqrt(coreBandSq / Math.max(1, voiceCoreHi - voiceCoreLo + 1));
    const ratio = totalSq > 0 ? Math.max(0, Math.min(1, bandSq / totalSq)) : 0;
    const coreRatio = totalSq > 0 ? Math.max(0, Math.min(1, coreBandSq / totalSq)) : 0;

    // More sensitive thresholds: reduced from 0.035 to 0.020, and ratio from 0.55 to 0.40
    // Also check that core voice band has reasonable energy (higher sensitivity)
    const looksLikeVoice =
      (bandRms > 0.020 && ratio > 0.40) ||
      (coreBandRms > 0.025 && coreRatio > 0.35);
    
    const target = looksLikeVoice ? 1 : 0;
    // Faster response to voice detection (0.28 instead of 0.22), slower decay (0.08 instead of 0.1)
    voiceGateRef.current =
      voiceGateRef.current + (target - voiceGateRef.current) * (looksLikeVoice ? 0.28 : 0.08);

    // Lower gate threshold from 0.35 to 0.25 for better sensitivity
    if (voiceGateRef.current < 0.25) {
      buffer.fill(0);
      return;
    }

    // Downsample.
    if (buffer.length === src.length) {
      buffer.set(src);
      return;
    }

    const step = src.length / buffer.length;
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] = src[Math.floor(i * step)];
    }
  }, []);

  const supportsMic = useMemo(() => {
    if (typeof window === "undefined") return false;
    return Boolean(
      navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function" &&
        ("AudioContext" in window || "webkitAudioContext" in (window as unknown as Record<string, unknown>)),
    );
  }, []);

  return (
    <div className="min-h-screen bg-black">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-10">
        <div className="min-h-18">
          <div className="text-4xl font-semibold tracking-tight text-zinc-100">
            {transcript || (supportsMic ? "Listening…" : "Microphone not supported")}
          </div>
          {transcribeError ? (
            <div className="mt-3 text-sm text-rose-300">{transcribeError}</div>
          ) : (
            <div className="mt-3 text-sm text-zinc-400">
              {supportsMic ? (transcribing ? "Transcribing…" : "Live transcription") : ""}
            </div>
          )}
        </div>

        <div className="mt-10 flex-1 flex items-center justify-center">
          {supportsMic ? (
            <SiriWaveform
              variant="minimal"
              className="w-full"
              heightClassName="h-56"
              bufferLength={128}
              getAudioData={getVoiceOnlyAudioData}
            />
          ) : (
            <div className="text-sm text-zinc-400">Your browser does not support microphone access.</div>
          )}
        </div>
      </div>
    </div>
  );
}
