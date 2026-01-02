"use client";

import React, { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import SiriWaveform from "./SiriWaveform";

type RecorderState = "idle" | "recording" | "paused" | "processing";

type RecorderErrorCode =
  | "unsupported"
  | "permission_denied"
  | "no_microphone"
  | "hardware_disconnected"
  | "in_use"
  | "unknown";

type RecorderError = {
  code: RecorderErrorCode;
  message: string;
};

type Model = {
  state: RecorderState;
  error: RecorderError | null;
  audioUrl: string | null;
  audioBlob: Blob | null;
  mimeType: string | null;
};

type Event =
  | { type: "START" }
  | { type: "STARTED" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "STOP" }
  | { type: "PROCESSING" }
  | { type: "READY"; audioUrl: string; audioBlob: Blob; mimeType: string | null }
  | { type: "RESET" }
  | { type: "ERROR"; error: RecorderError };

function reducer(model: Model, event: Event): Model {
  switch (event.type) {
    case "START":
      return {
        ...model,
        error: null,
        audioUrl: null,
        audioBlob: null,
        mimeType: null,
        state: "processing",
      };
    case "STARTED":
      return { ...model, error: null, state: "recording" };
    case "PAUSE":
      if (model.state !== "recording") return model;
      return { ...model, state: "paused" };
    case "RESUME":
      if (model.state !== "paused") return model;
      return { ...model, state: "recording" };
    case "STOP":
      if (model.state !== "recording" && model.state !== "paused") return model;
      return { ...model, state: "processing" };
    case "PROCESSING":
      return { ...model, state: "processing" };
    case "READY":
      return {
        ...model,
        state: "idle",
        error: null,
        audioUrl: event.audioUrl,
        audioBlob: event.audioBlob,
        mimeType: event.mimeType,
      };
    case "RESET":
      return {
        state: "idle",
        error: null,
        audioUrl: null,
        audioBlob: null,
        mimeType: null,
      };
    case "ERROR":
      return { ...model, state: "idle", error: event.error };
    default:
      return model;
  }
}

function formatError(err: unknown): RecorderError {
  // MediaDevices / MediaRecorder errors are not always standardized across browsers.
  const anyErr = err as { name?: string; message?: string };
  const name = anyErr?.name ?? "";
  const message = anyErr?.message ?? "";

  // Permission or user gesture issues
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      code: "permission_denied",
      message:
        "Microphone permission was denied. Please allow microphone access in your browser settings and try again.",
    };
  }

  // No device found
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      code: "no_microphone",
      message: "No microphone was found. Connect a microphone and try again.",
    };
  }

  // Device is already in use by another application
  if (name === "NotReadableError" || name === "TrackStartError") {
    return {
      code: "in_use",
      message:
        "The microphone is not readable (it may be in use by another app). Close other apps using the mic and try again.",
    };
  }

  // Fallback
  return {
    code: "unknown",
    message: message || "Something went wrong while accessing the microphone.",
  };
}

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
    // Some browsers throw on invalid strings; guard just in case.
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // ignore
    }
  }

  return null;
}

export default function AudioRecorder() {
  const [model, dispatch] = useReducer(reducer, {
    state: "idle",
    error: null,
    audioUrl: null,
    audioBlob: null,
    mimeType: null,
  });

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const analyserScratchRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const voiceGateRef = useRef(0); // 0..1 smoothed confidence

  const lastObjectUrlRef = useRef<string | null>(null);

  const mimeType = useMemo(() => pickSupportedMimeType(), []);

  const teardownVisualization = useCallback(async () => {
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
        // Some browsers may reject if already closed.
        await ctx.close();
      } catch {
        // ignore
      }
    }
  }, []);

  const stopAllTracks = useCallback((stream: MediaStream | null) => {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // ignore
      }
    }
  }, []);

  const teardownMedia = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;

    if (recorder) {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // ignore
      }
    }

    const stream = mediaStreamRef.current;
    mediaStreamRef.current = null;
    stopAllTracks(stream);

    chunksRef.current = [];
    await teardownVisualization();
  }, [stopAllTracks, teardownVisualization]);

  const revokeLastObjectUrl = useCallback(() => {
    const url = lastObjectUrlRef.current;
    if (url) {
      URL.revokeObjectURL(url);
      lastObjectUrlRef.current = null;
    }
  }, []);

  // Ensure we never leak resources on unmount.
  useEffect(() => {
    return () => {
      revokeLastObjectUrl();
      void teardownMedia();
    };
  }, [revokeLastObjectUrl, teardownMedia]);

  const setupVisualization = useCallback(async (stream: MediaStream) => {
    await teardownVisualization();

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const audioCtx = new AudioCtx();
    audioContextRef.current = audioCtx;

    // If the context is suspended (autoplay policies), resume it during the user gesture.
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

    // Waveform settings: time-domain data looks best with moderate resolution.
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.85;

    source.connect(analyser);
  }, [teardownVisualization]);

  const getLiveAudioData = useCallback((buffer: Uint8Array) => {
    const analyser = analyserRef.current;
    if (!analyser) {
      buffer.fill(0);
      return;
    }

    const audioCtx = audioContextRef.current;
    const sampleRate = audioCtx?.sampleRate ?? 48000;

    const required = analyser.frequencyBinCount;
    if (!analyserScratchRef.current || analyserScratchRef.current.length !== required) {
      // Allocate from a real ArrayBuffer to satisfy stricter lib.dom typing.
      analyserScratchRef.current = new Uint8Array(new ArrayBuffer(required));
    }

    const src = analyserScratchRef.current;
    analyser.getByteFrequencyData(src);

    // Voice-only gating: emphasize typical speech band and require band dominance.
    // Speech fundamentals/harmonics tend to concentrate roughly in ~80Hz..4kHz.
    const binHz = sampleRate / analyser.fftSize;
    const lo = Math.max(1, Math.floor(80 / binHz));
    const hi = Math.min(src.length - 1, Math.floor(4000 / binHz));

    let bandSq = 0;
    let totalSq = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i] / 255;
      const vv = v * v;
      totalSq += vv;
      if (i >= lo && i <= hi) bandSq += vv;
    }

    const bandRms = Math.sqrt(bandSq / Math.max(1, hi - lo + 1));
    const ratio = totalSq > 0 ? Math.max(0, Math.min(1, bandSq / totalSq)) : 0;

    // Heuristic thresholds:
    // - Require some energy in speech band (filters silence)
    // - Require band to dominate overall spectrum (filters broad noise)
    const looksLikeVoice = bandRms > 0.035 && ratio > 0.55;

    // Smooth the gate so it doesn't flicker.
    const target = looksLikeVoice ? 1 : 0;
    voiceGateRef.current = voiceGateRef.current + (target - voiceGateRef.current) * (looksLikeVoice ? 0.22 : 0.10);

    // If not voice, feed zeros so the Siri waveform stays in idle mode.
    if (voiceGateRef.current < 0.35) {
      buffer.fill(0);
      return;
    }

    // Downsample into the requested buffer length.
    if (buffer.length === src.length) {
      buffer.set(src);
      return;
    }

    const step = src.length / buffer.length;
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] = src[Math.floor(i * step)];
    }
  }, []);

  const handleHardwareDisconnected = useCallback(() => {
    // If the underlying track ends while recording/paused, surface a clear error and tear down.
    dispatch({
      type: "ERROR",
      error: {
        code: "hardware_disconnected",
        message:
          "Microphone disconnected while recording. Reconnect your device and try again.",
      },
    });
    void teardownMedia();
  }, [teardownMedia]);

  const start = useCallback(async () => {
    revokeLastObjectUrl();

    if (typeof window === "undefined") return;

    if (!navigator.mediaDevices?.getUserMedia) {
      dispatch({
        type: "ERROR",
        error: {
          code: "unsupported",
          message: "Your browser does not support microphone access (getUserMedia).",
        },
      });
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      dispatch({
        type: "ERROR",
        error: {
          code: "unsupported",
          message: "Your browser does not support audio recording (MediaRecorder).",
        },
      });
      return;
    }

    dispatch({ type: "START" });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      mediaStreamRef.current = stream;

      // Detect hardware disconnect (track ended).
      const tracks = stream.getAudioTracks();
      for (const track of tracks) {
        track.onended = () => {
          // Only raise if we were actively using the mic.
          handleHardwareDisconnected();
        };
      }

      // Try to detect device changes as an additional signal.
      const onDeviceChange = () => {
        const s = mediaStreamRef.current;
        if (!s) return;
        const active = s.getAudioTracks().some((t) => t.readyState === "live");
        if (!active) handleHardwareDisconnected();
      };

      navigator.mediaDevices.addEventListener?.("devicechange", onDeviceChange);

      // Prepare visualization
      await setupVisualization(stream);

      chunksRef.current = [];

      const options: MediaRecorderOptions = {};
      if (mimeType) options.mimeType = mimeType;

      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onerror = () => {
        dispatch({
          type: "ERROR",
          error: {
            code: "unknown",
            message: "Recording failed due to an internal MediaRecorder error.",
          },
        });
        void teardownMedia();
      };

      recorder.onstop = () => {
        navigator.mediaDevices.removeEventListener?.("devicechange", onDeviceChange);

        dispatch({ type: "PROCESSING" });

        try {
          const blob = new Blob(chunksRef.current, {
            type: mimeType || recorder.mimeType || "audio/webm",
          });

          chunksRef.current = [];

          const url = URL.createObjectURL(blob);
          lastObjectUrlRef.current = url;

          dispatch({ type: "READY", audioUrl: url, audioBlob: blob, mimeType: blob.type || null });
        } catch {
          dispatch({
            type: "ERROR",
            error: {
              code: "unknown",
              message: "Could not finalize the recording.",
            },
          });
        } finally {
          // Always stop tracks + audio graph after stop.
          void teardownMedia();
        }
      };

      // Start capturing small timeslices so ondataavailable fires periodically.
      recorder.start(250);
      dispatch({ type: "STARTED" });
    } catch (err) {
      dispatch({ type: "ERROR", error: formatError(err) });
      void teardownMedia();
    }
  }, [handleHardwareDisconnected, mimeType, revokeLastObjectUrl, setupVisualization, teardownMedia]);

  const stop = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    dispatch({ type: "STOP" });
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      dispatch({
        type: "ERROR",
        error: {
          code: "unknown",
          message: "Could not stop the recorder cleanly.",
        },
      });
      void teardownMedia();
    }
  }, [teardownMedia]);

  const pause = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    try {
      if (recorder.state === "recording") {
        recorder.pause();
        dispatch({ type: "PAUSE" });
      }
    } catch {
      dispatch({
        type: "ERROR",
        error: {
          code: "unknown",
          message: "Could not pause the recording.",
        },
      });
    }
  }, []);

  const resume = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    try {
      if (recorder.state === "paused") {
        recorder.resume();
        dispatch({ type: "RESUME" });
      }
    } catch {
      dispatch({
        type: "ERROR",
        error: {
          code: "unknown",
          message: "Could not resume the recording.",
        },
      });
    }
  }, []);

  const reset = useCallback(() => {
    revokeLastObjectUrl();
    dispatch({ type: "RESET" });
  }, [revokeLastObjectUrl]);

  const isIdle = model.state === "idle";
  const isRecording = model.state === "recording";
  const isPaused = model.state === "paused";
  const isProcessing = model.state === "processing";

  const statusLabel = useMemo(() => {
    switch (model.state) {
      case "idle":
        return "Idle";
      case "recording":
        return "Recording";
      case "paused":
        return "Paused";
      case "processing":
        return "Processing";
      default:
        return "Idle";
    }
  }, [model.state]);

  const canStart = isIdle && !isProcessing;
  const canStop = isRecording || isPaused;

  const primaryButtonLabel = isPaused ? "Resume" : "Start";
  const primaryButtonAction = isPaused ? resume : start;
  const primaryDisabled = isProcessing || isRecording;

  const pauseDisabled = !isRecording || isProcessing;
  const stopDisabled = !canStop || isProcessing;

  const downloadName = useMemo(() => {
    const ext = model.mimeType?.includes("ogg") ? "ogg" : "webm";
    return `recording.${ext}`;
  }, [model.mimeType]);

  const backendWsUrl = useMemo(() => {
    // e.g. ws://localhost:8000/ws/transcribe
    return process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? "ws://localhost:8000/ws/transcribe";
  }, []);

  const [transcribeUi, setTranscribeUi] = React.useState<{
    isTranscribing: boolean;
    transcript: string | null;
    error: string | null;
  }>({ isTranscribing: false, transcript: null, error: null });

  const doTranscribe = useCallback(async () => {
    const blob = model.audioBlob;
    if (!blob) return;

    setTranscribeUi({ isTranscribing: true, transcript: null, error: null });

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(backendWsUrl);
      ws.binaryType = "arraybuffer";

      const transcript = await new Promise<string>((resolve, reject) => {
        if (!ws) {
          reject(new Error("WebSocket not initialized"));
          return;
        }

        const timeout = window.setTimeout(() => {
          reject(new Error("Transcription timed out"));
          try {
            ws?.close();
          } catch {
            // ignore
          }
        }, 60_000);

        ws.onopen = async () => {
          try {
            const data = await blob.arrayBuffer();
            ws?.send(data);
          } catch (e) {
            window.clearTimeout(timeout);
            reject(e);
          }
        };

        ws.onmessage = (evt) => {
          window.clearTimeout(timeout);
          resolve(String(evt.data ?? ""));
          try {
            ws?.close();
          } catch {
            // ignore
          }
        };

        ws.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error("WebSocket error"));
        };

        ws.onclose = (evt) => {
          // If it closed before we got a message, treat it as failure.
          if (evt.code !== 1000) {
            // ignore normal close
          }
        };
      });

      setTranscribeUi({ isTranscribing: false, transcript: transcript.trim(), error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to transcribe.";
      setTranscribeUi({ isTranscribing: false, transcript: null, error: message });
      try {
        ws?.close();
      } catch {
        // ignore
      }
    }
  }, [backendWsUrl, model.audioBlob]);

  return (
    <section className="w-full max-w-3xl rounded-2xl border border-white/10 bg-zinc-950 px-5 py-6 text-zinc-100 shadow-sm">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Audio Recorder</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Record audio from your microphone with a live waveform.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={
              "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium " +
              (isRecording
                ? "bg-emerald-500/15 text-emerald-200"
                : isPaused
                  ? "bg-amber-500/15 text-amber-200"
                  : isProcessing
                    ? "bg-sky-500/15 text-sky-200"
                    : "bg-white/10 text-zinc-200")
            }
            aria-live="polite"
          >
            {statusLabel}
          </span>
        </div>
      </header>

      <div className="mt-5">
        <div className="rounded-xl border border-white/10 bg-black/40 p-3">
          <SiriWaveform
            className=""
            getAudioData={getLiveAudioData}
            defaultEnabled={true}
            bufferLength={128}
          />
        </div>

        {model.error ? (
          <div
            className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
            role="alert"
          >
            <div className="font-medium">Recording error</div>
            <div className="mt-1 text-rose-100/90">{model.error.message}</div>
          </div>
        ) : null}

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={primaryButtonAction}
            disabled={!canStart && !isPaused ? true : primaryDisabled}
            className={
              "inline-flex h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold transition " +
              (primaryDisabled && !isPaused
                ? "cursor-not-allowed bg-white/10 text-zinc-400"
                : "bg-white text-zinc-950 hover:bg-zinc-200")
            }
          >
            {primaryButtonLabel}
          </button>

          <button
            type="button"
            onClick={pause}
            disabled={pauseDisabled}
            className={
              "inline-flex h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold transition " +
              (pauseDisabled
                ? "cursor-not-allowed bg-white/10 text-zinc-400"
                : "bg-white/10 text-zinc-100 hover:bg-white/15")
            }
          >
            Pause
          </button>

          <button
            type="button"
            onClick={stop}
            disabled={stopDisabled}
            className={
              "inline-flex h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold transition " +
              (stopDisabled
                ? "cursor-not-allowed bg-white/10 text-zinc-400"
                : "bg-white/10 text-zinc-100 hover:bg-white/15")
            }
          >
            Stop
          </button>

          <button
            type="button"
            onClick={reset}
            disabled={isProcessing}
            className={
              "inline-flex h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold transition " +
              (isProcessing
                ? "cursor-not-allowed bg-white/10 text-zinc-400"
                : "bg-transparent text-zinc-300 hover:text-zinc-100")
            }
          >
            Reset
          </button>
        </div>

        <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4">
          <h3 className="text-sm font-semibold">Last recording</h3>
          {model.audioUrl ? (
            <div className="mt-3 space-y-3">
              <audio controls src={model.audioUrl} className="w-full" />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-zinc-400">
                  Format: <span className="text-zinc-200">{model.mimeType ?? "(unknown)"}</span>
                </p>
                <a
                  href={model.audioUrl}
                  download={downloadName}
                  className="inline-flex h-9 items-center justify-center rounded-lg bg-white px-3 text-sm font-semibold text-zinc-950 hover:bg-zinc-200"
                >
                  Download
                </a>
              </div>

              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm font-semibold">Transcription</div>
                  <button
                    type="button"
                    onClick={doTranscribe}
                    disabled={transcribeUi.isTranscribing}
                    className={
                      "inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-semibold transition " +
                      (transcribeUi.isTranscribing
                        ? "cursor-not-allowed bg-white/10 text-zinc-400"
                        : "bg-white/10 text-zinc-100 hover:bg-white/15")
                    }
                  >
                    {transcribeUi.isTranscribing ? "Transcribing…" : "Transcribe"}
                  </button>
                </div>

                {transcribeUi.error ? (
                  <div
                    className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
                    role="alert"
                  >
                    {transcribeUi.error}
                  </div>
                ) : null}

                {transcribeUi.transcript ? (
                  <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-200">
                    {transcribeUi.transcript}
                  </p>
                ) : (
                  <p className="mt-3 text-sm text-zinc-400">
                    Click “Transcribe” to send the recording to the backend.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p className="mt-2 text-sm text-zinc-400">No recording yet.</p>
          )}
        </div>

        <div className="mt-4 text-xs text-zinc-500">
          <p>
            Privacy: audio is recorded locally in your browser. Transcription uploads the last recording to your backend.
          </p>
        </div>
      </div>
    </section>
  );
}
