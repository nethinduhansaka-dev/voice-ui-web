
# Voice UI Backend (FastAPI + faster-whisper)

This backend provides a WebSocket endpoint that accepts recorded audio bytes (typically WebM/Opus from the browser) and returns transcribed text using `faster-whisper`.

## Requirements

- Python 3.9+ recommended
- `ffmpeg` available on your system PATH (needed to decode `.webm`/Opus)

## Setup

From this folder:

1) Create and activate a virtual environment

- Windows (PowerShell)

```powershell
python -m venv venv
./venv/Scripts/Activate.ps1
```

2) Install dependencies

```powershell
pip install -r requirements.txt
```

## Run the server

```powershell
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

## WebSocket API

- Endpoint: `ws://127.0.0.1:8000/ws/transcribe`
- Message type: client sends **binary** audio chunks (bytes). Server responds with **text** (the transcript).

Implementation notes:

- Received bytes are written to a temporary file with `.webm` extension (important for Windows + demuxing).
- Transcription is performed by `faster-whisper` using the `base` model on CPU.

## Quick local test (optional)

If you have a `test.wav` in this folder:

```powershell
python -m app.test_whisper
```

## Files

- `app/main.py` — FastAPI WebSocket server (`/ws/transcribe`)
- `app/whisper_service.py` — loads Whisper model and transcribes an audio file
- `requirements.txt` — Python dependencies

