import asyncio
import logging
from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .realtime import RealtimeHub
from . import db
from .mqtt_bridge import mqtt_loop

log = logging.getLogger("uvicorn.error")

app = FastAPI()
hub = RealtimeHub()
mqtt_task: asyncio.Task | None = None

# UI estática
app.mount("/assets", StaticFiles(directory="app/ui/assets"), name="assets")


@app.get("/")
def index():
    return FileResponse("app/ui/index.html")


@app.on_event("startup")
async def startup():
    global mqtt_task
    log.warning("[STARTUP] init_db() and starting MQTT task...")
    db.init_db()

    # Arranca el bridge MQTT en background
    mqtt_task = asyncio.create_task(mqtt_loop(hub))
    log.warning(f"[STARTUP] mqtt_task created: {mqtt_task is not None}")


@app.on_event("shutdown")
async def shutdown():
    global mqtt_task
    if mqtt_task:
        mqtt_task.cancel()
        log.warning("[SHUTDOWN] mqtt_task cancelled")


@app.websocket("/ws")
async def ws(ws: WebSocket):
    await hub.connect(ws)
    try:
        while True:
            # Mantiene viva la conexión (el cliente puede mandar "ping")
            await ws.receive_text()
    except Exception:
        pass
    finally:
        hub.disconnect(ws)


# API mínima
@app.get("/api/metrics")
def api_metrics():
    return db.list_metrics()


@app.get("/api/debug/raw")
def api_debug_raw(limit: int = 20):
    return db.last_raw(limit=limit)


@app.get("/api/debug/last-readings")
def api_debug_last(limit: int = 20):
    return db.last_readings(limit=limit)


@app.get("/api/metrics/{metric_key}/readings")
def api_metric_readings(metric_key: str, days: int = 1, limit: int = 500):
    return db.readings(metric_key, days=days, limit=limit)
