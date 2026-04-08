// =============================================
// Accio Manager – Frontend Application
// =============================================

const API = window.electronAPI ? 'http://localhost:3000' : '';
let accounts = [];
let overview = {};
let currentPage = 'dashboard';
const VALID_PAGES = new Set(['dashboard', 'accounts', 'credentials', 'quota']);

// ---- Color palette for avatars ---- 
const AVATAR_COLORS = [
  'linear-gradient(135deg, #6c63ff, #a855f7)',
  'linear-gradient(135deg, #3ddc84, #00c6ff)',
  'linear-gradient(135deg, #ff6b6b, #ffa502)',
  'linear-gradient(135deg, #40c4ff, #6c63ff)',
  'linear-gradient(135deg, #f44565, #ff6b9d)',
  'linear-gradient(135deg, #ffa502, #ff6348)',
];

function getAvatarColor(index) {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

function getAvatarInitial(account) {
  if (account.isGuest) return 'G';
  if (account.label && account.label !== `账号 ${account.id}`) return account.label.charAt(0).toUpperCase();
  return '#' + account.id.slice(-2);
}

function maskSecret(value, visible = 6) {
  if (!value) return '';
  if (value.length <= visible * 2) return value;
  return `${value.slice(0, visible)}••••••${value.slice(-visible)}`;
}

function formatDateTime(value) {
  if (!value) return '未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCountdown(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '未记录';
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${Math.max(minutes, 1)} 分钟`;
}

function getExpiryStatus(expiresAtIso) {
  if (!expiresAtIso) {
    return { label: '未记录', tone: 'warning', detail: '缺少过期时间' };
  }

  const expiresAt = new Date(expiresAtIso);
  if (Number.isNaN(expiresAt.getTime())) {
    return { label: '未知', tone: 'warning', detail: expiresAtIso };
  }

  const diff = expiresAt.getTime() - Date.now();
  if (diff <= 0) {
    return { label: '已过期', tone: 'danger', detail: formatDateTime(expiresAtIso) };
  }

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  const label = days >= 1 ? `${days} 天后过期` : `${Math.max(hours, 1)} 小时后过期`;
  const tone = days >= 3 ? 'success' : 'warning';
  return { label, tone, detail: formatDateTime(expiresAtIso) };
}

function hasOAuthSwitchReady(account) {
  const creds = account?.credentials || {};
  return Boolean(creds.token && (creds.cookie || creds.phoenixCookie));
}

function getConfiguredSwitchMode(account) {
  return account?.switchPreference === 'profile' ? 'profile' : 'oauth_logout';
}

function getSwitchModeLabel(mode) {
  return mode === 'oauth_logout' ? '退出登录 + OAuth 唤起' : '恢复本地配置';
}

function canUseSwitchMode(account, mode) {
  if (mode === 'profile') return Boolean(account?.profileSaved);
  if (mode === 'oauth_logout') return hasOAuthSwitchReady(account);
  return false;
}

function getSwitchStrategy(account) {
  if (hasOAuthSwitchReady(account)) return 'oauth_logout';
  if (Boolean(account?.profileSaved)) return 'profile';
  return 'none';
}

function getSwitchActionLabel(account) {
  const strategy = getSwitchStrategy(account);
  if (strategy === 'oauth_logout') return 'OAuth 唤起';
  if (strategy === 'profile') return '切换并重启';
  return '未就绪';
}

function getSwitchActionIcon(account) {
  return getSwitchStrategy(account) === 'oauth_logout' ? 'logout' : 'swap_horiz';
}

function canRefreshQuota(account) {
  return Boolean(account?.credentials?.token && (account?.credentials?.cookie || account?.credentials?.phoenixCookie));
}

function canRefreshUserInfo(account) {
  return Boolean(account?.credentials?.cookie || account?.credentials?.token);
}

function getQuotaRefreshState(quota = {}) {
  if (!quota.checkedAt || !Number.isFinite(quota.refreshCountdownSeconds)) {
    return {
      nextRefreshAtIso: null,
      nextRefreshAtLabel: '未记录',
      isReady: false,
      statusLabel: '刷新时间未记录',
      tone: 'low',
    };
  }

  const checkedAt = new Date(quota.checkedAt);
  if (Number.isNaN(checkedAt.getTime())) {
    return {
      nextRefreshAtIso: null,
      nextRefreshAtLabel: '未记录',
      isReady: false,
      statusLabel: '刷新时间未记录',
      tone: 'low',
    };
  }

  const nextRefreshAt = new Date(checkedAt.getTime() + quota.refreshCountdownSeconds * 1000);
  const isReady = Date.now() >= nextRefreshAt.getTime();

  return {
    nextRefreshAtIso: nextRefreshAt.toISOString(),
    nextRefreshAtLabel: formatDateTime(nextRefreshAt.toISOString()),
    isReady,
    statusLabel: isReady ? '配额已刷新' : `刷新日期：${formatDateTime(nextRefreshAt.toISOString())}`,
    tone: isReady ? 'ready' : 'low',
  };
}

function getAuthFacts(acc) {
  const creds = acc.credentials || {};
  const profile = acc.profile || {};
  const auth = acc.auth || {};
  const remote = acc.remoteProfile || {};
  const expiry = getExpiryStatus(creds.expiresAtIso || auth.expiresAtIso);
  const switchStrategy = getSwitchStrategy(acc);
  const preferredSwitchMode = getConfiguredSwitchMode(acc);
  const switchDetail = switchStrategy === 'none'
    ? '当前没有可用的本地配置或 OAuth 凭证'
    : preferredSwitchMode === switchStrategy
    ? `当前执行：${getSwitchModeLabel(switchStrategy)}`
    : `偏好已自动降级为：${getSwitchModeLabel(switchStrategy)}`;

  return [
    { label: '用户 ID', value: profile.userId || acc.id || '未识别', icon: 'fingerprint' },
    { label: 'Accio ID', value: profile.accioId || remote.accioId || '未识别', icon: 'badge' },
    { label: '显示名称', value: remote.nickName || remote.userName || profile.displayName || acc.label || '未识别', icon: 'person' },
    { label: '账号类型', value: remote.userType || profile.userType || '未识别', icon: 'workspace_premium' },
    { label: '地区 / 语言', value: profile.countryCode || profile.locale ? `${profile.countryCode || '--'} / ${profile.locale || '--'}` : '未识别', icon: 'public' },
    { label: '剩余 Credits', value: Number.isFinite(remote.remainingCredits) ? String(remote.remainingCredits) : '未同步', icon: 'credit_score' },
    {
      label: '多步积分',
      value: Number.isFinite(remote.remainingMultiStepPoints)
        ? `${remote.remainingMultiStepPoints} / ${Number.isFinite(remote.trialMaxAgentMultiStepPoints) ? remote.trialMaxAgentMultiStepPoints : '--'}`
        : '未同步',
      icon: 'alt_route'
    },
    { label: '认证状态', value: expiry.label, detail: expiry.detail, icon: 'verified_user', tone: expiry.tone },
    { label: '导入时间', value: formatDateTime(auth.importedAt), icon: 'schedule' },
    { label: '远端资料同步', value: formatDateTime(remote.syncedAt), icon: 'sync' },
    { label: '切换方式', value: getSwitchModeLabel(preferredSwitchMode), detail: switchDetail, icon: 'swap_horiz', tone: switchStrategy === 'profile' ? 'success' : switchStrategy === 'oauth_logout' ? 'warning' : 'danger' },
    { label: 'Access Token', value: creds.token ? maskSecret(creds.token, 8) : '未保存', icon: 'token' },
    { label: 'Refresh Token', value: creds.refreshToken ? maskSecret(creds.refreshToken, 8) : '未保存', icon: 'refresh' },
    { label: 'Phoenix Cookie', value: creds.phoenixCookie ? '已提取并保存' : '未保存', icon: 'cookie' },
    { label: '本地配置', value: acc.profileSaved ? '已保存，可直接切换' : '未保存，需先登录 Accio 并保存', icon: 'cloud_done', tone: acc.profileSaved ? 'success' : 'warning' },
  ];
}

// ---- API calls ----
async function fetchAccounts() {
  const res = await fetch(`${API}/api/accounts`);
  const data = await res.json();
  accounts = data.accounts || [];
  return data;
}

async function readApiJson(res, fallbackMessage = '请求失败') {
  const contentType = res.headers.get('content-type') || '';
  const rawText = await res.text();

  if (!rawText) {
    if (!res.ok) {
      throw new Error(fallbackMessage);
    }
    return {};
  }

  try {
    return JSON.parse(rawText);
  } catch {
    if (rawText.trim().startsWith('<')) {
      throw new Error('后端接口未生效，请重启 Manager 服务后再试');
    }
    throw new Error(fallbackMessage);
  }
}

async function fetchOverview() {
  const res = await fetch(`${API}/api/overview`);
  overview = await res.json();
  return overview;
}

async function updateAccount(id, data) {
  const res = await fetch(`${API}/api/accounts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function updateAccountsSwitchPreference(ids, switchPreference) {
  const res = await fetch(`${API}/api/accounts/switch-preference`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, switchPreference }),
  });
  return res.json();
}

async function activateAccount(id, options = {}) {
  const hasBody = options && Object.keys(options).length > 0;
  const res = await fetch(`${API}/api/accounts/${id}/activate`, {
    method: 'POST',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(options) : undefined,
  });
  return res.json();
}

async function saveProfile(id) {
  const res = await fetch(`${API}/api/accounts/${id}/save-profile`, { method: 'POST' });
  return res.json();
}

async function refreshAccountQuota(id) {
  const res = await fetch(`${API}/api/accounts/${id}/quota/refresh`, { method: 'POST' });
  return readApiJson(res, '配额刷新请求失败');
}

async function refreshAccountUserInfo(id) {
  const res = await fetch(`${API}/api/accounts/${id}/userinfo/refresh`, { method: 'POST' });
  return readApiJson(res, '同步用户信息请求失败');
}

async function refreshAllAccountQuotas() {
  const res = await fetch(`${API}/api/accounts/quota/refresh`, { method: 'POST' });
  return readApiJson(res, '批量刷新配额请求失败');
}

// ---- Toast ----
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const icons = { success: 'check_circle', error: 'error', info: 'info', warning: 'warning' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="material-icons-round">${icons[type] || 'info'}</span>${message}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ---- Navigation ----
function normalizePage(page) {
  return VALID_PAGES.has(page) ? page : 'dashboard';
}

function buildPageHash(page) {
  return `#/${normalizePage(page)}`;
}

function getPageFromLocation() {
  const hash = window.location.hash || '';
  const normalizedHash = hash.startsWith('#/') ? hash.slice(2) : hash.startsWith('#') ? hash.slice(1) : hash;
  return normalizePage(normalizedHash);
}

function navigateToPage(page) {
  const targetPage = normalizePage(page);
  const targetHash = buildPageHash(targetPage);

  if (window.location.hash === targetHash) {
    switchPage(targetPage);
    return;
  }

  window.location.hash = targetHash;
}

function syncRouteWithPage(page) {
  const targetHash = buildPageHash(page);
  if (window.location.hash !== targetHash) {
    window.location.replace(targetHash);
  }
}

function setupNav() {
  const items = document.querySelectorAll('.nav-item');
  items.forEach(item => {
    const page = normalizePage(item.dataset.page);
    item.setAttribute('href', buildPageHash(page));
    item.addEventListener('click', (e) => {
      e.preventDefault();
      navigateToPage(page);
    });
  });

  window.addEventListener('hashchange', () => {
    switchPage(getPageFromLocation());
  });

  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  document.getElementById('refresh-btn').addEventListener('click', async () => {
    await loadAll();
    showToast('数据已刷新', 'info');
  });
}

function switchPage(page) {
  currentPage = normalizePage(page);
  const titles = { dashboard: '总览', accounts: '账号管理', credentials: '凭证中心', quota: '配额管理' };
  document.getElementById('page-title').textContent = titles[currentPage] || currentPage;

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${currentPage}`).classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${currentPage}"]`)?.classList.add('active');

  document.getElementById('sidebar').classList.remove('open');
}

// ---- Render Dashboard ----
function renderDashboard() {
  const statsGrid = document.getElementById('stats-grid');
  statsGrid.innerHTML = `
    <div class="stat-card">
      <div class="stat-icon purple"><span class="material-icons-round">group</span></div>
      <div class="stat-value">${overview.totalAccounts || 0}</div>
      <div class="stat-label">总账号数</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon green"><span class="material-icons-round">save</span></div>
      <div class="stat-value">${overview.savedProfiles || 0}</div>
      <div class="stat-label">已保存配置</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon orange"><span class="material-icons-round">smart_toy</span></div>
      <div class="stat-value">${overview.totalAgents || 0}</div>
      <div class="stat-label">总代理数</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon blue"><span class="material-icons-round">chat</span></div>
      <div class="stat-value">${overview.totalConversations || 0}</div>
      <div class="stat-label">总对话数</div>
    </div>
  `;

  renderQuickSwitch();
}

function renderQuickSwitch() {
  const grid = document.getElementById('quick-switch-grid');
  if (!grid) return;

  // Sort: active first, then by remaining quota (highest first)
  const usableAccounts = accounts
    .filter(acc => !acc.disabled)
    .sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      const getRemainingPct = (q) => {
        if (!q || !q.checkedAt) return -1;
        if (q.total > 0) return (q.total - q.used) / q.total;
        // usagePercent is the % used: 0 = none used = max remaining
        if (Number.isFinite(q.usagePercent)) return 1 - q.usagePercent / 100;
        return -1;
      };
      return getRemainingPct(b.quota) - getRemainingPct(a.quota);
    });

  grid.innerHTML = usableAccounts.length === 0 ? `
    <div style="grid-column: 1/-1; padding: 40px; text-align: center; color: var(--text-tertiary);">
      没有可用的账号，请先在"账号管理"中启用或添加账号。
    </div>
  ` : usableAccounts.map((acc, idx) => {
    const bg = getAvatarColor(idx);
    const initial = getAvatarInitial(acc);
    const quota = acc.quota || {};
    const hasPoints = Number.isFinite(quota.total) && quota.total > 0;
    const hasPercent = Number.isFinite(quota.usagePercent);
    const hasQuotaData = !!quota.checkedAt;

    // Remaining percent for progress bar display (how much is LEFT)
    let remainPct = 0;
    let remainLabel = '—';
    let unitLabel = quota.unit || '积分';
    if (hasPoints) {
      const remain = Math.max(0, quota.total - quota.used);
      remainPct = Math.round((remain / quota.total) * 100);
      remainLabel = remain.toLocaleString();
    } else if (hasPercent) {
      // usagePercent = % used, remaining = 100 - usagePercent
      remainPct = Math.max(0, Math.round(100 - quota.usagePercent));
      remainLabel = remainPct + '%';
      unitLabel = '剩余';
    }

    const progressLevel = !hasQuotaData ? 'safe' : (remainPct > 50 ? 'safe' : (remainPct > 20 ? 'warning' : 'danger'));

    return `
      <div class="quick-card ${acc.isActive ? 'active' : ''}">
        <div class="quick-card-header">
          <div class="quick-card-avatar" style="background: ${bg}">${initial}</div>
          <div style="display:flex;align-items:center;gap:8px;">
            ${acc.profileSaved ? '<span class="material-icons-round" style="font-size:14px;color:var(--success);" title="本地配置已就绪">verified</span>' : ''}
            <span class="quick-card-status ${acc.isActive ? 'active' : 'inactive'}">
              ${acc.isActive ? '● 活动中' : '○ 未激活'}
            </span>
          </div>
        </div>
        <div class="quick-card-content" style="cursor:pointer;" onclick="openSwitchConfirmModalByAccount('${acc.id}')">
          <div class="quick-card-label">${acc.label || '未命名账号'}</div>
          <div class="quick-card-id-row">
            <span>ID: ${acc.id.substring(0, 10)}</span>
            <span>${quota.checkedAt ? formatDateTime(quota.checkedAt) : '未同步'}</span>
          </div>
        </div>

        <div class="quick-card-quota-compact">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <span style="font-size:11px; color:var(--text-tertiary);">剩余可用量</span>
            <span style="font-size:12px; font-weight:600; color:${!hasQuotaData ? 'var(--text-tertiary)' : (remainPct > 20 ? 'var(--text-secondary)' : 'var(--error)')}">
              ${hasQuotaData ? remainLabel : '未同步'} <small>${hasQuotaData ? unitLabel : ''}</small>
            </span>
          </div>
          <div class="quota-progress-bar" style="height:6px; background:rgba(255,255,255,0.05);">
            <div class="quota-progress-fill ${progressLevel}" style="width: ${hasQuotaData ? remainPct : 60}%;"></div>
          </div>
        </div>

        <div class="quick-card-actions" style="margin-top:16px; display:grid; grid-template-columns: 1fr auto; gap:8px;">
          <button class="btn btn-primary btn-sm" onclick="handleQuickSwitch('${acc.id}')" style="height:32px; font-size:12px; font-weight:600; background: ${acc.isActive ? 'rgba(255,255,255,0.05)' : 'var(--accent)'}; border:none; ${acc.isActive ? 'color:var(--text-tertiary);' : ''}" ${acc.isActive ? 'disabled' : ''}>
            ${acc.isActive ? '当前已登录' : (acc.profileSaved ? '🚀 快速登录' : '⚡️ 尝试切换')}
          </button>
          <button class="btn btn-sm" onclick="openSwitchConfirmModalByAccount('${acc.id}')" style="height:32px; width:32px; padding:0; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.05); color:var(--text-tertiary);" title="切换选项">
            <span class="material-icons-round" style="font-size:18px;">more_horiz</span>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function handleSaveProfile(id) {
  try {
    showToast('正在保存当前 Accio 登录配置...', 'info');
    const result = await saveProfile(id);
    if (result.success) {
      showToast(result.message || '配置已保存', 'success');
    } else {
      showToast(result.error || '保存失败', 'error');
    }
    await loadAll();
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

function openSwitchConfirmModal(acc) {
  const strategy = getSwitchStrategy(acc);
  const preferredMode = getConfiguredSwitchMode(acc);
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  const saveBtn = document.getElementById('modal-save');
  const cancelBtn = document.getElementById('modal-cancel');
  const footer = document.getElementById('modal-footer');

  openModal('确认切换账号');
  modal.classList.add('modal-compact');
  footer.style.display = 'flex';
  cancelBtn.textContent = '取消';
  saveBtn.textContent = strategy === 'oauth_logout' ? '继续切换' : strategy === 'profile' ? '确认重启' : '继续尝试';

  body.innerHTML = `
    <div class="switch-confirm">
      <div class="switch-confirm-hero ${strategy}">
        <div class="switch-confirm-icon">
          <span class="material-icons-round">${strategy === 'profile' ? 'restart_alt' : 'vpn_key'}</span>
        </div>
        <div class="switch-confirm-copy">
          <div class="switch-confirm-eyebrow">${strategy === 'profile' ? '稳定切换' : '凭证切换'}</div>
          <div class="switch-confirm-title">${acc.label}</div>
          <div class="switch-confirm-subtitle">
            ${strategy === 'oauth_logout'
              ? '先让 Accio 退出当前登录，再尝试用目标账号凭证重新唤起。'
              : strategy === 'profile'
              ? '恢复该账号已保存的本地登录态，并重启 Accio。'
              : '尝试用已保存的 OAuth 凭证直接切换到目标账号。'}
          </div>
        </div>
      </div>

      <div class="switch-confirm-meta">
        <div class="switch-confirm-meta-item">
          <span class="material-icons-round">fingerprint</span>
          <div>
            <div class="switch-confirm-meta-label">账号 ID</div>
            <div class="switch-confirm-meta-value">${acc.id}</div>
          </div>
        </div>
        <div class="switch-confirm-meta-item">
          <span class="material-icons-round">swap_horiz</span>
          <div>
            <div class="switch-confirm-meta-label">切换方式</div>
            <div class="switch-confirm-meta-value">${getSwitchModeLabel(preferredMode)}</div>
          </div>
        </div>
      </div>

      ${preferredMode !== strategy ? `
        <div class="switch-confirm-note warning">
          <span class="material-icons-round">sync_problem</span>
          <span>当前偏好不可用，本次将自动改走：${getSwitchModeLabel(strategy)}</span>
        </div>
      ` : ''}

      <div class="switch-confirm-steps">
        <div class="switch-confirm-step">
          <span class="switch-confirm-step-index">1</span>
          <span>${strategy === 'oauth_logout' ? '保存当前本地会话快照' : strategy === 'profile' ? '保存当前账号的本地配置' : '尽量保留当前本地会话快照'}</span>
        </div>
        <div class="switch-confirm-step">
          <span class="switch-confirm-step-index">2</span>
          <span>${strategy === 'oauth_logout' ? '请求 Accio 先退出当前登录态' : strategy === 'profile' ? '关闭 Accio 并恢复目标账号配置' : '向本地 Accio 回放目标账号凭证'}</span>
        </div>
        <div class="switch-confirm-step">
          <span class="switch-confirm-step-index">3</span>
          <span>${strategy === 'oauth_logout' ? '重新唤起目标账号并保存新配置' : strategy === 'profile' ? '重新启动 Accio 并进入目标账号' : '如果桌面端没接住登录态，仍可能需要手动确认登录'}</span>
        </div>
      </div>

      <div class="switch-confirm-note ${strategy}">
        <span class="material-icons-round">${strategy === 'profile' ? 'verified_user' : 'warning_amber'}</span>
        <span>${strategy === 'profile'
          ? '这条路径最稳定，但会重启 Accio。'
          : '这条路径更轻量，但稳定性取决于 Accio 当前是否正确接管了回调登录态。'}</span>
      </div>
    </div>
  `;

  saveBtn.onclick = async () => {
    closeModal();
    await executeSwitch(acc.id, strategy);
  };
}

async function promptDisableOnError(id, errorMsg) {
  const confirmed = await showConfirm('账号操作提示', `${errorMsg}\n\n该账号操作失败，是否立即禁用此账号以便在列表中排除？`, {
    type: 'warning',
    confirmText: '禁用并排除'
  });
  if (confirmed) {
    await toggleAccountDisabled(id);
  }
}

async function executeSwitch(id, strategy) {
  try {
    showToast(
      strategy === 'oauth_logout'
        ? '正在请求 Accio 退出登录，并通过 OAuth 唤起目标账号...'
        : '正在切换账号，Accio 将重启...',
      'info'
    );
    const result = await activateAccount(id, strategy === 'oauth_logout' ? { switchMode: 'oauth_logout' } : {});
    if (result.success) {
      if (result.switchMethod === 'oauth_logout') {
        showToast(result.message || '已通过退出登录 + OAuth 唤起方式切换账号', 'success');
      } else if (result.switchMethod === 'oauth') {
        showToast(result.message || '已尝试通过 OAuth 凭证切换账号', 'success');
      } else if (result.profileSwapped) {
        showToast(result.message || '切换成功，Accio 正在重启', 'success');
      } else {
        showToast(result.message || '已标记为活动账号', 'warning');
      }
    } else {
      showToast(result.error || '切换失败', 'error');
      await promptDisableOnError(id, `切换账号失败: ${result.error || '未知错误'}`);
    }
    await loadAll();
  } catch (e) {
    showToast('切换失败: ' + e.message, 'error');
    await promptDisableOnError(id, `切换操作发生网络错误: ${e.message}`);
  }
}

async function handleRefreshUserInfo(id) {
  try {
    showToast('正在同步用户信息...', 'info');
    const result = await refreshAccountUserInfo(id);
    if (result.success) {
      showToast('用户信息同步成功', 'success');
      await loadAll();
    } else {
      showToast(result.error || '同步失败', 'error');
      await promptDisableOnError(id, `同步用户信息失败: ${result.error || 'Token 可能已失效'}`);
    }
  } catch (e) {
    showToast('同步错误: ' + e.message, 'error');
    await promptDisableOnError(id, `网络请求失败: ${e.message}`);
  }
}

async function handleRefreshQuota(id) {
  try {
    showToast('正在刷新配额用法...', 'info');
    const result = await refreshAccountQuota(id);
    if (result.success) {
      showToast('配额刷新成功', 'success');
      await loadAll();
    } else {
      showToast(result.error || '刷新失败', 'error');
      await promptDisableOnError(id, `刷新可用量失败: ${result.error || '认证已失效'}`);
    }
  } catch (e) {
    showToast('刷新错误: ' + e.message, 'error');
    await promptDisableOnError(id, `配额刷新网络错误: ${e.message}`);
  }
}

async function toggleAccountDisabled(id) {
  try {
    const res = await fetch(`${API}/api/accounts/${id}/toggle-disabled`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(data.disabled ? '账号已禁用' : '账号已启用', 'info');
      await loadAll();
    }
  } catch (e) {
    showToast('操作失败: ' + e.message, 'error');
  }
}

async function deleteAccount(id) {
  const confirmed = await showConfirm('确认彻底删除', '确定要删除该账号吗？关联的数据和配置将被移除且无法恢复。', {
    type: 'error',
    danger: true,
    confirmText: '立即彻底删除'
  });
  if (!confirmed) return;
  try {
    const res = await fetch(`${API}/api/accounts/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('账号已从列表中移除', 'success');
      await loadAll();
    }
  } catch (e) {
    showToast('删除失败: ' + e.message, 'error');
  }
}

async function handleSwitch(id) {
  const acc = accounts.find(a => a.id === id);
  if (!acc) return;
  const strategy = getSwitchStrategy(acc);

  if (strategy === 'none') {
    showToast('此账号还不能切换。请先导入 Accio 回调 URL，或在 Accio 中登录后保存当前配置。', 'warning');
    return;
  }
  openSwitchConfirmModal(acc);
}

async function handleQuickSwitch(id) {
  const acc = accounts.find(a => a.id === id);
  if (!acc || acc.isActive) return;
  const strategy = getSwitchStrategy(acc);
  await executeSwitch(id, strategy);
}

function openSwitchConfirmModalByAccount(id) {
  handleSwitch(id);
}

// ---- Render Accounts ----
function renderAccounts() {
  const container = document.getElementById('accounts-list');
  if (!container) return;
  
  container.className = 'accounts-grid'; // Use the optimized grid class

  container.innerHTML = accounts.map((acc, idx) => {
    const bg = getAvatarColor(idx);
    const initial = getAvatarInitial(acc);
    const quota = acc.quota || { total: 0, used: 0 };
    const plan = acc.subscription?.planName || 'Free Plan';
    const isPro = plan.toLowerCase().includes('pro');

    return `
      <div class="account-card ${acc.isActive ? 'active' : ''} ${acc.disabled ? 'disabled' : ''}">
        <div class="account-card-header">
          <div class="account-card-top">
            <div class="account-card-avatar" style="background: ${bg}">${initial}</div>
            <div class="account-card-info">
              <div class="account-card-name">
                ${acc.label}
                <div class="account-card-badges">
                  ${acc.isActive ? '<span class="badge-compact active">Active</span>' : ''}
                  <span class="badge-compact ${isPro ? 'pro' : 'free'}">${plan}</span>
                </div>
              </div>
              <div class="account-card-id">#${acc.id.substring(0, 8)}</div>
            </div>
          </div>
          <div style="display:flex; gap:4px;">
            <button class="btn btn-icon btn-sm" onclick="toggleAccountDisabled('${acc.id}')" title="${acc.disabled ? '启用账号' : '禁用账号'}">
              <span class="material-icons-round" style="color: ${acc.disabled ? 'var(--success)' : 'var(--warning)'}; font-size:18px;">${acc.disabled ? 'play_circle' : 'pause_circle'}</span>
            </button>
            <button class="btn btn-icon btn-sm" onclick="deleteAccount('${acc.id}')" title="彻底删除">
              <span class="material-icons-round" style="color: var(--error); font-size:18px;">delete_forever</span>
            </button>
          </div>
        </div>

        <div class="account-card-details">
          <div class="detail-item">
            <div class="detail-label">可用量</div>
            <div class="detail-value">${(quota.total - quota.used).toLocaleString()} <span style="font-size:10px; opacity:0.5;">${quota.unit || '积分'}</span></div>
          </div>
          <div class="detail-item">
            <div class="detail-label">区域</div>
            <div class="detail-value">${acc.userType === 'cnfm' ? 'China' : 'Intl'}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">对话数</div>
            <div class="detail-value">${acc.stats.conversations}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">最后同步</div>
            <div class="detail-value">${quota.checkedAt ? formatDateTime(quota.checkedAt) : 'Never'}</div>
          </div>
        </div>

        <div class="account-card-actions">
          <button class="btn btn-outline btn-sm" onclick="openEditModal('${acc.id}')">
            <span class="material-icons-round" style="font-size:16px;">edit</span> 编辑
          </button>
          ${acc.isActive ? `
            <button class="btn btn-ghost btn-sm" onclick="handleSaveProfile('${acc.id}')">
              <span class="material-icons-round" style="font-size:16px;">save</span> 保存配置
            </button>
          ` : `
            <button class="btn btn-primary btn-sm" onclick="handleSwitch('${acc.id}')" ${acc.disabled ? 'disabled' : ''}>
              <span class="material-icons-round" style="font-size:16px;">swap_horiz</span> 切换
            </button>
          `}
        </div>
      </div>
    `;
  }).join('');
}

// ---- Render Credentials ----
function renderCredentials() {
  const grid = document.getElementById('credentials-grid');
  if (!grid) return;

  grid.innerHTML = accounts.map((acc, idx) => {
    const bg = getAvatarColor(idx);
    const hasToken = Boolean(acc.credentials?.token);
    const hasCookie = Boolean(acc.credentials?.cookie);
    const hasPhoenix = Boolean(acc.credentials?.phoenixCookie);
    const strategy = getSwitchStrategy(acc);
    const expiryDate = acc.auth?.expiresAtIso || acc.credentials?.expiresAtIso;
    
    let pathLabel = '无路径';
    let pathTone = 'danger';
    if (strategy === 'profile') { pathLabel = '配置复写'; pathTone = 'success'; }
    else if (strategy === 'oauth_logout') { pathLabel = 'OAuth 唤起'; pathTone = 'warning'; }

    return `
      <div class="credential-card">
        <div class="account-card-header" style="border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom:12px; margin-bottom:12px;">
          <div class="account-card-top">
            <div class="account-card-avatar" style="background: ${bg}; width:32px; height:32px; font-size:14px;">${getAvatarInitial(acc)}</div>
            <div class="account-card-info">
              <div class="account-card-name" style="font-size:14px;">${acc.label || '未命名账号'}</div>
              <div class="account-card-id" style="font-size:10px;">UID: ${acc.id}</div>
            </div>
          </div>
          <div style="display:flex; gap:6px;">
            <button class="btn btn-icon btn-sm" onclick="handleRefreshUserInfo('${acc.id}')" title="同步用户信息">
              <span class="material-icons-round" style="font-size:16px;">sync</span>
            </button>
            <button class="btn btn-icon btn-sm" onclick="openCredentialModal('${acc.id}')" title="设置">
              <span class="material-icons-round" style="font-size:16px;">settings</span>
            </button>
          </div>
        </div>

        <div class="credential-item" style="margin-bottom:16px;">
          <div class="credential-label-group">
            <span class="detail-label">Access Token (访问令牌)</span>
            <span class="badge-compact ${hasToken ? 'active' : 'free'}" style="font-size:9px; padding: 2px 6px;">${hasToken ? '已保存' : '缺失'}</span>
          </div>
          <div class="credential-code">
            <span>${hasToken ? maskSecret(acc.credentials.token, 6) : '---'}</span>
            <span class="material-icons-round" style="font-size:14px; opacity:0.3;">verified_user</span>
          </div>
        </div>

        <div class="account-card-details" style="background:none; border:none; padding:0; gap:8px; margin-bottom:16px; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom:16px;">
          <div class="detail-item">
            <div class="detail-label">切换方式</div>
            <div class="detail-value"><span class="badge-compact ${pathTone}">${pathLabel}</span></div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Cookie 状态</div>
            <div class="detail-value">${hasCookie ? '有效' : (hasPhoenix ? 'Phoenix' : '缺失')}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">链接状态</div>
            <div class="detail-value">${canRefreshQuota(acc) ? '在线 (同步中)' : '离线'}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">失效时间</div>
            <div class="detail-value" style="font-family:'JetBrains Mono'; font-size:11px; color:${expiryDate ? 'var(--text-secondary)' : 'var(--warning)'}">
              ${expiryDate ? formatDateTime(expiryDate) : '未记录'}
            </div>
          </div>
        </div>

        </div>
      </div>
    `;
  }).join('');
}

// ---- Render Quota ----
function renderQuota() {
  const grid = document.getElementById('quota-grid');
  grid.innerHTML = accounts.map((acc, idx) => {
    const bg = getAvatarColor(idx);
    const quota = acc.quota || {};
    const refreshReady = canRefreshQuota(acc);
    const hasLivePoints = Number.isFinite(quota.total) && quota.total > 0;
    // usagePercent from API = % already consumed (0 = nothing used, 100 = all used)
    const hasLivePercent = Number.isFinite(quota.usagePercent);
    const hasLiveQuota = !!quota.checkedAt;
    const refreshState = getQuotaRefreshState(quota);

    // displayUsedPct: how much has been CONSUMED (0–100), drives progress bar fill
    let displayUsedPct = 0;
    let quotaMainLabel = '';    // left side of "X / Y 单位"
    let quotaTotalLabel = '';
    let quotaUnitLabel = quota.unit || '积分';
    let remainSubLabel = '';    // e.g. "剩余 2030 积分"

    if (hasLivePoints) {
      displayUsedPct = quota.total > 0 ? Math.round((quota.used / quota.total) * 100) : 0;
      quotaMainLabel  = quota.used.toLocaleString();
      quotaTotalLabel = quota.total.toLocaleString();
      const remain    = Math.max(0, quota.total - quota.used);
      remainSubLabel  = `剩余 ${remain.toLocaleString()} ${quotaUnitLabel}`;
    } else if (hasLivePercent) {
      // Only have %-based data — usagePercent = % consumed
      displayUsedPct  = Math.round(Math.max(0, Math.min(100, quota.usagePercent)));
      quotaMainLabel  = displayUsedPct + '%';
      quotaTotalLabel = '100%';
      quotaUnitLabel  = '已使用';
      remainSubLabel  = `剩余 ${100 - displayUsedPct}%`;
    }

    // Progress bar color: based on how much REMAINS (green = plenty left, red = almost gone)
    const remainPct = 100 - displayUsedPct;
    const level = refreshState.isReady
      ? 'ready'
      : (remainPct > 50 ? 'safe' : (remainPct > 20 ? 'warning' : 'danger'));
    const checkedAt = quota.checkedAt ? formatDateTime(quota.checkedAt) : '从未刷新';

    // Breakdown detail
    const points = quota.details || {};
    const hasBreakdown = !!(points.basic?.total || points.limited?.total || points.supplement?.total);

    // Usage badge label: shows consumed%, "充足" when 0
    const usageBadge = displayUsedPct === 0 ? '充足' : `已用 ${displayUsedPct}%`;

    return `
      <div class="quota-card">
        <div class="quota-card-header">
          <div class="quota-card-title">
            <div class="quick-card-avatar" style="background: ${bg}; width: 32px; height: 32px; font-size: 13px; border-radius: 8px;">${getAvatarInitial(acc)}</div>
            <div>
              <div style="font-weight: 600;">${acc.label || '未命名账号'}</div>
              <div style="font-size: 11px; color: var(--text-tertiary); font-family: monospace;">${acc.id.substring(0, 8)}...</div>
            </div>
          </div>
          <div style="display:flex; gap:4px;">
            <button class="btn btn-icon btn-sm" onclick="openUsageDetailsModal('${acc.id}')" title="使用详情" style="background:rgba(255,255,255,0.05);">
              <span class="material-icons-round" style="font-size:16px; color:var(--accent);">analytics</span>
            </button>
            <button class="btn-icon" onclick="handleQuotaRefresh('${acc.id}', this)" title="${refreshReady ? '刷新配额' : '缺少远端凭证，无法刷新配额'}" ${refreshReady ? '' : 'disabled'}>
              <span class="material-icons-round" style="font-size:16px">sync</span>
            </button>
          </div>
        </div>

        ${hasLiveQuota ? `
          <div class="quota-progress-container">
            <div class="quota-progress-bar">
              <div class="quota-progress-fill ${level}" style="width: ${displayUsedPct}%"></div>
            </div>
          </div>
          <div class="quota-info">
            <div style="display:flex; flex-direction:column;">
              <div class="quota-used">${quotaMainLabel} <small style="font-weight:400; font-size:12px; color:var(--text-tertiary);">/ ${quotaTotalLabel} ${quotaUnitLabel}</small></div>
              ${remainSubLabel ? `<div style="font-size:11px; color:var(--text-tertiary); margin-top:2px;">${remainSubLabel}</div>` : ''}
            </div>
            <span class="quota-percent ${level}">${usageBadge}</span>
          </div>

          ${hasBreakdown ? `
            <div class="quota-breakdown" style="margin-top:12px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.03); display:grid; grid-template-columns: repeat(3, 1fr); gap:8px;">
              <div class="breakdown-item">
                <div class="label" style="font-size:9px; color:var(--text-tertiary); margin-bottom:2px;">今日基础积分</div>
                <div class="value" style="font-size:11px; font-weight:600;">${(points.basic?.total || 0).toLocaleString()}</div>
                ${points.basic?.used > 0 ? `<div style="font-size:9px; color:var(--text-tertiary);">已用 ${points.basic.used}</div>` : ''}
              </div>
              <div class="breakdown-item">
                <div class="label" style="font-size:9px; color:var(--text-tertiary); margin-bottom:2px;">限时积分</div>
                <div class="value" style="font-size:11px; font-weight:600; color:var(--warning);">
                  ${(points.limited?.used || 0).toLocaleString()} <span style="font-size:9px; opacity:0.6;">/ ${(points.limited?.total || 0).toLocaleString()}</span>
                </div>
              </div>
              <div class="breakdown-item">
                <div class="label" style="font-size:9px; color:var(--text-tertiary); margin-bottom:2px;">补充积分</div>
                <div class="value" style="font-size:11px; font-weight:600; color:var(--accent);">${(points.supplement?.total || 0).toLocaleString()}</div>
                ${points.supplement?.used > 0 ? `<div style="font-size:9px; color:var(--text-tertiary);">已用 ${points.supplement.used}</div>` : ''}
              </div>
            </div>
          ` : ''}

          <div class="quota-footer">
            <span class="material-icons-round" style="font-size:12px">${refreshReady ? 'verified' : 'history'}</span>
            <span>${checkedAt} · ${quota.source === '/api/entitlement/quota' ? 'Accio API' : '快照同步'}</span>
          </div>
        ` : `
          <div class="credential-empty">
            <span class="material-icons-round" style="font-size:24px;display:flex;margin-bottom:8px;opacity:0.4;">cloud_off</span>
            ${refreshReady ? '暂未拉取到配额数据，点击右上角刷新' : '凭证失效，无法查看配额'}
          </div>
        `}
      </div>
    `;
  }).join('');
}


async function openUsageDetailsModal(id) {
  const acc = accounts.find(a => a.id === id);
  if (!acc) return;
  
  openModal(`使用详情: ${acc.label || acc.id}`);
  document.getElementById('modal-body').innerHTML = `
    <div style="display:flex; align-items:center; justify-content:center; padding: 40px;">
      <div class="loading-spinner"></div>
    </div>
  `;

  try {
    const res = await fetch(`${API}/api/accounts/${id}/records`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const records = data.records || [];
    const points = acc.quota?.details || {};

    const rows = records.map(r => `
      <tr>
        <td style="padding:12px; border-bottom:1px solid rgba(255,255,255,0.03); font-size:12px;">${formatDateTime(r.createdAt)}</td>
        <td style="padding:12px; border-bottom:1px solid rgba(255,255,255,0.03); font-size:12px; font-weight:600;">${r.actionName || '使用 Accio'}</td>
        <td style="padding:12px; border-bottom:1px solid rgba(255,255,255,0.03); font-size:12px; color:var(--error); text-align:right;">-${r.pointsUsed || 1} 积分</td>
      </tr>
    `).join('');

    document.getElementById('modal-body').innerHTML = `
      <div style="display:grid; grid-template-columns: 1fr 1.5fr; gap:20px; margin-bottom:24px;">
        <div style="background:rgba(255,255,255,0.03); padding:20px; border-radius:12px;">
          <div style="font-size:14px; color:var(--text-tertiary); margin-bottom:16px;">本月概览</div>
          
          <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:8px; margin-bottom:24px; background: rgba(0,0,0,0.15); padding:14px 10px; border-radius:8px;">
            <div style="display:flex; flex-direction:column; align-items:center; border-right:1px solid rgba(255,255,255,0.05);">
              <span style="font-size:11px; color:var(--text-tertiary); margin-bottom:6px;">总积分</span>
              <span style="font-size:18px; font-weight:600; color:var(--text-primary); cursor:help;" title="Total">${acc.quota?.total || 0}</span>
            </div>
            <div style="display:flex; flex-direction:column; align-items:center; border-right:1px solid rgba(255,255,255,0.05);">
              <span style="font-size:11px; color:var(--text-tertiary); margin-bottom:6px;">已用积分</span>
              <span style="font-size:18px; font-weight:600; color:var(--error); cursor:help;" title="Used">${acc.quota?.used || 0}</span>
            </div>
            <div style="display:flex; flex-direction:column; align-items:center;">
              <span style="font-size:11px; color:var(--text-tertiary); margin-bottom:6px;">可用积分</span>
              <span style="font-size:18px; font-weight:600; color:var(--emerald); cursor:help;" title="Remaining">${Math.max(0, (acc.quota?.total || 0) - (acc.quota?.used || 0))}</span>
            </div>
          </div>
          
          <div style="font-size:12px; color:var(--text-tertiary); margin-bottom:12px;">各分项配额情况：</div>
          <div style="display:flex; flex-direction:column; gap:12px; background: rgba(0,0,0,0.1); padding:16px; border-radius:8px;">
            <div style="display:flex; justify-content:space-between; font-size:12px;">
              <span style="color:var(--text-tertiary);">基础积分</span>
              <span>${points.basic?.used || 0} <span style="color:var(--text-tertiary); margin:0 2px;">/</span> ${points.basic?.total || 0}</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:12px;">
              <span style="color:var(--text-tertiary);">限时积分</span>
              <span style="color:var(--warning);">${points.limited?.used || 0} <span style="color:var(--text-tertiary); margin:0 2px;">/</span> ${points.limited?.total || 0}</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:12px;">
              <span style="color:var(--text-tertiary);">补充积分</span>
              <span style="color:var(--accent);">${points.supplement?.used || 0} <span style="color:var(--text-tertiary); margin:0 2px;">/</span> ${points.supplement?.total || 0}</span>
            </div>
          </div>
        </div>
        
        <div style="background:rgba(255,255,255,0.03); padding:16px; border-radius:12px; display:flex; flex-direction:column; justify-content:center; align-items:center;">
          <div style="font-size:13px; color:var(--text-tertiary); margin-bottom:12px; width:100%;">近 14 天消耗</div>
          <div style="height:140px; width:100%; display:flex; align-items:flex-end; gap:4px; padding-bottom: 20px; position:relative;">
            ${(() => {
              // Replicate the 14-day zero-fill logic from the official JS
              const usageMap = new Map((acc.recentUsage || []).map(d => [d.date, d.creditAmount || 0]));
              const maxAmount = Math.max(...(acc.recentUsage || []).map(d => d.creditAmount || 0), 10);
              const days = [];
              const now = new Date();
              for (let i = 13; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                const isoDate = d.toISOString().split('T')[0];
                const displayDay = String(d.getDate()).padStart(2, '0');
                const val = usageMap.get(isoDate) || 0;
                days.push({ date: isoDate, displayDay, val });
              }
              
              return days.map(day => {
                const h = Math.max(2, Math.min(100, (day.val / maxAmount) * 100));
                return `
                  <div style="flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; height:100%; position:relative;" title="${day.date}: ${day.val}积分">
                    <div style="width:100%; height:${h}%; background: ${day.val > 0 ? 'var(--emerald)' : 'rgba(255,255,255,0.05)'}; border-radius:3px 3px 0 0; transition:height 0.3s;"></div>
                    <div style="position:absolute; bottom:-18px; font-size:10px; color:var(--text-tertiary); transform:scale(0.85);">${day.displayDay}</div>
                  </div>
                `;
              }).join('');
            })()}
          </div>
        </div>
      </div>

      <div style="font-size:16px; font-weight:600; margin-bottom:12px;">最近用量记录</div>
      <div style="background:rgba(255,255,255,0.02); border-radius:12px; overflow:hidden;">
        <table style="width:100%; border-collapse:collapse;">
          <thead>
            <tr style="background:rgba(255,255,255,0.03); text-align:left;">
              <th style="padding:12px; font-size:11px; color:var(--text-tertiary); text-transform:uppercase;">时间</th>
              <th style="padding:12px; font-size:11px; color:var(--text-tertiary); text-transform:uppercase;">操作项目</th>
              <th style="padding:12px; font-size:11px; color:var(--text-tertiary); text-transform:uppercase; text-align:right;">消耗</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="3" style="padding:40px; text-align:center; color:var(--text-tertiary);">暂无用量数据</td></tr>'}
          </tbody>
        </table>
      </div>
    `;

    document.getElementById('modal').classList.add('modal-wide');
  } catch (e) {
    document.getElementById('modal-body').innerHTML = `
      <div style="padding:40px; text-align:center; color:var(--error);">
        加载失败: ${e.message}
      </div>
    `;
  }
}

function updateAccountQuota(accountId, quota) {
  accounts = accounts.map(acc => (
    acc.id === accountId
      ? { ...acc, quota: { ...(acc.quota || {}), ...quota } }
      : acc
  ));
}

function updateAccountRemoteProfile(accountId, accountPatch = {}) {
  accounts = accounts.map(acc => (
    acc.id === accountId
      ? {
          ...acc,
          ...accountPatch,
          remoteProfile: { ...(acc.remoteProfile || {}), ...((accountPatch && accountPatch.remoteProfile) || {}) },
          email: accountPatch?.email || acc.email,
          label: accountPatch?.label || acc.label,
        }
      : acc
  ));
}

function setButtonLoading(button, loading, loadingLabel = '处理中...') {
  if (!button) return;

  if (loading) {
    if (!button.dataset.originalHtml) {
      button.dataset.originalHtml = button.innerHTML;
    }

    button.disabled = true;
    button.classList.add('is-loading');
    button.innerHTML = button.classList.contains('btn-icon')
      ? '<span class="material-icons-round" style="font-size:16px">sync</span>'
      : `<span class="material-icons-round">sync</span> ${loadingLabel}`;
    return;
  }

  if (button.dataset.originalHtml) {
    button.innerHTML = button.dataset.originalHtml;
  }
  button.disabled = false;
  button.classList.remove('is-loading');
}

async function handleQuotaRefresh(accountId, button) {
  const acc = accounts.find(item => item.id === accountId);
  if (!acc) return;

  if (!canRefreshQuota(acc)) {
    showToast('该账号缺少可用的 Accio 远端凭证，暂时无法刷新配额', 'warning');
    return;
  }

  setButtonLoading(button, true);

  try {
    const result = await refreshAccountQuota(accountId);
    if (!result.success) {
      showToast(result.error || '配额刷新失败', 'error');
      return;
    }

    updateAccountQuota(accountId, result.quota || {});
    renderQuota();
    showToast(`${acc.label} 配额已刷新`, 'success');
  } catch (e) {
    showToast('配额刷新失败: ' + e.message, 'error');
  } finally {
    setButtonLoading(button, false);
  }
}

async function handleBulkQuotaRefresh() {
  const button = document.getElementById('quota-bulk-refresh-btn');
  setButtonLoading(button, true, '批量刷新中...');

  try {
    const result = await refreshAllAccountQuotas();
    const successful = (result.results || []).filter(item => item.success);
    const failed = (result.results || []).filter(item => !item.success);

    successful.forEach(item => updateAccountQuota(item.id, item.quota || {}));
    renderQuota();

    if (!successful.length) {
      showToast(result.error || '没有账号刷新成功', 'error');
      return;
    }

    if (failed.length) {
      showToast(`已刷新 ${successful.length} 个账号，${failed.length} 个失败`, 'warning');
      return;
    }

    showToast(`已批量刷新 ${successful.length} 个账号配额`, 'success');
  } catch (e) {
    showToast('批量刷新失败: ' + e.message, 'error');
  } finally {
    setButtonLoading(button, false);
  }
}

async function handleUserInfoRefresh(accountId, button) {
  const acc = accounts.find(item => item.id === accountId);
  if (!acc) return;

  if (!canRefreshUserInfo(acc)) {
    showToast('该账号缺少可用的远端凭证，暂时无法同步用户信息', 'warning');
    return;
  }

  setButtonLoading(button, true, '同步中...');

  try {
    const result = await refreshAccountUserInfo(accountId);
    if (!result.success) {
      showToast(result.error || '同步用户信息失败', 'error');
      return;
    }

    updateAccountRemoteProfile(accountId, result.account || { remoteProfile: result.remoteProfile || {} });
    renderAccounts();
    renderCredentials();
    const syncedName = result.account?.label || acc.label;
    showToast(`${syncedName} 用户信息已同步`, 'success');
  } catch (e) {
    showToast('同步用户信息失败: ' + e.message, 'error');
  } finally {
    setButtonLoading(button, false);
  }
}

// ---- Modals ----
function openModal(title) {
  const modal = document.getElementById('modal');
  const footer = document.getElementById('modal-footer');
  const cancelBtn = document.getElementById('modal-cancel');
  const saveBtn = document.getElementById('modal-save');

  document.getElementById('modal-title').textContent = title;
  modal.className = 'modal'; // Reset classes
  footer.style.display = 'flex';
  cancelBtn.style.display = 'inline-flex';
  cancelBtn.textContent = '取消';
  saveBtn.style.display = 'inline-flex';
  saveBtn.textContent = '保存';
  saveBtn.style.background = '';
  saveBtn.style.color = '';
  saveBtn.onclick = null;
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('modal-overlay').onclick = (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  };
}

function closeModal() {
  document.getElementById('modal').className = 'modal';
  document.getElementById('modal-save').onclick = null;
  document.getElementById('modal-overlay').classList.remove('open');
}

/**
 * Custom modern confirmation modal
 */
function showConfirm(title, message, options = {}) {
  const { 
    confirmText = '确定', 
    cancelText = '取消', 
    type = 'warning', // warning, error, info
    danger = false 
  } = options;

  return new Promise((resolve) => {
    openModal(title);
    const modal = document.getElementById('modal');
    modal.classList.add('modal-confirm');
    
    const body = document.getElementById('modal-body');
    const saveBtn = document.getElementById('modal-save');
    const cancelBtn = document.getElementById('modal-cancel');
    
    const icon = type === 'error' ? 'report_gmailerrorred' : (type === 'warning' ? 'warning_amber' : 'info');
    const iconColor = type === 'error' ? 'var(--error)' : (type === 'warning' ? 'var(--warning)' : 'var(--accent)');

    body.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; text-align:center; padding: 12px 10px;">
        <span class="material-icons-round" style="font-size:48px; color:${iconColor}; margin-bottom:16px;">${icon}</span>
        <div style="font-size:15px; font-weight:500; line-height:1.6; color:var(--text-primary);">${message.replace(/\n/g, '<br>')}</div>
      </div>
    `;
    
    saveBtn.textContent = confirmText;
    if (danger) {
      saveBtn.style.background = 'var(--error)';
      saveBtn.style.color = '#fff';
    } else {
      saveBtn.style.background = 'var(--accent)';
    }

    saveBtn.onclick = () => {
      closeModal();
      resolve(true);
    };
    
    cancelBtn.textContent = cancelText;
    cancelBtn.onclick = () => {
      closeModal();
      resolve(false);
    };
    
    // Clicking overlay also resolves false for pure confirmation
    document.getElementById('modal-overlay').onclick = (e) => {
      if (e.target.id === 'modal-overlay') {
        closeModal();
        resolve(false);
      }
    };
  });
}

function openEditModal(accountId) {
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) return;
  openModal(`编辑: ${acc.label}`);

  document.getElementById('modal-body').innerHTML = `
    <div class="form-group">
      <label class="form-label">账号别名</label>
      <input class="form-input" id="edit-label" value="${acc.label}" placeholder="输入别名">
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">邮箱</label>
        <input class="form-input" id="edit-email" type="email" value="${acc.email}" placeholder="email@example.com">
      </div>
      <div class="form-group">
        <label class="form-label">手机号</label>
        <input class="form-input" id="edit-phone" value="${acc.phone}" placeholder="+86 ...">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">标签（逗号分隔）</label>
      <input class="form-input" id="edit-tags" value="${(acc.tags || []).join(', ')}" placeholder="主账号, 工作, 测试">
    </div>
    <div class="form-group">
      <label class="form-label">备注</label>
      <textarea class="form-textarea" id="edit-notes" placeholder="备注信息...">${acc.notes}</textarea>
    </div>
  `;

  const saveBtn = document.getElementById('modal-save');
  saveBtn.onclick = async () => {
    const data = {
      label: document.getElementById('edit-label').value,
      email: document.getElementById('edit-email').value,
      phone: document.getElementById('edit-phone').value,
      tags: document.getElementById('edit-tags').value.split(',').map(t => t.trim()).filter(Boolean),
      notes: document.getElementById('edit-notes').value,
    };
    await updateAccount(accountId, data);
    closeModal();
    await loadAll();
    showToast('账号信息已更新');
  };
}

function openCredentialModal(accountId) {
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) return;
  const creds = acc.credentials || {};
  const switchPreference = getConfiguredSwitchMode(acc);
  const expiryDate = acc.auth?.expiresAtIso || acc.credentials?.expiresAtIso;

  openModal(`管理凭证: ${acc.label || acc.id}`);

  document.getElementById('modal-body').innerHTML = `
    <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px; margin-bottom: 20px; font-size: 12px; border-left: 3px solid var(--accent);">
      此处信息用于账号切换及配额同步。建议通过 <b>OAuth 唤起链接</b> 自动导入，而非手动维护。
    </div>

    <div class="form-group">
      <label class="form-label">切换偏好方式</label>
      <select class="form-input" id="cred-switch-preference">
        <option value="oauth_logout" ${switchPreference === 'oauth_logout' ? 'selected' : ''}>退出登录 + OAuth 唤起 (更稳健)</option>
        <option value="profile" ${switchPreference === 'profile' ? 'selected' : ''}>快速配置复写 (更快速)</option>
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">访问令牌 (Access Token)</label>
      <textarea class="form-textarea" id="cred-token" placeholder="通常由 OAuth 导入时自动填充..." style="height: 60px;">${creds.token || ''}</textarea>
    </div>

    <div class="form-group">
      <label class="form-label">刷新令牌 (Refresh Token)</label>
      <input class="form-input" id="cred-refresh-token" value="${creds.refreshToken || ''}" placeholder="用于自动刷新访问令牌">
    </div>

    <div class="form-group">
      <label class="form-label">Accio 会话 Cookie</label>
      <textarea class="form-textarea" id="cred-cookie" placeholder="包含登录态的原始 Cookie..." style="height: 80px;">${creds.cookie || ''}</textarea>
    </div>

    <div class="form-group">
      <label class="form-label">失效时间</label>
      <div style="display:flex; gap:10px; align-items:center;">
        <input class="form-input" id="cred-expires-iso" value="${creds.expiresAtIso || ''}" placeholder="YYYY-MM-DDTHH:mm:ssZ" style="flex:1;">
        <div style="font-size:11px; color:var(--text-tertiary); min-width: 140px;">
          预览: ${expiryDate ? formatDateTime(expiryDate) : '未记录'}
        </div>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">用户名</label>
        <input class="form-input" id="cred-username" value="${creds.username || ''}" placeholder="账号/手机/邮箱">
      </div>
      <div class="form-group">
        <label class="form-label">密码</label>
        <input class="form-input" id="cred-password" type="password" value="${creds.password || ''}" placeholder="••••••••">
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Phoenix Cookie (选填)</label>
      <input class="form-input" id="cred-phoenix" value="${creds.phoenixCookie || ''}" placeholder="某些特定环境可能需要">
    </div>
    
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">API Key</label>
        <input class="form-input" id="cred-apikey" value="${creds.apiKey || ''}" placeholder="sk-...">
      </div>
      <div class="form-group">
        <label class="form-label">邀请码</label>
        <input class="form-input" id="cred-invite" value="${creds.inviteCode || ''}" placeholder="邀请码">
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">保存后的备注</label>
      <textarea class="form-textarea" id="cred-notes" placeholder="其他信息..." style="height: 50px;">${creds.notes || ''}</textarea>
    </div>
  `;

  const saveBtn = document.getElementById('modal-save');
  saveBtn.onclick = async () => {
    const credentials = {
      ...creds,
      username: document.getElementById('cred-username').value.trim(),
      password: document.getElementById('cred-password').value.trim(),
      token: document.getElementById('cred-token').value.trim(),
      refreshToken: document.getElementById('cred-refresh-token').value.trim(),
      cookie: document.getElementById('cred-cookie').value.trim(),
      phoenixCookie: document.getElementById('cred-phoenix').value.trim(),
      expiresAtIso: document.getElementById('cred-expires-iso').value.trim(),
      apiKey: document.getElementById('cred-apikey').value.trim(),
      inviteCode: document.getElementById('cred-invite').value.trim(),
      notes: document.getElementById('cred-notes').value.trim(),
    };
    // Also sync the numeric expiresAt if provided a valid ISO date
    if (credentials.expiresAtIso) {
      try {
        const d = new Date(credentials.expiresAtIso);
        if (!isNaN(d.getTime())) credentials.expiresAt = Math.floor(d.getTime() / 1000);
      } catch {}
    }
    await updateAccount(accountId, {
      credentials,
      switchPreference: document.getElementById('cred-switch-preference').value,
    });
    closeModal();
    await loadAll();
    showToast('凭证信息已保存');
  };
}

function openBatchSwitchPreferenceModal() {
  const eligibleAccounts = accounts.filter(acc => !acc.isGuest);
  openModal('批量设置切换方式');

  document.getElementById('modal-body').innerHTML = `
    <div class="form-group">
      <label class="form-label">切换方式</label>
      <select class="form-input" id="batch-switch-preference">
        <option value="oauth_logout">退出登录 + OAuth 唤起</option>
        <option value="profile">恢复本地配置</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">应用范围</label>
      <select class="form-input" id="batch-switch-scope">
        <option value="all">全部账号（${eligibleAccounts.length}）</option>
        <option value="profile_ready">仅已保存本地配置账号</option>
        <option value="oauth_ready">仅已导入 OAuth 凭证账号</option>
      </select>
    </div>
    <div style="padding:12px 14px;border-radius:12px;background:var(--bg-tertiary);font-size:12px;color:var(--text-secondary);line-height:1.6;">
      批量设置只会更新账号偏好，不会立即触发切换。实际切换时如果偏好方式未就绪，系统会自动降级到另一条可用链路。
    </div>
  `;

  const saveBtn = document.getElementById('modal-save');
  saveBtn.onclick = async () => {
    try {
      const switchPreference = document.getElementById('batch-switch-preference').value;
      const scope = document.getElementById('batch-switch-scope').value;
      const targetAccounts = eligibleAccounts.filter(acc => {
        if (scope === 'profile_ready') return Boolean(acc.profileSaved);
        if (scope === 'oauth_ready') return hasOAuthSwitchReady(acc);
        return true;
      });

      if (!targetAccounts.length) {
        showToast('当前范围内没有可更新的账号', 'warning');
        return;
      }

      const result = await updateAccountsSwitchPreference(
        targetAccounts.map(acc => acc.id),
        switchPreference
      );

      if (!result.success) {
        showToast(result.error || '批量设置失败', 'error');
        return;
      }

      closeModal();
      await loadAll();
      showToast(`已批量更新 ${targetAccounts.length} 个账号的切换方式`, 'success');
    } catch (e) {
      showToast('批量设置失败: ' + e.message, 'error');
    }
  };
}

function openQuotaModal(accountId) {
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) return;
  const quota = acc.quota || { total: 0, used: 0, unit: '次' };
  openModal(`配额: ${acc.label}`);

  document.getElementById('modal-body').innerHTML = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">已使用量</label>
        <input class="form-input" id="quota-used" type="number" value="${quota.used}" min="0">
      </div>
      <div class="form-group">
        <label class="form-label">总配额</label>
        <input class="form-input" id="quota-total" type="number" value="${quota.total}" min="0">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">单位</label>
      <input class="form-input" id="quota-unit" value="${quota.unit}" placeholder="次 / 条 / GB">
    </div>
    <div style="margin-top:12px;padding:12px;background:var(--bg-input);border-radius:var(--radius-sm);font-size:13px;color:var(--text-secondary);">
      <span class="material-icons-round" style="font-size:16px;vertical-align:middle;margin-right:4px;">info</span>
      设置配额后可在配额管理页面直观查看各账号的使用情况
    </div>
  `;

  const saveBtn = document.getElementById('modal-save');
  saveBtn.onclick = async () => {
    const quotaData = {
      used: parseInt(document.getElementById('quota-used').value) || 0,
      total: parseInt(document.getElementById('quota-total').value) || 0,
      unit: document.getElementById('quota-unit').value || '次',
    };
    await updateAccount(accountId, { quota: quotaData });
    closeModal();
    await loadAll();
    showToast('配额信息已更新');
  };
}

// ---- Active account tracking & polling ----
let currentActiveId = null;

function updateActiveBadge() {
  const active = accounts.find(a => a.isActive);
  currentActiveId = active ? active.id : null;
  const badge = document.getElementById('active-account-label');
  badge.textContent = active ? active.label : '未选择账号';
}

let pollingIntervalId = null;

function startPolling() {
  if (pollingIntervalId) return; // Already polling
  pollingIntervalId = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/status`);
      const status = await res.json();
      if (status.activeAccountId && currentActiveId && status.activeAccountId !== currentActiveId) {
        currentActiveId = status.activeAccountId;
        showToast('检测到 Accio 账号发生变化，已自动同步', 'info');
        await loadAll();
      }
    } catch (e) {
      // Ignore network errors in background poll
    }
  }, 3000); // Check every 3 seconds
}

function stopPolling() {
  if (pollingIntervalId) {
    clearInterval(pollingIntervalId);
    pollingIntervalId = null;
  }
}

function openImportModal() {
  openModal('📥 迁移旧版授权数据');
  const body = document.getElementById('modal-body');
  body.innerHTML = `
    <div style="margin-bottom: 20px; font-size: 13px; color: var(--text-secondary); line-height: 1.6; padding:12px; background:rgba(255,255,255,0.03); border-radius:8px;">
      <span style="color:var(--accent); font-weight:600;">✨ 自动迁移说明：</span><br>
      选择包含旧版 Manager 数据或官方 Accio 账号数据的文件夹。系统将自动批量导入所有的：<br>
      • <b>Token 登录凭证</b> (来自 accounts_meta.json)<br>
      • <b>物理 Profile 缓存</b> (来自 profiles/ 或 .accio/accounts/)
    </div>
    
    <div class="form-group">
      <label class="form-label">选择源文件夹</label>
      <div style="display:flex; gap:12px;">
        <input type="text" class="form-input" id="import-folder-path" readonly placeholder="点击右侧按钮选择文件夹..." style="flex:1;">
        <button class="btn btn-ghost" id="browse-folder-btn" style="padding:0 16px;">
          <span class="material-icons-round">folder_open</span>
        </button>
      </div>
    </div>
    <div id="import-progress" style="margin-top:16px; display:none; text-align:center;">
       <div class="spinner" style="margin:0 auto 10px;"></div>
       <div style="color:var(--text-secondary); font-size:12px;">正在迁移大容量数据，请稍候...</div>
    </div>
  `;

  const browseBtn = document.getElementById('browse-folder-btn');
  const pathInput = document.getElementById('import-folder-path');
  const saveBtn = document.getElementById('modal-save');
  saveBtn.textContent = '开始迁移';

  browseBtn.onclick = async () => {
    if (window.electronAPI && window.electronAPI.selectDirectory) {
      const path = await window.electronAPI.selectDirectory();
      if (path) pathInput.value = path;
    } else {
      showToast('该功能仅限桌面客户端使用', 'warning');
    }
  };

  saveBtn.onclick = async () => {
    const directoryPath = pathInput.value.trim();
    if (!directoryPath) return showToast('请先选择有效的源文件夹', 'warning');

    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="material-icons-round spin">sync</span> 迁移中...';
    document.getElementById('import-progress').style.display = 'block';

    try {
      const res = await fetch(`${API}/api/auth/import-from-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directoryPath })
      });
      const data = await res.json();
      
      if (res.ok && data.success) {
        showToast(`迁移完成！成功导入 ${data.count} 个账号`, 'success');
        closeModal();
        await loadAll();
      } else {
        showToast(`迁移失败: ${data.error || '未找到有效数据'}`, 'error');
      }
    } catch (e) {
      showToast(`网络或系统错误: ${e.message}`, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '开始迁移';
      document.getElementById('import-progress').style.display = 'none';
    }
  };
}

// ---- Close modal events ----
function setupModal() {
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  const importBtn = document.getElementById('import-auth-btn');
  if (importBtn) importBtn.addEventListener('click', openImportModal);

  const credentialsBatchSwitchBtn = document.getElementById('credentials-batch-switch-btn');
  if (credentialsBatchSwitchBtn) {
    credentialsBatchSwitchBtn.addEventListener('click', openBatchSwitchPreferenceModal);
  }

  const quotaBulkRefreshBtn = document.getElementById('quota-bulk-refresh-btn');
  if (quotaBulkRefreshBtn) quotaBulkRefreshBtn.addEventListener('click', handleBulkQuotaRefresh);
}

// ---- Load all data ----
async function loadAll(retries = 0) {
  try {
    await Promise.all([fetchAccounts(), fetchOverview()]);
    renderDashboard();
    renderAccounts();
    renderCredentials();
    renderQuota();
    updateActiveBadge();
  } catch (e) {
    // On initial load, retry a few times to let the local Express server start up
    if (retries < 10 && (e instanceof TypeError || e.message.includes('fetch'))) {
      console.warn(`[loadAll] Server not ready, retrying in 500ms (attempt ${retries + 1}/10)...`);
      await new Promise(res => setTimeout(res, 500));
      return loadAll(retries + 1);
    }
    showToast('加载失败: ' + e.message, 'error');
    console.error(e);
  }
}

// ---- Accio Auth ----
async function setupAccioAuth() {
  const linkEl = document.getElementById('accio-auth-link');
  // ... (previous setup code)
  
  // Add Security & Automated Capture Tips below the UI
  const container = document.getElementById('accio-auth-container');
  if (container && !document.getElementById('accio-auth-tips')) {
    const tipsBox = document.createElement('div');
    tipsBox.id = 'accio-auth-tips';
    tipsBox.style.marginTop = '24px';
    tipsBox.style.padding = '16px';
    tipsBox.style.borderRadius = '12px';
    tipsBox.style.background = 'rgba(108, 99, 255, 0.05)';
    tipsBox.style.border = '1px dashed rgba(108, 99, 255, 0.2)';
    
    tipsBox.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px; color:var(--accent);">
        <span class="material-icons-round" style="font-size:20px;">security</span>
        <span style="font-size:14px; font-weight:600;">认证安全与自动化提示</span>
      </div>
      <ul style="margin:0; padding-left:20px; font-size:13px; color:var(--text-secondary); line-height:1.8;">
        <li><b style="color:var(--text-primary);">自动抓取</b>：点击“唤起授权”后，Manager 将在登录成功的瞬间自动捕获 Token 并保存，你无需手动操作。</li>
        <li><b style="color:var(--text-primary);">指纹随机</b>：已启用 <b>Anti-Detect</b>。每次弹出窗口均使用随机的浏览器环境（User-Agent）和独立的 Session 分区，有效规避风控。</li>
        <li><b style="color:var(--text-primary);">物理隔离</b>：不同账号的登录会话完全隔离，不会出现 Cookie 覆盖或账号关联问题。</li>
        <li><b style="color:var(--text-primary);">风险建议</b>：为保证账号安全，建议在批量导入时每 5 个账号更换一次 IP 节点。</li>
      </ul>
    `;
    container.appendChild(tipsBox);
  }

  // ... (rest of search/open logic)
  const copyBtn = document.getElementById('copy-auth-link');
  const openBtn = document.getElementById('open-auth-link');
  const submitBtn = document.getElementById('submit-callback-url');
  const inputEl = document.getElementById('accio-callback-url');
  const statusEl = document.getElementById('accio-auth-status');

  try {
    const res = await fetch(`${API}/api/accio/auth/url`);
    const data = await res.json();
    if (data.url && linkEl) {
      linkEl.textContent = data.url;
      
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(data.url);
        showToast('授权链接已复制', 'success');
      };
      
      openBtn.onclick = () => {
        window.open(data.url, '_blank');
      };
    }
  } catch (e) {
    if (linkEl) linkEl.textContent = '生成链接失败';
  }

  if (submitBtn) {
    submitBtn.onclick = async () => {
      const url = inputEl.value.trim();
      if (!url) {
        showToast('请输入 Accio 回调 URL', 'warning');
        return;
      }
      
      statusEl.style.display = 'inline';
      statusEl.textContent = '等待认证中...';
      submitBtn.disabled = true;

      try {
        const res = await fetch(`${API}/api/accio/auth/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const data = await res.json();
        
        if (res.ok && data.success) {
          showToast(`Accio 登录成功，已保存用户：${data.name}`, 'success');
          inputEl.value = '';
          await loadAll();
        } else {
          showToast(`认证失败: ${data.error || '未知错误'}`, 'error');
        }
      } catch (e) {
        showToast(`网络错误: ${e.message}`, 'error');
      } finally {
        statusEl.style.display = 'none';
        submitBtn.disabled = false;
      }
    };
  }
}

function setupDesktopControls() {
  if (window.electronAPI) {
    document.getElementById('win-min').addEventListener('click', () => {
      window.electronAPI.minimize();
    });
    document.getElementById('win-max').addEventListener('click', () => {
      window.electronAPI.maximize();
    });
    document.getElementById('win-close').addEventListener('click', () => {
      window.electronAPI.close();
    });
  }
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  setupNav();
  setupModal();
  setupAccioAuth();
  setupDesktopControls();
  syncRouteWithPage(getPageFromLocation());
  switchPage(getPageFromLocation());
  loadAll().then(() => {
    startPolling();
  });

  // Desktop OAuth Auto-Persistence Listener — registered only once
  if (window.electronAPI && typeof window.electronAPI.onOAuthSuccess === 'function') {
    // Remove any previous listener to prevent stacking on hot reloads
    if (window.electronAPI.removeOAuthSuccessListener) {
      window.electronAPI.removeOAuthSuccessListener();
    }
    window.electronAPI.onOAuthSuccess(async (data) => {
      console.log('[Desktop] OAuth Success triggered via IPC:', data.url);
      showToast('自动抓取到认证跳转，正在同步账号...', 'info');
      await loadAll();
    });
  }

  // Automatic Update Check on Startup
  setTimeout(async () => {
    try {
      const res = await fetch(`${API}/api/updates/check`);
      const data = await res.json();
      if (data.updateAvailable) {
        const platformLabel = data.platform === 'darwin' ? 'macOS' : 'Windows';
        const confirmed = await showConfirm(`发现新版本 (${platformLabel})`, 
          `检测到最新版本 <b>v${data.latest}</b> (当前 v${data.current})。<br>建议立即前往下载最新版，体验更稳定的多账号管理。`, {
          confirmText: '前往下载',
          type: 'info'
        });
        if (confirmed) window.open(data.releaseUrl, '_blank');
      }
    } catch (e) {
      console.warn('[Update] Check failed:', e.message);
    }
  }, 5000); // Check after 5s to prioritize main data load
});
