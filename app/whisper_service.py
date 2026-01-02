from faster_whisper import WhisperModel

# Use "base" for balance, "small" for better accuracy
model = WhisperModel(
    "base",
    device="cpu",
    compute_type="int8"
)

def transcribe(audio_path: str) -> str:
    segments, _ = model.transcribe(audio_path)
    return " ".join([seg.text for seg in segments])
