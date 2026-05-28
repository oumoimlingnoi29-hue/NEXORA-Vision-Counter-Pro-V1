
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from ultralytics import YOLO
from datetime import datetime
from pathlib import Path
from openpyxl import Workbook
import cv2, numpy as np, sqlite3, tempfile, csv, base64, json

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "nexora.db"
SNAPSHOT_DIR = BASE_DIR / "snapshots"
SNAPSHOT_DIR.mkdir(exist_ok=True)

MODEL_NAME = "yolov8s.pt"
model = YOLO(MODEL_NAME)

TARGET_CLASSES = {
    0: "person",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}

app = FastAPI(title="NEXORA Vision Counter Pro API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class EventIn(BaseModel):
    camera_id: str = "browser-camera"
    object_type: str
    track_id: int | None = None
    confidence: float | None = None
    action: str = "detected"

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = db()
    conn.execute("""
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      camera_id TEXT NOT NULL,
      object_type TEXT NOT NULL,
      track_id INTEGER,
      confidence REAL,
      action TEXT
    )
    """)
    conn.commit()
    conn.close()

init_db()

@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_NAME,
        "classes": list(TARGET_CLASSES.values()),
        "time": datetime.now().isoformat()
    }

@app.post("/events")
def create_event(event: EventIn):
    conn = db()
    now = datetime.now().isoformat(timespec="seconds")
    cur = conn.execute("""
        INSERT INTO events(created_at, camera_id, object_type, track_id, confidence, action)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (now, event.camera_id, event.object_type, event.track_id, event.confidence, event.action))
    conn.commit()
    event_id = cur.lastrowid
    conn.close()
    return {"id": event_id, "created_at": now}

@app.get("/events")
def list_events(limit: int = 200):
    conn = db()
    rows = conn.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.get("/summary")
def summary():
    conn = db()
    rows = conn.execute("""
      SELECT object_type, COUNT(*) as count
      FROM events
      WHERE substr(created_at, 1, 10)=?
      GROUP BY object_type
    """, (datetime.now().date().isoformat(),)).fetchall()
    conn.close()
    return {r["object_type"]: r["count"] for r in rows}

@app.post("/detect/image")
async def detect_image(file: UploadFile = File(...), conf: float = 0.35):
    data = await file.read()
    arr = np.frombuffer(data, np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Invalid image")

    results = model.predict(image, conf=conf, classes=list(TARGET_CLASSES.keys()), verbose=False)[0]
    detections = []

    for box in results.boxes:
        cls_id = int(box.cls[0])
        label = TARGET_CLASSES.get(cls_id)
        if not label:
            continue
        x1, y1, x2, y2 = [float(v) for v in box.xyxy[0]]
        score = float(box.conf[0])
        detections.append({
            "class_id": cls_id,
            "label": label,
            "confidence": score,
            "box": [x1, y1, x2, y2]
        })

    return {"detections": detections}

@app.websocket("/ws/detect")
async def websocket_detect(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            payload = json.loads(await websocket.receive_text())
            image_data = payload.get("image", "")
            conf = float(payload.get("conf", 0.35))

            if "," in image_data:
                image_data = image_data.split(",", 1)[1]

            frame_bytes = base64.b64decode(image_data)
            arr = np.frombuffer(frame_bytes, np.uint8)
            image = cv2.imdecode(arr, cv2.IMREAD_COLOR)

            if image is None:
                await websocket.send_json({"detections": [], "error": "invalid image"})
                continue

            results = model.predict(
                image,
                conf=conf,
                classes=list(TARGET_CLASSES.keys()),
                verbose=False
            )[0]

            detections = []
            for box in results.boxes:
                cls_id = int(box.cls[0])
                label = TARGET_CLASSES.get(cls_id)
                if not label:
                    continue
                x1, y1, x2, y2 = [float(v) for v in box.xyxy[0]]
                score = float(box.conf[0])
                detections.append({
                    "class_id": cls_id,
                    "label": label,
                    "confidence": score,
                    "box": [x1, y1, x2, y2]
                })

            await websocket.send_json({
                "detections": detections,
                "server_time": datetime.now().isoformat(timespec="seconds")
            })

    except WebSocketDisconnect:
        return
    except Exception as e:
        try:
            await websocket.send_json({"detections": [], "error": str(e)})
        except Exception:
            pass

@app.get("/export/csv")
def export_csv():
    conn = db()
    rows = conn.execute("SELECT * FROM events ORDER BY id DESC").fetchall()
    conn.close()

    temp = tempfile.NamedTemporaryFile(delete=False, suffix=".csv", mode="w", newline="", encoding="utf-8-sig")
    fieldnames = ["id", "created_at", "camera_id", "object_type", "track_id", "confidence", "action"]
    writer = csv.DictWriter(temp, fieldnames=fieldnames)
    writer.writeheader()
    for r in rows:
        writer.writerow(dict(r))
    temp.close()
    return FileResponse(temp.name, filename="nexora_events.csv", media_type="text/csv")

@app.get("/export/xlsx")
def export_xlsx():
    conn = db()
    rows = conn.execute("SELECT * FROM events ORDER BY id DESC").fetchall()
    conn.close()

    wb = Workbook()
    ws = wb.active
    ws.title = "Events"
    headers = ["id", "created_at", "camera_id", "object_type", "track_id", "confidence", "action"]
    ws.append(headers)
    for r in rows:
        d = dict(r)
        ws.append([d.get(h) for h in headers])

    temp = tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx")
    wb.save(temp.name)
    return FileResponse(
        temp.name,
        filename="nexora_events.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
