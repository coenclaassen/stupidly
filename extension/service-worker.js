const SETTINGS_KEY = "settings";
const USAGE_KEY = "usage";
const SESSIONS_KEY = "sessions";

const MIDNIGHT_ALARM = "midnight";
const SESSION_ALARM_PREFIX = "session:";
const DAY_ALARM_PREFIX = "day:";
const DNR_RULE_BASE = 1000;

const DEFAULT_SETTINGS = {
  changeWaitSeconds: 0,
  rules: []
};

let stateQueue = Promise.resolve();

function enqueueStateTask(task) {
  stateQueue = stateQueue.then(task).catch((error) => {
    console.error("STUPIDLY:", error);
  });
  return stateQueue;
}

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});

chrome.runtime.onInstalled.addListener(() => enqueueStateTask(async () => {
  await scheduleMidnightAlarm();
  await reconcileOpenTabs({ startFresh: true });
}));

chrome.runtime.onStartup.addListener(() => enqueueStateTask(async () => {
  await scheduleMidnightAlarm();
  await resetSessionsForBrowserStart();
  await reconcileOpenTabs({ startFresh: true });
}));

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  enqueueStateTask(() => handleCommittedNavigation(details.tabId, details.url));
});

chrome.tabs.onActivated.addListener(() => {
  enqueueStateTask(() => handleForegroundChanged());
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueStateTask(() => removeTabSession(tabId));
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => enqueueStateTask(async () => {
  await removeTabSession(removedTabId);
  try {
    const tab = await chrome.tabs.get(addedTabId);
    if (tab.url) await handleCommittedNavigation(addedTabId, tab.url);
  } catch {
    // Tab disappeared before it could be inspected.
  }
}));

chrome.windows.onFocusChanged.addListener(() => {
  enqueueStateTask(() => handleForegroundChanged());
});

chrome.alarms.onAlarm.addListener((alarm) => enqueueStateTask(async () => {
  if (alarm.name === MIDNIGHT_ALARM) {
    await resetForNewDay();
    return;
  }

  if (alarm.name.startsWith(SESSION_ALARM_PREFIX)) {
    await handleSessionAlarm(alarm.name);
    return;
  }

  if (alarm.name.startsWith(DAY_ALARM_PREFIX)) {
    await handleDayAlarm(alarm.name.slice(DAY_ALARM_PREFIX.length));
  }
}));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[SETTINGS_KEY]) return;

  const before = sanitizeSettings(changes[SETTINGS_KEY].oldValue).rules;
  const after = sanitizeSettings(changes[SETTINGS_KEY].newValue).rules;
  if (JSON.stringify(before) === JSON.stringify(after)) return;

  enqueueStateTask(() => handleSettingsChanged());
});

async function resetSessionsForBrowserStart() {
  await chrome.storage.session.set({ [SESSIONS_KEY]: {} });

  const { usage } = await loadLocalState();
  for (const entry of Object.values(usage.domains)) {
    entry.activeSince = null;
  }
  await chrome.storage.local.set({ [USAGE_KEY]: usage });

  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms
      .filter((alarm) => isLimitAlarmName(alarm.name))
      .map((alarm) => chrome.alarms.clear(alarm.name))
  );
}

async function handleForegroundChanged() {
  const state = await loadRuntimeState();
  if (await enforceForegroundLimits(state)) return;
  await finishRuntimeState(state);
}

async function scheduleMidnightAlarm() {
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  await chrome.alarms.create(MIDNIGHT_ALARM, { when: next.getTime() });
}

async function loadRuntimeState(now = Date.now()) {
  const { settings, usage: storedUsage } = await loadLocalState();
  let usage = storedUsage;
  let sessions = await loadSessions();
  const savedUsage = JSON.stringify(usage);
  const savedSessions = JSON.stringify(sessions);
  const foregroundTabId = await getForegroundTabId();

  ({ usage, sessions } = await rollDayIfNeeded(usage, sessions, foregroundTabId, now));

  return { settings, usage, sessions, savedUsage, savedSessions, foregroundTabId, now };
}

async function finishRuntimeState(state, { syncBlocking = false, schedule = true } = {}) {
  const changed = hasRuntimeStateChanged(state);
  if (changed) await saveState(state.usage, state.sessions);
  if (changed || state.foregroundTabId != null) await updateActiveDailyBadge(state);
  if (syncBlocking) await syncDailyBlocking(state.settings, state.usage);
  if (schedule && (changed || syncBlocking)) await scheduleRuntimeAlarms(state);
}

async function scheduleRuntimeAlarms(state) {
  await scheduleLimitAlarms(state.settings, state.usage, state.sessions, state.foregroundTabId, state.now);
}

function hasRuntimeStateChanged(state) {
  return JSON.stringify(state.usage) !== state.savedUsage || JSON.stringify(state.sessions) !== state.savedSessions;
}

async function handleCommittedNavigation(tabId, url) {
  const state = await loadRuntimeState();
  const { settings, usage, sessions, foregroundTabId, now } = state;

  await dropTabSession(sessions, tabId);

  const rule = findRuleForUrl(settings.rules, url);

  if (!rule) {
    await clearTabBadge(tabId);
    syncActiveFlags(usage, sessions, foregroundTabId, now);
    await finishRuntimeState(state);
    return;
  }

  if (hasDailyLimitReached(rule, usage)) {
    await clearTabBadge(tabId);
    syncActiveFlags(usage, sessions, foregroundTabId, now);
    await finishRuntimeState(state, { syncBlocking: true });
    await blockTab(tabId, rule, "day", url);
    return;
  }

  sessions[String(tabId)] = createSession(rule, url);
  syncActiveFlags(usage, sessions, foregroundTabId, now);
  await setDailyBadge(tabId, rule);
  await finishRuntimeState(state);
}

async function removeTabSession(tabId) {
  const state = await loadRuntimeState();
  const { usage, sessions, foregroundTabId, now } = state;

  await dropTabSession(sessions, tabId);
  await clearTabBadge(tabId);
  syncActiveFlags(usage, sessions, foregroundTabId, now);
  await finishRuntimeState(state, { syncBlocking: true });
}

async function handleSessionAlarm(alarmName) {
  const parsed = parseSessionAlarmName(alarmName);
  if (!parsed) return;

  const state = await loadRuntimeState();
  const { settings, usage, sessions, foregroundTabId, now } = state;

  const session = sessions[String(parsed.tabId)];
  if (!session || session.token !== parsed.token) {
    await finishRuntimeState(state);
    return;
  }

  const rule = findRuleForSession(settings, session);
  if (!rule) {
    await dropTabSession(sessions, parsed.tabId);
    await clearTabBadge(parsed.tabId);
    syncActiveFlags(usage, sessions, foregroundTabId, now);
    await finishRuntimeState(state);
    return;
  }

  if (foregroundTabId !== parsed.tabId || !hasSessionReachedLimit(rule, session)) {
    await finishRuntimeState(state);
    return;
  }

  const dayReached = hasDailyLimitReached(rule, usage);

  await dropTabSession(sessions, parsed.tabId);
  await clearTabBadge(parsed.tabId);
  if (dayReached) await removeSessionsForDomain(sessions, rule.domain);
  syncActiveFlags(usage, sessions, foregroundTabId, now);
  await finishRuntimeState(state, { syncBlocking: dayReached, schedule: false });

  if (dayReached) {
    await blockAllOpenTabsForDomain(rule, "day");
  } else {
    await blockTab(parsed.tabId, rule, "session", session.originalUrl);
  }

  await scheduleRuntimeAlarms(state);
}

async function handleDayAlarm(domain) {
  const state = await loadRuntimeState();
  const { settings, usage, sessions, foregroundTabId, now } = state;

  const rule = settings.rules.find((candidate) => candidate.domain === domain);
  if (!rule || !isForegroundDomain(sessions, foregroundTabId, domain)) {
    await finishRuntimeState(state);
    return;
  }

  if (!hasDailyLimitReached(rule, usage)) {
    await finishRuntimeState(state);
    return;
  }

  await removeSessionsForDomain(sessions, domain);
  syncActiveFlags(usage, sessions, foregroundTabId, now);
  await finishRuntimeState(state, { syncBlocking: true, schedule: false });
  await blockAllOpenTabsForDomain(rule, "day");
  await scheduleRuntimeAlarms(state);
}

async function handleSettingsChanged() {
  const state = await loadRuntimeState();
  const { settings, usage, sessions, foregroundTabId, now } = state;

  const rulesById = new Map(settings.rules.map((rule) => [rule.id, rule]));

  for (const [tabId, session] of Object.entries(sessions)) {
    const rule = rulesById.get(session.ruleId);
    if (!rule || rule.domain !== session.domain) {
      await dropTabSession(sessions, Number(tabId));
      continue;
    }

    session.usedMs = Math.max(0, Number(session.usedMs) || 0);
    session.activeSince = null;
  }

  syncActiveFlags(usage, sessions, foregroundTabId, now);

  if (await enforceForegroundLimits(state)) return;

  await finishRuntimeState(state, { syncBlocking: true });
  await blockReachedDailyLimits(settings, usage);
  await reconcileOpenTabs({ startFresh: false });
}

async function reconcileOpenTabs({ startFresh }) {
  const tabs = await chrome.tabs.query({});
  const state = await loadRuntimeState();
  const { settings, usage, sessions, foregroundTabId, now } = state;

  const openTabIds = new Set(tabs.filter((tab) => tab.id != null).map((tab) => String(tab.id)));
  for (const [tabId] of Object.entries(sessions)) {
    if (!openTabIds.has(tabId)) {
      await dropTabSession(sessions, Number(tabId));
    }
  }

  for (const tab of tabs) {
    if (tab.id == null || !tab.url || !isHttpUrl(tab.url)) continue;
    const rule = findRuleForUrl(settings.rules, tab.url);
    const existing = sessions[String(tab.id)];

    if (!rule) {
      if (existing) await dropTabSession(sessions, tab.id);
      await clearTabBadge(tab.id);
      continue;
    }

    if (hasDailyLimitReached(rule, usage)) {
      if (existing) await dropTabSession(sessions, tab.id);
      await clearTabBadge(tab.id);
      continue;
    }

    if (existing && existing.ruleId === rule.id && existing.domain === rule.domain && !startFresh) {
      await setDailyBadge(tab.id, rule);
      continue;
    }

    if (existing) await dropTabSession(sessions, tab.id);

    sessions[String(tab.id)] = createSession(rule, tab.url);
    await setDailyBadge(tab.id, rule);
  }

  syncActiveFlags(usage, sessions, foregroundTabId, now);

  if (await enforceForegroundLimits(state)) return;

  await finishRuntimeState(state, { syncBlocking: true });
  await blockReachedDailyLimits(settings, usage);
}

async function resetForNewDay() {
  const now = Date.now();
  const { settings, usage: storedUsage } = await loadLocalState();
  const sessions = await loadSessions();
  const foregroundTabId = await getForegroundTabId();
  const usage = checkpointUsage(storedUsage, sessions, foregroundTabId, now, { resetDaily: true });

  await saveState(usage, sessions);
  await clearOurDynamicRules();

  await scheduleRuntimeAlarms({ settings, usage, sessions, foregroundTabId, now });
  await scheduleMidnightAlarm();
}

async function rollDayIfNeeded(usage, sessions, foregroundTabId, now) {
  const newDay = usage.dateKey !== localDateKey(now);
  usage = checkpointUsage(usage, sessions, foregroundTabId, now, { resetDaily: newDay });
  if (!newDay) return { usage, sessions };

  await clearOurDynamicRules();
  await scheduleMidnightAlarm();
  return { usage, sessions };
}

async function dropTabSession(sessions, tabId) {
  const key = String(tabId);
  const session = sessions[key];
  if (!session) return null;

  await chrome.alarms.clear(sessionAlarmName(tabId, session.token));
  delete sessions[key];
  return session;
}

function createSession(rule, originalUrl) {
  return {
    token: randomToken(),
    domain: rule.domain,
    ruleId: rule.id,
    originalUrl,
    usedMs: 0,
    activeSince: null
  };
}

function hasDailyLimitReached(rule, usage) {
  return getDomainUsage(usage, rule.domain).usedMs >= minutesToMs(rule.dayLimitMinutes);
}

async function blockReachedDailyLimits(settings, usage) {
  for (const rule of settings.rules) {
    if (hasDailyLimitReached(rule, usage)) {
      await blockAllOpenTabsForDomain(rule, "day");
    }
  }
}

function checkpointUsage(usage, sessions, foregroundTabId, now, { resetDaily = false } = {}) {
  const dailyUsage = resetDaily ? emptyUsage(now) : usage;
  const dailyStart = resetDaily ? startOfLocalDay(now) : 0;

  for (const session of Object.values(sessions)) {
    if (session.activeSince == null) continue;

    const activeSince = Number(session.activeSince) || now;
    const sessionDelta = Math.max(0, now - activeSince);
    const dailyDelta = Math.max(0, now - Math.max(activeSince, dailyStart));

    session.usedMs = Math.max(0, Number(session.usedMs) || 0) + sessionDelta;
    session.activeSince = null;

    const entry = getDomainUsage(dailyUsage, session.domain);
    entry.usedMs = Math.max(0, Number(entry.usedMs) || 0) + dailyDelta;
    entry.activeSince = null;
  }

  syncActiveFlags(dailyUsage, sessions, foregroundTabId, now);
  return dailyUsage;
}

function syncActiveFlags(usage, sessions, foregroundTabId, now) {
  for (const session of Object.values(sessions)) {
    session.activeSince = null;
  }

  for (const entry of Object.values(usage.domains)) {
    entry.activeSince = null;
  }

  const activeSession = foregroundTabId != null ? sessions[String(foregroundTabId)] : null;
  if (!activeSession) return;

  activeSession.activeSince = now;
  getDomainUsage(usage, activeSession.domain).activeSince = now;
}

async function scheduleLimitAlarms(settings, usage, sessions, foregroundTabId, now) {
  const desired = new Map();
  const activeSession = foregroundTabId != null ? sessions[String(foregroundTabId)] : null;
  const activeRule = activeSession ? findRuleForSession(settings, activeSession) : null;

  if (activeSession && activeRule) {
    const sessionRemaining = minutesToMs(activeRule.sessionLimitMinutes) - (Number(activeSession.usedMs) || 0);
    if (sessionRemaining > 0) {
      desired.set(sessionAlarmName(foregroundTabId, activeSession.token), now + sessionRemaining);
    }

    const dayRemaining = minutesToMs(activeRule.dayLimitMinutes) - getDomainUsage(usage, activeRule.domain).usedMs;
    if (dayRemaining > 0) {
      desired.set(dayAlarmName(activeRule.domain), now + dayRemaining);
    }
  }

  const existing = new Map(
    (await chrome.alarms.getAll())
      .filter((alarm) => isLimitAlarmName(alarm.name))
      .map((alarm) => [alarm.name, alarm])
  );

  for (const name of existing.keys()) {
    if (!desired.has(name)) await chrome.alarms.clear(name);
  }

  for (const [name, when] of desired) {
    const current = existing.get(name);
    if (!current || Math.abs(current.scheduledTime - when) > 1000) {
      await chrome.alarms.create(name, { when });
    }
  }
}

async function enforceForegroundLimits(state) {
  const { settings, usage, sessions, foregroundTabId, now } = state;
  const sessionKey = foregroundTabId != null ? String(foregroundTabId) : "";
  const session = sessionKey ? sessions[sessionKey] : null;
  if (!session) return false;

  const rule = findRuleForSession(settings, session);
  if (!rule) {
    await dropTabSession(sessions, foregroundTabId);
    await clearTabBadge(foregroundTabId);
    syncActiveFlags(usage, sessions, foregroundTabId, now);
    return false;
  }

  if (hasDailyLimitReached(rule, usage)) {
    await removeSessionsForDomain(sessions, rule.domain);
    syncActiveFlags(usage, sessions, foregroundTabId, now);
    await finishRuntimeState(state, { syncBlocking: true, schedule: false });
    await blockAllOpenTabsForDomain(rule, "day");
    await scheduleRuntimeAlarms(state);
    return true;
  }

  if (!hasSessionReachedLimit(rule, session)) return false;

  await dropTabSession(sessions, foregroundTabId);
  await clearTabBadge(foregroundTabId);
  syncActiveFlags(usage, sessions, foregroundTabId, now);
  await finishRuntimeState(state, { schedule: false });
  await blockTab(foregroundTabId, rule, "session", session.originalUrl);
  await scheduleRuntimeAlarms(state);
  return true;
}

async function syncDailyBlocking(settings, usage) {
  const addRules = [];

  settings.rules.forEach((rule, index) => {
    const entry = getDomainUsage(usage, rule.domain);
    if (entry.usedMs < minutesToMs(rule.dayLimitMinutes)) return;

    addRules.push({
      id: DNR_RULE_BASE + index,
      priority: 1,
      action: rule.redirect
        ? { type: "redirect", redirect: { url: rule.redirect } }
        : { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
      condition: {
        requestDomains: [rule.domain],
        resourceTypes: ["main_frame"]
      }
    });
  });

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .map((rule) => rule.id)
    .filter((id) => id >= DNR_RULE_BASE && id < DNR_RULE_BASE + 100000);

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

async function clearOurDynamicRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .map((rule) => rule.id)
    .filter((id) => id >= DNR_RULE_BASE && id < DNR_RULE_BASE + 100000);
  if (removeRuleIds.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  }
}

async function removeSessionsForDomain(sessions, domain) {
  for (const [tabId, session] of Object.entries(sessions)) {
    if (session.domain !== domain) continue;
    await dropTabSession(sessions, Number(tabId));
    await clearTabBadge(Number(tabId));
  }
}

async function blockAllOpenTabsForDomain(rule, kind) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id == null || !tab.url) continue;
    if (urlMatchesDomain(tab.url, rule.domain)) {
      await blockTab(tab.id, rule, kind, tab.url);
    }
  }
}

async function blockTab(tabId, rule, kind, originalUrl) {
  await clearTabBadge(tabId);

  try {
    if (rule.redirect) {
      await chrome.tabs.update(tabId, { url: rule.redirect });
      return;
    }

    const params = new URLSearchParams();
    params.set("kind", kind);
    if (kind === "session" && isHttpUrl(originalUrl)) params.set("original", originalUrl);

    await chrome.tabs.update(tabId, {
      url: `${chrome.runtime.getURL("blocked.html")}?${params.toString()}`
    });
  } catch {
    // Tab may have closed between the alarm firing and the update.
  }
}

async function updateActiveDailyBadge(state) {
  if (state.foregroundTabId == null) return;

  const session = state.sessions[String(state.foregroundTabId)];
  const rule = session ? findRuleForSession(state.settings, session) : null;
  if (!rule) {
    await clearTabBadge(state.foregroundTabId);
    return;
  }

  await setDailyBadge(state.foregroundTabId, rule);
}

async function setDailyBadge(tabId, rule) {
  const minutes = Number(rule.dayLimitMinutes);
  const text = formatBadgeText(minutes);
  try {
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text }),
      chrome.action.setTitle({ tabId, title: `STUPIDLY - ${minutes} min daily limit` })
    ]);
  } catch {
    // Tab may have disappeared.
  }
}

async function clearTabBadge(tabId) {
  try {
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: "" }),
      chrome.action.setTitle({ tabId, title: "STUPIDLY" })
    ]);
  } catch {
    // Tab may have disappeared.
  }
}

function formatBadgeText(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) ? `${Math.min(Math.max(Math.round(minutes), 0), 999)}m` : "";
}

async function getForegroundTabId() {
  try {
    const focusedWindow = await chrome.windows.getLastFocused({
      populate: true,
      windowTypes: ["normal"]
    });
    if (!focusedWindow || !focusedWindow.focused) return null;

    const activeTab = (focusedWindow.tabs || []).find((tab) => tab.active);
    return Number.isInteger(activeTab?.id) ? activeTab.id : null;
  } catch {
    return null;
  }
}

async function loadLocalState() {
  const data = await chrome.storage.local.get([SETTINGS_KEY, USAGE_KEY]);
  return {
    settings: sanitizeSettings(data[SETTINGS_KEY]),
    usage: sanitizeUsage(data[USAGE_KEY])
  };
}

async function loadSessions() {
  const data = await chrome.storage.session.get(SESSIONS_KEY);
  return sanitizeSessions(data[SESSIONS_KEY]);
}

async function saveState(usage, sessions) {
  await Promise.all([
    chrome.storage.local.set({ [USAGE_KEY]: usage }),
    chrome.storage.session.set({ [SESSIONS_KEY]: sessions })
  ]);
}

function sanitizeSettings(value) {
  const source = value && typeof value === "object" ? value : DEFAULT_SETTINGS;
  return {
    changeWaitSeconds: Math.max(0, Number(source.changeWaitSeconds) || 0),
    rules: Array.isArray(source.rules)
      ? source.rules.filter(isValidStoredRule).map((rule) => ({
          id: String(rule.id),
          domain: String(rule.domain).toLowerCase(),
          sessionLimitMinutes: Number(rule.sessionLimitMinutes),
          dayLimitMinutes: Number(rule.dayLimitMinutes),
          redirect: String(rule.redirect || "")
        }))
      : []
  };
}

function sanitizeUsage(value) {
  if (!value || typeof value !== "object" || typeof value.dateKey !== "string") return emptyUsage();
  const domains = {};
  for (const [domain, entry] of Object.entries(value.domains || {})) {
    domains[domain] = {
      usedMs: Math.max(0, Number(entry.usedMs) || 0),
      activeSince: Number.isFinite(entry.activeSince) ? entry.activeSince : null
    };
  }
  return { dateKey: value.dateKey, domains };
}

function sanitizeSessions(value) {
  const sessions = {};
  if (!value || typeof value !== "object") return sessions;

  for (const [tabId, session] of Object.entries(value)) {
    const numericTabId = Number(tabId);
    if (!Number.isInteger(numericTabId) || numericTabId < 0 || !session || typeof session !== "object") continue;
    if (!session.domain || !session.ruleId) continue;

    sessions[String(numericTabId)] = {
      token: session.token ? String(session.token) : randomToken(),
      domain: String(session.domain).toLowerCase(),
      ruleId: String(session.ruleId),
      originalUrl: String(session.originalUrl || ""),
      usedMs: Math.max(0, Number(session.usedMs) || 0),
      activeSince: Number.isFinite(session.activeSince) ? session.activeSince : null
    };
  }

  return sessions;
}

function isValidStoredRule(rule) {
  return Boolean(
    rule &&
      typeof rule.id === "string" &&
      typeof rule.domain === "string" &&
      Number(rule.sessionLimitMinutes) > 0 &&
      Number(rule.dayLimitMinutes) > 0
  );
}

function findRuleForUrl(rules, url) {
  const hostname = getHttpHostname(url);
  if (!hostname) return null;
  return rules.find((rule) => domainMatches(hostname, rule.domain)) || null;
}

function findRuleForSession(settings, session) {
  return settings.rules.find((candidate) => candidate.id === session.ruleId && candidate.domain === session.domain) || null;
}

function hasSessionReachedLimit(rule, session) {
  return (Number(session.usedMs) || 0) >= minutesToMs(rule.sessionLimitMinutes);
}

function isForegroundDomain(sessions, foregroundTabId, domain) {
  const session = foregroundTabId != null ? sessions[String(foregroundTabId)] : null;
  return Boolean(session && session.domain === domain);
}

function urlMatchesDomain(url, domain) {
  const hostname = getHttpHostname(url);
  return Boolean(hostname && domainMatches(hostname, domain));
}

function isHttpUrl(url) {
  return Boolean(getHttpHostname(url));
}

function getHttpHostname(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

function domainMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function getDomainUsage(usage, domain) {
  if (!usage.domains[domain]) {
    usage.domains[domain] = { usedMs: 0, activeSince: null };
  }
  return usage.domains[domain];
}

function emptyUsage(now = Date.now()) {
  return { dateKey: localDateKey(now), domains: {} };
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function minutesToMs(minutes) {
  return Math.max(0, Number(minutes) || 0) * 60 * 1000;
}

function randomToken() {
  return crypto.randomUUID().replaceAll("-", "");
}

function isLimitAlarmName(name) {
  return name.startsWith(SESSION_ALARM_PREFIX) || name.startsWith(DAY_ALARM_PREFIX);
}

function sessionAlarmName(tabId, token) {
  return `${SESSION_ALARM_PREFIX}${tabId}:${token}`;
}

function parseSessionAlarmName(name) {
  const rest = name.slice(SESSION_ALARM_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator < 1) return null;
  const tabId = Number(rest.slice(0, separator));
  const token = rest.slice(separator + 1);
  if (!Number.isInteger(tabId) || !token) return null;
  return { tabId, token };
}

function dayAlarmName(domain) {
  return `${DAY_ALARM_PREFIX}${domain}`;
}
