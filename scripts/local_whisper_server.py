#!/usr/bin/env python3
"""
Tiny FastAPI server that mimics OpenAI's /v1/audio/transcriptions endpoint
using openai-whisper running locally. Useful during PhotoSpeak development
so you don't burn OpenAI credits while iterating on the UX.

Setup (one-time):
    brew install ffmpeg
    pip install -U openai-whisper "fastapi" "uvicorn[standard]" python-multipart

Run:
    python scripts/local_whisper_server.py
    # Listens on http://0.0.0.0:8090 by default.
    # 8090 was picked to avoid Expo dev server (8081) and common dev ports.
    # Override the model with WHISPER_MODEL=small.en (default: base.en).
    # Override the port with PORT=9000.

Wire it up in PhotoSpeak (.env):
    EXPO_PUBLIC_WHISPER_ENDPOINT=http://localhost:8090/v1/audio/transcriptions
    EXPO_PUBLIC_OPENAI_API_KEY=local

iOS Simulator can reach the host machine via localhost. For a real device
on the same Wi-Fi, replace localhost with your Mac's LAN IP (e.g. 192.168.x.x).
Restart `npx expo start` after changing .env so the new value gets bundled.

Model size guide (download happens on first run):
    tiny.en    ~75 MB     fastest, lowest accuracy
    base.en    ~150 MB    good default for development
    small.en   ~500 MB    noticeably better, ~3x slower than base
    medium.en  ~1.5 GB    closer to OpenAI's whisper-1 quality
"""

from __future__ import annotations

import os
import tempfile
from typing import Optional

import uvicorn
import whisper
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import PlainTextResponse

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base.en")
print(f"[local-whisper] Loading model: {MODEL_NAME} ...")
model = whisper.load_model(MODEL_NAME)
print(f"[local-whisper] Model loaded.")

app = FastAPI()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model": MODEL_NAME}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model_param: str = Form("whisper-1", alias="model"),
    language: Optional[str] = Form(None),
    response_format: str = Form("json"),
):
    suffix = os.path.splitext(file.filename or "audio.m4a")[1] or ".m4a"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        result = model.transcribe(tmp_path, language=language, fp16=False)
        text = (result.get("text") or "").strip()
        print(f"[local-whisper] -> {text[:80]}{'...' if len(text) > 80 else ''}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    if response_format == "text":
        return PlainTextResponse(text)
    return {"text": text}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8090"))
    print(f"[local-whisper] Listening on http://0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
