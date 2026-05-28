# NEXORA Vision Counter Pro

เวอร์ชัน Pro แยก Frontend + Backend

## จุดเด่น
- Frontend deploy บน Vercel
- Backend deploy บน Railway
- ใช้ YOLOv8 ฝั่ง Backend
- ตรวจจับ person, car, motorcycle, bus, truck
- ตรวจจับวัตถุอยู่นิ่งและเคลื่อนไหวพร้อมกัน
- มี frontend tracking + count stability
- บันทึก event ลง SQLite
- Export CSV / Excel จาก backend

## Run Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

macOS/Linux:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

## Run Frontend

```bash
cd frontend
python -m http.server 5500
```

เปิด `http://localhost:5500` แล้วใส่ Backend API URL เป็น:

```text
http://127.0.0.1:8000
```

## Deploy
- Backend: Railway, root directory `backend`
- Frontend: Vercel, root directory `frontend`
