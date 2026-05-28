const video = document.getElementById("video");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

const statusText = document.getElementById("statusText");
const backendText = document.getElementById("backendText");

const loading = document.getElementById("loading");
const placeholder = document.getElementById("placeholder");

const apiUrlInput = document.getElementById("apiUrl");
const saveApiBtn = document.getElementById("saveApiBtn");

const confidenceInput = document.getElementById("confidence");

const DEFAULT_API_URL =
  "https://nexora-vision-counter-pro-v1-1.onrender.com";

let savedApiUrl = localStorage.getItem("NEXORA_API_URL");

if (
  !savedApiUrl ||
  savedApiUrl.includes("127.0.0.1") ||
  savedApiUrl.includes("localhost") ||
  savedApiUrl.includes("railway.app")
) {
  savedApiUrl = DEFAULT_API_URL;
  localStorage.setItem("NEXORA_API_URL", savedApiUrl);
}

let API_URL = normalizeApiUrl(savedApiUrl);

apiUrlInput.value = API_URL;

let stream = null;
let ws = null;
let running = false;
let sending = false;

let tracks = {};

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

saveApiBtn.addEventListener("click", () => {
  API_URL = normalizeApiUrl(apiUrlInput.value || DEFAULT_API_URL);

  apiUrlInput.value = API_URL;

  localStorage.setItem("NEXORA_API_URL", API_URL);

  showToast("API URL saved");

  checkBackend();
});

async function checkBackend() {
  try {
    backendText.textContent = "Checking backend...";

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 20000);

    const response = await fetch(`${API_URL}/health`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error("Backend error");
    }

    const data = await response.json();

    backendText.textContent =
      "Backend connected · " + (data.model || "YOLO");

    return true;
  } catch (e) {
    backendText.textContent = "Backend not connected";

    addLog("ERROR", "Backend not connected");

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
          facingMode: {
            ideal: "environment",
          },
          width: {
            ideal: 1280,
          },
          height: {
            ideal: 720,
          },
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

    stopBtn.disabled = false;

    running = true;

    loading.classList.add("hidden");

    addLog("SYSTEM", "Vision started");

    requestAnimationFrame(loop);
  } catch (e) {
    console.error(e);

    loading.classList.add("hidden");

    startBtn.disabled = false;
    stopBtn.disabled = true;

    stopCameraOnly();

    showToast("Cannot start camera or backend");

    addLog("ERROR", e.message);
  }
}

function stopVision() {
  running = false;

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

  sending = false;

  tracks = {};

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

  addLog("SYSTEM", "Connecting WebSocket");

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

        handleDetections(data.detections || []);
      } catch (e) {
        addLog("ERROR", e.message);
      } finally {
        sending = false;
      }
    };

    ws.onclose = () => {
      backendText.textContent = "WebSocket closed";

      sending = false;

      if (running) {
        addLog("ERROR", "WebSocket closed");
      }
    };
  });
}

function resizeCanvas() {
  canvas.width = video.videoWidth || video.clientWidth;
  canvas.height = video.videoHeight || video.clientHeight;
}

function loop() {
  if (!running) return;

  if (
    ws &&
    ws.readyState === WebSocket.OPEN &&
    !sending &&
    video.readyState >= 2
  ) {
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

  const width = 640;

  const ratio =
    (video.videoHeight / video.videoWidth) || 9 / 16;

  offscreen.width = width;
  offscreen.height = Math.round(width * ratio);

  const offctx = offscreen.getContext("2d");

  offctx.drawImage(
    video,
    0,
    0,
    offscreen.width,
    offscreen.height
  );

  try {
    ws.send(
      JSON.stringify({
        image: offscreen.toDataURL("image/jpeg", 0.72),
        conf: Number(confidenceInput.value) / 100,
      })
    );
  } catch (e) {
    sending = false;

    addLog("ERROR", e.message);
  }
}

function handleDetections(detections) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  detections.forEach((det) => {
    const [x1, y1, x2, y2] = det.box;

    ctx.strokeStyle = "#33F6FF";
    ctx.lineWidth = 3;

    ctx.strokeRect(
      x1,
      y1,
      x2 - x1,
      y2 - y1
    );

    ctx.fillStyle = "#33F6FF";

    ctx.font = "16px Arial";

    ctx.fillText(
      `${det.class} ${Math.round(det.conf * 100)}%`,
      x1,
      y1 - 10
    );
  });
}

function addLog(type, message) {
  console.log(`[${type}]`, message);
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
