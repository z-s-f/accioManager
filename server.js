const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse: parseJsonc } = require('jsonc-parser');
const { execSync, exec } = require('child_process');
const crypto = require('crypto');
const net = require('net');

const app = express();
const PORT = process.env.PORT || 3456;

const HOME_DIR = require('os').homedir();
const ACCIO_DIR = path.join(HOME_DIR, '.accio');
const ACCOUNTS_DIR = path.join(ACCIO_DIR, 'accounts');
const ELECTRON_DIR = process.platform === 'darwin'
  ? path.join(HOME_DIR, 'Library', 'Application Support', 'Accio')
  : (process.env.APPDATA ? path.join(process.env.APPDATA, 'Accio') : path.join(HOME_DIR, 'AppData', 'Roaming', 'Accio'));

// Support custom data directory for packaged Electron apps
const DATA_ROOT = process.env.ACCIO_MANAGER_DATA_DIR || path.join(__dirname, 'data');
const META_FILE = path.join(DATA_ROOT, 'accounts_meta.json');
const PROFILES_DIR = path.join(DATA_ROOT, 'profiles');
const SDK_LOG = path.join(ACCIO_DIR, 'logs', 'sdk.log');
const UTDID_FILE = path.join(ACCIO_DIR, 'utdid');
const REGISTER_OAUTH_BRIDGE_FILE = path.join(DATA_ROOT, 'register', 'oauth_bridge_queue.json');
const ACCIO_AUTH_CALLBACK = 'http://127.0.0.1:3456/auth/callback';
const ACCIO_LOGIN_URL = 'https://www.accio.com/login?language=en_US';
const ACCIO_GATEWAY_ORIGIN = 'https://phoenix-gw.alibaba.com';
const ACCIO_MTOP_ORIGIN = 'https://acs.h.accio.com';
const ACCIO_APP_VERSION = '0.5.0';
const ACCIO_MTOP_APP_KEY = '24889839';
const ACCIO_MTOP_JSV = '2.7.2';
const ACCIO_ACCOUNT_INFO_API = 'mtop.alibaba.intl.buyeragent.account.getAccountInfo';
let currentAccioAuthState = '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== Helpers ==========

function ensureDataDir() {
  const dataDir = DATA_ROOT;
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) {
    fs.writeFileSync(META_FILE, JSON.stringify({ accounts: {}, activeAccountId: null }, null, 2));
  }
}

function readMeta() {
  ensureDataDir();
  return JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
}

function writeMeta(data) {
  ensureDataDir();
  fs.writeFileSync(META_FILE, JSON.stringify(data, null, 2));
}

function readRegisterOAuthBridgeQueue() {
  try {
    if (!fs.existsSync(REGISTER_OAUTH_BRIDGE_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(REGISTER_OAUTH_BRIDGE_FILE, 'utf-8'));
    return Array.isArray(raw) ? raw.filter(item => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function writeRegisterOAuthBridgeQueue(entries) {
  fs.mkdirSync(path.dirname(REGISTER_OAUTH_BRIDGE_FILE), { recursive: true });
  fs.writeFileSync(REGISTER_OAUTH_BRIDGE_FILE, JSON.stringify(entries, null, 2));
}

function consumeRegisterOAuthBridgeEntry({ email = '' } = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;

  const entries = readRegisterOAuthBridgeQueue();
  const matchIndex = entries.findIndex(item =>
    String(item.email || '').trim().toLowerCase() === normalizedEmail
  );

  if (matchIndex === -1) return null;

  const [matched] = entries.splice(matchIndex, 1);
  writeRegisterOAuthBridgeQueue(entries);
  return matched;
}

function readSettings() {
  try {
    const raw = fs.readFileSync(path.join(ACCIO_DIR, 'settings.jsonc'), 'utf-8');
    return parseJsonc(raw);
  } catch { return {}; }
}

function getFetchTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

function safeDecode(value) {
  if (!value) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getCookieValue(cookieString, key) {
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`));
  return match ? match[1] : '';
}

function getCookieKVPayload(cookieString, key) {
  const rawValue = getCookieValue(cookieString, key);
  if (!rawValue) return new URLSearchParams();
  return new URLSearchParams(safeDecode(rawValue));
}

function getDefaultQuota() {
  return {
    total: 0,
    used: 0,
    unit: '次',
    usagePercent: null,
    refreshCountdownSeconds: null,
    checkedAt: null,
    source: null,
  };
}

function normalizeSwitchPreference(value) {
  return value === 'profile' ? 'profile' : 'oauth_logout';
}

function getAllAccountIds(meta = readMeta()) {
  const accountDirs = fs.existsSync(ACCOUNTS_DIR)
    ? fs.readdirSync(ACCOUNTS_DIR).filter(f =>
        !f.startsWith('.') && fs.statSync(path.join(ACCOUNTS_DIR, f)).isDirectory()
      )
    : [];
  return Array.from(new Set([...accountDirs, ...Object.keys(meta.accounts || {})]));
}

function getFetchTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

function readUtdid() {
  try {
    if (!fs.existsSync(UTDID_FILE)) return '';
    return fs.readFileSync(UTDID_FILE, 'utf-8').trim();
  } catch {
    return '';
  }
}

function getAccioGatewayContext(credentials = {}) {
  const cookie = credentials.cookie || '';
  const localeMatch = cookie.match(/xman_us_f=x_locale=([^&;]+)/);
  const siteConfig = getCookieKVPayload(cookie, 'sc_g_cfg_f');
  const locale = safeDecode(siteConfig.get('sc_b_locale') || (localeMatch ? localeMatch[1] : '')) || 'en_US';

  return {
    cookie,
    cna: getCookieValue(cookie, 'cna') || '',
    language: locale,
    utdid: readUtdid(),
    version: ACCIO_APP_VERSION,
    os: process.platform,
  };
}

function getAccioAccountInfoContext(accountMeta = {}) {
  const credentials = accountMeta.credentials || {};
  const cookie = credentials.cookie || '';
  const siteConfig = getCookieKVPayload(cookie, 'sc_g_cfg_f');
  const tokenCookie = getCookieValue(cookie, '_m_h5_tk');
  const token = tokenCookie ? tokenCookie.split('_')[0] : '';
  const accountProfile = accountMeta.profile || {};

  return {
    cookie,
    cna: getCookieValue(cookie, 'cna') || '',
    mtopToken: token,
    language: safeDecode(siteConfig.get('sc_b_locale')) || accountProfile.locale || 'en_US',
    country: safeDecode(siteConfig.get('sc_b_site')) || accountProfile.countryCode || 'US',
    currency: safeDecode(siteConfig.get('sc_b_currency')) || 'USD',
    deviceId: credentials.deviceId || `accio_${crypto.randomUUID()}`,
  };
}

async function fetchAccioRemoteProfile(credentials = {}) {
  if (typeof fetch === 'undefined' || !credentials.token || !credentials.cookie) return null;
  const gatewayContext = getAccioGatewayContext(credentials);

  try {
    const fetchRes = await fetch(`${ACCIO_GATEWAY_ORIGIN}/api/auth/userinfo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'x-language': gatewayContext.language,
        'x-utdid': gatewayContext.utdid,
        'x-app-version': gatewayContext.version,
        'x-os': gatewayContext.os,
        'x-cna': gatewayContext.cna,
        'Cookie': credentials.cookie,
      },
      body: JSON.stringify({
        accessToken: credentials.token,
        utdid: gatewayContext.utdid,
        version: gatewayContext.version,
      }),
      signal: getFetchTimeoutSignal(5000),
    });

    if (!fetchRes.ok) return null;
    const payload = await fetchRes.json();
    return payload && payload.success && payload.data ? payload.data : null;
  } catch (e) {
    console.warn('Could not fetch remote user info:', e.message);
    return null;
  }
}

function mergeRemoteProfilePayloads(baseProfile = {}, legacyProfile = null, accountInfo = null) {
  const nextProfile = {
    ...baseProfile,
    syncedAt: new Date().toISOString(),
  };

  if (legacyProfile && typeof legacyProfile === 'object') {
    Object.assign(nextProfile, legacyProfile);
  }

  if (accountInfo && typeof accountInfo === 'object') {
    nextProfile.nickName = accountInfo.nickName || nextProfile.nickName || null;
    nextProfile.email = accountInfo.email || nextProfile.email || null;
    nextProfile.userType = accountInfo.userType || nextProfile.userType || null;
    nextProfile.remainingCredits = Number.isFinite(Number(accountInfo.remainingCredits))
      ? Number(accountInfo.remainingCredits)
      : (nextProfile.remainingCredits ?? null);
    nextProfile.remainingMultiStepPoints = Number.isFinite(Number(accountInfo.remainingMultiStepPoints))
      ? Number(accountInfo.remainingMultiStepPoints)
      : (nextProfile.remainingMultiStepPoints ?? null);
    nextProfile.trialMaxAgentMultiStepPoints = Number.isFinite(Number(accountInfo.trialMaxAgentMultiStepPoints))
      ? Number(accountInfo.trialMaxAgentMultiStepPoints)
      : (nextProfile.trialMaxAgentMultiStepPoints ?? null);
    nextProfile.recentRegisterUser = typeof accountInfo.recentRegisterUser === 'boolean'
      ? accountInfo.recentRegisterUser
      : (nextProfile.recentRegisterUser ?? null);
    nextProfile.registrationType = accountInfo.registrationType || nextProfile.registrationType || null;
    nextProfile.isAddWaitList = typeof accountInfo.isAddWaitList === 'boolean'
      ? accountInfo.isAddWaitList
      : (nextProfile.isAddWaitList ?? null);
    nextProfile.deliverTo = accountInfo.deliverTo || nextProfile.deliverTo || null;
    nextProfile.accountInfoSource = ACCIO_ACCOUNT_INFO_API;
  }

  if (legacyProfile) {
    nextProfile.userInfoSource = '/api/auth/userinfo';
  }

  return nextProfile;
}

async function fetchAccioAccountInfo(accountMeta = {}) {
  if (typeof fetch === 'undefined') return null;

  const ctx = getAccioAccountInfoContext(accountMeta);
  if (!ctx.cookie || !ctx.mtopToken) return null;

  const t = String(Date.now());
  const data = JSON.stringify({
    deviceId: ctx.deviceId,
    language: ctx.language,
    country: ctx.country,
    currency: ctx.currency,
    cna: ctx.cna,
  });
  const sign = crypto
    .createHash('md5')
    .update(`${ctx.mtopToken}&${t}&${ACCIO_MTOP_APP_KEY}&${data}`)
    .digest('hex');

  const requestUrl = new URL(`/h5/${ACCIO_ACCOUNT_INFO_API.toLowerCase()}/1.0/`, ACCIO_MTOP_ORIGIN);
  requestUrl.searchParams.set('jsv', ACCIO_MTOP_JSV);
  requestUrl.searchParams.set('appKey', ACCIO_MTOP_APP_KEY);
  requestUrl.searchParams.set('t', t);
  requestUrl.searchParams.set('sign', sign);
  requestUrl.searchParams.set('api', ACCIO_ACCOUNT_INFO_API);
  requestUrl.searchParams.set('v', '1.0');
  requestUrl.searchParams.set('dataType', 'json');
  requestUrl.searchParams.set('method', 'GET');
  requestUrl.searchParams.set('type', 'originaljson');
  requestUrl.searchParams.set('data', data);

  try {
    const fetchRes = await fetch(requestUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Language': ctx.language.replace('_', '-'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://www.accio.com',
        'Referer': 'https://www.accio.com/',
        'Cookie': ctx.cookie,
      },
      signal: getFetchTimeoutSignal(5000),
    });

    if (!fetchRes.ok) return null;
    const payload = await fetchRes.json();
    const accountInfo = payload?.data?.data;
    return accountInfo && typeof accountInfo === 'object' ? accountInfo : null;
  } catch (e) {
    console.warn('Could not fetch account info via MTOP:', e.message);
    return null;
  }
}

// Parse a single point component — handles both new API (totalPoint/usedPoint) and old API (total/used)
function parsePointComponent(comp) {
  if (!comp || typeof comp !== 'object') return { total: 0, used: 0 };
  const total = Number(comp.totalPoint ?? comp.total ?? comp.totalPoints ?? comp.quota ?? 0) || 0;
  const used  = Number(comp.usedPoint  ?? comp.used  ?? comp.usedPoints  ?? comp.consume ?? 0) || 0;
  return { total, used };
}

// Classify a point component by type name
function classifyPointComponent(comp) {
  const raw = String(
    comp.pointType || comp.type || comp.name || comp.pointName || comp.category || ''
  ).toLowerCase();
  if (raw.includes('basic') || raw.includes('daily') || raw.includes('today') || raw.includes('base')) return 'basic';
  if (raw.includes('limit') || raw.includes('timed') || raw.includes('temp')) return 'limited';
  if (raw.includes('supplement') || raw.includes('gift') || raw.includes('extra') || raw.includes('bonus')) return 'supplement';
  return 'other';
}

async function fetchAccioPoints(credentials = {}) {
  const gatewayContext = getAccioGatewayContext(credentials);
  const pointUrl = new URL('/api/entitlement/point', ACCIO_GATEWAY_ORIGIN);
  pointUrl.searchParams.set('accessToken', credentials.token);
  pointUrl.searchParams.set('utdid', gatewayContext.utdid);
  pointUrl.searchParams.set('version', gatewayContext.version);

  try {
    const fetchRes = await fetch(pointUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'x-language': gatewayContext.language,
        'x-utdid': gatewayContext.utdid,
        'x-app-version': gatewayContext.version,
        'x-os': gatewayContext.os,
        'x-cna': gatewayContext.cna,
        ...(gatewayContext.cookie ? { 'Cookie': gatewayContext.cookie } : {}),
      },
      signal: getFetchTimeoutSignal(5000),
    });

    if (!fetchRes.ok) return null;
    const payload = await fetchRes.json();
    console.log('[Points] Raw /api/entitlement/point response:', JSON.stringify(payload?.data));
    return (payload && payload.success) ? payload.data : null;
  } catch (e) {
    return null;
  }
}

async function fetchAccioQuota(credentials = {}) {
  if (typeof fetch === 'undefined' || !credentials.token) return null;
  const gatewayContext = getAccioGatewayContext(credentials);
  
  // Try to fetch detailed points first as it has more breakdown
  const pointData = await fetchAccioPoints(credentials);
  
  const quotaUrl = new URL('/api/entitlement/quota', ACCIO_GATEWAY_ORIGIN);
  quotaUrl.searchParams.set('accessToken', credentials.token);
  quotaUrl.searchParams.set('utdid', gatewayContext.utdid);
  quotaUrl.searchParams.set('version', gatewayContext.version);

  try {
    const fetchRes = await fetch(quotaUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'x-language': gatewayContext.language,
        'x-utdid': gatewayContext.utdid,
        'x-app-version': gatewayContext.version,
        'x-os': gatewayContext.os,
        'x-cna': gatewayContext.cna,
        ...(gatewayContext.cookie ? { 'Cookie': gatewayContext.cookie } : {}),
      },
      signal: getFetchTimeoutSignal(5000),
    });

    if (!fetchRes.ok && !pointData) return null;
    const payload = fetchRes.ok ? await fetchRes.json() : { success: true, data: {} };
    if (!payload || !payload.success) {
      if (!pointData) return null;
    }

    // Merge: point API data on top of quota API data (point data is more detailed)
    const raw = { ...(payload.data || {}), ...(pointData || {}) };

    console.log('[Quota] Raw merged API data:', JSON.stringify(raw));

    const refreshCountdownSeconds = Number(raw.refreshCountdownSeconds ?? raw.countdown ?? raw.nextRefreshSeconds);

    const result = {
      checkedAt: new Date().toISOString(),
      source: '/api/entitlement/quota',
      refreshCountdownSeconds: Number.isFinite(refreshCountdownSeconds)
        ? Math.max(0, Math.floor(refreshCountdownSeconds))
        : null,
      details: {
        basic:      { total: 0, used: 0 },
        limited:    { total: 0, used: 0 },
        supplement: { total: 0, used: 0 },
      },
    };

    let total = 0;
    let used  = 0;
    let hasBreakdown = false;

    // --- Strategy 1: pointComponents array (old + new API) ---
    const components = raw.pointComponents || raw.components || raw.pointList || raw.points || null;
    if (Array.isArray(components) && components.length > 0) {
      hasBreakdown = true;
      components.forEach(comp => {
        const { total: ct, used: cu } = parsePointComponent(comp);
        total += ct;
        used  += cu;
        const kind = classifyPointComponent(comp);
        if (kind === 'basic')           result.details.basic      = { total: ct, used: cu };
        else if (kind === 'limited')    result.details.limited    = { total: ct, used: cu };
        else if (kind === 'supplement') result.details.supplement = { total: ct, used: cu };
        else {
          // Unknown type — add to supplement bucket as a catch-all
          result.details.supplement.total += ct;
          result.details.supplement.used  += cu;
        }
      });
    }
    // --- Strategy 2: flat named sub-objects (including new API entitlement) ---
    else {
      const basicRaw      = raw.entitlement?.daily   || raw.basic      || raw.basePoint  || raw.dailyPoint || raw.todayPoint || {};
      const limitedRaw    = raw.entitlement?.monthly || raw.limited    || raw.limitedTime || raw.timedPoint || raw.tempPoint  || {};
      const supplementRaw = raw.entitlement?.referral|| raw.supplement || raw.gift        || raw.bonusPoint || raw.extraPoint || {};

      const b = parsePointComponent(basicRaw);
      const l = parsePointComponent(limitedRaw);
      const s = parsePointComponent(supplementRaw);

      if (b.total > 0 || l.total > 0 || s.total > 0) {
        hasBreakdown = true;
        result.details.basic      = b;
        result.details.limited    = l;
        result.details.supplement = s;
        total = b.total + l.total + s.total;
        used  = b.used  + l.used  + s.used;
      }
    }

    // --- Strategy 3: top-level total/used (fallback or override) ---
    const rawTotal = Number(raw.total ?? raw.totalPoint ?? raw.quota ?? raw.totalQuota ?? 0);
    let rawUsed  = Number(raw.used  ?? raw.usedPoint  ?? raw.consume ?? raw.usedQuota ?? 0);
    
    // New Accio API uses `remaining` instead of `used`
    if (raw.remaining !== undefined && raw.used === undefined && raw.usedPoint === undefined && raw.consume === undefined) {
      rawUsed = Math.max(0, rawTotal - Number(raw.remaining || 0));
    }
    
    // Favor top-level total/used if the API explicitly provides a global total
    if (rawTotal > 0) {
      total = rawTotal;
      used  = rawUsed;
    }

    // Populate result with final totals
    if (total > 0) {
      result.total = total;
      result.used  = used;
      result.unit  = '积分';
      result.usagePercent = total > 0 ? (used / total) * 100 : 0;
    } else {
      // Only a percent is available
      const rawPct = Number(raw.usagePercent ?? raw.percent ?? raw.usedPercent);
      if (Number.isFinite(rawPct)) {
        result.usagePercent = Math.max(0, Math.min(100, rawPct));
      }
    }

    return result;
  } catch (e) {
    console.warn('Could not fetch remote quota:', e.message);
    return null;
  }
}


function buildRuntimeAccountState(accountMeta = {}) {
  return {
    quota: { ...getDefaultQuota(), ...(accountMeta.quota || {}) },
  };
}

async function refreshStoredQuota(accountId, meta = readMeta()) {
  const accountIds = getAllAccountIds(meta);
  if (!accountIds.includes(accountId)) {
    throw new Error('Account not found');
  }

  meta.accounts[accountId] = meta.accounts[accountId] || { quota: getDefaultQuota() };
  const existing = meta.accounts[accountId];

  if (!hasAccioAuthCredentials(existing.credentials)) {
    throw new Error('缺少可用的 Accio 远端凭证，无法刷新配额');
  }

  const [liveQuota, liveSubscription, accountInfo] = await Promise.all([
    fetchAccioQuota(existing.credentials),
    fetchAccioSubscription(existing.credentials),
    existing.credentials.cookie ? fetchAccioAccountInfo(existing) : Promise.resolve(null)
  ]);

  // Merge high-precision MTOP points into the quota result if available
  if (liveQuota && accountInfo) {
    if (Number.isFinite(accountInfo.remainingCredits)) {
      // If MTOP reports a different total/used, favor MTOP or adjust logic
      // In Accio, 'remainingCredits' is typically total - used.
      // We keep total from Quota API but adjust used if MTOP is more 'live'
    }
  }

  meta.accounts[accountId] = {
    ...existing,
    quota: { ...getDefaultQuota(), ...(existing.quota || {}), ...liveQuota },
    subscription: liveSubscription || existing.subscription || { planName: '免费套餐' },
    remoteProfile: { ...(existing.remoteProfile || {}), ...(accountInfo || {}) },
    updatedAt: new Date().toISOString(),
    createdAt: existing.createdAt || new Date().toISOString(),
  };

  if (accountInfo?.nickName) meta.accounts[accountId].label = accountInfo.nickName;

  return meta.accounts[accountId].quota;
}

async function fetchAccioUsageRecords(credentials = {}) {
  if (typeof fetch === 'undefined' || !credentials.token) return [];
  const gatewayContext = getAccioGatewayContext(credentials);
  const recordsUrl = new URL('/api/entitlement/usage/record', ACCIO_GATEWAY_ORIGIN);
  recordsUrl.searchParams.set('accessToken', credentials.token);
  recordsUrl.searchParams.set('utdid', gatewayContext.utdid);
  recordsUrl.searchParams.set('version', gatewayContext.version);
  recordsUrl.searchParams.set('pageSize', '20');

  try {
    const fetchRes = await fetch(recordsUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'x-language': gatewayContext.language,
        'x-utdid': gatewayContext.utdid,
        'x-app-version': gatewayContext.version,
        'x-os': gatewayContext.os,
        'x-cna': gatewayContext.cna,
        ...(gatewayContext.cookie ? { 'Cookie': gatewayContext.cookie } : {}),
      },
      signal: getFetchTimeoutSignal(5000),
    });

    if (!fetchRes.ok) return [];
    const payload = await fetchRes.json();
    if (!payload || !payload.success || !payload.data || !Array.isArray(payload.data.list)) return [];

    return payload.data.list.map(item => ({
      createdAt: item.gmtCreate || item.createAt || item.time || new Date().toISOString(),
      actionName: item.sceneName || item.actionName || item.scene || item.title || '使用 Accio',
      pointsUsed: Math.abs(item.pointChange || item.cost || item.pointsUsed || 1)
    }));
  } catch (e) {
    console.warn('Could not fetch usage records:', e.message);
    return [];
  }
}

async function fetchAccioSubscription(credentials = {}) {
  if (typeof fetch === 'undefined' || !credentials.token) return null;
  const gatewayContext = getAccioGatewayContext(credentials);
  const subUrl = new URL('/api/entitlement/currentSubscription', ACCIO_GATEWAY_ORIGIN);
  subUrl.searchParams.set('accessToken', credentials.token);
  subUrl.searchParams.set('utdid', gatewayContext.utdid);
  subUrl.searchParams.set('version', gatewayContext.version);

  try {
    const fetchRes = await fetch(subUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'x-language': gatewayContext.language,
        'x-utdid': gatewayContext.utdid,
        'x-app-version': gatewayContext.version,
        'x-os': gatewayContext.os,
        'x-cna': gatewayContext.cna,
        ...(gatewayContext.cookie ? { 'Cookie': gatewayContext.cookie } : {}),
      },
      signal: getFetchTimeoutSignal(5000),
    });

    if (!fetchRes.ok) return null;
    const payload = await fetchRes.json();
    if (!payload || !payload.success || !payload.data) return null;

    return {
      planName: payload.data.planName || '未知套餐',
      status: payload.data.status || 'active',
      expireAt: payload.data.expireAt || null,
    };
  } catch (e) {
    console.warn('Could not fetch subscription info:', e.message);
    return null;
  }
}

async function refreshStoredRemoteProfile(accountId, meta = readMeta()) {
  const accountIds = getAllAccountIds(meta);
  if (!accountIds.includes(accountId)) {
    throw new Error('Account not found');
  }

  meta.accounts[accountId] = meta.accounts[accountId] || { quota: getDefaultQuota() };
  const existing = meta.accounts[accountId];
  existing.credentials = existing.credentials || {};
  existing.credentials.deviceId = existing.credentials.deviceId
    || getAccioAccountInfoContext(existing).deviceId;

  const [legacyRemoteProfile, accountInfo] = await Promise.all([
    hasAccioAuthCredentials(existing.credentials)
      ? fetchAccioRemoteProfile(existing.credentials)
      : Promise.resolve(null),
    existing.credentials.cookie
      ? fetchAccioAccountInfo(existing)
      : Promise.resolve(null),
  ]);

  if (!legacyRemoteProfile && !accountInfo) {
    throw new Error('缺少可用的远端凭证，无法同步用户信息');
  }

  const mergedRemoteProfile = mergeRemoteProfilePayloads(
    existing.remoteProfile || {},
    legacyRemoteProfile,
    accountInfo
  );

  meta.accounts[accountId] = {
    ...existing,
    remoteProfile: mergedRemoteProfile,
    email: accountInfo?.email || legacyRemoteProfile?.email || existing.email || '',
    updatedAt: new Date().toISOString(),
    createdAt: existing.createdAt || new Date().toISOString(),
  };

  if (accountInfo?.nickName) {
    meta.accounts[accountId].label = accountInfo.nickName;
  }

  return meta.accounts[accountId];
}

function extractAccioAuthMetadata(parsedUrl, decodedCookie) {
  const profileMatch = decodedCookie.match(/xman_us_f=x_locale=([^&;]+)&x_user=([A-Z]+)\|([^|]+)\|([^|]+)\|([^|]+)\|(\d+)/);
  const legacyMatch = decodedCookie.match(/xman_us_f=.*x_user=[A-Z]+\|([^|]+)\|([^|]+)\|[^|]+\|(\d+)/);
  const accioIdMatch = decodedCookie.match(/(?:^|;\s*)xman_i=aid=(\d+)/);
  const phoenixCookieRaw = getCookieValue(decodedCookie, 'phoenix_cookie');
  const phoenixCookie = new URLSearchParams(phoenixCookieRaw);
  const callbackExpiresAt = parsedUrl.searchParams.get('expiresAt');

  return {
    locale: profileMatch ? profileMatch[1] : null,
    countryCode: profileMatch ? profileMatch[2] : null,
    firstName: safeDecode(profileMatch ? profileMatch[3] : (legacyMatch ? legacyMatch[1] : null)),
    lastName: safeDecode(profileMatch ? profileMatch[4] : (legacyMatch ? legacyMatch[2] : null)),
    userType: profileMatch ? profileMatch[5] : null,
    userId: profileMatch ? profileMatch[6] : (legacyMatch ? legacyMatch[3] : null),
    accioId: accioIdMatch ? accioIdMatch[1] : null,
    phoenixCookieRaw: phoenixCookieRaw || null,
    effectiveRefreshToken: parsedUrl.searchParams.get('refreshToken') || phoenixCookie.get('refreshToken') || null,
    effectiveExpiresAt: callbackExpiresAt || phoenixCookie.get('expiresAt') || null,
  };
}

function buildAccioAuthUrl() {
  currentAccioAuthState = crypto.randomBytes(32).toString('hex');
  const loginUrl = new URL(ACCIO_LOGIN_URL);
  loginUrl.searchParams.set('return_url', ACCIO_AUTH_CALLBACK);
  loginUrl.searchParams.set('state', currentAccioAuthState);
  return loginUrl.toString();
}

function hasAccioAuthCredentials(credentials = {}) {
  return Boolean(credentials.token && (credentials.cookie || credentials.phoenixCookie));
}

function buildAccioCallbackUrlFromCredentials(credentials = {}) {
  if (!hasAccioAuthCredentials(credentials)) {
    throw new Error('缺少可重放的 Accio OAuth 凭证');
  }

  const callbackUrl = new URL(ACCIO_AUTH_CALLBACK);
  callbackUrl.searchParams.set('accessToken', credentials.token);

  if (credentials.cookie) {
    callbackUrl.searchParams.set('cookie', encodeURIComponent(credentials.cookie));
  }
  if (credentials.expiresAt) {
    callbackUrl.searchParams.set('expiresAt', String(credentials.expiresAt));
  }
  if (credentials.refreshToken) {
    callbackUrl.searchParams.set('refreshToken', credentials.refreshToken);
  }

  return callbackUrl.toString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function canConnectToPort(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host });
    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForAccioAuthListener(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnectToPort(4097)) return true;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return false;
}

async function forwardAccioAuthCallback(rawUrl) {
  if (typeof fetch === 'undefined') {
    throw new Error('当前运行环境不支持本地认证回调转发');
  }

  const targetUrl = new URL(rawUrl);
  targetUrl.port = '4097';

  const response = await fetch(targetUrl.toString(), {
    method: 'GET',
    signal: getFetchTimeoutSignal(5000),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Accio 本地认证回调失败（HTTP ${response.status}）`);
  }

  return { status: response.status, body };
}

async function fetchAccioLocalAuthUser() {
  if (typeof fetch === 'undefined') {
    throw new Error('当前运行环境不支持本地认证状态查询');
  }

  const targetUrl = new URL(ACCIO_AUTH_CALLBACK);
  targetUrl.port = '4097';
  targetUrl.pathname = '/auth/user';

  const response = await fetch(targetUrl.toString(), {
    method: 'GET',
    signal: getFetchTimeoutSignal(3000),
  });

  const body = await response.text();
  return { status: response.status, ok: response.ok, body };
}

async function logoutAccioLocal() {
  if (typeof fetch === 'undefined') {
    throw new Error('当前运行环境不支持本地登出');
  }

  const targetUrl = new URL(ACCIO_AUTH_CALLBACK);
  targetUrl.port = '4097';
  targetUrl.pathname = '/auth/logout';

  const response = await fetch(targetUrl.toString(), {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
    },
    signal: getFetchTimeoutSignal(5000),
  });

  const body = await response.text();
  if (!response.ok && response.status !== 401 && response.status !== 403) {
    throw new Error(`Accio 本地登出失败（HTTP ${response.status}）`);
  }

  return { status: response.status, body };
}

async function waitForAccioLogout(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const userState = await fetchAccioLocalAuthUser();
      if (userState.status === 401 || userState.status === 403) return true;
    } catch {}

    await sleep(400);
  }

  return false;
}

async function ensureAccioAuthListenerReady() {
  let launchedAccio = false;

  if (!(await canConnectToPort(4097))) {
    launchAccio();
    launchedAccio = true;
  }

  const listenerReady = await waitForAccioAuthListener(launchedAccio ? 15000 : 3000);
  if (!listenerReady) {
    throw new Error('Accio 本地认证端口未就绪，无法执行 OAuth 切换');
  }

  return { launchedAccio };
}

async function switchAccioAccountWithOAuth(accountId, accountMeta = {}, options = {}) {
  const credentials = accountMeta.credentials || {};
  const callbackUrl = buildAccioCallbackUrlFromCredentials(credentials);
  const { logoutFirst = false } = options;

  const listenerState = await ensureAccioAuthListenerReady();

  if (logoutFirst) {
    await logoutAccioLocal();
    const loggedOut = await waitForAccioLogout(10000);
    if (!loggedOut) {
      throw new Error('Accio 未在预期时间内完成登出，已取消 OAuth 切换');
    }
    await sleep(600);
  }

  await forwardAccioAuthCallback(callbackUrl);

  const meta = readMeta();
  meta.activeAccountId = accountId;
  meta.accounts[accountId] = meta.accounts[accountId] || {};
  meta.accounts[accountId].auth = {
    ...(meta.accounts[accountId].auth || {}),
    lastSwitchAt: new Date().toISOString(),
    lastSwitchMethod: logoutFirst ? 'oauth_logout_callback_replay' : 'oauth_callback_replay',
  };
  writeMeta(meta);

  scheduleProfileSaveIfActive(accountId);

  return { launchedAccio: listenerState.launchedAccio, logoutFirst };
}

async function importAccioAuthCallback(rawUrl, { validateState = false } = {}) {
  if (!rawUrl) throw new Error('URL 不能为空');

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error('无效的 URL 格式');
  }

  const isExpectedCallback =
    (parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost') &&
    parsedUrl.pathname === '/auth/callback';

  if (!isExpectedCallback) {
    throw new Error(`请输入 Accio 回调链接，例如 ${ACCIO_AUTH_CALLBACK}?accessToken=...`);
  }

  const callbackState = parsedUrl.searchParams.get('state');

  if (validateState) {
    if (callbackState && currentAccioAuthState && callbackState !== currentAccioAuthState) {
      throw new Error('state 校验失败，请重新发起授权');
    }
    if (!callbackState) {
      console.warn('[Auth] Accio callback URL did not include state; continuing with token import.');
    } else if (!currentAccioAuthState) {
      console.warn('[Auth] Local auth state was missing or expired; continuing because callback included usable tokens.');
    }
  }

  const accessToken = parsedUrl.searchParams.get('accessToken');
  const cookieRaw = parsedUrl.searchParams.get('cookie') || '';

  let decodedCookie = cookieRaw;
  try {
    // Repeatedly decode to handle double/triple-encoded cookies (e.g. %253D → %3D → =)
    let prev = cookieRaw;
    let current = decodeURIComponent(prev);
    while (current !== prev) {
      prev = current;
      try { current = decodeURIComponent(prev); } catch { break; }
    }
    decodedCookie = current;
  } catch {}

  if (!accessToken) {
    throw new Error('未在 URL 中找到 accessToken，请确认粘贴的是 Accio 本地回调链接');
  }

  const extracted = extractAccioAuthMetadata(parsedUrl, decodedCookie);
  if (!extracted.userId) throw new Error('无法从 Cookie 解析用户 ID');

  const firstName = extracted.firstName || '';
  const lastName = extracted.lastName || '';
  const userId = extracted.userId;
  const name = `${firstName} ${lastName}`.trim();
  const importedAt = new Date().toISOString();

  const meta = readMeta();
  if (!meta.accounts[userId]) meta.accounts[userId] = { quota: getDefaultQuota() };

  meta.accounts[userId].label = name;
  meta.accounts[userId].credentials = meta.accounts[userId].credentials || {};
  meta.accounts[userId].credentials.token = accessToken;
  meta.accounts[userId].credentials.refreshToken = extracted.effectiveRefreshToken;
  meta.accounts[userId].credentials.cookie = decodedCookie;
  meta.accounts[userId].credentials.expiresAt = extracted.effectiveExpiresAt ? Number(extracted.effectiveExpiresAt) : null;
  meta.accounts[userId].credentials.expiresAtIso = extracted.effectiveExpiresAt
    ? new Date(Number(extracted.effectiveExpiresAt) * 1000).toISOString()
    : null;
  meta.accounts[userId].credentials.phoenixCookie = extracted.phoenixCookieRaw;
  meta.accounts[userId].credentials.deviceId = meta.accounts[userId].credentials.deviceId
    || getAccioAccountInfoContext(meta.accounts[userId]).deviceId;
  meta.accounts[userId].profile = {
    userId,
    accioId: extracted.accioId,
    locale: extracted.locale,
    countryCode: extracted.countryCode,
    firstName: extracted.firstName,
    lastName: extracted.lastName,
    displayName: name,
    userType: extracted.userType,
  };
  meta.accounts[userId].auth = {
    source: 'callback_url',
    callbackHost: parsedUrl.host,
    callbackPath: parsedUrl.pathname,
    importedAt,
    expiresAt: extracted.effectiveExpiresAt ? Number(extracted.effectiveExpiresAt) : null,
    expiresAtIso: extracted.effectiveExpiresAt
      ? new Date(Number(extracted.effectiveExpiresAt) * 1000).toISOString()
      : null,
  };
  meta.accounts[userId].tags = meta.accounts[userId].tags || [];
  if (!meta.accounts[userId].tags.includes('Accio')) {
    meta.accounts[userId].tags.push('Accio');
  }

  const [legacyRemoteProfile, accountInfo] = await Promise.all([
    fetchAccioRemoteProfile(meta.accounts[userId].credentials),
    fetchAccioAccountInfo(meta.accounts[userId]),
  ]);
  const mergedRemoteProfile = mergeRemoteProfilePayloads(
    meta.accounts[userId].remoteProfile || {},
    legacyRemoteProfile,
    accountInfo
  );

  if (legacyRemoteProfile || accountInfo) {
    meta.accounts[userId].remoteProfile = mergedRemoteProfile;
    if (accountInfo?.email || legacyRemoteProfile?.email) {
      meta.accounts[userId].email = accountInfo?.email || legacyRemoteProfile?.email;
    }
    if ((!meta.accounts[userId].label || meta.accounts[userId].label === `账号 ${userId}`) && accountInfo?.nickName) {
      meta.accounts[userId].label = accountInfo.nickName;
    }
  }

  const bridgeMatched = consumeRegisterOAuthBridgeEntry({
    email: meta.accounts[userId].email,
  });
  if (bridgeMatched) {
    meta.accounts[userId].registration = {
      ...(meta.accounts[userId].registration || {}),
      source: bridgeMatched.source || 'python_register',
      email: bridgeMatched.email || meta.accounts[userId].email || '',
      registeredAt: bridgeMatched.registeredAt || null,
      authProcessType: bridgeMatched.authProcessType || null,
      sid: bridgeMatched.sid || null,
      bridgeMatchedAt: new Date().toISOString(),
    };
    if (!meta.accounts[userId].credentials.deviceId && bridgeMatched.deviceId) {
      meta.accounts[userId].credentials.deviceId = bridgeMatched.deviceId;
    }
    meta.accounts[userId].tags = meta.accounts[userId].tags || [];
    if (!meta.accounts[userId].tags.includes('Registered')) {
      meta.accounts[userId].tags.push('Registered');
    }
  }

  const liveQuota = await fetchAccioQuota(meta.accounts[userId].credentials);
  if (liveQuota) {
    meta.accounts[userId].quota = {
      ...getDefaultQuota(),
      ...(meta.accounts[userId].quota || {}),
      ...liveQuota,
    };
  }

  try {
    await forwardAccioAuthCallback(rawUrl);
    console.log('[Import] Forwarded auth callback to local Accio app on port 4097!');
  } catch (e) {
    console.warn('Accio local port 4097 not listening or already consumed.');
  }

  meta.activeAccountId = userId;
  writeMeta(meta);

  scheduleProfileSaveIfActive(userId);

  if (validateState) currentAccioAuthState = '';

  return { success: true, userId, name, accessToken, autoLoggedIn: true };
}

// ========== Active Account Detection ==========

// Detect which account Accio is currently logged into by reading the SDK log
function detectActiveAccountFromLogs() {
  try {
    if (!fs.existsSync(SDK_LOG)) return null;
    
    // Efficiently use grep to find the last occurring userId or account path in the entire log
    const cmd = `grep -oE '"userId":"[0-9]{10,}"|\\.accio/accounts/[0-9]{10,}' "${SDK_LOG}" | tail -n 1 | grep -oE '[0-9]{10,}'`;
    const result = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    
    if (result && result.length >= 10) {
      return result;
    }
    return null;
  } catch (e) {
    // grep returns exit code 1 if no match is found, which throws an error in execSync
    return null;
  }
}

// Always re-detect active account from live Accio state
function getActiveAccountId() {
  const detected = detectActiveAccountFromLogs();
  if (detected) {
    // Update meta with the latest detection
    const meta = readMeta();
    if (meta.activeAccountId !== detected) {
      meta.activeAccountId = detected;
      writeMeta(meta);
      console.log(`[Detect] Active account changed to: ${detected}`);
    }
    return detected;
  }
  // Fallback to stored meta
  return readMeta().activeAccountId;
}

// ========== Profile Switching (Real Accio) ==========

const PROFILE_FILES = [
  'credentials.enc',
  'Cookies',
  'Cookies-journal',
  'Preferences',
  'Network Persistent State',
  'TransportSecurity',
  'DIPS',
  'DIPS-shm',
  'DIPS-wal',
  'Trust Tokens',
  'Trust Tokens-journal',
];
const PROFILE_DIRS = ['Local Storage', 'Session Storage'];

function getProfileDir(accountId) {
  const dir = path.join(PROFILES_DIR, accountId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isProfileSaved(accountId) {
  const profileDir = getProfileDir(accountId);
  return fs.existsSync(path.join(profileDir, 'credentials.enc'));
}

function saveProfile(accountId) {
  const profileDir = getProfileDir(accountId);
  for (const file of PROFILE_FILES) {
    const src = path.join(ELECTRON_DIR, file);
    const dst = path.join(profileDir, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
  for (const dir of PROFILE_DIRS) {
    const src = path.join(ELECTRON_DIR, dir);
    const dst = path.join(profileDir, dir);
    if (fs.existsSync(src)) {
      if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
      copyDirSync(src, dst);
    }
  }
  console.log(`[Profile] Saved profile for account ${accountId}`);
}

function scheduleProfileSaveIfActive(accountId, delayMs = 2000) {
  setTimeout(() => {
    try {
      if (!isAccioRunning()) return;
      const detectedActiveId = getActiveAccountId();
      if (detectedActiveId !== accountId) {
        console.warn(`[Profile] Skip saving ${accountId}; live active account is ${detectedActiveId || 'unknown'}.`);
        return;
      }
      saveProfile(accountId);
    } catch (e) {
      console.warn(`[Profile] Deferred save failed for ${accountId}: ${e.message}`);
    }
  }, delayMs);
}

function restoreProfile(accountId) {
  const profileDir = getProfileDir(accountId);
  if (!fs.existsSync(path.join(profileDir, 'credentials.enc'))) {
    throw new Error(`账号 ${accountId} 没有保存的登录配置文件，请先在 Accio 中登录此账号并保存配置`);
  }
  for (const file of PROFILE_FILES) {
    const src = path.join(profileDir, file);
    const dst = path.join(ELECTRON_DIR, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
  for (const dir of PROFILE_DIRS) {
    const src = path.join(profileDir, dir);
    const dst = path.join(ELECTRON_DIR, dir);
    if (fs.existsSync(src)) {
      if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
      copyDirSync(src, dst);
    }
  }
  console.log(`[Profile] Restored profile for account ${accountId}`);
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, dstPath);
    else fs.copyFileSync(srcPath, dstPath);
  }
}

function isAccioRunning() {
  try {
    const result = execSync('pgrep -f "Accio" 2>/dev/null', { encoding: 'utf-8' }).trim();
    return result.length > 0;
  } catch { return false; }
}

function killAccio() {
  try {
    execSync('pkill -f "Accio.app" 2>/dev/null; pkill -f "com.accio.desktop" 2>/dev/null', { encoding: 'utf-8' });
    execSync('sleep 1');
    console.log('[Accio] Killed Accio process');
  } catch {
    console.log('[Accio] No running Accio process found');
  }
}

async function waitForAccioShutdown(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = isAccioRunning();
    const authPortOpen = await canConnectToPort(4097, '127.0.0.1', 250);
    if (!running && !authPortOpen) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

function launchAccio() {
  exec('open -a "Accio"', (err) => {
    if (err) console.error('[Accio] Failed to launch:', err.message);
    else console.log('[Accio] Launched Accio app');
  });
}

// ========== Account Stats ==========

function getAccountStats(accountId) {
  const accountDir = path.join(ACCOUNTS_DIR, accountId);
  const stats = { conversations: 0, agents: 0, connectors: [], tasks: 0, skills: 0, channels: [], lastModified: null };
  try {
    if (!fs.existsSync(accountDir)) return stats; // Don't error if directory hasn't been created yet
    
    const convDir = path.join(accountDir, 'conversations');
    if (fs.existsSync(convDir)) stats.conversations = fs.readdirSync(convDir).filter(f => !f.startsWith('.')).length;
    const agentsDir = path.join(accountDir, 'agents');
    if (fs.existsSync(agentsDir)) stats.agents = fs.readdirSync(agentsDir).filter(f => !f.startsWith('.')).length;
    const connectorsDir = path.join(accountDir, 'connectors');
    if (fs.existsSync(connectorsDir)) stats.connectors = fs.readdirSync(connectorsDir).filter(f => !f.startsWith('.'));
    const tasksDir = path.join(accountDir, 'tasks');
    if (fs.existsSync(tasksDir)) stats.tasks = fs.readdirSync(tasksDir).filter(f => !f.startsWith('.')).length;
    const skillsDir = path.join(accountDir, 'skills');
    if (fs.existsSync(skillsDir)) stats.skills = fs.readdirSync(skillsDir).filter(f => !f.startsWith('.')).length;
    const channelsDir = path.join(accountDir, 'channels');
    if (fs.existsSync(channelsDir)) stats.channels = fs.readdirSync(channelsDir).filter(f => !f.startsWith('.'));
    stats.lastModified = fs.statSync(accountDir).mtime.toISOString();
  } catch (e) {
    // Avoid spamming error for missing directories during initial state
    if (e.code !== 'ENOENT') {
      console.error(`Error reading stats for account ${accountId}:`, e.message);
    }
  }
  return stats;
}

// ========== Routes ==========

// GET /api/accounts
app.get('/api/accounts', async (req, res) => {
  try {
    const meta = readMeta();
    const settings = readSettings();
    const activeId = getActiveAccountId(); // Always re-detect!
    const accountIds = getAllAccountIds(meta);

    const accounts = await Promise.all(accountIds.map(async id => {
      const stats = getAccountStats(id);
      const accountMeta = meta.accounts[id] || {};
      const settingsEntry = settings.accounts?.[id] || {};
      const runtimeState = buildRuntimeAccountState(accountMeta);

      return {
        id,
        label: accountMeta.label || (id === 'guest' ? '访客账号' : `账号 ${id}`),
        email: accountMeta.email || '',
        phone: accountMeta.phone || '',
        notes: accountMeta.notes || '',
        quota: runtimeState.quota,
        credentials: accountMeta.credentials || {},
        profile: accountMeta.profile || null,
        auth: accountMeta.auth || null,
        remoteProfile: accountMeta.remoteProfile || null,
        isActive: activeId === id,
        isGuest: id === 'guest',
        disabled: !!accountMeta.disabled, // Add missing disabled state
        subscription: accountMeta.subscription || { planName: 'Free Plan' }, // Add subscription
        userType: accountMeta.profile?.userType || (accountMeta.userType || 'ifm'), // User type for China/Intl detection
        stats,
        defaultAgentsCreated: settingsEntry.defaultAgentsCreated || [],
        createdAt: accountMeta.createdAt || null,
        tags: accountMeta.tags || [],
        profileSaved: isProfileSaved(id),
        switchPreference: normalizeSwitchPreference(accountMeta.switchPreference),
      };
    }));

    accounts.sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      if (a.isGuest) return 1;
      if (b.isGuest) return -1;
      return a.id.localeCompare(b.id);
    });

    res.json({ accounts, activeAccountId: activeId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/accounts/:id
app.get('/api/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const accountDir = path.join(ACCOUNTS_DIR, id);

    const meta = readMeta();
    if (!fs.existsSync(accountDir) && !meta.accounts[id]) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const activeId = getActiveAccountId();
    const stats = getAccountStats(id);
    const accountMeta = meta.accounts[id] || {};
    const runtimeState = buildRuntimeAccountState(accountMeta);

    const connectorDetails = {};
    const connectorsDir = path.join(accountDir, 'connectors');
    if (fs.existsSync(connectorsDir)) {
      for (const c of fs.readdirSync(connectorsDir).filter(f => !f.startsWith('.'))) {
        const stateFile = path.join(connectorsDir, c, 'state.json');
        if (fs.existsSync(stateFile)) {
          try { connectorDetails[c] = JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch {}
        }
      }
    }

    res.json({
      id,
      label: accountMeta.label || (id === 'guest' ? '访客账号' : `账号 ${id}`),
      email: accountMeta.email || '',
      phone: accountMeta.phone || '',
      notes: accountMeta.notes || '',
      quota: runtimeState.quota,
      credentials: accountMeta.credentials || {},
      profile: accountMeta.profile || null,
      auth: accountMeta.auth || null,
      remoteProfile: accountMeta.remoteProfile || null,
      isActive: activeId === id,
      stats,
      connectorDetails,
      tags: accountMeta.tags || [],
      profileSaved: isProfileSaved(id),
      switchPreference: normalizeSwitchPreference(accountMeta.switchPreference),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/accounts/:id
app.put('/api/accounts/:id', (req, res) => {
  try {
    const { id } = req.params;
    const meta = readMeta();
    const existing = meta.accounts[id] || {};
    const updates = { ...(req.body || {}) };
    if (Object.prototype.hasOwnProperty.call(updates, 'switchPreference')) {
      updates.switchPreference = normalizeSwitchPreference(updates.switchPreference);
    }
    meta.accounts[id] = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
      createdAt: existing.createdAt || new Date().toISOString(),
    };
    writeMeta(meta);
    res.json({ success: true, account: meta.accounts[id] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/accounts/:id
app.delete('/api/accounts/:id', (req, res) => {
  try {
    const { id } = req.params;
    const meta = readMeta();
    
    // 1. Remove from metadata
    if (meta.accounts && meta.accounts[id]) {
      delete meta.accounts[id];
      writeMeta(meta);
    }
    
    // 2. Remove physical storage directory to prevent "auto-discovery" of ghost accounts
    const accountDir = path.join(ACCOUNTS_DIR, id);
    if (fs.existsSync(accountDir)) {
      try {
        fs.rmSync(accountDir, { recursive: true, force: true });
      } catch (err) {
        console.error(`Failed to cleanup directory for ${id}:`, err.message);
      }
    }
    
    res.json({ success: true, message: `账号 ${id} 及其所有本地配置已移除` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/accounts/:id/toggle-disabled
app.post('/api/accounts/:id/toggle-disabled', (req, res) => {
  try {
    const meta = readMeta();
    const acc = meta.accounts[req.params.id];
    if (!acc) {
      return res.status(404).json({ error: 'Account not found' });
    }
    acc.disabled = !acc.disabled;
    writeMeta(meta);
    res.json({ success: true, disabled: acc.disabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/accounts/:id/records
app.get('/api/accounts/:id/records', async (req, res) => {
  try {
    const meta = readMeta();
    const acc = meta.accounts[req.params.id];
    if (!acc || !hasAccioAuthCredentials(acc.credentials)) {
      return res.json({ success: true, records: [] });
    }
    const records = await fetchAccioUsageRecords(acc.credentials);
    res.json({ success: true, records });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/accounts/switch-preference
app.post('/api/accounts/switch-preference', (req, res) => {
  try {
    const meta = readMeta();
    const allAccountIds = new Set(getAllAccountIds(meta));
    const requestedIds = Array.isArray(req.body?.ids) ? req.body.ids.filter(id => typeof id === 'string') : [];
    const switchPreference = normalizeSwitchPreference(req.body?.switchPreference);

    if (!requestedIds.length) {
      return res.status(400).json({ error: 'ids is required' });
    }

    const invalidIds = requestedIds.filter(id => !allAccountIds.has(id));
    if (invalidIds.length) {
      return res.status(404).json({ error: `Account not found: ${invalidIds[0]}` });
    }

    const updatedIds = [];
    for (const id of requestedIds) {
      const existing = meta.accounts[id] || {};
      meta.accounts[id] = {
        ...existing,
        switchPreference,
        updatedAt: new Date().toISOString(),
        createdAt: existing.createdAt || new Date().toISOString(),
      };
      updatedIds.push(id);
    }

    writeMeta(meta);
    res.json({ success: true, updatedIds, switchPreference });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/accounts/:id/quota/refresh
app.post('/api/accounts/:id/quota/refresh', async (req, res) => {
  try {
    const { id } = req.params;
    const meta = readMeta();
    const quota = await refreshStoredQuota(id, meta);
    writeMeta(meta);
    res.json({ success: true, id, quota });
  } catch (e) {
    const status = e.message === 'Account not found' ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

// POST /api/accounts/:id/userinfo/refresh
app.post('/api/accounts/:id/userinfo/refresh', async (req, res) => {
  try {
    const { id } = req.params;
    const meta = readMeta();
    const account = await refreshStoredRemoteProfile(id, meta);
    writeMeta(meta);
    res.json({ success: true, id, account, remoteProfile: account.remoteProfile || null });
  } catch (e) {
    const status = e.message === 'Account not found' ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

// POST /api/accounts/quota/refresh
app.post('/api/accounts/quota/refresh', async (req, res) => {
  try {
    const meta = readMeta();
    const accountIds = getAllAccountIds(meta);
    const results = [];

    for (const id of accountIds) {
      try {
        const quota = await refreshStoredQuota(id, meta);
        results.push({ id, success: true, quota });
      } catch (e) {
        results.push({ id, success: false, error: e.message });
      }
    }

    if (results.some(item => item.success)) {
      writeMeta(meta);
    }

    res.json({
      success: results.some(item => item.success),
      refreshed: results.filter(item => item.success).length,
      failed: results.filter(item => !item.success).length,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/accounts/:id/save-profile
app.post('/api/accounts/:id/save-profile', (req, res) => {
  try {
    const { id } = req.params;
    const accountDir = path.join(ACCOUNTS_DIR, id);
    if (!fs.existsSync(accountDir)) return res.status(404).json({ error: 'Account not found' });

    if (!fs.existsSync(path.join(ELECTRON_DIR, 'credentials.enc'))) {
      return res.status(400).json({ error: 'Accio 未检测到登录凭证，请先在 Accio 中登录此账号' });
    }

    saveProfile(id);
    const meta = readMeta();
    meta.activeAccountId = id;
    writeMeta(meta);

    res.json({ success: true, message: `已保存账号 ${id} 的登录配置` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/accounts/:id/activate
app.post('/api/accounts/:id/activate', async (req, res) => {
  try {
    const { id } = req.params;
    const meta = readMeta();
    const switchMode = req.body?.switchMode === 'oauth_logout' ? 'oauth_logout' : 'auto';
    if (!meta.accounts[id] && !fs.existsSync(path.join(ACCOUNTS_DIR, id))) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const targetMeta = meta.accounts[id] || {};
    const hasOAuth = hasAccioAuthCredentials(targetMeta.credentials);
    const hasSavedProfile = isProfileSaved(id);

    const currentActiveId = getActiveAccountId();
    if (currentActiveId && currentActiveId !== id && isAccioRunning()) {
      try { saveProfile(currentActiveId); } catch (e) {
        console.warn(`[Profile] Failed to save current profile: ${e.message}`);
      }
    }

    if (!hasOAuth && hasSavedProfile && switchMode !== 'oauth_logout') {
      killAccio();
      const fullyStopped = await waitForAccioShutdown(15000);
      if (!fullyStopped) {
        console.warn('[Accio] Timed out waiting for full shutdown before restoring profile.');
      }
      restoreProfile(id);
      meta.activeAccountId = id;
      meta.accounts[id] = meta.accounts[id] || {};
      meta.accounts[id].auth = {
        ...(meta.accounts[id].auth || {}),
        lastSwitchAt: new Date().toISOString(),
        lastSwitchMethod: 'profile_restore',
      };
      writeMeta(meta);
      launchAccio();

      return res.json({
        success: true,
        activeAccountId: id,
        profileSwapped: true,
        switchMethod: 'profile',
        message: `已恢复账号 ${id} 的本地登录配置，Accio 正在重启...`,
      });
    }

    if (!hasOAuth) {
      return res.status(400).json({
        error: '此账号既没有已保存的本地配置，也没有可用的 OAuth 凭证。请先导入回调 URL 或保存当前配置。',
      });
    }

    const oauthResult = await switchAccioAccountWithOAuth(id, targetMeta, {
      logoutFirst: switchMode === 'oauth_logout',
    });
    return res.json({
      success: true,
      activeAccountId: id,
      profileSwapped: false,
      switchMethod: switchMode === 'oauth_logout' ? 'oauth_logout' : 'oauth',
      launchedAccio: oauthResult.launchedAccio,
      message: switchMode === 'oauth_logout'
        ? (oauthResult.launchedAccio
            ? `已请求 Accio 退出当前登录，并通过 OAuth 唤起账号 ${id}，桌面端正在启动并同步登录状态...`
            : `已请求 Accio 退出当前登录，并通过 OAuth 唤起账号 ${id}。`)
        : (oauthResult.launchedAccio
            ? `已尝试通过授权凭证切换到账号 ${id}，Accio 正在启动并同步登录状态...`
            : `已尝试通过授权凭证切换到账号 ${id}。若桌面端仍显示登录页，请先保存一次本地配置。`),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/import
app.post('/api/auth/import', async (req, res) => {
  try {
    const result = await importAccioAuthCallback(req.body?.url);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/debug/quota/:id — returns raw API responses for debugging the new points system
app.get('/api/debug/quota/:id', async (req, res) => {
  try {
    const meta = readMeta();
    const acc = meta.accounts[req.params.id];
    if (!acc || !hasAccioAuthCredentials(acc.credentials)) {
      return res.status(404).json({ error: '账号不存在或缺少凭证' });
    }
    const gatewayContext = getAccioGatewayContext(acc.credentials);
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'x-language': gatewayContext.language,
      'x-utdid': gatewayContext.utdid,
      'x-app-version': gatewayContext.version,
      'x-os': gatewayContext.os,
      'x-cna': gatewayContext.cna,
      ...(gatewayContext.cookie ? { 'Cookie': gatewayContext.cookie } : {}),
    };

    const fetchRaw = async (path) => {
      const url = new URL(path, ACCIO_GATEWAY_ORIGIN);
      url.searchParams.set('accessToken', acc.credentials.token);
      url.searchParams.set('utdid', gatewayContext.utdid);
      url.searchParams.set('version', gatewayContext.version);
      try {
        const r = await fetch(url, { method: 'GET', headers, signal: getFetchTimeoutSignal(5000) });
        const text = await r.text();
        return { status: r.status, ok: r.ok, raw: text, parsed: JSON.parse(text) };
      } catch (e) {
        return { error: e.message };
      }
    };

    const [quotaRaw, pointRaw] = await Promise.all([
      fetchRaw('/api/entitlement/quota'),
      fetchRaw('/api/entitlement/point'),
    ]);

    res.json({ quotaEndpoint: quotaRaw, pointEndpoint: pointRaw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// DELETE /api/accounts/:id/meta
app.delete('/api/accounts/:id/meta', (req, res) => {
  try {
    const { id } = req.params;
    const meta = readMeta();
    delete meta.accounts[id];
    if (meta.activeAccountId === id) meta.activeAccountId = null;
    writeMeta(meta);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/overview
app.get('/api/overview', (req, res) => {
  try {
    const settings = readSettings();
    const meta = readMeta();
    const activeId = getActiveAccountId();
    const accountIds = getAllAccountIds(meta);

    let totalConversations = 0, totalAgents = 0, totalTasks = 0;
    for (const id of accountIds) {
      const stats = getAccountStats(id);
      totalConversations += stats.conversations;
      totalAgents += stats.agents;
      totalTasks += stats.tasks;
    }

    const savedProfiles = accountIds.filter(id => isProfileSaved(id)).length;

    res.json({
      totalAccounts: accountIds.length,
      totalConversations,
      totalAgents,
      totalTasks,
      savedProfiles,
      activeAccountId: activeId,
      accioRunning: isAccioRunning(),
      appVersion: '0.5.0',
      theme: settings.general?.theme || 'light',
      language: settings.general?.language || 'en',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/accio/auth/url
app.get('/api/accio/auth/url', (req, res) => {
  res.json({ url: buildAccioAuthUrl() });
});

// Keep the old route for compatibility with stale frontend assets.
app.get('/api/codex/auth/url', (req, res) => {
  res.json({ url: buildAccioAuthUrl() });
});

// GET /auth/callback - Automatic redirect handler for one-click import
app.get('/auth/callback', async (req, res) => {
  const rawUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  try {
    console.log('[Auth] Received automatic callback redirect, processing import...');
    // Process the import logic directly (without needing manual paste)
    const result = await importAccioAuthCallback(rawUrl, { validateState: true });
    
    // Return a beautiful success page that automatically closes or redirects
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>授权成功 - Accio Manager</title>
        <style>
          body { font-family: -apple-system, system-ui; background: #0a0b0f; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #15161c; padding: 40px; border-radius: 20px; text-align: center; border: 1px solid #2d2e3a; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border-left: 4px solid #6c63ff; }
          h1 { color: #6c63ff; margin-bottom: 10px; }
          p { color: #b4b6c3; margin-bottom: 20px; }
          .btn { background: #6c63ff; color: white; padding: 10px 30px; border-radius: 100px; text-decoration: none; font-weight: 600; display: inline-block; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🚀 授权成功</h1>
          <p>账号 <b>${result.name}</b> 已自动保存到 Manager。<br>你可以关闭此窗口返回程序。</p>
          <a href="/" class="btn">回到首页</a>
          <script>
            // Attempt to focus or notify opener (if any), then redirect home after 2s
            setTimeout(() => { location.href = '/'; }, 3000);
          </script>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    res.status(400).send(`授权失败: ${e.message}`);
  }
});

// POST /api/auth/import-from-folder - Migrate data from another directory
app.post('/api/auth/import-from-folder', async (req, res) => {
  const { directoryPath } = req.body;
  if (!directoryPath || !fs.existsSync(directoryPath)) {
    return res.status(400).json({ error: '路径不存在或无效' });
  }

  try {
    const metaPath = path.join(directoryPath, 'accounts_meta.json');
    const profilesPath = path.join(directoryPath, 'profiles');
    let importedCount = 0;
    const currentMeta = readMeta();

    if (fs.existsSync(metaPath)) {
      const sourceMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (sourceMeta.accounts) {
        for (const [id, account] of Object.entries(sourceMeta.accounts)) {
          // Merge metadata
          currentMeta.accounts[id] = {
            ...(currentMeta.accounts[id] || {}),
            ...account,
          };
          
          // Attempt to copy physical profile from the source folder
          const sourceProfileDir = path.join(profilesPath, id);
          const destProfileDir = path.join(PROFILES_DIR, id);
          if (fs.existsSync(sourceProfileDir)) {
            const fsExtra = require('fs-extra');
            await fsExtra.copy(sourceProfileDir, destProfileDir, { overwrite: true });
          }
          importedCount++;
        }
      }
    } else {
      // Check if it's an official Accio accounts folder
      const possibleAccioAccounts = path.join(directoryPath, 'accounts');
      const targetDir = fs.existsSync(possibleAccioAccounts) ? possibleAccioAccounts : directoryPath;
      const subdirs = fs.readdirSync(targetDir);
      
      for (const dirName of subdirs) {
        const fullPath = path.join(targetDir, dirName);
        if (fs.statSync(fullPath).isDirectory() && /^\d+$/.test(dirName)) {
           // It looks like an Accio userId folder
           const userId = dirName;
           let label = `导入账号 ${userId}`;
           let email = '';
           
           // Try to extract rich meta from Accio's config.json
           try {
             const configPath = path.join(fullPath, 'config.json');
             if (fs.existsSync(configPath)) {
               const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
               if (config.nickName) label = config.nickName;
               if (config.email) email = config.email;
             }
           } catch {}

           if (!currentMeta.accounts[userId]) {
             currentMeta.accounts[userId] = { 
               label: label,
               email: email,
               quota: getDefaultQuota(),
               tags: ['Imported', 'AccioNative']
             };
           }
           const destProfileDir = path.join(PROFILES_DIR, userId);
           const fsExtra = require('fs-extra');
           await fsExtra.copy(fullPath, destProfileDir, { overwrite: true });
           importedCount++;
        }
      }
    }

    if (importedCount > 0) {
      writeMeta(currentMeta);
      res.json({ success: true, count: importedCount });
    } else {
      res.status(400).json({ error: '在目标文件夹中未找到有效的授权数据' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/accio/auth/callback
app.post('/api/accio/auth/callback', async (req, res) => {
  try {
    const result = await importAccioAuthCallback(req.body?.url, { validateState: true });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Keep the old route for compatibility with stale frontend assets.
app.post('/api/codex/auth/callback', async (req, res) => {
  try {
    const result = await importAccioAuthCallback(req.body?.url);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/updates/check - Version detection from Git
app.get('/api/updates/check', async (req, res) => {
  try {
    const pkgUrl = 'https://raw.githubusercontent.com/z-s-f/accio-manager/main/package.json';
    const fetchRes = await fetch(pkgUrl, { signal: getFetchTimeoutSignal(5000) });
    if (!fetchRes.ok) throw new Error('无法连接到版本库');
    const remotePkg = await fetchRes.json();
    const currentVersion = require('./package.json').version;
    
    res.json({
      current: currentVersion,
      latest: remotePkg.version,
      updateAvailable: remotePkg.version !== currentVersion,
      platform: process.platform, // 'darwin' or 'win32'
      releaseUrl: 'https://github.com/z-s-f/accio-manager/releases'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({
    accioRunning: isAccioRunning(),
    activeAccountId: getActiveAccountId(),
  });
});

const server = app.listen(PORT, () => {
  ensureDataDir();
  const activeId = getActiveAccountId();
  console.log(`\n  🚀 Accio Manager is running at http://localhost:${PORT}`);
  console.log(`  📌 Active account: ${activeId || 'unknown'}`);
  console.log(`  📁 Profiles saved in: ${PROFILES_DIR}\n`);
});

// Export the http.Server instance so Electron's main process can
// hook the 'listening' event to know when the server is ready.
module.exports = server;
