import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.getenv("DB_PATH", "/data/hydromonitor.db")


def _conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode=WAL;")
    con.execute("PRAGMA synchronous=NORMAL;")
    con.execute("PRAGMA foreign_keys=ON;")
    con.row_factory = sqlite3.Row
    return con


def _table_columns(con, table: str) -> set[str]:
    rows = con.execute(f"PRAGMA table_info({table})").fetchall()
    return {r["name"] for r in rows}


def init_db():
    con = _conn()
    cur = con.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS metrics (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT,
      kind TEXT DEFAULT 'line',
      topic TEXT,
      desc TEXT DEFAULT '',
      demo INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric_key TEXT NOT NULL,
      ts TEXT NOT NULL,
      value REAL,
      unit TEXT,
      device_id TEXT,
      topic TEXT,
      payload TEXT,
      FOREIGN KEY(metric_key) REFERENCES metrics(key)
    );
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_readings_metric_ts ON readings(metric_key, ts);")

    cur.execute("""
    CREATE TABLE IF NOT EXISTS raw_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_received TEXT NOT NULL,
      topic TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    """)

    # Migraciones simples
    cols = _table_columns(con, "metrics")
    if "desc" not in cols:
        con.execute("ALTER TABLE metrics ADD COLUMN desc TEXT DEFAULT ''")
    if "demo" not in cols:
        con.execute("ALTER TABLE metrics ADD COLUMN demo INTEGER DEFAULT 0")
    if "topic" not in cols:
        con.execute("ALTER TABLE metrics ADD COLUMN topic TEXT")
    if "kind" not in cols:
        con.execute("ALTER TABLE metrics ADD COLUMN kind TEXT DEFAULT 'line'")
    if "unit" not in cols:
        con.execute("ALTER TABLE metrics ADD COLUMN unit TEXT")

    con.commit()
    con.close()


def upsert_metric(
    key: str,
    name: str | None,
    unit: str | None,
    kind: str | None,
    topic: str | None,
    desc: str | None,
    demo: bool | None
):
    con = _conn()
    now = datetime.now(timezone.utc).isoformat()

    name = name or key.replace("_", " ").title()
    kind = kind or "line"
    desc = desc or ""
    demo_int = 1 if demo else 0

    con.execute("""
      INSERT INTO metrics(key, name, unit, kind, topic, desc, demo, created_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET
        name=excluded.name,
        unit=excluded.unit,
        kind=excluded.kind,
        topic=excluded.topic,
        desc=excluded.desc,
        demo=excluded.demo
    """, (key, name, unit, kind, topic, desc, demo_int, now))

    con.commit()
    con.close()


def delete_metric(key: str):
    # Limpia también lecturas asociadas (más ordenado para el demo)
    con = _conn()
    con.execute("DELETE FROM readings WHERE metric_key = ?", (key,))
    con.execute("DELETE FROM metrics WHERE key = ?", (key,))
    con.commit()
    con.close()


# --- MQTT topic match (wildcards + y #)
def mqtt_match(filter: str, topic: str) -> bool:
    if not filter:
        return False
    f = str(filter).split("/")
    t = str(topic).split("/")

    for i in range(len(f)):
        fp = f[i]
        if fp == "#":
            return True
        if i >= len(t):
            return False
        if fp == "+":
            continue
        if fp != t[i]:
            return False

    return len(f) == len(t)


def metrics_matching_topic(topic: str):
    """
    Devuelve métricas (manuales) cuyo 'topic' hace match con el topic entrante.
    - Ignora demo=1 (porque demo no debe consumir MQTT real)
    """
    con = _conn()
    rows = con.execute("""
      SELECT key, unit, kind, topic, demo
      FROM metrics
      WHERE topic IS NOT NULL AND topic != ''
        AND demo = 0
      ORDER BY key
    """).fetchall()
    con.close()

    out = []
    for r in rows:
        if mqtt_match(r["topic"], topic):
            out.append(dict(r))
    return out


def insert_raw(topic: str, payload_text: str):
    con = _conn()
    now = datetime.now(timezone.utc).isoformat()
    con.execute(
        "INSERT INTO raw_messages(ts_received, topic, payload) VALUES(?,?,?)",
        (now, topic, payload_text),
    )

    # Retención 30 días (robusta con datetime())
    con.execute("DELETE FROM raw_messages WHERE datetime(ts_received) < datetime('now','-30 days')")

    con.commit()
    con.close()


def insert_reading(
    metric_key: str,
    ts_iso: str,
    value: float | None,
    unit: str | None,
    device_id: str | None,
    topic: str,
    payload_text: str
) -> bool:
    """
    IMPORTANTE:
    - YA NO auto-crea métricas.
    - Si la métrica no existe, NO inserta (comportamiento manual-only).
    """
    con = _conn()

    exists = con.execute("SELECT 1 FROM metrics WHERE key = ? LIMIT 1", (metric_key,)).fetchone()
    if not exists:
        con.close()
        return False

    con.execute("""
      INSERT INTO readings(metric_key, ts, value, unit, device_id, topic, payload)
      VALUES(?,?,?,?,?,?,?)
    """, (metric_key, ts_iso, value, unit, device_id, topic, payload_text))

    # Retención 30 días (robusta con datetime())
    con.execute("DELETE FROM readings WHERE datetime(ts) < datetime('now','-30 days')")
    con.execute("DELETE FROM raw_messages WHERE datetime(ts_received) < datetime('now','-30 days')")

    con.commit()
    con.close()
    return True


def list_metrics():
    con = _conn()
    rows = con.execute("""
      SELECT key, name, unit, kind, topic, desc, demo
      FROM metrics
      ORDER BY key
    """).fetchall()
    con.close()
    return [dict(r) for r in rows]


def last_raw(limit: int = 20):
    con = _conn()
    rows = con.execute("""
      SELECT ts_received, topic, payload
      FROM raw_messages
      ORDER BY id DESC
      LIMIT ?
    """, (limit,)).fetchall()
    con.close()
    return [dict(r) for r in rows]


def last_readings(limit: int = 20):
    con = _conn()
    rows = con.execute("""
      SELECT metric_key, ts, value, unit, device_id, topic, payload
      FROM readings
      ORDER BY id DESC
      LIMIT ?
    """, (limit,)).fetchall()
    con.close()
    return [dict(r) for r in rows]


def readings(metric_key: str, days: int = 1, limit: int = 500):
    con = _conn()
    rows = con.execute("""
      SELECT ts, value, unit, device_id, topic, payload
      FROM readings
      WHERE metric_key = ?
        AND datetime(ts) >= datetime('now', ?)
      ORDER BY ts ASC
      LIMIT ?
    """, (metric_key, f"-{days} days", limit)).fetchall()
    con.close()
    return [dict(r) for r in rows]
