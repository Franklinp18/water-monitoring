import asyncio
import logging
import csv
import io
from fastapi import FastAPI, WebSocket, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from fastapi.responses import StreamingResponse

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


# -----------------------------
# API mínima (ya existente)
# -----------------------------
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


# -----------------------------
# ✅ Agregado: CRUD de métricas
# -----------------------------
class MetricIn(BaseModel):
    key: str
    name: str | None = None
    unit: str | None = None
    kind: str | None = "line"    # kpi | line | bar | table
    topic: str | None = None
    desc: str | None = ""
    demo: bool | None = False


@app.post("/api/metrics")
def api_create_metric(m: MetricIn):
    key = (m.key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="key es obligatorio")

    topic = (m.topic or "").strip()
    if not topic:
        raise HTTPException(status_code=400, detail="topic MQTT es obligatorio")

    kind = (m.kind or "line").strip()
    if kind not in {"kpi", "line", "bar", "table"}:
        kind = "line"

    # Requiere que db.py tenga upsert_metric(...)
    db.upsert_metric(
        key=key,
        name=m.name,
        unit=m.unit,
        kind=kind,
        topic=topic,
        desc=m.desc,
        demo=bool(m.demo),
    )
    return {"ok": True}


@app.delete("/api/metrics/{key}")
def api_delete_metric(key: str):
    key = (key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="key inválido")

    # Requiere que db.py tenga delete_metric(...)
    db.delete_metric(key)
    return {"ok": True}

@app.get("/metric/{metric_key}")
def metric_page(metric_key: str):
    return FileResponse("app/ui/metric.html")




@app.get("/api/metrics/{metric_key}/export.csv")
def api_metric_export_csv(metric_key: str, days: int = 30):
    # Forzamos 1..30 días (MVP)
    days = max(1, min(int(days), 30))

    # Un límite alto, pero controlado. Ajusta si quieres.
    rows = db.readings(metric_key, days=days, limit=200000)

    def generate():
        output = io.StringIO()
        writer = csv.writer(output)

        # header
        writer.writerow(["ts", "value", "unit", "device_id", "topic", "payload"])
        yield output.getvalue()
        output.seek(0)
        output.truncate(0)

        for r in rows:
            writer.writerow([
                r.get("ts", ""),
                r.get("value", ""),
                r.get("unit", ""),
                r.get("device_id", ""),
                r.get("topic", ""),
                r.get("payload", ""),
            ])
            yield output.getvalue()
            output.seek(0)
            output.truncate(0)

    filename = f"hydromonitor_{metric_key}_{days}d.csv"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}

    return StreamingResponse(generate(), media_type="text/csv; charset=utf-8", headers=headers)
