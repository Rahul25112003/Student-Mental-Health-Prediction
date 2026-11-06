"use strict";

/* ============ Config ============ */
// Change this if your FastAPI server runs elsewhere.
const API_BASE_URL = "https://student-mental-health-prediction-v18f.onrender.com";                 //========This is the link of backend========//
const PREDICT_URL = `${API_BASE_URL}/predict`;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_SCORE = 10; // gauge scale
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 52;

/* ============ Field rules (mirror the Pydantic model) ============ */
const FIELDS = {
  age:                     { type: "int",    label: "Age",                    min: 10, max: 100 },
  gender:                  { type: "select", label: "Gender" },
  country:                 { type: "text",   label: "Country" },
  academic_level:          { type: "select", label: "Academic level" },
  most_used_platform:      { type: "select", label: "Most used platform" },
  purpose_of_use:          { type: "select", label: "Purpose of use" },
  avg_daily_usage_hours:   { type: "float",  label: "Average daily usage", min: 0, max: 24 },
  daily_unlocks:           { type: "int",    label: "Daily unlocks",       min: 0 },
  study_hours:             { type: "float",  label: "Study hours",         min: 0, max: 24 },
  physical_activity_hours: { type: "float",  label: "Physical activity",   min: 0, max: 24 },
  sleep_hours_per_night:   { type: "float",  label: "Sleep hours",         min: 0, max: 24 },
  stress_level:            { type: "select", label: "Stress level" },
};

/* ============ DOM ============ */
const $ = (id) => document.getElementById(id);
const form = $("predictForm");
const submitBtn = $("submitBtn");
const resetBtn = $("resetBtn");
const retryBtn = $("retryBtn");
const formAlert = $("formAlert");

const panels = {
  placeholder: $("placeholder"),
  loader: $("loader"),
  result: $("result"),
  error: $("errorState"),
};

/* ============ UI helpers ============ */
function showPanel(name) {
  Object.entries(panels).forEach(([key, el]) => { el.hidden = key !== name; });
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  submitBtn.classList.toggle("loading", isLoading);
  submitBtn.querySelector(".btn-label").textContent = isLoading ? "Predicting…" : "Predict Score";
}

function setFieldError(name, message) {
  const input = form.elements[name];
  const holder = document.querySelector(`[data-error-for="${name}"]`);
  if (!input || !holder) return;
  holder.textContent = message || "";
  input.closest(".field").classList.toggle("invalid", Boolean(message));
}

function clearErrors() {
  Object.keys(FIELDS).forEach((name) => setFieldError(name, ""));
  formAlert.hidden = true;
  formAlert.textContent = "";
}

function showFormAlert(message) {
  formAlert.textContent = message;
  formAlert.hidden = false;
}

function showErrorPanel(title, message) {
  $("errorTitle").textContent = title;
  $("errorMessage").textContent = message;
  showPanel("error");
}

/* ============ Validation (client side) ============ */
function validateField(name) {
  const rule = FIELDS[name];
  const el = form.elements[name];
  const raw = el.value.trim();

  if (raw === "") return `${rule.label} is required.`;

  if (rule.type === "int" || rule.type === "float") {
    const num = Number(raw);
    if (Number.isNaN(num)) return `${rule.label} must be a number.`;
    if (rule.type === "int" && !Number.isInteger(num)) return `${rule.label} must be a whole number.`;
    if (rule.min !== undefined && num < rule.min) return `${rule.label} must be at least ${rule.min}.`;
    if (rule.max !== undefined && num > rule.max) return `${rule.label} must be at most ${rule.max}.`;
  }
  return "";
}

function validateForm() {
  let firstInvalid = null;
  Object.keys(FIELDS).forEach((name) => {
    const message = validateField(name);
    setFieldError(name, message);
    if (message && !firstInvalid) firstInvalid = form.elements[name];
  });
  if (firstInvalid) firstInvalid.focus();
  return !firstInvalid;
}

/* ============ Build payload ============ */
function buildPayload() {
  const payload = {};
  Object.entries(FIELDS).forEach(([name, rule]) => {
    const value = form.elements[name].value.trim();
    if (rule.type === "int" || rule.type === "float") payload[name] = Number(value);
    else payload[name] = value;
  });
  return payload;
}

/* ============ API ============ */
class ApiError extends Error {
  constructor(message, { status = 0, fieldErrors = null, title = "Request failed" } = {}) {
    super(message);
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.title = title;
  }
}

async function requestPrediction(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(PREDICT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new ApiError("The server took too long to respond. Please try again.", { title: "Request timed out" });
    }
    throw new ApiError(
      `Could not reach the server at ${API_BASE_URL}. Make sure the FastAPI backend is running.`,
      { title: "Connection error" }
    );
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try { body = await response.json(); } catch { /* non-JSON body */ }

  if (!response.ok) {
    // FastAPI validation errors: { detail: [{ loc: ["body","age"], msg: "...", type: "..." }] }
    if (response.status === 422 && Array.isArray(body?.detail)) {
      const fieldErrors = {};
      body.detail.forEach((d) => {
        const field = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : null;
        if (field) fieldErrors[field] = d.msg;
      });
      throw new ApiError("Some inputs were rejected by the server.", {
        status: 422, fieldErrors, title: "Invalid input",
      });
    }
    const detail = typeof body?.detail === "string" ? body.detail : null;
    if (response.status >= 500) {
      throw new ApiError(
        detail || "The server hit an error while making the prediction. Please try again later.",
        { status: response.status, title: "Server error" }
      );
    }
    throw new ApiError(detail || `Unexpected response (HTTP ${response.status}).`, { status: response.status });
  }

  if (typeof body?.predicted_mental_health_score !== "number") {
    throw new ApiError("The server returned an unexpected response.", { title: "Bad response" });
  }
  return body.predicted_mental_health_score;
}

/* ============ Result rendering ============ */
function describeScore(score) {
  if (score >= 7) return { cls: "good", label: "Good wellbeing", msg: "The model estimates a healthy mental wellbeing level for this profile." };
  if (score >= 5) return { cls: "mid",  label: "Moderate",       msg: "The model estimates a moderate level. Habits like sleep and activity may help." };
  return { cls: "low", label: "Needs attention", msg: "The model estimates a lower wellbeing level. Consider healthier routines or seeking support." };
}

function animateNumber(el, target, duration = 1200) {
  const start = performance.now();
  function frame(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = (target * eased).toFixed(2);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function renderResult(score) {
  const info = describeScore(score);
  const label = $("scoreLabel");
  label.textContent = info.label;
  label.className = `score-label ${info.cls}`;
  $("scoreMessage").textContent = info.msg;

  const fill = $("gaugeFill");
  fill.style.strokeDashoffset = GAUGE_CIRCUMFERENCE; // reset
  showPanel("result");

  // let the browser paint the reset state, then animate
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const ratio = Math.max(0, Math.min(score / MAX_SCORE, 1));
    fill.style.strokeDashoffset = GAUGE_CIRCUMFERENCE * (1 - ratio);
    animateNumber($("scoreValue"), score);
  }));
}

/* ============ Events ============ */
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearErrors();

  if (!validateForm()) {
    showFormAlert("Please fix the highlighted fields and try again.");
    return;
  }

  setLoading(true);
  showPanel("loader");

  try {
    const score = await requestPrediction(buildPayload());
    renderResult(score);
  } catch (err) {
    if (err instanceof ApiError && err.fieldErrors) {
      Object.entries(err.fieldErrors).forEach(([name, msg]) => setFieldError(name, msg));
      showFormAlert(err.message);
      showPanel("placeholder");
    } else {
      const title = err instanceof ApiError ? err.title : "Something went wrong";
      showErrorPanel(title, err.message || "Unexpected error.");
    }
  } finally {
    setLoading(false);
  }
});

// Clear a field's error as soon as the user edits it
form.addEventListener("input", (event) => {
  const name = event.target.name;
  if (name in FIELDS) setFieldError(name, "");
});
form.addEventListener("change", (event) => {
  const name = event.target.name;
  if (name in FIELDS) setFieldError(name, "");
});

resetBtn.addEventListener("click", () => {
  form.reset();
  clearErrors();
  showPanel("placeholder");
});

retryBtn.addEventListener("click", () => {
  showPanel("placeholder");
  form.requestSubmit();
});
