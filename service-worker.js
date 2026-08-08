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
    console.error("SiteLimit:", error);
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
      .filter((alarm) => alarm.name.startsWith(SESSION_ALARM_PREFIX) || alarm.name.startsWith(DAY_ALARM_PREFIX))
      .map((alarm) => chrome.alarms.clear(alarm.name))
  );
}

async function scheduleMidnightAlarm() {
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  await chrome.alarms.create(MIDNIGHT_ALARM, { when: next.getTime() });
}

async function handleCommittedNavigation(tabId, url) {
  const now = Date.now();
  let { settings, usage } = await loadLocalState();
  let sessions = await loadSessions();

  ({ usage, sessions } = await rollDayIfNeeded(usage, sessions, now));
  checkpointUsage(usage, sessions, now);

  const previous = sessions[String(tabId)];
  if (previous) {
    await chrome.alarms.clear(sessionAlarmName(tabId, previous.token));
    delete sessions[String(tabId)];
  }

  const rule = findRuleForUrl(settings.rules, url);

  if (!rule) {
    await clearTabBadge(tabId);
    syncActiveFlags(usage, sessions, now);
    await saveState(usage, sessions);
    await scheduleDayAlarms(settings, usage, sessions, now);
    return;
  }

  const domainUsage = getDomainUsage(usage, rule.domain);
  if (domainUsage.usedMs >= minutesToMs(rule.dayLimitMinutes)) {
    await clearTabBadge(tabId);
    syncActiveFlags(usage, sessions, now);
    await saveState(usage, sessions);
    await syncDailyBlocking(settings, usage);
    await blockTab(tabId, rule, "day", url);
    return;
  }

  const token = randomToken();
  const session = {
    token,
    domain: rule.domain,
    ruleId: rule.id,
    originalUrl: url,
    startedAt: now,
    expiresAt: now + minutesToMs(rule.sessionLimitMinutes)
  };

  sessions[String(tabId)] = session;
  syncActiveFlags(usage, sessions, now);
  await saveState(usage, sessions);
  await setSessionBadge(tabId, rule);

  await chrome.alarms.create(sessionAlarmName(tabId, token), { when: session.expiresAt });
  await scheduleDayAlarms(settings, usage, sessions, now);
}

async function removeTabSession(tabId) {
  const now = Date.now();
  let { settings, usage } = await loadLocalState();
  let sessions = await loadSessions();

  ({ usage, sessions } = await rollDayIfNeeded(usage, sessions, now));
  checkpointUsage(usage, sessions, now);

  const previous = sessions[String(tabId)];
  if (previous) {
    await chrome.alarms.clear(sessionAlarmName(tabId, previous.token));
    delete sessions[String(tabId)];
  }

  await clearTabBadge(tabId);
  syncActiveFlags(usage, sessions, now);
  await saveState(usage, sessions);
  await scheduleDayAlarms(settings, usage, sessions, now);
  await syncDailyBlocking(settings, usage);
}

async function handleSessionAlarm(alarmName) {
  const parsed = parseSessionAlarmName(alarmName);
  if (!parsed) return;

  const now = Date.now();
  let { settings, usage } = await loadLocalState();
  let sessions = await loadSessions();

  ({ usage, sessions } = await rollDayIfNeeded(usage, sessions, now));
  checkpointUsage(usage, sessions, now);

  const session = sessions[String(parsed.tabId)];
  if (!session || session.token !== parsed.token) return;

  const rule = settings.rules.find((candidate) => candidate.id === session.ruleId && candidate.domain === session.domain);
  delete sessions[String(parsed.tabId)];
  await clearTabBadge(parsed.tabId);
  syncActiveFlags(usage, sessions, now);
  await saveState(usage, sessions);

  if (!rule) {
    await scheduleDayAlarms(settings, usage, sessions, now);
    return;
  }

  const domainUsage = getDomainUsage(usage, rule.domain);
  const dayReached = domainUsage.usedMs >= minutesToMs(rule.dayLimitMinutes);

  if (dayReached) {
    await syncDailyBlocking(settings, usage);
    await blockAllOpenTabsForDomain(rule, "day");
  } else {
    await blockTab(parsed.tabId, rule, "session", session.originalUrl);
  }

  await scheduleDayAlarms(settings, usage, sessions, now);
}

async function handleDayAlarm(domain) {
  const now = Date.now();
  let { settings, usage } = await loadLocalState();
  let sessions = await loadSessions();

  ({ usage, sessions } = await rollDayIfNeeded(usage, sessions, now));
  checkpointUsage(usage, sessions, now);

  const rule = settings.rules.find((candidate) => candidate.domain === domain);
  if (!rule) return;

  const domainUsage = getDomainUsage(usage, domain);
  if (domainUsage.usedMs < minutesToMs(rule.dayLimitMinutes)) {
    await saveState(usage, sessions);
    await scheduleDayAlarms(settings, usage, sessions, now);
    return;
  }

  for (const [tabId, session] of Object.entries(sessions)) {
    if (session.domain === domain) {
      await chrome.alarms.clear(sessionAlarmName(Number(tabId), session.token));
      delete sessions[tabId];
    }
  }

  syncActiveFlags(usage, sessions, now);
  await saveState(usage, sessions);
  await syncDailyBlocking(settings, usage);
  await blockAllOpenTabsForDomain(rule, "day");
  await scheduleDayAlarms(settings, usage, sessions, now);
}

async function handleSettingsChanged() {
  const now = Date.now();
  let { settings, usage } = await loadLocalState();
  let sessions = await loadSessions();

  ({ usage, sessions } = await rollDayIfNeeded(usage, sessions, now));
  checkpointUsage(usage, sessions, now);

  const rulesById = new Map(settings.rules.map((rule) => [rule.id, rule]));

  for (const [tabId, session] of Object.entries(sessions)) {
    const rule = rulesById.get(session.ruleId);
    if (!rule || rule.domain !== session.domain) {
      await chrome.alarms.clear(sessionAlarmName(Number(tabId), session.token));
      delete sessions[tabId];
      continue;
    }

    const newExpiry = session.startedAt + minutesToMs(rule.sessionLimitMinutes);
    session.expiresAt = newExpiry;
    await chrome.alarms.create(sessionAlarmName(Number(tabId), session.token), { when: newExpiry });
  }

  syncActiveFlags(usage, sessions, now);
  await saveState(usage, sessions);
  await syncDailyBlocking(settings, usage);
  await scheduleDayAlarms(settings, usage, sessions, now);

  for (const rule of settings.rules) {
    if (getDomainUsage(usage, rule.domain).usedMs >= minutesToMs(rule.dayLimitMinutes)) {
      await blockAllOpenTabsForDomain(rule, "day");
    }
  }

  await reconcileOpenTabs({ startFresh: false });
}

async function reconcileOpenTabs({ startFresh }) {
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  let { settings, usage } = await loadLocalState();
  let sessions = await loadSessions();

  ({ usage, sessions } = await rollDayIfNeeded(usage, sessions, now));
  checkpointUsage(usage, sessions, now);

  const openTabIds = new Set(tabs.map((tab) => String(tab.id)));
  for (const [tabId, session] of Object.entries(sessions)) {
    if (!openTabIds.has(tabId)) {
      await chrome.alarms.clear(sessionAlarmName(Number(tabId), session.token));
      delete sessions[tabId];
    }
  }

  for (const tab of tabs) {
    if (!tab.id || !tab.url || !isHttpUrl(tab.url)) continue;
    const rule = findRuleForUrl(settings.rules, tab.url);
    const existing = sessions[String(tab.id)];

    if (!rule) {
      if (existing) {
        await chrome.alarms.clear(sessionAlarmName(tab.id, existing.token));
        delete sessions[String(tab.id)];
      }
      await clearTabBadge(tab.id);
      continue;
    }

    const domainUsage = getDomainUsage(usage, rule.domain);
    if (domainUsage.usedMs >= minutesToMs(rule.dayLimitMinutes)) {
      if (existing) {
        await chrome.alarms.clear(sessionAlarmName(tab.id, existing.token));
        delete sessions[String(tab.id)];
      }
      await clearTabBadge(tab.id);
      continue;
    }

    if (existing && existing.ruleId === rule.id && existing.domain === rule.domain && !startFresh) {
      await setSessionBadge(tab.id, rule);
      continue;
    }

    if (existing) await chrome.alarms.clear(sessionAlarmName(tab.id, existing.token));

    const token = randomToken();
    const session = {
      token,
      domain: rule.domain,
      ruleId: rule.id,
      originalUrl: tab.url,
      startedAt: now,
      expiresAt: now + minutesToMs(rule.sessionLimitMinutes)
    };
    sessions[String(tab.id)] = session;
    await setSessionBadge(tab.id, rule);
    await chrome.alarms.create(sessionAlarmName(tab.id, token), { when: session.expiresAt });
  }

  syncActiveFlags(usage, sessions, now);
  await saveState(usage, sessions);
  await syncDailyBlocking(settings, usage);
  await scheduleDayAlarms(settings, usage, sessions, now);

  for (const rule of settings.rules) {
    if (getDomainUsage(usage, rule.domain).usedMs >= minutesToMs(rule.dayLimitMinutes)) {
      await blockAllOpenTabsForDomain(rule, "day");
    }
  }
}

async function resetForNewDay() {
  const now = Date.now();
  const sessions = await loadSessions();
  const usage = emptyUsage();

  syncActiveFlags(usage, sessions, now);
  await chrome.storage.local.set({ [USAGE_KEY]: usage });
  await clearOurDynamicRules();

  const { settings } = await loadLocalState();
  await scheduleDayAlarms(settings, usage, sessions, now);
  await scheduleMidnightAlarm();
}

async function rollDayIfNeeded(usage, sessions, now) {
  if (usage.dateKey === localDateKey(now)) return { usage, sessions };

  usage = emptyUsage(now);
  syncActiveFlags(usage, sessions, now);
  await clearOurDynamicRules();
  await scheduleMidnightAlarm();
  return { usage, sessions };
}

function checkpointUsage(usage, sessions, now) {
  const activeDomains = activeDomainSet(sessions);

  for (const [domain, entry] of Object.entries(usage.domains)) {
    if (entry.activeSince != null) {
      const delta = Math.max(0, now - entry.activeSince);
      entry.usedMs = Math.max(0, Number(entry.usedMs) || 0) + delta;
      entry.activeSince = activeDomains.has(domain) ? now : null;
    }
  }

  for (const domain of activeDomains) {
    const entry = getDomainUsage(usage, domain);
    if (entry.activeSince == null) entry.activeSince = now;
  }
}

function syncActiveFlags(usage, sessions, now) {
  const activeDomains = activeDomainSet(sessions);
  const allDomains = new Set([...Object.keys(usage.domains), ...activeDomains]);

  for (const domain of allDomains) {
    const entry = getDomainUsage(usage, domain);
    entry.activeSince = activeDomains.has(domain) ? (entry.activeSince ?? now) : null;
  }
}

async function scheduleDayAlarms(settings, usage, sessions, now) {
  const activeDomains = activeDomainSet(sessions);
  const desired = new Map();

  for (const rule of settings.rules) {
    if (!activeDomains.has(rule.domain)) continue;
    const remaining = minutesToMs(rule.dayLimitMinutes) - getDomainUsage(usage, rule.domain).usedMs;
    if (remaining > 0) desired.set(dayAlarmName(rule.domain), now + remaining);
  }

  const existing = new Map(
    (await chrome.alarms.getAll())
      .filter((alarm) => alarm.name.startsWith(DAY_ALARM_PREFIX))
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

async function blockAllOpenTabsForDomain(rule, kind) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
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

async function setSessionBadge(tabId, rule) {
  const text = formatBadgeMinutes(rule.sessionLimitMinutes);
  try {
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text }),
      chrome.action.setTitle({ tabId, title: `SiteLimit — ${rule.sessionLimitMinutes} min session` })
    ]);
  } catch {
    // Tab may have disappeared.
  }
}

async function clearTabBadge(tabId) {
  try {
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: "" }),
      chrome.action.setTitle({ tabId, title: "SiteLimit" })
    ]);
  } catch {
    // Tab may have disappeared.
  }
}

function formatBadgeMinutes(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? `${Math.min(Math.round(minutes), 999)}m` : "";
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
  return data[SESSIONS_KEY] && typeof data[SESSIONS_KEY] === "object" ? data[SESSIONS_KEY] : {};
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
  if (!isHttpUrl(url)) return null;
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }

  return rules.find((rule) => hostname === rule.domain || hostname.endsWith(`.${rule.domain}`)) || null;
}

function urlMatchesDomain(url, domain) {
  if (!isHttpUrl(url)) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function getDomainUsage(usage, domain) {
  if (!usage.domains[domain]) {
    usage.domains[domain] = { usedMs: 0, activeSince: null };
  }
  return usage.domains[domain];
}

function activeDomainSet(sessions) {
  return new Set(Object.values(sessions).map((session) => session.domain));
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

function minutesToMs(minutes) {
  return Math.max(0, Number(minutes) || 0) * 60 * 1000;
}

function randomToken() {
  return crypto.randomUUID().replaceAll("-", "");
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
