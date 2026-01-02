from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from app.whisper_service import transcribe
import tempfile
import os

app = FastAPI()

@app.websocket("/ws/transcribe")
async def websocket_transcribe(ws: WebSocket):
    await ws.accept()
    print("Client connected to transcription service")

    try:
        while True:
            # 1. Receive audio data
            audio_bytes = await ws.receive_bytes()

            # 2. Save and process audio
            # We use delete=False because on Windows, some libraries 
            # can't open a file while it's still "held" by the tempfile process.
            # MediaRecorder in browsers typically produces WebM/Opus or Ogg/Opus.
            # The extension helps ffmpeg-based loaders pick the right demuxer.
            with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as temp:
                temp.write(audio_bytes)
                temp_path = temp.name

            try:
                # 3. Transcribe
                text = transcribe(temp_path)
                
                # 4. Send result back
                await ws.send_text(text)
            finally:
                # 5. Clean up the temp file manually
                if os.path.exists(temp_path):
                    os.remove(temp_path)

    except WebSocketDisconnect:
        print("Client disconnected normally")
    except Exception as e:
        print(f"Unexpected error: {e}")