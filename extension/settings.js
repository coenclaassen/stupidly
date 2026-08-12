const SETTINGS_KEY = "settings";
const MAX_LIMIT_MINUTES = 999;
const MAX_WAIT_MINUTES = 999;

const rulesBody = document.getElementById("rules-body");
const addRuleButton = document.getElementById("add-rule");
const waitBody = document.getElementById("wait-body");
const waitControlRow = document.querySelector(".wait-control-row");
const lockStatus = document.getElementById("lock-status");
const lockStatusTitle = document.getElementById("lock-status-title");
const lockStatusMessage = document.getElementById("lock-status-message");

const draftInputs = {
  domain: document.getElementById("draft-domain"),
  session: document.getElementById("draft-session"),
  day: document.getElementById("draft-day"),
  redirect: document.getElementById("draft-redirect")
};

let settings = { changeWaitSeconds: 0, rules: [] };
let freshRuleIds = new Set();
let remainingLockMs = 0;
let lockActiveSince = null;
let globallyUnlocked = true;
let lockTimer = null;

init();

async function init() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = sanitizeSettings(stored[SETTINGS_KEY]);

  renderRules();
  renderWaitTable();
  resetLockCountdown();
  updateLockState();

  addRuleButton.addEventListener("click", addDraftRule);
  document.addEventListener("visibilitychange", handlePageAttentionChanged);
  window.addEventListener("focus", handlePageAttentionChanged);
  window.addEventListener("blur", handlePageAttentionChanged);

  for (const input of Object.values(draftInputs)) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") addDraftRule();
    });
  }
}

function startLockTimerIfNeeded() {
  if (lockTimer || settings.changeWaitSeconds <= 0 || globallyUnlocked || !isPageActivelyViewed()) return;
  if (lockActiveSince == null) lockActiveSince = Date.now();
  lockTimer = window.setInterval(updateLockState, 1000);
}

function stopLockTimer() {
  if (!lockTimer) return;
  clearInterval(lockTimer);
  lockTimer = null;
}

function handlePageAttentionChanged() {
  if (settings.changeWaitSeconds <= 0) {
    updateLockState();
    return;
  }

  if (isPageActivelyViewed()) {
    updateLockState();
    return;
  }

  if (globallyUnlocked) {
    resetLockCountdown();
  } else {
    pauseLockCountdown();
  }

  updateLockState();
}

function resetLockCountdown() {
  stopLockTimer();
  lockActiveSince = null;
  remainingLockMs = Math.max(0, settings.changeWaitSeconds * 1000);
  globallyUnlocked = remainingLockMs <= 0;
}

function pauseLockCountdown() {
  remainingLockMs = getRemainingLockMs();
  lockActiveSince = null;
  stopLockTimer();
}

function getRemainingLockMs() {
  if (globallyUnlocked || settings.changeWaitSeconds <= 0) return 0;
  const activeElapsed = lockActiveSince == null ? 0 : Date.now() - lockActiveSince;
  return Math.max(0, remainingLockMs - activeElapsed);
}

function isPageActivelyViewed() {
  return document.visibilityState === "visible" && document.hasFocus();
}

function updateLockState() {
  if (settings.changeWaitSeconds <= 0) {
    globallyUnlocked = true;
    remainingLockMs = 0;
    lockActiveSince = null;
    stopLockTimer();
  } else if (!globallyUnlocked) {
    if (isPageActivelyViewed()) {
      startLockTimerIfNeeded();
    } else {
      pauseLockCountdown();
    }

    const remaining = getRemainingLockMs();
    if (remaining <= 0) {
      globallyUnlocked = true;
      remainingLockMs = 0;
      lockActiveSince = null;
      stopLockTimer();
    }
  }

  if (globallyUnlocked) {
    waitControlRow.classList.remove("is-locked");
    lockStatus.hidden = true;
    lockStatus.classList.remove("is-locked");
    lockStatusTitle.textContent = "";
    lockStatusMessage.textContent = "";
    stopLockTimer();
  } else {
    const remaining = Math.ceil(getRemainingLockMs() / 1000);
    waitControlRow.classList.add("is-locked");
    lockStatus.hidden = false;
    lockStatus.classList.add("is-locked");
    lockStatusTitle.textContent = `Unlocks in ${formatDuration(remaining)}`;
    lockStatusMessage.textContent = getLockMessage(remaining, settings.changeWaitSeconds);
  }

  applyRowLocks();
  applyWaitLock();
}

function getLockMessage(remainingSeconds, totalSeconds) {
  const total = Math.max(1, Number(totalSeconds) || 1);
  const ratio = Math.max(0, Math.min(1, remainingSeconds / total));

  if (ratio > 0.75) return "You set this for a reason.";
  if (ratio > 0.5) return "Still think changing it is a good idea?";
  if (ratio > 0.25) return "Is this getting you anywhere?";
  return "Good ideas can wait another minute.";
}

function renderRules() {
  rulesBody.textContent = "";

  for (const rule of settings.rules) {
    const tr = document.createElement("tr");
    tr.dataset.ruleId = rule.id;

    const domain = createCellInput(rule.domain, "text");
    const session = createMinuteInput(rule.sessionLimitMinutes);
    const day = createMinuteInput(rule.dayLimitMinutes);
    const redirect = createCellInput(rule.redirect, "text");

    tr.append(
      wrapCell(domain),
      wrapMinuteCell(session),
      wrapMinuteCell(day),
      wrapCell(redirect)
    );

    const deleteCell = document.createElement("td");
    deleteCell.className = "action-cell";
    const deleteButton = createButton("button button-delete", "Delete", () => deleteRule(rule.id));
    deleteCell.append(deleteButton);
    tr.append(deleteCell);

    const fields = { domain, session, day, redirect };
    for (const input of Object.values(fields)) {
      input.addEventListener("change", () => saveExistingRule(rule.id, fields));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") input.blur();
      });
    }

    rulesBody.append(tr);
  }

  applyRowLocks();
}

function applyRowLocks() {
  for (const row of rulesBody.querySelectorAll("tr")) {
    const id = row.dataset.ruleId;
    const editable = globallyUnlocked || freshRuleIds.has(id);
    row.classList.toggle("protected", !editable);

    for (const input of row.querySelectorAll("input")) {
      input.disabled = !editable;
    }

    const deleteButton = row.querySelector(".button-delete");
    if (deleteButton) {
      deleteButton.disabled = !editable;
      deleteButton.textContent = editable ? "Delete" : "Locked";
    }
  }
}

function renderWaitTable() {
  waitBody.textContent = "";
  const row = document.createElement("tr");
  row.id = "wait-row";

  const input = document.createElement("input");
  input.id = "wait-minutes";
  input.type = "number";
  input.min = "1";
  input.max = String(MAX_WAIT_MINUTES);
  input.step = "1";
  input.inputMode = "numeric";
  input.autocomplete = "off";

  const isConfigured = settings.changeWaitSeconds > 0;
  if (isConfigured) {
    input.value = formatWaitMinutes(settings.changeWaitSeconds);
  } else {
    input.placeholder = "5";
  }

  const valueCell = wrapMinuteCell(input);
  row.append(valueCell);

  const actionCell = document.createElement("td");
  actionCell.className = "action-cell";
  let actionButton;

  if (isConfigured) {
    actionButton = createButton("button button-delete", "Delete", removeWaitTime);
    input.addEventListener("change", () => saveExistingWaitTime(input));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
  } else {
    actionButton = createButton("button button-primary", "Add", () => addWaitTime(input));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") addWaitTime(input);
    });
  }

  actionCell.append(actionButton);
  row.append(actionCell);
  waitBody.append(row);
  applyWaitLock();
}

function applyWaitLock() {
  const row = document.getElementById("wait-row");
  if (!row) return;

  const isConfigured = settings.changeWaitSeconds > 0;
  const editable = !isConfigured || globallyUnlocked;
  row.classList.toggle("protected", !editable);

  const input = row.querySelector("input");
  const button = row.querySelector("button");
  if (input) input.disabled = !editable;
  if (button) {
    button.disabled = !editable;
    if (isConfigured) button.textContent = editable ? "Delete" : "Locked";
  }
}

async function addWaitTime(input) {
  const minutes = parseWaitMinutes(input.value);
  if (!Number.isFinite(minutes)) {
    shake([input]);
    return;
  }

  settings.changeWaitSeconds = minutes * 60;
  freshRuleIds.clear();
  resetLockCountdown();

  await persistSettings();

  renderWaitTable();
  updateLockState();
}

async function saveExistingWaitTime(input) {
  if (!globallyUnlocked) return;

  const minutes = parseWaitMinutes(input.value);
  if (!Number.isFinite(minutes)) {
    shake([input]);
    input.value = formatWaitMinutes(settings.changeWaitSeconds);
    return;
  }

  settings.changeWaitSeconds = minutes * 60;
  await persistSettings();
  input.value = String(minutes);
  // The updated delay applies the next time the page locks.
}

async function removeWaitTime() {
  if (!globallyUnlocked) return;

  settings.changeWaitSeconds = 0;
  resetLockCountdown();
  await persistSettings();
  renderWaitTable();
  updateLockState();
}

async function addDraftRule() {
  const validation = validateCandidate({
    domain: draftInputs.domain.value,
    session: draftInputs.session.value,
    day: draftInputs.day.value,
    redirect: draftInputs.redirect.value
  });

  if (!validation.ok) {
    shake(validation.invalidElements.map((key) => draftInputs[key]));
    return;
  }

  if (settings.rules.some((rule) => domainsOverlap(rule.domain, validation.rule.domain))) {
    shake([draftInputs.domain]);
    return;
  }

  const rule = {
    id: crypto.randomUUID(),
    ...validation.rule
  };

  settings.rules.push(rule);
  freshRuleIds.add(rule.id);
  await persistSettings();

  for (const input of Object.values(draftInputs)) input.value = "";
  renderRules();
}

async function saveExistingRule(ruleId, fields) {
  if (!globallyUnlocked && !freshRuleIds.has(ruleId)) return;

  const savedRule = settings.rules.find((rule) => rule.id === ruleId);
  if (!savedRule) return;

  const validation = validateCandidate({
    domain: fields.domain.value,
    session: fields.session.value,
    day: fields.day.value,
    redirect: fields.redirect.value
  });

  if (!validation.ok) {
    shake(validation.invalidElements.map((key) => fields[key]));
    restoreRuleFields(fields, savedRule);
    return;
  }

  const duplicate = settings.rules.some(
    (rule) => rule.id !== ruleId && domainsOverlap(rule.domain, validation.rule.domain)
  );
  if (duplicate) {
    shake([fields.domain]);
    restoreRuleFields(fields, savedRule);
    return;
  }

  const index = settings.rules.findIndex((rule) => rule.id === ruleId);
  if (index < 0) return;

  settings.rules[index] = { id: ruleId, ...validation.rule };
  await persistSettings();

  fields.domain.value = validation.rule.domain;
  fields.session.value = formatMinuteValue(validation.rule.sessionLimitMinutes);
  fields.day.value = formatMinuteValue(validation.rule.dayLimitMinutes);
  fields.redirect.value = validation.rule.redirect;
}

function restoreRuleFields(fields, rule) {
  fields.domain.value = rule.domain;
  fields.session.value = formatMinuteValue(rule.sessionLimitMinutes);
  fields.day.value = formatMinuteValue(rule.dayLimitMinutes);
  fields.redirect.value = rule.redirect;
}

async function deleteRule(ruleId) {
  if (!globallyUnlocked && !freshRuleIds.has(ruleId)) return;
  settings.rules = settings.rules.filter((rule) => rule.id !== ruleId);
  freshRuleIds.delete(ruleId);
  await persistSettings();
  renderRules();
}

function validateCandidate(raw) {
  const invalidElements = [];
  const domain = normalizeDomain(raw.domain);
  const sessionLimitMinutes = parseMinutes(raw.session);
  const dayLimitMinutes = parseMinutes(raw.day);
  const redirect = normalizeRedirect(raw.redirect);

  if (!domain) invalidElements.push("domain");
  if (!Number.isFinite(sessionLimitMinutes)) invalidElements.push("session");
  if (!Number.isFinite(dayLimitMinutes)) invalidElements.push("day");
  if (Number.isFinite(sessionLimitMinutes) && Number.isFinite(dayLimitMinutes) && dayLimitMinutes < sessionLimitMinutes) {
    invalidElements.push("day");
  }
  if (redirect === null) invalidElements.push("redirect");

  if (domain && redirect) {
    try {
      const redirectHost = new URL(redirect).hostname.toLowerCase().replace(/\.$/, "");
      if (redirectHost === domain || redirectHost.endsWith(`.${domain}`)) {
        invalidElements.push("redirect");
      }
    } catch {
      invalidElements.push("redirect");
    }
  }

  return {
    ok: invalidElements.length === 0,
    invalidElements: [...new Set(invalidElements)],
    rule: {
      domain,
      sessionLimitMinutes,
      dayLimitMinutes,
      redirect: redirect || ""
    }
  };
}

function domainsOverlap(a, b) {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function normalizeDomain(value) {
  let text = String(value || "").trim().toLowerCase();
  if (!text) return "";

  try {
    if (!text.includes("://")) text = `https://${text}`;
    const url = new URL(text);
    if (!url.hostname || (url.protocol !== "http:" && url.protocol !== "https:")) return "";
    let host = url.hostname.replace(/\.$/, "");
    if (host.startsWith("www.")) host = host.slice(4);
    if (!isValidHostname(host)) return "";
    return host;
  } catch {
    return "";
  }
}

function normalizeRedirect(value) {
  let text = String(value || "").trim();
  if (!text) return "";

  try {
    if (!text.includes("://")) text = `https://${text}`;
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function isValidHostname(host) {
  if (host.length > 253 || host.includes("..")) return false;
  if (host === "localhost") return true;
  if (!host.includes(".")) return false;
  return host.split(".").every((label) => {
    if (!label || label.length > 63) return false;
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label);
  });
}

function parseMinutes(value) {
  return parsePositiveInteger(value, MAX_LIMIT_MINUTES);
}

function parseWaitMinutes(value) {
  return parsePositiveInteger(value, MAX_WAIT_MINUTES);
}

function parsePositiveInteger(value, max) {
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) return NaN;
  const number = Number(text);
  if (!Number.isInteger(number) || number < 1 || number > max) return NaN;
  return number;
}

function formatMinuteValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "";
}

function formatWaitMinutes(seconds) {
  const minutes = Number(seconds) / 60;
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  if (Number.isInteger(minutes)) return String(minutes);
  return String(Math.max(1, Math.round(minutes)));
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function createButton(className, text, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function createCellInput(value, type) {
  const input = document.createElement("input");
  input.type = type;
  input.value = value;
  input.autocomplete = "off";
  input.spellcheck = false;
  return input;
}

function createMinuteInput(value) {
  const input = createCellInput(formatMinuteValue(value), "number");
  input.min = "1";
  input.max = String(MAX_LIMIT_MINUTES);
  input.step = "1";
  input.inputMode = "numeric";
  return input;
}

function wrapCell(element) {
  const td = document.createElement("td");
  td.append(element);
  return td;
}

function wrapMinuteCell(input) {
  const td = document.createElement("td");
  const wrapper = document.createElement("div");
  wrapper.className = "unit-input";
  const suffix = document.createElement("span");
  suffix.textContent = "min";
  wrapper.append(input, suffix);
  td.append(wrapper);
  return td;
}

function shake(elements) {
  for (const element of elements.filter(Boolean)) {
    const target = element.closest(".unit-input") || element;
    target.classList.remove("shake");
    void target.offsetWidth;
    target.classList.add("shake");
    window.setTimeout(() => target.classList.remove("shake"), 500);
  }
}

async function persistSettings() {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

function sanitizeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    changeWaitSeconds: Number.isFinite(Number(source.changeWaitSeconds))
      ? Math.max(0, Number(source.changeWaitSeconds))
      : 0,
    rules: Array.isArray(source.rules)
      ? source.rules
          .filter((rule) => rule && rule.id && rule.domain)
          .map((rule) => ({
            id: String(rule.id),
            domain: String(rule.domain),
            sessionLimitMinutes: Number(rule.sessionLimitMinutes),
            dayLimitMinutes: Number(rule.dayLimitMinutes),
            redirect: String(rule.redirect || "")
          }))
      : []
  };
}
