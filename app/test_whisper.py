from app.whisper_service import transcribe

audio_path = "test.wav"

print("Transcribing...")
text = transcribe(audio_path)

print("RESULT:")
print(text)
