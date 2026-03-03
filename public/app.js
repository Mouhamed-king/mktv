const STORAGE_FAVORITES = "mktv.favorites.v1";
const STORAGE_RECENT = "mktv.recent.v1";
const STORAGE_STREAM_ID = "mktv.stream_id.v1";
const CHANNEL_FALLBACK_THUMB =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='100%25' height='100%25' fill='%23051a2f'/%3E%3C/svg%3E";

const state = {
  q: "",
  group: "",
  offset: 0,
  limit: 200,
  total: 0,
  hasMore: false,
  channels: [],
  selectedUrl: "",
  groups: [],
  activeTab: "live",
  favorites: [],
  recent: [],
  user: null,
  accessToken: "",
  streamId: loadOrCreateStreamId(),
  hasActivePlayback: false,
  accessApproved: false,
  isAdmin: false,
};

const els = {
  authView: document.getElementById("authView"),
  pendingView: document.getElementById("pendingView"),
  appView: document.getElementById("appView"),
  authStatus: document.getElementById("authStatus"),
  pendingStatus: document.getElementById("pendingStatus"),
  showLoginBtn: document.getElementById("showLoginBtn"),
  showSignupBtn: document.getElementById("showSignupBtn"),
  loginForm: document.getElementById("loginForm"),
  signupForm: document.getElementById("signupForm"),
  loginEmail: document.getElementById("loginEmail"),
  loginPassword: document.getElementById("loginPassword"),
  signupEmail: document.getElementById("signupEmail"),
  signupName: document.getElementById("signupName"),
  signupPassword: document.getElementById("signupPassword"),
  userEmail: document.getElementById("userEmail"),
  settingsUserEmail: document.getElementById("settingsUserEmail"),
  supabaseStatus: document.getElementById("supabaseStatus"),
  logoutBtn: document.getElementById("logoutBtn"),
  pendingLogoutBtn: document.getElementById("pendingLogoutBtn"),
  pendingMessage: document.getElementById("pendingMessage"),
  pageTitle: document.getElementById("pageTitle"),
  installAppBtn: document.getElementById("installAppBtn"),
  toggleMainTabsBtn: document.getElementById("toggleMainTabsBtn"),
  mainTabsPanel: document.getElementById("mainTabsPanel"),
  toggleGroupsBtn: document.getElementById("toggleGroupsBtn"),
  groupsBlock: document.getElementById("groupsBlock"),
  tabButtons: Array.from(document.querySelectorAll(".main-tab")),
  searchInput: document.getElementById("searchInput"),
  groupSelect: document.getElementById("groupSelect"),
  groupNav: document.getElementById("groupNav"),
  channelsList: document.getElementById("channelsList"),
  favoritesList: document.getElementById("favoritesList"),
  recentList: document.getElementById("recentList"),
  listMeta: document.getElementById("listMeta"),
  loadLessBtn: document.getElementById("loadLessBtn"),
  loadMoreBtn: document.getElementById("loadMoreBtn"),
  liveSection: document.getElementById("liveSection"),
  favoritesSection: document.getElementById("favoritesSection"),
  recentSection: document.getElementById("recentSection"),
  settingsSection: document.getElementById("settingsSection"),
  currentTitle: document.getElementById("currentTitle"),
  playerShell: document.querySelector(".player-shell"),
  player: document.getElementById("player"),
  playerLoading: document.getElementById("playerLoading"),
  playerStatus: document.getElementById("playerStatus"),
  playerFullscreenBtn: document.getElementById("playerFullscreenBtn"),
};

let hls = null;
let searchTimer = null;
let playRequestId = 0;
let networkRecoveryAttempts = 0;
let lockRecoveryAttempts = 0;
const MAX_NETWORK_RECOVERY_ATTEMPTS = 3;
const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_GRACE_MS = 5 * 60 * 1000;
const AUTO_REJOIN_MIN_DELAY_MS = 1500;
const AUTO_REJOIN_MAX_DELAY_MS = 15000;
const STALL_DETECTION_MS = 12000;
const STALL_CHECK_INTERVAL_MS = 4000;
const STALL_RECOVERY_COOLDOWN_MS = 4000;
const MAX_STALL_RECOVERY_ATTEMPTS = 5;
let supabaseClient = null;
let deferredInstallPrompt = null;
let playerLoadingSafetyTimer = null;
let lastPlaybackProgressAt = 0;
let lastPlaybackTime = 0;
let lastStallRecoveryAt = 0;
let stallRecoveryAttempts = 0;
let stallHardRestartDone = false;
let playbackWatchdogTimer = null;
let remoteNavigationPrimed = false;
let tokenRefreshTimer = null;
let authRecoveryAttempts = 0;
let autoRejoinTimer = null;
let autoRejoinAttempts = 0;

const FAST_LIVE_HLS_CONFIG = {
  enableWorker: true,
  lowLatencyMode: false,
  startPosition: -1,
  liveSyncDurationCount: 1,
  liveMaxLatencyDurationCount: 3,
  initialLiveManifestSize: 1,
  maxBufferLength: 8,
  maxMaxBufferLength: 12,
  backBufferLength: 8,
  maxLiveSyncPlaybackRate: 1.5,
  startFragPrefetch: true,
  testBandwidth: false,
  manifestLoadingTimeOut: 15000,
  manifestLoadingMaxRetry: 2,
  levelLoadingTimeOut: 15000,
  levelLoadingMaxRetry: 2,
  fragLoadingTimeOut: 20000,
  fragLoadingMaxRetry: 3,
  fragLoadingRetryDelay: 1000,
  fragLoadingMaxRetryTimeout: 10000,
};

init().catch((error) => {
  console.error(error);
  els.authStatus.textContent = "Erreur d'initialisation.";
});

async function init() {
  hydrateLocalState();
  bindUiEvents();
  await initSupabase();
  await handleSupabaseAuthHashError();
  setupPwaInstall();
  await restoreSession();
}

async function initSupabase() {
  const cfg = await resolveSupabaseConfig();
  const hasConfig = Boolean(cfg.url && cfg.anonKey);
  if (!hasConfig || !window.supabase?.createClient) {
    els.supabaseStatus.textContent = "Non configure";
    return;
  }
  supabaseClient = window.supabase.createClient(cfg.url, cfg.anonKey);
  els.supabaseStatus.textContent = "Connecte";
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    if (session?.user) {
      state.user = session.user;
      state.accessToken = session.access_token || "";
      startTokenRefreshLoop();
      return;
    }
    stopTokenRefreshLoop();
    clearCurrentPlaybackUi();
    state.user = null;
    state.accessToken = "";
    state.accessApproved = false;
    state.isAdmin = false;
    showAuth();
  });
}

async function resolveSupabaseConfig() {
  const localCfg = window.MKTV_SUPABASE || {};
  if (localCfg.url && localCfg.anonKey) {
    return { url: localCfg.url, anonKey: localCfg.anonKey };
  }
  try {
    const response = await fetch("/api/public-config");
    if (!response.ok) return { url: "", anonKey: "" };
    const payload = await response.json();
    return {
      url: payload.supabaseUrl || "",
      anonKey: payload.supabaseAnonKey || "",
    };
  } catch {
    return { url: "", anonKey: "" };
  }
}

async function restoreSession() {
  if (!supabaseClient) {
    showAuth();
    els.authStatus.textContent = "Configuration Supabase manquante.";
    return;
  }
  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data.session?.user) {
    showAuth();
    return;
  }
  await onAuthenticated(data.session);
}

function bindUiEvents() {
  els.showLoginBtn.addEventListener("click", () => setAuthMode("login"));
  els.showSignupBtn.addEventListener("click", () => setAuthMode("signup"));

  els.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!supabaseClient) return;
    setAuthStatus("Connexion en cours...");
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: els.loginEmail.value.trim(),
      password: els.loginPassword.value,
    });
    if (error || !data.user) {
      setAuthStatus(error?.message || "Connexion echouee.");
      return;
    }
    setAuthStatus("");
    await onAuthenticated(data.session);
  });

  els.signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!supabaseClient) return;
    setAuthStatus("Inscription en cours...");
    const displayName = (els.signupName.value || "").trim();
    const { data, error } = await supabaseClient.auth.signUp({
      email: els.signupEmail.value.trim(),
      password: els.signupPassword.value,
      options: {
        emailRedirectTo: window.location.origin,
        data: {
          display_name: displayName,
        },
      },
    });
    if (error) {
      const msg = error.message || "Inscription echouee.";
      if (/already registered|already_exists|user already exists|duplicate/i.test(msg)) {
        setAuthStatus("Email deja utilise. Connecte-toi ou réinitialise le mot de passe.");
        setAuthMode("login");
        return;
      }
      setAuthStatus(msg);
      return;
    }
    if (!data.session) {
      setAuthStatus("Compte cree. Verifie ton email pour confirmer.");
      return;
    }
    setAuthStatus("");
    await onAuthenticated(data.session);
  });

  els.logoutBtn.addEventListener("click", async () => {
    await releaseCurrentStream();
    clearCurrentPlaybackUi();
    if (supabaseClient) {
      await supabaseClient.auth.signOut({ scope: "global" });
    }
    rotateStreamId();
    state.user = null;
    state.accessToken = "";
    stopTokenRefreshLoop();
    showAuth();
    setAuthMode("login");
    setAuthStatus("Session fermee.");
  });

  els.pendingLogoutBtn?.addEventListener("click", async () => {
    await releaseCurrentStream();
    clearCurrentPlaybackUi();
    if (supabaseClient) {
      await supabaseClient.auth.signOut({ scope: "global" });
    }
    rotateStreamId();
    state.user = null;
    state.accessToken = "";
    stopTokenRefreshLoop();
    state.accessApproved = false;
    state.isAdmin = false;
    showAuth();
    setAuthMode("login");
    setPendingStatus("");
    setAuthStatus("Session fermee.");
  });

  els.searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = els.searchInput.value.trim();
      refreshChannels();
    }, 250);
  });

  els.groupSelect.addEventListener("change", () => {
    state.group = els.groupSelect.value;
    syncGroupNavActive();
    refreshChannels();
  });

  els.groupNav.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-group]");
    if (!button) return;
    const nextGroup = button.dataset.group || "";
    state.group = nextGroup;
    els.groupSelect.value = nextGroup;
    syncGroupNavActive();
    refreshChannels();
  });

  els.loadMoreBtn.addEventListener("click", () => loadMore());
  els.loadLessBtn?.addEventListener("click", () => loadLess());

  els.tabButtons.forEach((button) => {
    button.addEventListener("click", () => setMainTab(button.dataset.tab || "live"));
  });

  els.toggleMainTabsBtn?.addEventListener("click", () => {
    toggleAccordionPanel(els.mainTabsPanel);
  });

  els.toggleGroupsBtn?.addEventListener("click", () => {
    toggleAccordionPanel(els.groupsBlock);
  });

  els.playerFullscreenBtn?.addEventListener("click", () => {
    requestPlayerFullscreen();
  });
  bindPlayerLoadingEvents();

  bindFullscreenTracking();

  if (els.installAppBtn) {
    els.installAppBtn.addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => null);
      deferredInstallPrompt = null;
      els.installAppBtn.classList.add("hidden");
    });
  }

  window.addEventListener("beforeunload", () => {
    if (!state.accessToken) return;
    releaseCurrentStream({ silent: true });
  });

  document.addEventListener("keydown", handleRemoteKeydown);

  // On mobile, keep categories drawer closed by default.
  if (window.matchMedia?.("(max-width: 980px)").matches && els.groupsBlock) {
    els.groupsBlock.classList.remove("is-open");
    els.groupsBlock.classList.add("is-collapsed");
  }
}

async function handleSupabaseAuthHashError() {
  const rawHash = (window.location.hash || "").replace(/^#/, "");
  if (!rawHash) return;
  const params = new URLSearchParams(rawHash);
  const errorCode = params.get("error_code") || "";
  const errorDescription = params.get("error_description") || "";

  // If there is no explicit error but the hash contains an access token,
  // try to let the Supabase client parse the session and authenticate the user.
  if (!errorCode && !errorDescription && /access_token|refresh_token/.test(rawHash)) {
    try {
      if (supabaseClient?.auth?.getSessionFromUrl) {
        const res = await supabaseClient.auth.getSessionFromUrl();
        const session = res?.data?.session || res?.session || null;
        if (session) await onAuthenticated(session);
      } else {
        const payload = await supabaseClient.auth.getSession();
        const session = payload?.data?.session;
        if (session) await onAuthenticated(session);
      }
    } catch (err) {
      console.warn("Failed to parse session from URL hash", err);
    }
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return;
  }

  if (errorCode === "otp_expired") {
    setAuthStatus("Lien email expire. Refais l'inscription pour recevoir un nouveau lien.");
  } else {
    const decoded = decodeURIComponent(errorDescription.replace(/\+/g, " "));
    setAuthStatus(decoded || "Erreur de validation email.");
  }

  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}


function bindPlayerLoadingEvents() {
  const video = els.player;
  if (!video) return;

  const markPlaybackProgress = () => {
    if (!state.hasActivePlayback) return;
    lastPlaybackProgressAt = Date.now();
    lastPlaybackTime = Number(video.currentTime || 0);
    stallRecoveryAttempts = 0;
    stallHardRestartDone = false;
  };

  video.addEventListener("loadstart", () => {
    if (!state.hasActivePlayback) return;
    setPlayerLoading(true);
  });
  video.addEventListener("waiting", () => {
    if (!state.hasActivePlayback) return;
    setPlayerLoading(true);
  });
  video.addEventListener("canplay", () => setPlayerLoading(false));
  video.addEventListener("playing", () => {
    setPlayerLoading(false);
    markPlaybackProgress();
  });
  video.addEventListener("timeupdate", markPlaybackProgress);
  video.addEventListener("progress", () => {
    if (!state.hasActivePlayback) return;
    lastPlaybackProgressAt = Date.now();
  });
  video.addEventListener("stalled", () => {
    if (!state.hasActivePlayback) return;
    attemptPlaybackRecovery("stalled");
  });
  video.addEventListener("error", () => setPlayerLoading(false));
}

function startPlaybackWatchdog() {
  stopPlaybackWatchdog();
  lastPlaybackProgressAt = Date.now();
  lastPlaybackTime = Number(els.player?.currentTime || 0);
  playbackWatchdogTimer = setInterval(() => {
    const video = els.player;
    if (!video || !state.hasActivePlayback) return;
    if (video.paused || video.seeking || video.ended) return;
    if (video.readyState < 2) return;

    const now = Date.now();
    const currentTime = Number(video.currentTime || 0);
    if (currentTime > lastPlaybackTime + 0.15) {
      lastPlaybackTime = currentTime;
      lastPlaybackProgressAt = now;
      return;
    }

    if (now - lastPlaybackProgressAt >= STALL_DETECTION_MS) {
      attemptPlaybackRecovery("watchdog");
    }
  }, STALL_CHECK_INTERVAL_MS);
}

function stopPlaybackWatchdog() {
  if (!playbackWatchdogTimer) return;
  clearInterval(playbackWatchdogTimer);
  playbackWatchdogTimer = null;
}

function findSelectedChannel() {
  const all = [...state.channels, ...state.favorites, ...state.recent];
  return all.find((channel) => channel.url === state.selectedUrl) || null;
}

function attemptPlaybackRecovery(reason) {
  const now = Date.now();
  if (now - lastStallRecoveryAt < STALL_RECOVERY_COOLDOWN_MS) return;
  lastStallRecoveryAt = now;

  const video = els.player;
  if (!video || !state.hasActivePlayback || !state.selectedUrl) return;

  if (stallRecoveryAttempts >= MAX_STALL_RECOVERY_ATTEMPTS) {
    if (!stallHardRestartDone) {
      const selected = findSelectedChannel();
      if (!selected) return;
      stallHardRestartDone = true;
      els.playerStatus.textContent = "Flux fige, relance complete du direct...";
      playChannel(selected);
      return;
    }
    els.playerStatus.textContent = "Flux instable, verification IPTV en cours...";
    return;
  }

  stallRecoveryAttempts += 1;
  els.playerStatus.textContent = `Recuperation du flux (${reason})... (${stallRecoveryAttempts}/${MAX_STALL_RECOVERY_ATTEMPTS})`;
  setPlayerLoading(true);

  if (hls) {
    try {
      hls.stopLoad();
      hls.startLoad(-1);
      hls.recoverMediaError();
    } catch {}
    video.play().catch(() => {});
    return;
  }

  const source = video.currentSrc || video.src;
  if (source) {
    video.src = source;
    video.load();
  }
  video.play().catch(() => {});
}

function normalizeRemoteKey(event) {
  const key = String(event.key || "");
  const keyCode = Number(event.keyCode || event.which || 0);
  if (key === "ArrowUp" || keyCode === 38) return "up";
  if (key === "ArrowDown" || keyCode === 40) return "down";
  if (key === "ArrowLeft" || keyCode === 37) return "left";
  if (key === "ArrowRight" || keyCode === 39) return "right";
  if (key === "Enter" || key === "OK" || keyCode === 13) return "select";
  if (key === "Escape" || key === "Backspace" || key === "GoBack" || key === "BrowserBack" || keyCode === 8 || keyCode === 27 || keyCode === 461 || keyCode === 10009) return "back";
  if (key === "MediaPlayPause" || keyCode === 179) return "playpause";
  return "";
}

function isVisibleFocusableElement(element) {
  if (!element || !(element instanceof HTMLElement)) return false;
  if (element.hidden || element.disabled) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (element.offsetParent === null && style.position !== "fixed") return false;
  return true;
}

function getRemoteCandidates() {
  return Array.from(document.querySelectorAll("button, input, [tabindex]:not([tabindex='-1'])"))
    .filter(isVisibleFocusableElement);
}

function focusElementForRemote(element) {
  if (!element) return false;
  remoteNavigationPrimed = true;
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

function getChannelCardByUrl(container, url) {
  if (!container || !url) return null;
  const cards = container.querySelectorAll(".channel-item");
  for (const card of cards) {
    if (card.dataset.url === url) return card;
  }
  return null;
}

function focusDefaultForActiveTab() {
  if (state.activeTab === "settings" && focusElementForRemote(els.logoutBtn)) return;

  const list = state.activeTab === "favorites"
    ? els.favoritesList
    : state.activeTab === "recent"
      ? els.recentList
      : els.channelsList;
  const selectedCard = getChannelCardByUrl(list, state.selectedUrl || "");
  if (selectedCard && focusElementForRemote(selectedCard)) return;
  const firstCard = list?.querySelector(".channel-item");
  if (firstCard && focusElementForRemote(firstCard)) return;
  if (state.activeTab === "live" && focusElementForRemote(els.groupNav?.querySelector(".group-item.active"))) return;
  if (state.activeTab === "live" && focusElementForRemote(els.groupNav?.querySelector(".group-item"))) return;
  if (state.activeTab === "live" && focusElementForRemote(els.loadMoreBtn)) return;
  if (state.activeTab === "live") focusElementForRemote(els.searchInput);
}

function moveRemoteFocus(direction) {
  const candidates = getRemoteCandidates();
  if (!candidates.length) return;

  const current = document.activeElement;
  if (!candidates.includes(current)) {
    focusDefaultForActiveTab();
    return;
  }

  const fromRect = current.getBoundingClientRect();
  const fromX = fromRect.left + fromRect.width / 2;
  const fromY = fromRect.top + fromRect.height / 2;

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (candidate === current) continue;
    const rect = candidate.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const dx = x - fromX;
    const dy = y - fromY;

    let valid = false;
    let primary = 0;
    let secondary = 0;
    if (direction === "up" && dy < -4) {
      valid = true;
      primary = -dy;
      secondary = Math.abs(dx);
    } else if (direction === "down" && dy > 4) {
      valid = true;
      primary = dy;
      secondary = Math.abs(dx);
    } else if (direction === "left" && dx < -4) {
      valid = true;
      primary = -dx;
      secondary = Math.abs(dy);
    } else if (direction === "right" && dx > 4) {
      valid = true;
      primary = dx;
      secondary = Math.abs(dy);
    }
    if (!valid) continue;

    const score = primary * 1.2 + secondary * 0.6;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (best) {
    focusElementForRemote(best);
  }
}

function handleRemoteKeydown(event) {
  if (!state.accessApproved || els.appView.classList.contains("hidden")) return;
  const remoteKey = normalizeRemoteKey(event);
  if (!remoteKey) return;

  const target = event.target;
  const isTextInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
  if (isTextInput && !["left", "right", "up", "down", "back"].includes(remoteKey)) return;

  if (remoteKey === "playpause") {
    event.preventDefault();
    if (els.player.paused) {
      els.player.play().catch(() => {});
    } else {
      els.player.pause();
    }
    return;
  }

  if (remoteKey === "back") {
    event.preventDefault();
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    if (state.activeTab !== "live") {
      setMainTab("live");
      setTimeout(() => focusDefaultForActiveTab(), 0);
      return;
    }
    if (els.groupsBlock?.classList.contains("is-open") && window.matchMedia?.("(max-width: 980px)").matches) {
      els.groupsBlock.classList.remove("is-open");
      els.groupsBlock.classList.add("is-collapsed");
      return;
    }
    focusElementForRemote(els.searchInput);
    return;
  }

  if (["up", "down", "left", "right"].includes(remoteKey)) {
    event.preventDefault();
    moveRemoteFocus(remoteKey);
    return;
  }

  if (remoteKey === "select") {
    event.preventDefault();
    const active = document.activeElement;
    if (!active || active === document.body) {
      focusDefaultForActiveTab();
      return;
    }
    if (active instanceof HTMLElement) active.click();
  }
}

function setupPwaInstall() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }

  const isStandalone =
    window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone;
  if (isStandalone) {
    if (els.installAppBtn) els.installAppBtn.classList.add("hidden");
    return;
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (els.installAppBtn) els.installAppBtn.classList.remove("hidden");
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    if (els.installAppBtn) els.installAppBtn.classList.add("hidden");
  });
}

function setAuthMode(mode) {
  const isLogin = mode === "login";
  els.showLoginBtn.classList.toggle("active", isLogin);
  els.showSignupBtn.classList.toggle("active", !isLogin);
  els.loginForm.classList.toggle("hidden", !isLogin);
  els.signupForm.classList.toggle("hidden", isLogin);
}

function setAuthStatus(text) {
  els.authStatus.textContent = text;
}

function setPendingStatus(text) {
  if (!els.pendingStatus) return;
  els.pendingStatus.textContent = text;
}

async function onAuthenticated(session) {
  if (!session?.user) return;
  state.user = session.user;
  state.accessToken = session.access_token || "";
  startTokenRefreshLoop();
  const displayName =
    (session.user.user_metadata?.display_name || "").trim() ||
    (session.user.email || "").split("@")[0] ||
    "utilisateur";
  els.userEmail.textContent = displayName;
  els.userEmail.title = displayName;
  els.settingsUserEmail.textContent = session.user.email || "-";

  const access = await fetchAccessStatus();
  if (!access?.approved) {
    showPending(access);
    return;
  }

  state.accessApproved = true;
  state.isAdmin = Boolean(access.isAdmin);
  showApp();
  ensureAppLoaded();
}

let appBootstrapped = false;
async function ensureAppLoaded() {
  if (appBootstrapped) return;
  appBootstrapped = true;
  updatePlayerLayout(false);
  await loadGroups();
  await refreshChannels();
  renderFavorites();
  renderRecent();
}

function showAuth() {
  els.authView.classList.remove("hidden");
  els.pendingView?.classList.add("hidden");
  els.appView.classList.add("hidden");
}

function showApp() {
  els.authView.classList.add("hidden");
  els.pendingView?.classList.add("hidden");
  els.appView.classList.remove("hidden");
  if (remoteNavigationPrimed) {
    setTimeout(() => focusDefaultForActiveTab(), 0);
  }
}

function startTokenRefreshLoop() {
  stopTokenRefreshLoop();
  tokenRefreshTimer = setInterval(() => {
    refreshAccessToken({ silent: true }).catch(() => {});
  }, TOKEN_REFRESH_INTERVAL_MS);
}

function stopTokenRefreshLoop() {
  if (!tokenRefreshTimer) return;
  clearInterval(tokenRefreshTimer);
  tokenRefreshTimer = null;
}

async function refreshAccessToken(options = {}) {
  const silent = Boolean(options.silent);
  if (!supabaseClient) return false;

  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data.session) return false;

  const session = data.session;
  const expiresAtMs = Number(session.expires_at || 0) * 1000;
  const shouldRefresh = !expiresAtMs || (expiresAtMs - Date.now()) <= TOKEN_REFRESH_GRACE_MS;
  if (!shouldRefresh) {
    state.accessToken = session.access_token || state.accessToken;
    return Boolean(state.accessToken);
  }

  const refreshed = await supabaseClient.auth.refreshSession();
  const refreshedSession = refreshed?.data?.session || null;
  if (refreshed?.error || !refreshedSession) {
    if (!silent) console.warn("token refresh failed", refreshed?.error || "missing session");
    return false;
  }

  state.accessToken = refreshedSession.access_token || state.accessToken;
  return Boolean(state.accessToken);
}

function showPending(access = {}) {
  state.accessApproved = Boolean(access.approved);
  state.isAdmin = Boolean(access.isAdmin);
  els.authView.classList.add("hidden");
  els.appView.classList.add("hidden");
  els.pendingView?.classList.remove("hidden");
  if (els.pendingMessage) {
    els.pendingMessage.textContent = "Ton compte est en attente d'approbation par un administrateur.";
  }
}

function getAuthHeaders(extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;
  return headers;
}

async function fetchAccessStatus() {
  const response = await fetch("/api/access/status", {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    setAuthStatus("Impossible de verifier le statut d'approbation.");
    return { approved: false, isAdmin: false };
  }
  return response.json();
}

function setMainTab(tab) {
  state.activeTab = tab;
  const isMobile = window.matchMedia?.("(max-width: 980px)")?.matches;
  els.tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });

  const titles = {
    live: "Live",
    favorites: "Favoris",
    recent: "Recent",
    settings: "Parametres",
  };
  els.pageTitle.textContent = titles[tab] || "Live";

  els.liveSection.classList.toggle("hidden", tab !== "live");
  els.favoritesSection.classList.toggle("hidden", tab !== "favorites");
  els.recentSection.classList.toggle("hidden", tab !== "recent");
  els.settingsSection.classList.toggle("hidden", tab !== "settings");
  els.groupsBlock.classList.toggle("hidden", !isMobile && tab !== "live");
  if (isMobile) {
    els.toggleGroupsBtn?.classList.remove("hidden");
  } else {
    els.toggleGroupsBtn?.classList.toggle("hidden", tab !== "live");
  }
  els.searchInput.disabled = tab !== "live";
  els.searchInput.parentElement.classList.toggle("hidden", tab !== "live");

  if (tab === "favorites") renderFavorites();
  if (tab === "recent") renderRecent();
  if (remoteNavigationPrimed) {
    setTimeout(() => focusDefaultForActiveTab(), 0);
  }
}

function toggleAccordionPanel(panel) {
  if (!panel) return;
  const isOpen = panel.classList.contains("is-open");
  panel.classList.toggle("is-open", !isOpen);
  panel.classList.toggle("is-collapsed", isOpen);
}

async function requestPlayerFullscreen() {
  const video = els.player;
  if (!video) return;

  try {
    if (video.requestFullscreen) {
      await video.requestFullscreen();
      return;
    }
    if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
  } catch (error) {
    console.warn("fullscreen request failed", error);
  }
}

function bindFullscreenTracking() {
  const markFullscreenState = () => {
    const isFullscreen = Boolean(document.fullscreenElement);
    document.body.classList.toggle("video-fullscreen", isFullscreen);
  };

  document.addEventListener("fullscreenchange", markFullscreenState);
}

async function loadGroups() {
  const response = await fetch("/api/groups", {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error("Impossible de charger les categories");

  const payload = await response.json();
  state.groups = payload.groups || [];

  els.groupSelect.innerHTML = "";
  appendOption("", "Toutes");
  for (const group of state.groups) {
    appendOption(group.name, `${group.name} (${group.count})`);
  }
  renderGroupNav();
}

function appendOption(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  els.groupSelect.appendChild(option);
}

function renderGroupNav() {
  const totalChannels = state.groups.reduce((acc, group) => acc + group.count, 0);
  const fragment = document.createDocumentFragment();
  fragment.appendChild(createGroupButton("Toutes", "", totalChannels));
  for (const group of state.groups) {
    fragment.appendChild(createGroupButton(group.name, group.name, group.count));
  }
  els.groupNav.innerHTML = "";
  els.groupNav.appendChild(fragment);
  syncGroupNavActive();
}

function createGroupButton(label, value, count) {
  const button = document.createElement("button");
  button.className = "group-item";
  button.type = "button";
  button.dataset.group = value;

  const text = document.createElement("span");
  text.textContent = label;

  const badge = document.createElement("span");
  badge.className = "count";
  badge.textContent = String(count);

  button.append(text, badge);
  return button;
}

function syncGroupNavActive() {
  const buttons = els.groupNav.querySelectorAll("button[data-group]");
  buttons.forEach((button) => {
    const active = (button.dataset.group || "") === state.group;
    button.classList.toggle("active", active);
  });
}

async function refreshChannels() {
  state.offset = 0;
  state.channels = [];
  await fetchChannelsPage();
}

async function loadMore() {
  if (!state.hasMore) return;
  state.offset += state.limit;
  await fetchChannelsPage(true);
}

function loadLess() {
  if (state.channels.length <= state.limit) return;
  state.channels = state.channels.slice(0, Math.max(state.limit, state.channels.length - state.limit));
  state.offset = Math.max(0, state.offset - state.limit);
  state.hasMore = state.channels.length < state.total;
  renderLiveChannels();
  els.listMeta.textContent = `${state.channels.length} affichees sur ${state.total}`;
  updateLoadButtons();
}

function makeChannelsUrl() {
  const params = new URLSearchParams({
    offset: String(state.offset),
    limit: String(state.limit),
  });
  if (state.q) params.set("q", state.q);
  if (state.group) params.set("group", state.group);
  return `/api/channels?${params.toString()}`;
}

function makeProxyUrl(rawUrl, options = {}) {
  const includeAuthToken = Boolean(options.includeAuthToken);
  const params = new URLSearchParams({
    url: rawUrl,
    sid: state.streamId,
  });
  if (includeAuthToken && state.accessToken) {
    params.set("at", state.accessToken);
  }
  return `/api/proxy?${params.toString()}`;
}

function buildLogoUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return CHANNEL_FALLBACK_THUMB;
  if (value.startsWith("data:")) return value;
  try {
    const resolved = new URL(value, window.location.origin);
    const isAbsoluteHttp = resolved.protocol === "http:" || resolved.protocol === "https:";
    if (isAbsoluteHttp) {
      // Route all remote logos through backend to avoid mixed content and ensure access checks.
      return makeProxyUrl(resolved.href, { includeAuthToken: true });
    }
  } catch {}
  return value;
}

async function fetchChannelsPage(append = false) {
  els.loadMoreBtn.disabled = true;
  if (els.loadLessBtn) els.loadLessBtn.disabled = true;
  els.listMeta.textContent = "Chargement des chaines...";

  const response = await fetch(makeChannelsUrl(), {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error("Erreur chargement chaines");

  const payload = await response.json();
  state.total = payload.total;
  state.hasMore = payload.hasMore;
  state.channels = append ? state.channels.concat(payload.items) : payload.items;

  renderLiveChannels();
  els.listMeta.textContent = `${state.channels.length} affichees sur ${state.total}`;
  updateLoadButtons();
}

function updateLoadButtons() {
  els.loadMoreBtn.disabled = !state.hasMore;
  if (!els.loadLessBtn) return;
  els.loadLessBtn.disabled = state.channels.length <= state.limit;
}

function renderLiveChannels() {
  renderChannelCollection(els.channelsList, state.channels, "Aucune chaine trouvee.");
  if (remoteNavigationPrimed && state.activeTab === "live") {
    setTimeout(() => focusDefaultForActiveTab(), 0);
  }
}

function renderFavorites() {
  renderChannelCollection(els.favoritesList, state.favorites, "Aucun favori pour le moment.");
  if (remoteNavigationPrimed && state.activeTab === "favorites") {
    setTimeout(() => focusDefaultForActiveTab(), 0);
  }
}

function renderRecent() {
  renderChannelCollection(els.recentList, state.recent, "Aucun historique pour le moment.");
  if (remoteNavigationPrimed && state.activeTab === "recent") {
    setTimeout(() => focusDefaultForActiveTab(), 0);
  }
}

function renderChannelCollection(container, list, emptyText) {
  const fragment = document.createDocumentFragment();
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "muted small";
    empty.textContent = emptyText;
    container.innerHTML = "";
    container.appendChild(empty);
    return;
  }

  for (const channel of list) {
    fragment.appendChild(createChannelCard(channel));
  }
  container.innerHTML = "";
  container.appendChild(fragment);
}

function createChannelCard(channel) {
  const item = document.createElement("button");
  item.className = `channel-item${channel.url === state.selectedUrl ? " active" : ""}`;
  item.type = "button";
  item.dataset.url = channel.url;

  const image = document.createElement("img");
  image.className = "channel-logo";
  image.alt = channel.name;
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.src = buildLogoUrl(channel.logo);
  image.addEventListener("error", () => {
    if (image.src.startsWith("data:image/svg+xml")) return;
    image.src = CHANNEL_FALLBACK_THUMB;
  });

  const title = document.createElement("div");
  title.className = "channel-name";
  title.textContent = channel.name;

  const group = document.createElement("div");
  group.className = "channel-group";
  group.textContent = channel.group;

  const actions = document.createElement("div");
  actions.className = "channel-actions";

  const favBtn = document.createElement("button");
  favBtn.type = "button";
  favBtn.className = `fav-btn${isFavorite(channel.url) ? " active" : ""}`;
  favBtn.tabIndex = -1;
  favBtn.textContent = "♥";
  favBtn.title = "Favori";
  favBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFavorite(channel);
    favBtn.classList.toggle("active", isFavorite(channel.url));
  });

  actions.appendChild(favBtn);
  item.append(image, title, group, actions);

  item.addEventListener("click", () => {
    setMainTab("live");
    playChannel(channel);
  });
  return item;
}

function playChannel(channel) {
  clearAutoRejoin();
  playRequestId += 1;
  const currentRequestId = playRequestId;
  networkRecoveryAttempts = 0;
  lockRecoveryAttempts = 0;
  authRecoveryAttempts = 0;
  stallRecoveryAttempts = 0;
  stallHardRestartDone = false;
  lastPlaybackProgressAt = Date.now();
  lastPlaybackTime = 0;

  state.selectedUrl = channel.url;
  state.hasActivePlayback = true;
  addToRecent(channel);
  renderLiveChannels();
  updatePlayerLayout(true);
  startPlaybackWatchdog();

  const streamUrl = makeProxyUrl(channel.url);
  els.currentTitle.textContent = channel.name;
  els.playerStatus.textContent = `Connexion au flux... (${channel.group})`;

  const video = els.player;
  setPlayerLoading(true);
  teardownPlayer(video);

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = `${streamUrl}&at=${encodeURIComponent(state.accessToken)}`;
    video.play().then(() => {
      if (currentRequestId !== playRequestId) return;
      clearAutoRejoin();
      els.playerStatus.textContent = `Lecture en cours (${channel.group})`;
      setPlayerLoading(false);
    }).catch(() => {});
    video.onerror = () => {
      if (currentRequestId !== playRequestId) return;
      scheduleAutoRejoin(channel, "video-error");
    };
    return;
  }

  if (!window.Hls || !window.Hls.isSupported()) {
    els.playerStatus.textContent = "Votre navigateur ne supporte pas HLS.";
    setPlayerLoading(false);
    stopPlaybackWatchdog();
    return;
  }

  hls = new window.Hls({
    ...FAST_LIVE_HLS_CONFIG,
    xhrSetup: (xhr) => {
      if (state.accessToken) xhr.setRequestHeader("Authorization", `Bearer ${state.accessToken}`);
      xhr.setRequestHeader("x-mktv-stream-id", state.streamId);
    },
    fetchSetup: (context, init) => {
      const headers = new Headers(init?.headers || {});
      if (state.accessToken) headers.set("Authorization", `Bearer ${state.accessToken}`);
      headers.set("x-mktv-stream-id", state.streamId);
      return new Request(context.url, { ...init, headers });
    },
  });
  const thisHls = hls;
  thisHls.attachMedia(video);

  thisHls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
    if (currentRequestId !== playRequestId || thisHls !== hls) return;
    thisHls.loadSource(streamUrl);
  });

  thisHls.on(window.Hls.Events.MANIFEST_PARSED, () => {
    if (currentRequestId !== playRequestId || thisHls !== hls) return;
    video.play().then(() => {
      if (currentRequestId !== playRequestId || thisHls !== hls) return;
      clearAutoRejoin();
      els.playerStatus.textContent = `Lecture en cours (${channel.group})`;
    }).catch(() => {});
  });

  thisHls.on(window.Hls.Events.ERROR, (_, data) => {
    if (currentRequestId !== playRequestId || thisHls !== hls) return;
    if (!data.fatal) return;

    if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
      const statusCode = data?.response?.code || 0;
      if ([401, 403, 405, 409, 429].includes(statusCode)) {
        if (statusCode === 401 && authRecoveryAttempts < 1) {
          authRecoveryAttempts += 1;
          els.playerStatus.textContent = "Session expiree, reconnexion automatique...";
          refreshAccessToken({ silent: false })
            .then((ok) => {
              if (currentRequestId !== playRequestId || thisHls !== hls) return;
              if (!ok) {
                scheduleAutoRejoin(channel, "token-refresh-failed");
                return;
              }
              playChannel(channel);
            })
            .catch(() => {
              if (currentRequestId !== playRequestId || thisHls !== hls) return;
              scheduleAutoRejoin(channel, "token-refresh-error");
            });
          return;
        }
        if (statusCode === 409 && lockRecoveryAttempts < 1) {
          lockRecoveryAttempts += 1;
          els.playerStatus.textContent = "Session IPTV en conflit, tentative de recuperation...";
          releaseCurrentStream({ silent: true, force: true })
            .finally(() => {
              if (currentRequestId !== playRequestId || thisHls !== hls) return;
              playChannel(channel);
            });
          return;
        }
        const reason = statusCode === 429
          ? "Trop de requetes vers le fournisseur IPTV."
          : statusCode === 409
            ? "Un autre appareil utilise deja ce compte en lecture."
          : "Chaine non autorisee ou bloquee par le fournisseur IPTV.";
        els.playerStatus.textContent = `${reason} Nouvelle tentative... (code ${statusCode})`;
        scheduleAutoRejoin(channel, `status-${statusCode}`);
        return;
      }
      if (networkRecoveryAttempts < MAX_NETWORK_RECOVERY_ATTEMPTS) {
        networkRecoveryAttempts += 1;
        els.playerStatus.textContent = `Resynchronisation reseau... (${networkRecoveryAttempts}/${MAX_NETWORK_RECOVERY_ATTEMPTS})`;
        thisHls.stopLoad();
        thisHls.startLoad(-1);
        return;
      }
      attemptPlaybackRecovery("hls-network");
      return;
    }

    if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
      els.playerStatus.textContent = "Correction audio/video...";
      thisHls.recoverMediaError();
      return;
    }

    els.playerStatus.textContent = `Erreur HLS: ${data.details || data.type || "fatal"}`;
    scheduleAutoRejoin(channel, "hls-fatal");
  });
}

function computeAutoRejoinDelayMs() {
  const attempt = Math.max(1, autoRejoinAttempts);
  const exponential = AUTO_REJOIN_MIN_DELAY_MS * Math.pow(1.8, attempt - 1);
  const withJitter = exponential + Math.floor(Math.random() * 400);
  return Math.min(AUTO_REJOIN_MAX_DELAY_MS, Math.max(AUTO_REJOIN_MIN_DELAY_MS, withJitter));
}

function clearAutoRejoin() {
  autoRejoinAttempts = 0;
  if (!autoRejoinTimer) return;
  clearTimeout(autoRejoinTimer);
  autoRejoinTimer = null;
}

function scheduleAutoRejoin(channel, reason = "unknown") {
  if (!channel?.url) return;
  if (!state.hasActivePlayback || state.selectedUrl !== channel.url) return;
  if (autoRejoinTimer) return;

  autoRejoinAttempts += 1;
  const delayMs = computeAutoRejoinDelayMs();
  els.playerStatus.textContent = `Flux interrompu (${reason}). Reconnexion dans ${Math.ceil(delayMs / 1000)}s...`;
  setPlayerLoading(true);

  autoRejoinTimer = setTimeout(() => {
    autoRejoinTimer = null;
    if (!state.hasActivePlayback || state.selectedUrl !== channel.url) return;
    playChannel(channel);
  }, delayMs);
}

function teardownPlayer(video) {
  stopPlaybackWatchdog();
  if (autoRejoinTimer) {
    clearTimeout(autoRejoinTimer);
    autoRejoinTimer = null;
  }
  if (hls) {
    try {
      hls.stopLoad();
      hls.detachMedia();
    } catch {}
    hls.destroy();
    hls = null;
  }

  video.pause();
  video.removeAttribute("src");
  video.src = "";
  video.load();
  setPlayerLoading(false);
}

function clearCurrentPlaybackUi() {
  state.selectedUrl = "";
  state.hasActivePlayback = false;
  els.currentTitle.textContent = "Selectionnez une chaine";
  els.playerStatus.textContent = "";
  teardownPlayer(els.player);
  updatePlayerLayout(false);
  setPlayerLoading(false);
}

function updatePlayerLayout(hasActivePlayback) {
  state.hasActivePlayback = Boolean(hasActivePlayback);
  document.body.classList.toggle("has-active-player", state.hasActivePlayback);
  els.playerShell.classList.toggle("is-hidden", !state.hasActivePlayback);
}

function setPlayerLoading(isLoading) {
  if (playerLoadingSafetyTimer) {
    clearTimeout(playerLoadingSafetyTimer);
    playerLoadingSafetyTimer = null;
  }
  els.playerLoading?.classList.toggle("hidden", !isLoading);
  if (isLoading) {
    playerLoadingSafetyTimer = setTimeout(() => {
      els.playerLoading?.classList.add("hidden");
      playerLoadingSafetyTimer = null;
    }, 5000);
  }
}

function isFavorite(url) {
  return state.favorites.some((item) => item.url === url);
}

function toggleFavorite(channel) {
  const idx = state.favorites.findIndex((item) => item.url === channel.url);
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
  } else {
    state.favorites.unshift(cloneChannel(channel));
  }
  saveLocalState();
  renderFavorites();
}

function addToRecent(channel) {
  state.recent = state.recent.filter((item) => item.url !== channel.url);
  state.recent.unshift(cloneChannel(channel));
  state.recent = state.recent.slice(0, 80);
  saveLocalState();
  if (state.activeTab === "recent") renderRecent();
}

function cloneChannel(channel) {
  return {
    name: channel.name,
    group: channel.group,
    logo: channel.logo,
    url: channel.url,
  };
}

function hydrateLocalState() {
  state.favorites = parseStoredArray(STORAGE_FAVORITES);
  state.recent = parseStoredArray(STORAGE_RECENT);
}

function saveLocalState() {
  localStorage.setItem(STORAGE_FAVORITES, JSON.stringify(state.favorites));
  localStorage.setItem(STORAGE_RECENT, JSON.stringify(state.recent));
}

function parseStoredArray(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function createStreamId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `mktv-${Date.now().toString(36)}-${random}`;
}

function loadOrCreateStreamId() {
  try {
    const existing = localStorage.getItem(STORAGE_STREAM_ID);
    if (existing && existing.startsWith("mktv-")) return existing;
  } catch {}

  const created = createStreamId();
  try {
    localStorage.setItem(STORAGE_STREAM_ID, created);
  } catch {}
  return created;
}

function rotateStreamId() {
  state.streamId = createStreamId();
  try {
    localStorage.setItem(STORAGE_STREAM_ID, state.streamId);
  } catch {}
}

async function releaseCurrentStream(options = {}) {
  const silent = Boolean(options.silent);
  const force = Boolean(options.force);
  if (!state.accessToken || !state.streamId) return;
  try {
    const headers = {
      "content-type": "application/json",
      Authorization: `Bearer ${state.accessToken}`,
    };
    if (!force) headers["x-mktv-stream-id"] = state.streamId;

    const body = force ? {} : { streamId: state.streamId };

    await fetch("/api/session/release", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch (error) {
    if (!silent) console.error("release stream failed", error);
  }
}
