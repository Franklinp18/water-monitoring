import json
import time
import random
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

BROKER_HOST = "127.0.0.1"   # <-- IP de la laptop donde corre Docker (host)
BROKER_PORT = 1883

SENSORS = [
    # Caudal 1 (m)  (si realmente es nivel en metros)
    {"device_id": "sim-01", "topic": "hydromonit/sim-01/caudal1_m", "unit": "m", "base": 1.20, "noise": 0.05},
    # Caudal 2 (m)
    {"device_id": "sim-02", "topic": "hydromonit/sim-02/caudal2_m", "unit": "m", "base": 0.95, "noise": 0.06},
    # Presión (PSI)
    {"device_id": "sim-03", "topic": "hydromonit/sim-03/presion_psi", "unit": "PSI", "base": 32.0, "noise": 1.5},
]

PUBLISH_EVERY_SEC = 2


def connect_client():
    c = mqtt.Client(client_id=f"sim-publisher-{random.randint(1000,9999)}", clean_session=True)
    c.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
    c.loop_start()
    return c


def make_value(base, noise):
    return round(base + (random.random() - 0.5) * 2 * noise, 3)


def main():
    client = connect_client()
    print(f"Publishing to mqtt://{BROKER_HOST}:{BROKER_PORT}")

    try:
        while True:
            now = datetime.now(timezone.utc).isoformat()
            for s in SENSORS:
                payload = {
                    "value": make_value(s["base"], s["noise"]),
                    "unit": s["unit"],
                    "device_id": s["device_id"],
                    "ts": now,
                }
                client.publish(s["topic"], json.dumps(payload), qos=0, retain=False)
                print(f"PUB {s['topic']} -> {payload}")
            time.sleep(PUBLISH_EVERY_SEC)
    except KeyboardInterrupt:
        pass
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
