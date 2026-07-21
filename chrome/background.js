const browser = chrome;

const ALL_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
];
const ACTIVE_CONFIG_KEY = 'modheaderActiveConfig';
const MAX_PROFILES_IN_CLOUD = 50;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REQUEST_APPEND_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'access-control-request-headers',
  'cache-control',
  'connection',
  'content-language',
  'cookie',
  'forwarded',
  'if-match',
  'if-none-match',
  'keep-alive',
  'range',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'want-digest',
  'x-forwarded-for',
]);

let currentConfig = {};
let currentProfile = {headers: [], respHeaders: []};

function promisifyChromeCall(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (result) => {
      const error = browser.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function getLocalStorage(keys) {
  if (browser.storage.local.get.length === 1) {
    return browser.storage.local.get(keys);
  }
  return promisifyChromeCall(browser.storage.local.get.bind(browser.storage.local), keys);
}

async function setLocalStorage(items) {
  if (browser.storage.local.set.length === 1) {
    return browser.storage.local.set(items);
  }
  return promisifyChromeCall(browser.storage.local.set.bind(browser.storage.local), items);
}

async function getSyncStorage(keys) {
  if (browser.storage.sync.get.length === 1) {
    return browser.storage.sync.get(keys);
  }
  return promisifyChromeCall(browser.storage.sync.get.bind(browser.storage.sync), keys);
}

async function setSyncStorage(items) {
  if (browser.storage.sync.set.length === 1) {
    return browser.storage.sync.set(items);
  }
  return promisifyChromeCall(browser.storage.sync.set.bind(browser.storage.sync), items);
}

async function removeSyncStorage(keys) {
  if (browser.storage.sync.remove.length === 1) {
    return browser.storage.sync.remove(keys);
  }
  return promisifyChromeCall(browser.storage.sync.remove.bind(browser.storage.sync), keys);
}

function normalizeConfig(config) {
  config = config || {};
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  let selectedProfile = Number(config.selectedProfile || 0);
  if (!Number.isInteger(selectedProfile) || selectedProfile < 0) {
    selectedProfile = 0;
  }
  if (selectedProfile >= profiles.length) {
    selectedProfile = 0;
  }
  return {
    profiles,
    selectedProfile,
    isPaused: Boolean(config.isPaused),
    lockedTabId: config.lockedTabId ? Number(config.lockedTabId) : null,
    activeTabId: config.activeTabId ? Number(config.activeTabId) : null,
  };
}

function getSelectedProfile(config) {
  const selectedProfile = config.profiles[config.selectedProfile] || {};

  function enabledHeaders(headers) {
    if (!Array.isArray(headers)) {
      return [];
    }
    return headers
      .filter((header) => header && header.enabled && header.name)
      .map((header) => ({
        name: String(header.name).trim(),
        value: header.value == null ? '' : String(header.value),
      }))
      .filter((header) => HEADER_NAME_PATTERN.test(header.name));
  }

  return {
    appendMode: selectedProfile.appendMode || '',
    headers: enabledHeaders(selectedProfile.headers),
    respHeaders: enabledHeaders(selectedProfile.respHeaders),
    filters: Array.isArray(selectedProfile.filters) ? selectedProfile.filters : [],
  };
}

function getEnabledFilters(profile, type) {
  return profile.filters.filter((filter) => filter && filter.enabled && filter.type === type);
}

async function getUrlRegexes(profile) {
  const filters = getEnabledFilters(profile, 'urls');
  if (!filters.length) {
    return [null];
  }

  const supportedRegexes = [];
  for (const filter of filters) {
    const regex = filter.urlRegex || filter.urlPattern;
    if (!regex || /[^\x00-\x7F]/.test(regex)) {
      continue;
    }
    try {
      const result = await browser.declarativeNetRequest.isRegexSupported({regex});
      if (result.isSupported) {
        supportedRegexes.push(regex);
      }
    } catch (e) {
      // Invalid regex filters are skipped so the rest of the profile can load.
    }
  }
  return supportedRegexes;
}

function getResourceTypes(profile) {
  const filters = getEnabledFilters(profile, 'types');
  if (!filters.length) {
    // No type filter: return null so the rule condition omits resourceTypes
    // entirely and the browser defaults to all supported types. Enumerating
    // ALL_RESOURCE_TYPES would include Chrome-only values (e.g. "webtransport")
    // that Firefox's DNR schema rejects, which would drop the whole rule.
    return null;
  }

  const types = new Set();
  for (const filter of filters) {
    const resourceTypes = Array.isArray(filter.resourceType) ? filter.resourceType : [];
    for (const type of resourceTypes) {
      if (ALL_RESOURCE_TYPES.includes(type)) {
        types.add(type);
      }
    }
  }
  return Array.from(types);
}

function toHeaderOperations(headers, appendMode, isRequest) {
  return headers.map((header) => ({
    header: header.name,
    operation: appendMode && (!isRequest || REQUEST_APPEND_HEADERS.has(header.name.toLowerCase()))
      ? 'append'
      : 'set',
    value: header.value,
  }));
}

async function buildRules(profile, config) {
  const urlRegexes = await getUrlRegexes(profile);
  const resourceTypes = getResourceTypes(profile);
  const requestHeaders = toHeaderOperations(profile.headers, profile.appendMode, true);
  const responseHeaders = toHeaderOperations(profile.respHeaders, profile.appendMode, false);

  // resourceTypes === null means "no type filter" (apply to all types → omit
  // the key). An empty array means the user filtered to types but none were
  // valid, so no rule should match.
  if ((!requestHeaders.length && !responseHeaders.length) ||
      (Array.isArray(resourceTypes) && resourceTypes.length === 0)) {
    return [];
  }

  const rules = [];
  for (const regex of urlRegexes) {
    const condition = {};
    if (Array.isArray(resourceTypes) && resourceTypes.length) {
      condition.resourceTypes = resourceTypes;
    }
    if (regex) {
      condition.regexFilter = regex;
    }
    if (config.lockedTabId) {
      condition.tabIds = [Number(config.lockedTabId)];
    }

    const action = {type: 'modifyHeaders'};
    if (requestHeaders.length) {
      action.requestHeaders = requestHeaders;
    }
    if (responseHeaders.length) {
      action.responseHeaders = responseHeaders;
    }

    rules.push({
      id: rules.length + 1,
      priority: 1,
      action,
      condition,
    });
  }
  return rules;
}

async function replaceSessionRules(rules) {
  const oldRules = await browser.declarativeNetRequest.getSessionRules();
  const removeRuleIds = oldRules.map((rule) => rule.id);
  try {
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules: rules,
    });
    return;
  } catch (e) {
    await browser.declarativeNetRequest.updateSessionRules({removeRuleIds});
  }

  for (const rule of rules) {
    try {
      await browser.declarativeNetRequest.updateSessionRules({addRules: [rule]});
    } catch (e) {
      console.warn('Skipping unsupported HeaderMod rule', rule, e);
    }
  }
}

async function refreshRulesAndUi() {
  currentProfile = getSelectedProfile(currentConfig);
  const rules = currentConfig.isPaused ? [] : await buildRules(currentProfile, currentConfig);
  await replaceSessionRules(rules);
  await resetBadgeAndContextMenu();
}

async function loadConfig() {
  const items = await getLocalStorage([ACTIVE_CONFIG_KEY]);
  currentConfig = normalizeConfig(items[ACTIVE_CONFIG_KEY]);
  await refreshRulesAndUi();
}

async function saveConfig(config) {
  currentConfig = normalizeConfig({...currentConfig, ...config});
  await setLocalStorage({[ACTIVE_CONFIG_KEY]: currentConfig});
  await refreshRulesAndUi();
}

async function saveStorageToCloud() {
  if (!currentConfig.profiles.length) {
    return;
  }

  const serializedProfiles = JSON.stringify(currentConfig.profiles);
  const items = await getSyncStorage(null);
  const keys = items ? Object.keys(items).sort() : [];
  if (keys.length === 0 || items[keys[keys.length - 1]] !== serializedProfiles) {
    const data = {};
    data[Date.now()] = serializedProfiles;
    await setSyncStorage(data);
  }
  if (keys.length >= MAX_PROFILES_IN_CLOUD) {
    await removeSyncStorage(keys.slice(0, keys.length - MAX_PROFILES_IN_CLOUD));
  }
}

async function createContextMenus() {
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({
    id: 'pause',
    title: 'Pause HeaderMod',
    contexts: ['action'],
  });
  browser.contextMenus.create({
    id: 'lock',
    title: 'Lock to this tab',
    contexts: ['action'],
  });
}

async function createContextMenu() {
  browser.contextMenus.update('pause', {
    title: currentConfig.isPaused ? 'Unpause HeaderMod' : 'Pause HeaderMod',
  });
  browser.contextMenus.update('lock', {
    title: currentConfig.lockedTabId ? 'Unlock to all tabs' : 'Lock to this tab',
  });
}

async function resetBadgeAndContextMenu() {
  if (currentConfig.isPaused) {
    browser.action.setIcon({path: 'icon_bw.png'});
    browser.action.setBadgeText({text: '\u275A\u275A'});
    browser.action.setBadgeBackgroundColor({color: '#666'});
  } else {
    const numHeaders = currentProfile.headers.length + currentProfile.respHeaders.length;
    if (numHeaders === 0) {
      browser.action.setBadgeText({text: ''});
      browser.action.setIcon({path: 'icon_bw.png'});
    } else if (currentConfig.lockedTabId && currentConfig.lockedTabId !== currentConfig.activeTabId) {
      browser.action.setIcon({path: 'icon_bw.png'});
      browser.action.setBadgeText({text: '\uD83D\uDD12'});
      browser.action.setBadgeBackgroundColor({color: '#ff8e8e'});
    } else {
      browser.action.setIcon({path: 'icon.png'});
      browser.action.setBadgeText({text: numHeaders.toString()});
      browser.action.setBadgeBackgroundColor({color: '#db4343'});
    }
  }
  await createContextMenu();
}

async function onTabUpdated(tab) {
  if (!tab || !tab.active) {
    return;
  }
  let url = tab.url;
  if (!url) {
    const items = await getLocalStorage(['tabUrls']);
    url = items.tabUrls && items.tabUrls[tab.id];
  }

  const changes = {
    activeTabId: tab.id,
    currentTabUrl: url || '',
  };
  currentConfig.activeTabId = tab.id;
  await setLocalStorage(changes);
  await resetBadgeAndContextMenu();
}

browser.runtime.onInstalled.addListener(async () => {
  await createContextMenus();
  await loadConfig();
});

browser.runtime.onStartup.addListener(async () => {
  await createContextMenus();
  await loadConfig();
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'syncConfig') {
    return false;
  }

  saveConfig(message.config)
    .then(() => saveStorageToCloud())
    .then(() => sendResponse({ok: true}))
    .catch((error) => sendResponse({ok: false, error: error.message}));
  return true;
});

browser.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'pause') {
    await saveConfig({isPaused: !currentConfig.isPaused});
  } else if (info.menuItemId === 'lock') {
    await saveConfig({
      lockedTabId: currentConfig.lockedTabId ? null : currentConfig.activeTabId,
    });
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tabId) {
    getLocalStorage(['tabUrls']).then((items) => {
      const tabUrls = items.tabUrls || {};
      tabUrls[tabId] = changeInfo.url;
      setLocalStorage({tabUrls});
    });
  }
  onTabUpdated(tab);
});

browser.tabs.onActivated.addListener((activeInfo) => {
  browser.tabs.get(activeInfo.tabId, onTabUpdated);
});

browser.tabs.onRemoved.addListener((tabId) => {
  getLocalStorage(['tabUrls']).then((items) => {
    const tabUrls = items.tabUrls || {};
    if (tabId in tabUrls) {
      delete tabUrls[tabId];
      setLocalStorage({tabUrls});
    }
  });
});

browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) {
    return;
  }
  browser.windows.get(windowId, {populate: true}, (win) => {
    if (browser.runtime.lastError || !win) {
      return;
    }
    for (const tab of win.tabs || []) {
      onTabUpdated(tab);
    }
  });
});

// Re-apply rules when the user grants (or revokes) host access at runtime, so
// header rules take effect immediately even if access was granted outside the
// popup (e.g. via the browser's add-on settings).
if (browser.permissions && browser.permissions.onAdded) {
  browser.permissions.onAdded.addListener(() => {
    refreshRulesAndUi();
  });
}
if (browser.permissions && browser.permissions.onRemoved) {
  browser.permissions.onRemoved.addListener(() => {
    refreshRulesAndUi();
  });
}

createContextMenus().then(loadConfig);
