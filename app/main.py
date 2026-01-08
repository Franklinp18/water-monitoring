from pathlib import Path
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
UI_DIR = BASE_DIR / "ui"

app = FastAPI(title="HydroMonitor")

# Sirve /assets/*
app.mount("/assets", StaticFiles(directory=UI_DIR / "assets"), name="assets")

# Sirve el dashboard
@app.get("/")
def dashboard():
    return FileResponse(UI_DIR / "index.html")
