// =============================================
// Accio Manager – Frontend Application
// =============================================

const API = '';
let accounts = [];
let overview = {};
let currentPage = 'dashboard';

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
  const preferred = getConfiguredSwitchMode(account);
  if (canUseSwitchMode(account, preferred)) return preferred;
  if (preferred !== 'profile' && canUseSwitchMode(account, 'profile')) return 'profile';
  if (preferred !== 'oauth_logout' && canUseSwitchMode(account, 'oauth_logout')) return 'oauth_logout';
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
  accounts = data.accounts;
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
function setupNav() {
  const items = document.querySelectorAll('.nav-item');
  items.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      switchPage(page);
    });
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
  currentPage = page;
  const titles = { dashboard: '总览', accounts: '账号管理', credentials: '凭证中心', quota: '配额管理' };
  document.getElementById('page-title').textContent = titles[page] || page;

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');

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
  grid.innerHTML = accounts.map((acc, idx) => {
    const bg = getAvatarColor(idx);
    const initial = getAvatarInitial(acc);
    const switchStrategy = getSwitchStrategy(acc);
    const profileIcon = acc.profileSaved
      ? '<span class="material-icons-round" style="font-size:14px;color:var(--success);" title="配置已保存">cloud_done</span>'
      : '<span class="material-icons-round" style="font-size:14px;color:var(--text-tertiary);" title="配置未保存">cloud_off</span>';

    return `
      <div class="quick-card ${acc.isActive ? 'active' : ''}" data-id="${acc.id}">
        <div class="quick-card-header">
          <div class="quick-card-avatar" style="background: ${bg}">${initial}</div>
          <div style="display:flex;align-items:center;gap:8px;">
            ${profileIcon}
            <span class="quick-card-status ${acc.isActive ? 'active' : 'inactive'}">
              ${acc.isActive ? '● 活动中' : '○ 未激活'}
            </span>
          </div>
        </div>
        <div class="quick-card-label">${acc.label}</div>
        <div class="quick-card-id">${acc.isGuest ? 'guest' : 'ID: ' + acc.id}</div>
        <div class="quick-card-stats">
          <div class="quick-stat"><div class="quick-stat-value">${acc.stats.conversations}</div><div class="quick-stat-label">对话</div></div>
          <div class="quick-stat"><div class="quick-stat-value">${acc.stats.agents}</div><div class="quick-stat-label">代理</div></div>
          <div class="quick-stat"><div class="quick-stat-value">${acc.stats.tasks}</div><div class="quick-stat-label">任务</div></div>
          <div class="quick-stat"><div class="quick-stat-value">${acc.stats.connectors.length}</div><div class="quick-stat-label">连接器</div></div>
        </div>
        <div class="quick-card-actions" style="display:flex;gap:8px;margin-top:12px;">
          ${acc.isActive
            ? `<button class="btn btn-sm btn-ghost" style="flex:1" onclick="event.stopPropagation();handleSaveProfile('${acc.id}')">
                <span class="material-icons-round">save</span>保存当前配置
              </button>`
            : `<button class="btn btn-sm btn-primary" style="flex:1" onclick="event.stopPropagation();handleSwitch('${acc.id}')" ${switchStrategy === 'none' ? 'title="需要先导入 OAuth 回调或保存本地配置"' : ''} ${switchStrategy === 'none' ? 'disabled' : ''}>
                <span class="material-icons-round">${getSwitchActionIcon(acc)}</span>${getSwitchActionLabel(acc)}
              </button>`
          }
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
    }
    await loadAll();
  } catch (e) {
    showToast('切换失败: ' + e.message, 'error');
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

// ---- Render Accounts ----
function renderAccounts() {
  const list = document.getElementById('accounts-list');
  list.innerHTML = accounts.map((acc, idx) => {
    const bg = getAvatarColor(idx);
    const initial = getAvatarInitial(acc);
    const connectors = acc.stats.connectors.map(c => `<span class="account-meta-item"><span class="material-icons-round">link</span>${c}</span>`).join('');
    const switchStrategy = getSwitchStrategy(acc);
    const userInfoReady = canRefreshUserInfo(acc);
    const profileBadge = acc.profileSaved
      ? '<span class="tag" style="background:rgba(61,220,132,0.1);color:#3ddc84;">配置已保存</span>'
      : '<span class="tag" style="background:rgba(255,183,77,0.1);color:#ffb74d;">未保存配置</span>';
    const oauthBadge = hasOAuthSwitchReady(acc)
      ? '<span class="tag" style="background:rgba(52,211,153,0.14);color:#34d399;">OAuth 可切换</span>'
      : '';

    return `
      <div class="account-row ${acc.isActive ? 'active' : ''}" id="account-row-${acc.id}">
        <div class="account-avatar" style="background: ${bg}">${initial}</div>
        <div class="account-info">
          <div class="account-name">
            ${acc.label}
            ${acc.isActive ? '<span class="tag active">活动中</span>' : ''}
            ${acc.isGuest ? '<span class="tag guest">访客</span>' : ''}
            ${oauthBadge}
            ${profileBadge}
          </div>
          <div class="account-meta">
            <span class="account-meta-item"><span class="material-icons-round">fingerprint</span>${acc.id}</span>
            ${acc.email ? `<span class="account-meta-item"><span class="material-icons-round">email</span>${acc.email}</span>` : ''}
            ${connectors}
          </div>
        </div>
        <div class="account-stats-inline">
          <div class="inline-stat"><div class="inline-stat-value">${acc.stats.conversations}</div><div class="inline-stat-label">对话</div></div>
          <div class="inline-stat"><div class="inline-stat-value">${acc.stats.agents}</div><div class="inline-stat-label">代理</div></div>
          <div class="inline-stat"><div class="inline-stat-value">${acc.stats.tasks}</div><div class="inline-stat-label">任务</div></div>
        </div>
        <div class="account-actions">
          <button class="btn btn-sm btn-ghost" onclick="handleUserInfoRefresh('${acc.id}', this)" ${userInfoReady ? '' : 'title="需要先导入 OAuth 回调凭证"'} ${userInfoReady ? '' : 'disabled'}>
            <span class="material-icons-round">sync</span>同步用户信息
          </button>
          <button class="btn btn-sm btn-ghost" onclick="openEditModal('${acc.id}')">
            <span class="material-icons-round">edit</span>编辑
          </button>
          ${acc.isActive
            ? `<button class="btn btn-sm btn-ghost" onclick="handleSaveProfile('${acc.id}')">
                <span class="material-icons-round">save</span>保存配置
              </button>`
            : `<button class="btn btn-sm btn-primary" onclick="handleSwitch('${acc.id}')" ${switchStrategy === 'none' ? 'title="需要先导入 OAuth 回调或保存本地配置"' : ''} ${switchStrategy === 'none' ? 'disabled' : ''}>
                <span class="material-icons-round">${getSwitchActionIcon(acc)}</span>${getSwitchActionLabel(acc)}
              </button>`
          }
        </div>
      </div>
    `;
  }).join('');
}

// ---- Render Credentials ----
function renderCredentials() {
  const grid = document.getElementById('credentials-grid');
  grid.innerHTML = accounts.map((acc, idx) => {
    const bg = getAvatarColor(idx);
    const facts = getAuthFacts(acc);
    const hasAuthData = facts.some(item => !['未保存', '未识别', '未记录'].includes(item.value));

    return `
      <div class="credential-card">
        <div class="credential-card-header">
          <div class="credential-card-title">
            <div class="quick-card-avatar" style="background: ${bg}; width: 32px; height: 32px; font-size: 13px; border-radius: 8px;">${getAvatarInitial(acc)}</div>
            ${acc.label}
          </div>
          <button class="btn-icon" onclick="openCredentialModal('${acc.id}')" title="编辑原始凭证">
            <span class="material-icons-round" style="font-size:16px">edit</span>
          </button>
        </div>
        <div class="credential-card-body">
          ${hasAuthData ? `
            ${facts.map(item => `
              <div class="credential-field">
                <div class="credential-label">
                  <span class="material-icons-round" style="font-size:14px">${item.icon}</span>${item.label}
                </div>
                <div class="credential-value ${item.tone ? item.tone : ''}">
                  ${item.value}
                  ${item.detail ? `<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">${item.detail}</div>` : ''}
                </div>
              </div>
            `).join('')}
          ` : `
            <div class="credential-empty">
              <span class="material-icons-round" style="font-size:24px;display:block;margin-bottom:8px;opacity:0.4;">vpn_key</span>
              暂无可用认证信息，请先导入 Accio 回调 URL
            </div>
          `}
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
    const hasLiveQuota = Number.isFinite(quota.usagePercent) || Number.isFinite(quota.refreshCountdownSeconds);
    const refreshState = getQuotaRefreshState(quota);
    const percent = Number.isFinite(quota.usagePercent)
      ? Math.max(0, Math.min(100, Math.round(quota.usagePercent)))
      : (quota.total > 0 ? Math.round((quota.used / quota.total) * 100) : 0);
    const remainingPercent = Math.max(0, 100 - percent);
    const level = refreshState.isReady ? 'ready' : percent < 50 ? 'low' : percent < 80 ? 'medium' : 'high';
    const checkedAt = quota.checkedAt ? formatDateTime(quota.checkedAt) : '未记录';

    return `
      <div class="quota-card">
        <div class="quota-card-header">
          <div class="quota-card-title">
            <div class="quick-card-avatar" style="background: ${bg}; width: 32px; height: 32px; font-size: 13px; border-radius: 8px;">${getAvatarInitial(acc)}</div>
            ${acc.label}
          </div>
          <button class="btn-icon" onclick="handleQuotaRefresh('${acc.id}', this)" title="${refreshReady ? '刷新配额' : '缺少远端凭证，无法刷新配额'}" ${refreshReady ? '' : 'disabled'}>
            <span class="material-icons-round" style="font-size:16px">sync</span>
          </button>
        </div>
        ${hasLiveQuota ? `
          <div class="quota-progress-container">
            <div class="quota-progress-bar">
              <div class="quota-progress-fill ${level}" style="width: ${remainingPercent}%"></div>
            </div>
          </div>
          <div class="quota-info">
            <div>
              <span class="quota-used">${Number.isFinite(quota.usagePercent) ? `${remainingPercent}%` : '--'}</span>
              <span class="quota-total"> 剩余</span>
            </div>
            <span class="quota-percent ${level}">
              ${refreshState.isReady ? '配额已刷新' : Number.isFinite(quota.usagePercent) ? `已使用 ${percent}%` : '已同步'}
            </span>
          </div>
          <div style="margin-top:8px;font-size:12px;color:var(--text-tertiary);">
            ${refreshState.isReady ? '配额已刷新，点击右上角刷新同步' : refreshState.statusLabel}
          </div>
          <div style="margin-top:8px;font-size:12px;color:var(--text-tertiary);">
            来源：${quota.source || '/api/entitlement/quota'} · 最近同步：${checkedAt}
          </div>
        ` : quota.total > 0 ? `
          <div class="quota-progress-container">
            <div class="quota-progress-bar">
              <div class="quota-progress-fill ${level}" style="width: ${percent}%"></div>
            </div>
          </div>
          <div class="quota-info">
            <div>
              <span class="quota-used">${quota.used.toLocaleString()}</span>
              <span class="quota-total"> / ${quota.total.toLocaleString()} ${quota.unit}</span>
            </div>
            <span class="quota-percent ${level}">${percent}%</span>
          </div>
        ` : `
          <div class="credential-empty">
            <span class="material-icons-round" style="font-size:24px;display:block;margin-bottom:8px;opacity:0.4;">data_usage</span>
            ${refreshReady ? '暂未同步到实时配额，点击刷新重试' : '缺少远端凭证，暂时无法刷新配额'}
          </div>
        `}
      </div>
    `;
  }).join('');
}

function updateAccountQuota(accountId, quota) {
  accounts = accounts.map(acc => (
    acc.id === accountId
      ? { ...acc, quota: { ...(acc.quota || {}), ...quota } }
      : acc
  ));
}

function updateAccountRemoteProfile(accountId, remoteProfile) {
  accounts = accounts.map(acc => (
    acc.id === accountId
      ? {
          ...acc,
          remoteProfile: { ...(acc.remoteProfile || {}), ...(remoteProfile || {}) },
          email: remoteProfile?.email || acc.email,
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

    updateAccountRemoteProfile(accountId, result.remoteProfile || {});
    renderAccounts();
    renderCredentials();
    showToast(`${acc.label} 用户信息已同步`, 'success');
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
  modal.classList.remove('modal-compact');
  footer.style.display = 'flex';
  cancelBtn.style.display = 'inline-flex';
  cancelBtn.textContent = '取消';
  saveBtn.style.display = 'inline-flex';
  saveBtn.textContent = '保存';
  saveBtn.onclick = null;
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal').classList.remove('modal-compact');
  document.getElementById('modal-save').onclick = null;
  document.getElementById('modal-overlay').classList.remove('open');
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
  openModal(`凭证: ${acc.label}`);

  document.getElementById('modal-body').innerHTML = `
    <div class="form-group">
      <label class="form-label">切换方式</label>
      <select class="form-input" id="cred-switch-preference">
        <option value="oauth_logout" ${switchPreference === 'oauth_logout' ? 'selected' : ''}>退出登录 + OAuth 唤起</option>
        <option value="profile" ${switchPreference === 'profile' ? 'selected' : ''}>恢复本地配置</option>
      </select>
      <div style="margin-top:8px;font-size:12px;color:var(--text-tertiary);">
        实际切换时若所选方式当前不可用，会自动降级到另一条已就绪链路。
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">用户名 / 账号</label>
      <input class="form-input" id="cred-username" value="${creds.username || ''}" placeholder="username">
    </div>
    <div class="form-group">
      <label class="form-label">密码</label>
      <input class="form-input" id="cred-password" type="password" value="${creds.password || ''}" placeholder="••••••••">
    </div>
    <div class="form-group">
      <label class="form-label">Token / Session</label>
      <input class="form-input" id="cred-token" value="${creds.token || ''}" placeholder="token...">
    </div>
    <div class="form-group">
      <label class="form-label">API Key</label>
      <input class="form-input" id="cred-apikey" value="${creds.apiKey || ''}" placeholder="sk-...">
    </div>
    <div class="form-group">
      <label class="form-label">邀请码</label>
      <input class="form-input" id="cred-invite" value="${creds.inviteCode || ''}" placeholder="invite code">
    </div>
    <div class="form-group">
      <label class="form-label">其他凭证备注</label>
      <textarea class="form-textarea" id="cred-notes" placeholder="其他凭证信息...">${creds.notes || ''}</textarea>
    </div>
  `;

  const saveBtn = document.getElementById('modal-save');
  saveBtn.onclick = async () => {
    const credentials = {
      ...creds,
      username: document.getElementById('cred-username').value,
      password: document.getElementById('cred-password').value,
      token: document.getElementById('cred-token').value,
      apiKey: document.getElementById('cred-apikey').value,
      inviteCode: document.getElementById('cred-invite').value,
      notes: document.getElementById('cred-notes').value,
    };
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

function startPolling() {
  setInterval(async () => {
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

function openImportModal() {
  openModal('📥 导入自动授权链接');
  document.getElementById('modal-body').innerHTML = `
    <div style="margin-bottom: 16px; font-size: 13px; color: var(--text-secondary); line-height: 1.5;">
      请粘贴从浏览器拦截到的 Accio 登录回调链接 (http://127.0.0.1:4097/auth/callback...)。<br><br>
      <span style="color:var(--success)">✨ 功能说明：</span><br>
      Manager 会自动提取 Token 凭证以及真名，并自动向 Accio 客户端注入该登录状态。如果 Token 有效，系统还将为您自动查出最新余额并登记！
    </div>
    <div class="form-group">
      <label class="form-label">登录回调 URL</label>
      <textarea class="form-textarea" id="import-url" placeholder="http://127.0.0.1:4097/auth/callback?accessToken=..." style="min-height: 120px; word-break: break-all; font-family: monospace;"></textarea>
    </div>
  `;

  const saveBtn = document.getElementById('modal-save');
  saveBtn.onclick = async () => {
    const url = document.getElementById('import-url').value.trim();
    if (!url) return showToast('请输入有效的包含 accessToken 的 URL', 'warning');

    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="material-icons-round" style="animation: spin 1s linear infinite;">sync</span> 处理中...';

    try {
      const res = await fetch(`${API}/api/auth/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      
      if (res.ok && data.success) {
        showToast(`授权成功！用户：${data.name}`, 'success');
        closeModal();
        await loadAll();
      } else {
        showToast(`导入失败: ${data.error || '解析错误'}`, 'error');
      }
    } catch (e) {
      showToast(`网络错误: ${e.message}`, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
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
async function loadAll() {
  try {
    await Promise.all([fetchAccounts(), fetchOverview()]);
    renderDashboard();
    renderAccounts();
    renderCredentials();
    renderQuota();
    updateActiveBadge();
  } catch (e) {
    showToast('加载失败: ' + e.message, 'error');
    console.error(e);
  }
}

// ---- Accio Auth ----
async function setupAccioAuth() {
  const linkEl = document.getElementById('accio-auth-link');
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

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  setupNav();
  setupModal();
  setupAccioAuth();
  loadAll().then(() => {
    startPolling();
  });
});
