const STORAGE_PREFIX = "prus-post-validation-v1";
const DATA_PATH = "data/sample_posts.json?v=20260717-post-v3";
const CONFIG = window.PRUS_VALIDATION_CONFIG || { backendUrl: "" };
const ALLOWED_DOMAINS = ["content", "performance", "requirements_access"];

const screens = {
  home: document.querySelector("#home-screen"),
  instructions: document.querySelector("#instructions-screen"),
  exercise: document.querySelector("#exercise-screen"),
  finished: document.querySelector("#finished-screen")
};

const els = {
  status: document.querySelector("#status-pill"),
  newForm: document.querySelector("#new-form"),
  resumeForm: document.querySelector("#resume-form"),
  resumeError: document.querySelector("#resume-error"),
  backHome: document.querySelector("#back-home"),
  startExercise: document.querySelector("#start-exercise"),
  positionLabel: document.querySelector("#position-label"),
  totalLabel: document.querySelector("#total-label"),
  progressBar: document.querySelector("#progress-bar"),
  gameLabel: document.querySelector("#game-label"),
  releaseTimingLabel: document.querySelector("#release-timing-label"),
  postTitle: document.querySelector("#post-title"),
  postBody: document.querySelector("#post-body"),
  binaryDecision: document.querySelector("#binary-decision"),
  domainChoice: document.querySelector("#domain-choice"),
  confirmDomains: document.querySelector("#confirm-domains"),
  changeToNotPrus: document.querySelector("#change-to-not-prus"),
  previous: document.querySelector("#previous"),
  saveExit: document.querySelector("#save-exit"),
  exerciseSaveMessage: document.querySelector("#exercise-save-message"),
  returnHome: document.querySelector("#return-home"),
  remoteSaveMessage: document.querySelector("#remote-save-message"),
  retryRemoteSave: document.querySelector("#retry-remote-save"),
  downloadCsv: document.querySelector("#download-csv"),
  downloadJson: document.querySelector("#download-json")
};

let dataset = null;
let participant = null;
let session = null;
let currentIndex = 0;
let finishing = false;
let lastCheckpointCount = -1;
let remoteSaveInFlight = false;
let pendingRemoteSave = null;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function participantKey(email) {
  return `${STORAGE_PREFIX}:participant:${normalizeEmail(email)}`;
}

function sessionKey(email) {
  return `${STORAGE_PREFIX}:session:${normalizeEmail(email)}`;
}

function showScreen(name) {
  Object.entries(screens).forEach(([key, node]) => {
    node.hidden = key !== name;
  });
}

function setStatus(text) {
  els.status.textContent = text;
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function readJson(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadData() {
  const response = await fetch(DATA_PATH);
  if (!response.ok) {
    throw new Error(`Could not load validation sample: ${response.status}`);
  }
  dataset = await response.json();
  if (!Array.isArray(dataset.posts) || dataset.posts.length !== 500) {
    throw new Error("The post-level validation sample is incomplete.");
  }
  els.totalLabel.textContent = dataset.posts.length;
}

function emptyResponses() {
  return dataset.posts.map((post) => ({
    post_id: post.id,
    human_PRUS: null,
    human_domains: [],
    answered_at: null
  }));
}

function createSession(person) {
  const now = new Date().toISOString();
  return {
    version: 2,
    validation_unit: "topic_root_post",
    participant_email: person.email,
    started_at: now,
    updated_at: now,
    completed_at: null,
    current_index: 0,
    responses: emptyResponses()
  };
}

function responseComplete(response) {
  if (response.human_PRUS === false) return true;
  return response.human_PRUS === true
    && Array.isArray(response.human_domains)
    && response.human_domains.length > 0;
}

function persistLocalSession() {
  if (!participant || !session) return;
  session.updated_at = new Date().toISOString();
  session.current_index = currentIndex;
  saveJson(sessionKey(participant.email), session);
}

async function postRemoteProgress(saveReason) {
  if (!CONFIG.backendUrl) {
    throw new Error("The secure response endpoint is not configured.");
  }
  let lastError = new Error("Secure save failed.");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response = null;
    try {
      // Canonicalize the versioned validation contract at the point of submission.
      // This prevents stale or externally instrumented in-memory fields from
      // misidentifying a post-level session while preserving the user's answers.
      session.validation_unit = "topic_root_post";
      const sampleMetadata = {
        ...dataset.metadata,
        sample_version: "2026-07-17-post-level-v1",
        unit_of_validation: "topic_root_post"
      };
      response = await fetch(CONFIG.backendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participant,
          session,
          sample_metadata: sampleMetadata,
          save_reason: saveReason
        })
      });
    } catch (error) {
      lastError = error instanceof Error ? error : lastError;
    }
    if (response) {
      let result = null;
      try {
        result = await response.json();
      } catch {
        result = null;
      }
      if (response.ok && result?.saved) return result;
      lastError = new Error(result?.error || `Secure save failed (${response.status}).`);
      if (![429, 502, 503, 504].includes(response.status)) throw lastError;
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
  throw lastError;
}

function savePriority(reason) {
  if (reason === "completed") return 3;
  if (reason === "save_exit") return 2;
  return 1;
}

function queueRemoteProgress(saveReason) {
  return new Promise((resolve, reject) => {
    if (!pendingRemoteSave) {
      pendingRemoteSave = { reason: saveReason, waiters: [] };
    } else if (savePriority(saveReason) > savePriority(pendingRemoteSave.reason)) {
      pendingRemoteSave.reason = saveReason;
    }
    pendingRemoteSave.waiters.push({ resolve, reject });
    drainRemoteSaves();
  });
}

async function drainRemoteSaves() {
  if (remoteSaveInFlight || !pendingRemoteSave) return;
  const job = pendingRemoteSave;
  pendingRemoteSave = null;
  remoteSaveInFlight = true;
  try {
    const result = await postRemoteProgress(job.reason);
    job.waiters.forEach(({ resolve }) => resolve(result));
  } catch (error) {
    job.waiters.forEach(({ reject }) => reject(error));
  } finally {
    remoteSaveInFlight = false;
    if (pendingRemoteSave) drainRemoteSaves();
  }
}

function answeredCount() {
  return session.responses.filter(responseComplete).length;
}

function firstUnansweredIndex() {
  const index = session.responses.findIndex((response) => !responseComplete(response));
  return index === -1 ? dataset.posts.length : index;
}

function checkpointIfDue() {
  const completed = answeredCount();
  const interval = Math.max(1, Number(CONFIG.checkpointEvery) || 25);
  if (!CONFIG.backendUrl || completed === 0 || completed % interval !== 0 || completed === lastCheckpointCount) {
    return;
  }
  lastCheckpointCount = completed;
  queueRemoteProgress("checkpoint")
    .then((result) => setStatus(`${result.answered} / ${dataset.posts.length} coded · checkpoint saved`))
    .catch(() => {
      lastCheckpointCount = -1;
      setStatus(`${completed} / ${dataset.posts.length} coded · checkpoint pending`);
    });
}

function startParticipant(person, existingSession = null) {
  participant = person;
  session = existingSession || createSession(person);
  currentIndex = Math.min(firstUnansweredIndex(), dataset.posts.length - 1);
  persistLocalSession();
  setStatus(`${answeredCount()} / ${dataset.posts.length} coded`);
  showScreen("instructions");
}

function syncDomainButtons(response) {
  const selected = new Set(Array.isArray(response.human_domains) ? response.human_domains : []);
  els.domainChoice.querySelectorAll("button[data-domain]").forEach((button) => {
    const active = selected.has(button.dataset.domain);
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
  });
  els.confirmDomains.disabled = selected.size === 0;
}

function showCurrentPost() {
  if (firstUnansweredIndex() >= dataset.posts.length) {
    finishSession();
    return;
  }

  const item = dataset.posts[currentIndex];
  const response = session.responses[currentIndex];
  const completed = answeredCount();
  const progress = Math.round((completed / dataset.posts.length) * 100);

  els.positionLabel.textContent = String(currentIndex + 1);
  els.progressBar.style.width = `${progress}%`;
  els.gameLabel.textContent = item.app_name || "Unknown game";
  els.releaseTimingLabel.textContent = `Published ${Math.abs(item.release_relative_day)} day${Math.abs(item.release_relative_day) === 1 ? "" : "s"} before release`;
  els.postTitle.textContent = item.post_title || "Untitled Steam post";
  els.postBody.textContent = item.post_body || "No captured post text was available.";
  els.domainChoice.hidden = response.human_PRUS !== true;
  els.binaryDecision.hidden = response.human_PRUS === true;
  syncDomainButtons(response);
  els.previous.disabled = currentIndex === 0;
  els.exerciseSaveMessage.textContent = "";
  setStatus(`${completed} / ${dataset.posts.length} coded`);
  showScreen("exercise");
}

function answerNotPrus() {
  session.responses[currentIndex] = {
    ...session.responses[currentIndex],
    human_PRUS: false,
    human_domains: [],
    answered_at: new Date().toISOString()
  };
  advance();
}

function answerPrusPendingDomains() {
  const existingDomains = Array.isArray(session.responses[currentIndex].human_domains)
    ? session.responses[currentIndex].human_domains
    : [];
  session.responses[currentIndex] = {
    ...session.responses[currentIndex],
    human_PRUS: true,
    human_domains: existingDomains,
    answered_at: null
  };
  persistLocalSession();
  els.binaryDecision.hidden = true;
  els.domainChoice.hidden = false;
  syncDomainButtons(session.responses[currentIndex]);
}

function toggleDomain(domain) {
  if (!ALLOWED_DOMAINS.includes(domain)) return;
  const response = session.responses[currentIndex];
  const selected = new Set(Array.isArray(response.human_domains) ? response.human_domains : []);
  if (selected.has(domain)) {
    selected.delete(domain);
  } else {
    selected.add(domain);
  }
  response.human_PRUS = true;
  response.human_domains = ALLOWED_DOMAINS.filter((value) => selected.has(value));
  response.answered_at = null;
  persistLocalSession();
  syncDomainButtons(response);
}

function confirmDomains() {
  const response = session.responses[currentIndex];
  if (!Array.isArray(response.human_domains) || response.human_domains.length === 0) return;
  response.human_PRUS = true;
  response.answered_at = new Date().toISOString();
  advance();
}

function advance() {
  persistLocalSession();
  checkpointIfDue();
  if (firstUnansweredIndex() >= dataset.posts.length) {
    finishSession();
    return;
  }
  currentIndex = firstUnansweredIndex();
  showCurrentPost();
}

function goPrevious() {
  if (currentIndex <= 0) return;
  currentIndex -= 1;
  persistLocalSession();
  showCurrentPost();
}

async function saveCompletedSession() {
  els.retryRemoteSave.hidden = true;
  els.remoteSaveMessage.className = "save-message";
  els.remoteSaveMessage.textContent = "Saving the completed responses to the research repository…";
  setStatus("Saving completed session…");
  try {
    const result = await queueRemoteProgress("completed");
    els.remoteSaveMessage.className = "save-message success";
    els.remoteSaveMessage.textContent = "Saved successfully to the secure research repository.";
    setStatus(`${dataset.posts.length} / ${dataset.posts.length} coded · securely saved`);
    return result;
  } catch (error) {
    els.remoteSaveMessage.className = "save-message error";
    els.remoteSaveMessage.textContent = `${error.message} The completed responses remain saved in this browser; please retry.`;
    els.retryRemoteSave.hidden = false;
    setStatus("Completed · secure save needs retry");
    throw error;
  }
}

async function finishSession() {
  if (finishing) return;
  finishing = true;
  session.completed_at = session.completed_at || new Date().toISOString();
  currentIndex = dataset.posts.length - 1;
  persistLocalSession();
  setStatus(`${dataset.posts.length} / ${dataset.posts.length} coded`);
  showScreen("finished");
  try {
    await saveCompletedSession();
  } catch {
    // The completion screen exposes a retry action and download backups.
  } finally {
    finishing = false;
  }
}

function mergedRows() {
  return dataset.posts.map((item, index) => {
    const response = session.responses[index];
    return {
      participant_name: participant.name,
      participant_email: participant.email,
      participant_phone: participant.phone || "",
      validation_order: item.validation_order,
      post_id: item.id,
      app_id: item.app_id,
      app_name: item.app_name,
      release_date: item.release_date,
      release_relative_day: item.release_relative_day,
      post_title: item.post_title,
      post_body: item.post_body,
      human_PRUS: response.human_PRUS,
      human_domains: (response.human_domains || []).join("|"),
      answered_at: response.answered_at
    };
  });
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const stringValue = String(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }
  return stringValue;
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadCsv() {
  const rows = mergedRows();
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))
  ].join("\n");
  download(`prus_post_validation_${normalizeEmail(participant.email)}.csv`, csv, "text/csv;charset=utf-8");
}

function downloadJson() {
  const payload = {
    participant,
    session,
    sample_metadata: dataset.metadata,
    rows: mergedRows()
  };
  download(
    `prus_post_validation_${normalizeEmail(participant.email)}.json`,
    JSON.stringify(payload, null, 2),
    "application/json;charset=utf-8"
  );
}

els.newForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(els.newForm);
  const email = normalizeEmail(form.get("email"));
  const person = {
    name: String(form.get("name")).trim(),
    email,
    phone: String(form.get("phone")).trim(),
    created_at: new Date().toISOString()
  };
  saveJson(participantKey(email), person);
  startParticipant(person);
});

els.resumeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = normalizeEmail(new FormData(els.resumeForm).get("email"));
  const person = readJson(participantKey(email));
  const existingSession = readJson(sessionKey(email));
  if (!person || !existingSession) {
    els.resumeError.hidden = false;
    return;
  }
  els.resumeError.hidden = true;
  startParticipant(person, existingSession);
});

els.backHome.addEventListener("click", () => {
  showScreen("home");
  setStatus("Not started");
});

els.startExercise.addEventListener("click", () => {
  currentIndex = firstUnansweredIndex();
  if (currentIndex >= dataset.posts.length) {
    finishSession();
  } else {
    showCurrentPost();
  }
});

els.binaryDecision.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-prus]");
  if (!button) return;
  if (button.dataset.prus === "true") {
    answerPrusPendingDomains();
  } else {
    answerNotPrus();
  }
});

els.domainChoice.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-domain]");
  if (!button) return;
  toggleDomain(button.dataset.domain);
});

els.confirmDomains.addEventListener("click", confirmDomains);
els.changeToNotPrus.addEventListener("click", answerNotPrus);
els.previous.addEventListener("click", goPrevious);
els.saveExit.addEventListener("click", async () => {
  persistLocalSession();
  els.saveExit.disabled = true;
  els.exerciseSaveMessage.className = "save-message";
  els.exerciseSaveMessage.textContent = "Saving a secure checkpoint…";
  setStatus("Saving checkpoint…");
  try {
    await queueRemoteProgress("save_exit");
    els.exerciseSaveMessage.className = "save-message success";
    els.exerciseSaveMessage.textContent = "Checkpoint saved successfully.";
    setStatus(`${answeredCount()} / ${dataset.posts.length} coded · checkpoint saved`);
    showScreen("home");
  } catch (error) {
    els.exerciseSaveMessage.className = "save-message error";
    els.exerciseSaveMessage.textContent = `${error.message} Your browser copy is safe; try Save and Exit again.`;
    setStatus("Checkpoint save failed");
  } finally {
    els.saveExit.disabled = false;
  }
});
els.returnHome.addEventListener("click", () => showScreen("home"));
els.downloadCsv.addEventListener("click", downloadCsv);
els.downloadJson.addEventListener("click", downloadJson);
els.retryRemoteSave.addEventListener("click", () => {
  saveCompletedSession().catch(() => {});
});

loadData()
  .then(() => {
    if (CONFIG.validationPaused) {
      document.querySelector("#validation-pause-notice").hidden = false;
      document.querySelectorAll("#new-form input, #new-form button, #resume-form input, #resume-form button")
        .forEach((control) => {
          control.disabled = true;
        });
      setStatus("Temporarily paused");
    } else {
      document.querySelector("#validation-pause-notice")?.remove();
      setStatus("Ready");
    }
  })
  .catch((error) => {
    setStatus("Data load failed");
    screens.home.innerHTML = `<p class="error">${error.message}</p>`;
  });
