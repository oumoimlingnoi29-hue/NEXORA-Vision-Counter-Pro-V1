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

const confidenceInput = document.getElementById("confidenceInput");

const peopleCount = document.getElementById("peopleCount");
const carsCount = document.getElementById("carsCount");
const motorcyclesCount = document.getElementById("motorcyclesCount");
const trucksCount = document.getElementById("trucksCount");

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

startBtn.addEventListener("click", startVision);
stopBtn.addEventListener("click", stopVision);

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

    const response = await fetch(`${API_URL}/health`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error("Backend error");
    }

    const data = await response.json();

    backendText.textContent =
      "Backend connected · " + (data.model || "YOLO");

    return true;
  } catch (e) {
    backendText.textContent = "Backend not connected";

    console.error(e);

    return false;
  }
}

async function startVision() {
  loading.classList.remove("hidden");

  startBtn.disabled = true;

  try {
    const backendReady = await checkBackend();

    if (!backendReady) {
      throw new Error("Backend not ready");
    }

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

    video.srcObject = stream;

    await video.play();

    resizeCanvas();

    await connectWebSocket();

    placeholder.classList.add("hidden");

    statusText.textContent = "Live";

    running = true;

    stopBtn.disabled = false;

    loading.classList.add("hidden");

    requestAnimationFrame(loop);
  } catch (e) {
    console.error(e);

    stopVision();

    showToast("Cannot start camera or backend");
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

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());

    stream = null;
  }

  video.srcObject = null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  placeholder.classList.remove("hidden");

  statusText.textContent = "Offline";

  startBtn.disabled = false;
  stopBtn.disabled = true;

  loading.classList.add("hidden");
}

async function connectWebSocket() {
  const wsUrl = getWsUrl();

  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      backendText.textContent = "YOLO WebSocket connected";
      resolve();
    };

    ws.onerror = () => {
      reject(new Error("Cannot connect WebSocket"));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        handleDetections(data.detections || []);
      } catch (e) {
        console.error(e);
      } finally {
        sending = false;
      }
    };

    ws.onclose = () => {
      backendText.textContent = "WebSocket closed";
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

  ws.send(
    JSON.stringify({
      image: offscreen.toDataURL("image/jpeg", 0.72),
      conf: Number(confidenceInput.value || 40) / 100,
    })
  );
}

function handleDetections(detections) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let people = 0;
  let cars = 0;
  let motorcycles = 0;
  let trucks = 0;

  detections.forEach((det) => {
    const [x1, y1, x2, y2] = det.box;

    const label = det.label || "object";

    const confidence = det.confidence || 0;

    if (label === "person") people++;
    if (label === "car") cars++;
    if (label === "motorcycle") motorcycles++;
    if (label === "truck" || label === "bus") trucks++;

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
      `${label} ${Math.round(confidence * 100)}%`,
      x1,
      y1 - 10
    );
  });

  peopleCount.textContent = people;
  carsCount.textContent = cars;
  motorcyclesCount.textContent = motorcycles;
  trucksCount.textContent = trucks;
}

function showToast(message) {
  alert(message);
}

window.addEventListener("resize", () => {
  setTimeout(resizeCanvas, 200);
});

checkBackend();
