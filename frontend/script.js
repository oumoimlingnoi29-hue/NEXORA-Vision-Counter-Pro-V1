const video = document.getElementById("video");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const resetBtn = document.getElementById("resetBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const exportBtn = document.getElementById("exportBtn");
const clearLogBtn = document.getElementById("clearLogBtn");

const statusText = document.getElementById("statusText");
const backendText = document.getElementById("backendText");

const loading = document.getElementById("loading");
const placeholder = document.getElementById("placeholder");

const apiUrlInput = document.getElementById("apiUrl");
const saveApiBtn = document.getElementById("saveApiBtn");

const confidenceInput = document.getElementById("confidenceInput");
const confidenceText = document.getElementById("confidenceText");
const speedInput = document.getElementById("speedInput");
const stableInput = document.getElementById("stableInput");

const DEFAULT_API_URL =
  "https://nexora-vision-counter-pro-v1-1.onrender.com";

let API_URL =
  localStorage.getItem("NEXORA_API_URL") || DEFAULT_API_URL;

if (
  API_URL.includes("localhost") ||
  API_URL.includes("127.0.0.1") ||
  API_URL.includes("railway.app")
) {
  API_URL = DEFAULT_API_URL;
  localStorage.setItem("NEXORA_API_URL", API_URL);
}

API_URL = normalizeApiUrl(API_URL);
apiUrlInput.value = API_URL;

let stream = null;
let ws = null;
let running = false;
let sending = false;
let lastSentAt = 0;
let lastResponseAt = 0;

let logs = [];

let totals = {
  person: 0,
  car: 0,
  motorcycle: 0,
  large_vehicle: 0,
};

let live = {
  person: 0,
  car: 0,
  motorcycle: 0,
  large_vehicle: 0,
};

let tracks = {};
let nextTrackId = 1;

startBtn.addEventListener("click", startVision);
stopBtn.addEventListener("click", stopVision);

if (resetBtn) {
  resetBtn.addEventListener("click", resetAll);
}

if (fullscreenBtn) {
  fullscreenBtn.addEventListener("click", () => {
    document.querySelector(".camera-frame").requestFullscreen?.();
  });
}

if (exportBtn) {
  exportBtn.addEventListener("click", exportCSV);
}

if (clearLogBtn) {
  clearLogBtn.addEventListener("click", () => {
    logs = [];

    const logList = document.getElementById("logList");
    if (logList) logList.innerHTML = "";
  });
}

if (confidenceInput && confidenceText) {
  confidenceInput.addEventListener("input", () => {
    confidenceText.textContent = `${confidenceInput.value}%`;
  });
}

saveApiBtn.addEventListener("click", () => {
  API_URL = normalizeApiUrl(apiUrlInput.value || DEFAULT_API_URL);
  apiUrlInput.value = API_URL;
  localStorage.setItem("NEXORA_API_URL", API_URL);

  showToast("API URL saved");

  checkBackend();
});

function normalizeApiUrl(url) {
  return String(url || "").trim().replace(/\/$/, "");
}

function getWsUrl() {
  if (API_URL.startsWith("https://")) {
    return API_URL.replace("https://", "wss://") + "/ws/detect";
  }

  if (API_URL.startsWith("http://")) {
    return API_URL.replace("http://", "ws://") + "/ws/detect";
  }

  return "wss://" + API_URL + "/ws/detect";
}

async function checkBackend() {
  try {
    backendText.textContent = "Checking backend...";

    const response = await fetch(`${API_URL}/health`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status}`);
    }

    const data = await response.json();

    backendText.textContent =
      "Backend connected · " + (data.model || "YOLO");

    return true;
  } catch (error) {
    console.error(error);
    backendText.textContent = "Backend not connected";
    return false;
  }
}

async function startVision() {
  loading.classList.remove("hidden");
  startBtn.disabled = true;
  stopBtn.disabled = true;

  try {
    API_URL = normalizeApiUrl(apiUrlInput.value || DEFAULT_API_URL);
    apiUrlInput.value = API_URL;
    localStorage.setItem("NEXORA_API_URL", API_URL);

    const backendReady = await checkBackend();

    if (!backendReady) {
      throw new Error("Backend not ready");
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
    }

    video.srcObject = stream;
    await video.play();

    resizeCanvas();

    await connectWebSocket();

    placeholder.classList.add("hidden");
    statusText.textContent = "Live";

    running = true;
    sending = false;
    lastSentAt = 0;
    lastResponseAt = Date.now();

    stopBtn.disabled = false;
    loading.classList.add("hidden");

    addLog("SYSTEM", "Vision started");
    requestAnimationFrame(loop);
  } catch (error) {
    console.error(error);

    loading.classList.add("hidden");
    startBtn.disabled = false;
    stopBtn.disabled = true;

    stopCameraOnly();

    showToast(error.message || "Cannot start camera or backend");
    addLog("ERROR", error.message || "Cannot start camera or backend");
  }
}

function stopVision() {
  running = false;
  sending = false;

  if (ws) {
    try {
      ws.close();
    } catch {}
  }

  ws = null;

  stopCameraOnly();

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  placeholder.classList.remove("hidden");
  loading.classList.add("hidden");

  statusText.textContent = "Offline";

  startBtn.disabled = false;
  stopBtn.disabled = true;

  addLog("SYSTEM", "Vision stopped");
}

function stopCameraOnly() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  video.srcObject = null;
}

async function connectWebSocket() {
  const wsUrl = getWsUrl();

  addLog("SYSTEM", `Connecting WebSocket: ${wsUrl}`);

  return new Promise((resolve, reject) => {
    let settled = false;

    ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;

        try {
          ws.close();
        } catch {}

        reject(new Error("WebSocket timeout"));
      }
    }, 20000);

    ws.onopen = () => {
      if (settled) return;

      settled = true;
      clearTimeout(timeout);

      backendText.textContent = "YOLO WebSocket connected";
      addLog("SYSTEM", "WebSocket connected");

      resolve();
    };

    ws.onerror = () => {
      if (settled) return;

      settled = true;
      clearTimeout(timeout);

      reject(new Error("Cannot connect WebSocket backend"));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.error) {
          addLog("ERROR", data.error);
          return;
        }

        lastResponseAt = Date.now();

        handleDetections(data.detections || []);
      } catch (error) {
        console.error(error);
        addLog("ERROR", error.message);
      } finally {
        sending = false;
      }
    };

    ws.onclose = () => {
      backendText.textContent = "WebSocket closed";
      sending = false;

      if (running) {
        addLog("ERROR", "WebSocket closed while running");
      }
    };
  });
}

function resizeCanvas() {
  canvas.width = video.videoWidth || video.clientWidth || 1280;
  canvas.height = video.videoHeight || video.clientHeight || 720;
}

function loop(timestamp) {
  if (!running) return;

  const interval = speedInput ? Number(speedInput.value || 1000) : 1000;

  if (sending && Date.now() - lastResponseAt > 7000) {
    sending = false;
    addLog("WARN", "Frame timeout, sending next frame");
  }

  if (
    ws &&
    ws.readyState === WebSocket.OPEN &&
    !sending &&
    video.readyState >= 2 &&
    timestamp - lastSentAt > interval
  ) {
    lastSentAt = timestamp;
    sending = true;
    sendFrame();
  }

  requestAnimationFrame(loop);
}

function sendFrame() {
  if (!video.videoWidth || !video.videoHeight) {
    sending = false;
    return;
  }

  resizeCanvas();

  const offscreen = document.createElement("canvas");

  // ลดขนาดภาพเพื่อให้ Render Free ประมวลผล YOLO ได้ไวขึ้น
  const width = 320;
  const ratio = video.videoHeight / video.videoWidth || 9 / 16;

  offscreen.width = width;
  offscreen.height = Math.round(width * ratio);

  const offctx = offscreen.getContext("2d");
  offctx.drawImage(video, 0, 0, offscreen.width, offscreen.height);

  try {
    const confidence = Number(confidenceInput?.value || 25) / 100;

    ws.send(
      JSON.stringify({
        image: offscreen.toDataURL("image/jpeg", 0.55),
        conf: confidence,
        confidence: confidence,
      })
    );

    setTimeout(() => {
      if (sending && Date.now() - lastResponseAt > 5000) {
        sending = false;
      }
    }, 5000);
  } catch (error) {
    sending = false;
    console.error(error);
    addLog("ERROR", error.message);
  }
}

function handleDetections(detections) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  live = {
    person: 0,
    car: 0,
    motorcycle: 0,
    large_vehicle: 0,
  };

  const backendFrameWidth = 320;
  const backendFrameHeight = Math.round(
    backendFrameWidth *
      ((video.videoHeight || canvas.height) /
        (video.videoWidth || canvas.width))
  );

  const scaleX = canvas.width / backendFrameWidth;
  const scaleY = canvas.height / backendFrameHeight;

  const scaledDetections = detections
    .map((det) => {
      const label = normalizeLabel(det.label);
      if (!label) return null;

      const confidence = det.confidence || det.conf || 0;
      const [x1, y1, x2, y2] = det.box;

      return {
        label,
        confidence,
        box: [
          x1 * scaleX,
          y1 * scaleY,
          x2 * scaleX,
          y2 * scaleY,
        ],
      };
    })
    .filter(Boolean);

  scaledDetections.forEach((det) => {
    live[det.label]++;
    drawDetectionBox(det.box, det.label, det.confidence);
  });

  updateTracks(scaledDetections);
  updateDisplay();
}

function normalizeLabel(label) {
  if (label === "person") return "person";
  if (label === "car") return "car";
  if (label === "motorcycle") return "motorcycle";
  if (label === "bus" || label === "truck") return "large_vehicle";
  return null;
}

function updateTracks(detections) {
  const now = Date.now();
  const stableFrames = stableInput ? Number(stableInput.value || 1) : 1;

  detections.forEach((det) => {
    let bestId = null;
    let bestIou = 0;

    for (const [id, track] of Object.entries(tracks)) {
      if (track.label !== det.label) continue;

      const iou = calcIoU(track.box, det.box);

      if (iou > bestIou) {
        bestIou = iou;
        bestId = id;
      }
    }

    if (bestId && bestIou > 0.2) {
      const track = tracks[bestId];

      track.box = det.box;
      track.lastSeen = now;
      track.frames += 1;

      if (!track.counted && track.frames >= stableFrames) {
        track.counted = true;
        totals[det.label]++;
        addLog("COUNT", `${labelName(det.label)} counted`);
        saveEvent(det, Number(bestId));
      }
    } else {
      const id = String(nextTrackId++);

      tracks[id] = {
        label: det.label,
        box: det.box,
        lastSeen: now,
        frames: 1,
        counted: false,
      };

      if (stableFrames <= 1) {
        tracks[id].counted = true;
        totals[det.label]++;
        addLog("COUNT", `${labelName(det.label)} counted`);
        saveEvent(det, Number(id));
      }
    }
  });

  for (const [id, track] of Object.entries(tracks)) {
    if (now - track.lastSeen > 7000) {
      delete tracks[id];
    }
  }
}

async function saveEvent(det, trackId) {
  try {
    await fetch(`${API_URL}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        camera_id: "browser-camera",
        object_type: det.label,
        track_id: trackId,
        confidence: det.confidence,
        action: "detected",
      }),
    });
  } catch {}
}

function calcIoU(a, b) {
  const [ax1, ay1, ax2, ay2] = a;
  const [bx1, by1, bx2, by2] = b;

  const x1 = Math.max(ax1, bx1);
  const y1 = Math.max(ay1, by1);
  const x2 = Math.min(ax2, bx2);
  const y2 = Math.min(ay2, by2);

  const intersection =
    Math.max(0, x2 - x1) * Math.max(0, y2 - y1);

  const areaA =
    Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1);

  const areaB =
    Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1);

  const union = areaA + areaB - intersection;

  return union <= 0 ? 0 : intersection / union;
}

function drawDetectionBox(box, label, confidence) {
  const [x1, y1, x2, y2] = box;

  const colorMap = {
    person: "#33F6FF",
    car: "#3CFFB0",
    motorcycle: "#FFD166",
    large_vehicle: "#8B5CF6",
  };

  const color = colorMap[label] || "#33F6FF";

  ctx.strokeStyle = color;
  ctx.lineWidth = 3;

  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

  const text = `${labelName(label)} ${Math.round(confidence * 100)}%`;

  ctx.font = "16px Arial";

  const textWidth = ctx.measureText(text).width + 14;

  ctx.fillStyle = "rgba(3, 7, 18, 0.84)";
  ctx.fillRect(x1, Math.max(0, y1 - 28), textWidth, 26);

  ctx.fillStyle = color;
  ctx.fillText(text, x1 + 7, Math.max(18, y1 - 10));
}

function updateDisplay() {
  setText("personLive", live.person);
  setText("carLive", live.car);
  setText("motorcycleLive", live.motorcycle);
  setText("largeVehicleLive", live.large_vehicle);

  setText("personCount", totals.person);
  setText("carCount", totals.car);
  setText("motorcycleCount", totals.motorcycle);
  setText("largeVehicleCount", totals.large_vehicle);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function labelName(label) {
  return {
    person: "Person",
    car: "Car",
    motorcycle: "Motorcycle",
    large_vehicle: "Large Vehicle",
  }[label] || label;
}

function resetAll() {
  totals = {
    person: 0,
    car: 0,
    motorcycle: 0,
    large_vehicle: 0,
  };

  live = {
    person: 0,
    car: 0,
    motorcycle: 0,
    large_vehicle: 0,
  };

  tracks = {};
  nextTrackId = 1;

  updateDisplay();

  addLog("SYSTEM", "Counters reset");
}

function addLog(type, message) {
  console.log(`[${type}]`, message);

  logs.push({
    time: new Date().toLocaleTimeString("th-TH", {
      hour12: false,
    }),
    type,
    message,
  });

  const logList = document.getElementById("logList");

  if (!logList) return;

  const div = document.createElement("div");
  div.className = "log-item";
  div.innerHTML = `
    <span class="log-time">${logs[logs.length - 1].time}</span>
    <span class="log-type">${type}</span>
    <span>${message}</span>
  `;

  logList.prepend(div);
}

function exportCSV() {
  const rows = [
    ["time", "type", "message"],
    ...logs.map((log) => [log.time, log.type, log.message]),
    [],
    ["summary"],
    ["person", totals.person],
    ["car", totals.car],
    ["motorcycle", totals.motorcycle],
    ["large_vehicle", totals.large_vehicle],
  ];

  const csv =
    "\uFEFF" +
    rows
      .map((row) =>
        row
          .map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`)
          .join(",")
      )
      .join("\n");

  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8",
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `nexora-log-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;

  link.click();

  URL.revokeObjectURL(url);
}

function showToast(message) {
  alert(message);
}

window.addEventListener("resize", () => {
  setTimeout(resizeCanvas, 200);
});

window.addEventListener("orientationchange", () => {
  setTimeout(resizeCanvas, 500);
});

checkBackend();
