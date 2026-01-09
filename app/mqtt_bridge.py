import os
import json
import asyncio
from datetime import datetime, timezone
from asyncio_mqtt import Client, MqttError

from . import db

MQTT_HOST = os.getenv("MQTT_HOST", "mqtt")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_TOPIC = os.getenv("MQTT_TOPIC", "hydromonit/#")


def _guess_metric_from_topic(topic: str) -> tuple[str, str | None]:
    # hydromonit/<device>/<metric>
    parts = topic.split("/")
    device_id = parts[1] if len(parts) >= 3 else None
    metric = parts[-1] if parts else "unknown"
    return metric, device_id


def _parse_payload(payload_text: str, topic: str):
    metric, device_from_topic = _guess_metric_from_topic(topic)
    ts = datetime.now(timezone.utc).isoformat()
    value = None
    unit = None
    device_id = device_from_topic

    # 1) Intenta JSON
    try:
        obj = json.loads(payload_text)
        if isinstance(obj, dict):
            metric = str(obj.get("metric", metric))
            device_id = obj.get("device_id", device_id)
            unit = obj.get("unit", unit)
            if "ts" in obj:
                ts = str(obj["ts"])
            if "value" in obj:
                try:
                    value = float(obj["value"])
                except Exception:
                    value = None
        # Si es JSON pero no dict, se guarda como raw igual
        return metric, ts, value, unit, device_id
    except Exception:
        pass

    # 2) Si no es JSON, intenta número plano
    try:
        value = float(payload_text.strip())
    except Exception:
        value = None

    return metric, ts, value, unit, device_id


async def mqtt_loop(hub):
    print(f"[MQTT] Starting loop host={MQTT_HOST} port={MQTT_PORT} topic={MQTT_TOPIC}")

    # backoff simple para reconexión (evita loop agresivo)
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

                        print(f"[MQTT] Message topic={topic} payload={payload_text}")

                        # Guarda raw siempre
                        db.insert_raw(topic, payload_text)

                        metric_key, ts, value, unit, device_id = _parse_payload(payload_text, topic)

                        # Guarda lectura
                        db.insert_reading(
                            metric_key=metric_key,
                            ts_iso=ts,
                            value=value,
                            unit=unit,
                            device_id=device_id,
                            topic=topic,
                            payload_text=payload_text,
                        )

                        # Emite en vivo
                        await hub.broadcast({
                            "type": "reading",
                            "metric": metric_key,
                            "ts": ts,
                            "value": value,
                            "unit": unit,
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
