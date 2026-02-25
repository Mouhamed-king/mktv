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
let supabaseClient = null;
let deferredInstallPrompt = null;
let playerLoadingSafetyTimer = null;

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
  manifestLoadingTimeOut: 5000,
  manifestLoadingMaxRetry: 0,
  levelLoadingTimeOut: 5000,
  levelLoadingMaxRetry: 0,
  fragLoadingTimeOut: 7000,
  fragLoadingMaxRetry: 1,
};

init().catch((error) => {
  console.error(error);
  els.authStatus.textContent = "Erreur d'initialisation.";
});

async function init() {
  hydrateLocalState();
  bindUiEvents();
  await initSupabase();
  handleSupabaseAuthHashError();
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
      return;
    }
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
      setAuthStatus(error.message || "Inscription echouee.");
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

  // On mobile, keep categories drawer closed by default.
  if (window.matchMedia?.("(max-width: 980px)").matches && els.groupsBlock) {
    els.groupsBlock.classList.remove("is-open");
    els.groupsBlock.classList.add("is-collapsed");
  }
}

function handleSupabaseAuthHashError() {
  const rawHash = (window.location.hash || "").replace(/^#/, "");
  if (!rawHash) return;
  const params = new URLSearchParams(rawHash);
  const errorCode = params.get("error_code") || "";
  const errorDescription = params.get("error_description") || "";
  if (!errorCode && !errorDescription) return;

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

  video.addEventListener("loadstart", () => {
    if (!state.hasActivePlayback) return;
    setPlayerLoading(true);
  });
  video.addEventListener("waiting", () => {
    if (!state.hasActivePlayback) return;
    setPlayerLoading(true);
  });
  video.addEventListener("canplay", () => setPlayerLoading(false));
  video.addEventListener("playing", () => setPlayerLoading(false));
  video.addEventListener("error", () => setPlayerLoading(false));
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

function makeProxyUrl(rawUrl) {
  const params = new URLSearchParams({
    url: rawUrl,
    sid: state.streamId,
  });
  return `/api/proxy?${params.toString()}`;
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
}

function renderFavorites() {
  renderChannelCollection(els.favoritesList, state.favorites, "Aucun favori pour le moment.");
}

function renderRecent() {
  renderChannelCollection(els.recentList, state.recent, "Aucun historique pour le moment.");
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

  const image = document.createElement("img");
  image.className = "channel-logo";
  image.alt = channel.name;
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.src = channel.logo || CHANNEL_FALLBACK_THUMB;
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
  playRequestId += 1;
  const currentRequestId = playRequestId;
  networkRecoveryAttempts = 0;
  lockRecoveryAttempts = 0;

  state.selectedUrl = channel.url;
  state.hasActivePlayback = true;
  addToRecent(channel);
  renderLiveChannels();
  updatePlayerLayout(true);

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
      els.playerStatus.textContent = `Lecture en cours (${channel.group})`;
      setPlayerLoading(false);
    }).catch(() => {});
    return;
  }

  if (!window.Hls || !window.Hls.isSupported()) {
    els.playerStatus.textContent = "Votre navigateur ne supporte pas HLS.";
    setPlayerLoading(false);
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
      els.playerStatus.textContent = `Lecture en cours (${channel.group})`;
    }).catch(() => {});
  });

  thisHls.on(window.Hls.Events.ERROR, (_, data) => {
    if (currentRequestId !== playRequestId || thisHls !== hls) return;
    if (!data.fatal) return;

    if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
      const statusCode = data?.response?.code || 0;
      if ([401, 403, 405, 409, 429].includes(statusCode)) {
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
        els.playerStatus.textContent = `${reason} (code ${statusCode}).`;
        setPlayerLoading(false);
        thisHls.destroy();
        if (thisHls === hls) hls = null;
        return;
      }
      if (networkRecoveryAttempts < 1) {
        networkRecoveryAttempts += 1;
        els.playerStatus.textContent = "Resynchronisation reseau...";
        thisHls.stopLoad();
        thisHls.startLoad(-1);
        return;
      }
      els.playerStatus.textContent = "Flux indisponible apres plusieurs tentatives reseau.";
      setPlayerLoading(false);
      thisHls.destroy();
      if (thisHls === hls) hls = null;
      return;
    }

    if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
      els.playerStatus.textContent = "Correction audio/video...";
      thisHls.recoverMediaError();
      return;
    }

    els.playerStatus.textContent = `Erreur HLS: ${data.details || data.type || "fatal"}`;
    setPlayerLoading(false);
    thisHls.destroy();
    if (thisHls === hls) hls = null;
  });
}

function teardownPlayer(video) {
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
