const ws = new WebSocket("ws://localhost:8000/ws/transcribe");

ws.onmessage = (e) => console.log("TEXT:", e.data);
ws.onopen = () => console.log("WebSocket connection established");
