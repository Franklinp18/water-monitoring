import os
import json
import asyncio
from datetime import datetime, timezone
from asyncio_mqtt import Client, MqttError

from . import db

MQTT_HOST = os.getenv("MQTT_HOST", "mqtt")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_TOPIC = os.getenv("MQTT_TOPIC", "hydromonit/#")


def _guess_device_from_topic(topic: str) -> str | None:
    # hydromonit/<device>/<metric>
    parts = topic.split("/")
    if len(parts) >= 3:
        return parts[1]
    return None


def _parse_payload(payload_text: str, topic: str):
    ts = datetime.now(timezone.utc).isoformat()
    value = None
    unit = None
    device_id = _guess_device_from_topic(topic)

    # 1) Intenta JSON
    try:
        obj = json.loads(payload_text)
        if isinstance(obj, dict):
            device_id = obj.get("device_id", device_id)
            unit = obj.get("unit", unit)
            if "ts" in obj:
                ts = str(obj["ts"])
            if "value" in obj:
                try:
                    value = float(obj["value"])
                except Exception:
                    value = None
        return ts, value, unit, device_id
    except Exception:
        pass

    # 2) número plano
    try:
        value = float(payload_text.strip())
    except Exception:
        value = None

    return ts, value, unit, device_id


async def mqtt_loop(hub):
    print(f"[MQTT] Starting loop host={MQTT_HOST} port={MQTT_PORT} topic={MQTT_TOPIC}")

    backoff = 1

    while True:
        try:
            async with Client(MQTT_HOST, MQTT_PORT) as client:
                print("[MQTT] Connected. Subscribing...")
                backoff = 1

                async with client.filtered_messages(MQTT_TOPIC) as messages:
                    await client.subscribe(MQTT_TOPIC)
                    print("[MQTT] Subscribed OK. Waiting messages...")

                    async for msg in messages:
                        topic = str(msg.topic)
                        payload_text = msg.payload.decode(errors="replace")

                        # 1) RAW siempre (debug)
                        db.insert_raw(topic, payload_text)

                        # 2) Parse mínimo (value/unit/ts/device)
                        ts, value, unit, device_id = _parse_payload(payload_text, topic)

                        # 3) MANUAL-ONLY: solo procesar si existe métrica que matchee este topic
                        matches = db.metrics_matching_topic(topic)
                        if not matches:
                            # No hay métrica configurada por el usuario para este topic -> NO lecturas, NO WS
                            continue

                        # 4) Por cada métrica que matchee, guardamos lectura y emitimos
                        for m in matches:
                            metric_key = m["key"]
                            unit_final = unit or m.get("unit") or None

                            ok = db.insert_reading(
                                metric_key=metric_key,
                                ts_iso=ts,
                                value=value,
                                unit=unit_final,
                                device_id=device_id,
                                topic=topic,
                                payload_text=payload_text,
                            )
                            if not ok:
                                continue

                            await hub.broadcast({
                                "type": "reading",
                                "metric": metric_key,   # útil para futuro
                                "ts": ts,
                                "value": value,
                                "unit": unit_final,
                                "device_id": device_id,
                                "topic": topic,
                            })

        except MqttError as e:
            print(f"[MQTT] MqttError: {e}. Reconnecting in {backoff}s...")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 10)
            continue
        except Exception as e:
            print(f"[MQTT] FATAL ERROR: {e}. Restarting in {backoff}s...")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 10)
            continue
