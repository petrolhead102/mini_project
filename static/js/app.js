/* static/js/app.js */

// Global App State
const state = {
  currentUser: null,
  selectedStationId: null,
  mode: 'recommendation', // 'recommendation' | 'discovery'
  filters: {
    search: '',
    status: 'all',
    type: 'all'
  },
  ev: {
    batteryPct: 35,
    remainingRangeKm: 60,
    batteryCapacityKwh: 60,
    efficiency: 5.5,
    safetyMarginPct: 15,
    connector: 'all',
    lat: 37.7749,
    lng: -122.4194
  },
  recommendationData: null,
  stations: [], // Ranked reachable stations or all stations
  unreachableStations: [],
  userReservations: {}, // { stationId: expiresTimestamp }
  claimedRewards: {}, // { stationId: token }
  userRewardsSummary: { verified: 0, estimated: 0, transactions: [] },
  map: null,
  infoWindow: null,
  markers: {}, // Map station.id -> google.maps.Marker
  vehicleMarker: null
};

// Initialize App
document.addEventListener("DOMContentLoaded", () => {
  initAuth();
  initRewardsSummary();
  initMap();

  // Obtain vehicle location from browser geolocation or use default
  if ("geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        state.ev.lat = position.coords.latitude;
        state.ev.lng = position.coords.longitude;
        updateLocationDisplay();
        if (state.map) {
          state.map.setCenter({ lat: parseFloat(state.ev.lat), lng: parseFloat(state.ev.lng) });
        }
        fetchRecommendations();
      },
      (error) => {
        console.warn("Geolocation denied or error. Using San Francisco default location.", error);
        state.ev.lat = 37.7749;
        state.ev.lng = -122.4194;
        updateLocationDisplay();
        fetchRecommendations();
      }
    );
  } else {
    updateLocationDisplay();
    fetchRecommendations();
  }

  setupEventListeners();
  updateSafeRangeDisplay();
});

function updateLocationDisplay() {
  const el = document.getElementById("vehicle-coords-display");
  if (el) {
    el.textContent = `${state.ev.lat.toFixed(4)}° N, ${state.ev.lng.toFixed(4)}° W`;
  }
}

function updateSafeRangeDisplay() {
  const safeRange = state.ev.remainingRangeKm * (1.0 - (state.ev.safetyMarginPct / 100.0));
  const el = document.getElementById("safe-range-val");
  if (el) {
    el.textContent = `${safeRange.toFixed(1)} km`;
  }
}

// -------------------------------------------------------------
// FEATURE 6 & FEATURE 9: Fetch Intelligent Recommendations
// -------------------------------------------------------------
async function fetchRecommendations() {
  showToast("Computing intelligent station recommendations...", "info");

  try {
    const payload = {
      battery_percentage: parseFloat(state.ev.batteryPct),
      remaining_range_km: parseFloat(state.ev.remainingRangeKm),
      battery_capacity_kwh: parseFloat(state.ev.batteryCapacityKwh),
      vehicle_efficiency_km_per_kwh: parseFloat(state.ev.efficiency),
      safety_margin_pct: parseFloat(state.ev.safetyMarginPct),
      connector_preference: state.ev.connector,
      lat: parseFloat(state.ev.lat),
      lng: parseFloat(state.ev.lng)
    };

    const res = await fetch("/api/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      showToast(err.message || "Recommendation calculation failed", "error");
      return;
    }

    const data = await res.json();
    state.recommendationData = data;
    state.stations = data.ranked_alternatives || [];
    state.unreachableStations = data.unreachable_stations || [];

    renderUrgencyBanner(data.urgency);
    renderWarningAlert(data.warning);
    renderStatsFromRecommendation(data);
    renderRecommendationShowcase(data.recommended_station, data.reward_incentive);
    renderStationsList();
    renderUnreachableDrawer(data.unreachable_stations);
    renderMapMarkers();

    if (data.recommended_station) {
      showToast(`Recommended: ${data.recommended_station.name} (${data.recommended_station.composite_score}/100)`, "success");
    }
  } catch (err) {
    console.error("Recommendation error:", err);
    showToast("Network error computing recommendations.", "error");
  }
}

// -------------------------------------------------------------
// FEATURE 2: Discover All Stations (Classic Mode)
// -------------------------------------------------------------
async function fetchAllStations(lat, lng) {
  try {
    const response = await fetch(`/api/stations?lat=${lat}&lng=${lng}`);
    if (response.ok) {
      const data = await response.json();
      state.stations = data;
      state.unreachableStations = [];
      document.getElementById("recommendation-showcase").style.display = "none";
      document.getElementById("urgency-banner").style.display = "none";
      document.getElementById("global-warning-box").style.display = "none";
      document.getElementById("unreachable-drawer").style.display = "none";
      document.getElementById("stations-list-title").textContent = "All Nearby Charging Stations";
      renderStats();
      renderStationsList();
      renderMapMarkers();
    } else {
      showToast("Failed to fetch stations.", "error");
    }
  } catch (error) {
    console.error("Error fetching stations:", error);
    showToast("Network error fetching stations.", "error");
  }
}

// -------------------------------------------------------------
// FEATURE 4: Render Charging Urgency Banner
// -------------------------------------------------------------
function renderUrgencyBanner(urgency) {
  const banner = document.getElementById("urgency-banner");
  if (!urgency) {
    banner.style.display = "none";
    return;
  }

  banner.style.display = "flex";
  const badge = document.getElementById("urgency-level-badge");
  const scoreVal = document.getElementById("urgency-score-val");
  const explText = document.getElementById("urgency-explanation-text");

  const levelClass = urgency.urgency_level.toLowerCase();
  badge.className = `urgency-level-pill ${levelClass}`;
  badge.textContent = `${urgency.urgency_level} Urgency`;
  scoreVal.textContent = Math.round(urgency.urgency_score);
  explText.textContent = urgency.explanation;
}

function renderWarningAlert(warningMsg) {
  const box = document.getElementById("global-warning-box");
  const text = document.getElementById("global-warning-text");
  if (warningMsg) {
    box.style.display = "flex";
    text.textContent = warningMsg;
  } else {
    box.style.display = "none";
  }
}

// -------------------------------------------------------------
// FEATURE 6: Render Top Recommendation Showcase Card
// -------------------------------------------------------------
function renderRecommendationShowcase(rec, reward) {
  const container = document.getElementById("recommendation-showcase");
  if (!rec || state.mode !== 'recommendation') {
    container.style.display = "none";
    return;
  }

  container.style.display = "block";

  let rewardHtml = '';
  if (reward && reward.eligible && reward.points > 0) {
    rewardHtml = `
      <div class="rec-reward-callout">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>
        <span>+${reward.points} Incentive Points: choosing this station saves ~${reward.wait_time_saved_mins} mins wait!</span>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="rec-header">
      <div class="rec-title-group">
        <div class="rec-rank-tag">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
          Optimal Match #1
        </div>
        <div class="rec-station-name">${rec.name}</div>
      </div>
      <div class="rec-score-badge">Score: ${rec.composite_score}/100</div>
    </div>

    <div style="font-size: 0.8rem; color: #94a3b8; margin-bottom: 0.5rem;">${rec.address}</div>

    <div class="rec-metrics-row">
      <div class="rec-metric-item">
        <span class="rec-metric-label">Route Dist</span>
        <span class="rec-metric-val">${rec.route_distance_km} km</span>
        <span class="rec-data-source-pill">~${rec.estimated_travel_time_mins} min drive</span>
      </div>
      <div class="rec-metric-item">
        <span class="rec-metric-label">Forecast Wait</span>
        <span class="rec-metric-val">${rec.predicted_waiting_time_mins} min</span>
        <span class="rec-data-source-pill">${rec.forecast_method || 'ARIMA'}</span>
      </div>
      <div class="rec-metric-item">
        <span class="rec-metric-label">Plugs Open</span>
        <span class="rec-metric-val">${rec.availablePlugs}/${rec.totalPlugs}</span>
        <span class="rec-data-source-pill">${rec.speed} kW ${rec.connector}</span>
      </div>
    </div>

    <div class="rec-explanation-box">
      ${rec.rank_explanation || "Optimal choice balancing drive time and forecast queue delay."}
    </div>

    ${rewardHtml}

    <div style="margin-top: 0.85rem; display: flex; gap: 0.5rem;">
      <button class="btn btn-primary" style="flex: 1; justify-content: center; font-size: 0.85rem;" onclick="bookStation(event, ${rec.id})">
        Reserve Optimal Slot
      </button>
      <button class="btn btn-outline" style="font-size: 0.85rem;" onclick="selectStation(${rec.id}, true)">
        View on Map
      </button>
    </div>
  `;
}

// -------------------------------------------------------------
// FEATURE 3: Render Excluded / Unreachable Stations Drawer
// -------------------------------------------------------------
function renderUnreachableDrawer(unreachables) {
  const drawer = document.getElementById("unreachable-drawer");
  const countBadge = document.getElementById("unreachable-count-badge");
  const list = document.getElementById("unreachable-list");

  if (!unreachables || unreachables.length === 0 || state.mode !== 'recommendation') {
    drawer.style.display = "none";
    return;
  }

  drawer.style.display = "block";
  countBadge.textContent = unreachables.length;

  list.innerHTML = unreachables.map(st => `
    <div class="unreachable-card">
      <div class="unreachable-header">
        <span>${st.name}</span>
        <span style="font-size: 0.75rem; color: #94a3b8;">${st.connector || 'Unknown Plug'}</span>
      </div>
      <div class="unreachable-reason-text">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 3px;">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="15" y1="9" x2="9" y2="15"></line>
          <line x1="9" y1="9" x2="15" y2="15"></line>
        </svg>
        ${st.exclusion_reason || 'Station not suitable'}
      </div>
    </div>
  `).join('');
}

// Toast System
function showToast(message, type = 'info') {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  let iconSVG = '';
  if (type === 'success') {
    iconSVG = `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>`;
  } else if (type === 'error') {
    iconSVG = `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>`;
  } else {
    iconSVG = `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zm-1 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/></svg>`;
  }

  toast.innerHTML = `
    <span class="toast-icon">${iconSVG}</span>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("removing");
    toast.addEventListener("animationend", () => {
      toast.remove();
    });
  }, 4000);
}

// Authentication Logic
async function initAuth() {
  try {
    const res = await fetch("/profile");
    if (res.ok) {
      const user = await res.json();
      setAuthenticatedUser(user);
    } else {
      setAuthenticatedUser(null);
    }
  } catch (err) {
    setAuthenticatedUser(null);
  }
}

function setAuthenticatedUser(user) {
  state.currentUser = user;
  const authPanel = document.getElementById("auth-panel");

  if (user) {
    authPanel.innerHTML = `
      <div class="user-badge">
        <div class="user-avatar">${user.username.charAt(0).toUpperCase()}</div>
        <span class="user-name">${user.username}</span>
        <button id="logout-btn" class="btn-logout" title="Log Out">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
        </button>
      </div>
    `;
    document.getElementById("logout-btn").addEventListener("click", handleLogout);
  } else {
    authPanel.innerHTML = `
      <button id="open-login-btn" class="btn btn-outline">Sign In</button>
      <button id="open-register-btn" class="btn btn-primary">Register</button>
    `;
    document.getElementById("open-login-btn").addEventListener("click", () => toggleModal("login-modal", true));
    document.getElementById("open-register-btn").addEventListener("click", () => toggleModal("register-modal", true));
  }
}

function toggleModal(modalId, show) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  const formMessage = modal.querySelector(".form-message");
  if (formMessage) {
    formMessage.style.display = "none";
    formMessage.textContent = "";
  }
  if (show) {
    modal.classList.add("active");
  } else {
    modal.classList.remove("active");
    modal.querySelector("form")?.reset();
  }
}

async function handleLogout() {
  try {
    const res = await fetch("/logout", { method: "POST" });
    if (res.ok) {
      showToast("Logged out successfully.", "success");
      setAuthenticatedUser(null);
      state.userReservations = {};
      renderStationsList();
    } else {
      showToast("Logout failed.", "error");
    }
  } catch (err) {
    showToast("Server communication error.", "error");
  }
}

// Dark Map Custom Style for Google Maps
const darkMapStyle = [
  { elementType: "geometry", stylers: [{ color: "#0f172a" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0f172a" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#94a3b8" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#cbd5e1" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#64748b" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#1e293b" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#1e293b" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#0f172a" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#94a3b8" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#334155" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#1e293b" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0284c7" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#38bdf8" }] }
];

function initMap() {
  if (typeof google === 'undefined' || !google.maps) {
    console.warn("Google Maps API not loaded. Operating in fallback mode.");
    return;
  }

  const defaultLocation = { lat: parseFloat(state.ev.lat), lng: parseFloat(state.ev.lng) };

  state.map = new google.maps.Map(document.getElementById("map"), {
    zoom: 13,
    center: defaultLocation,
    styles: darkMapStyle,
    disableDefaultUI: false,
    zoomControl: true,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: true
  });

  state.infoWindow = new google.maps.InfoWindow();

  // Marker for Vehicle position
  state.vehicleMarker = new google.maps.Marker({
    position: defaultLocation,
    map: state.map,
    title: "Your EV Location",
    icon: {
      path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 6,
      fillColor: "#38bdf8",
      fillOpacity: 1,
      strokeWeight: 2,
      strokeColor: "#ffffff",
      rotation: 0
    }
  });

  renderMapMarkers();
}

function renderMapMarkers() {
  if (!state.map || typeof google === 'undefined') return;

  // Clear existing markers
  if (state.markers) {
    Object.values(state.markers).forEach(marker => marker.setMap(null));
  }
  state.markers = {};

  const filtered = getFilteredStations();

  filtered.forEach(station => {
    if (station.lat == null || station.lng == null) return;

    let pinColor = "#06b6d4"; // available
    if (station.status === "charging") pinColor = "#f59e0b"; // busy
    if (station.status === "offline") pinColor = "#ef4444"; // offline
    if (station.rank === 1) pinColor = "#10b981"; // Best match green

    const marker = new google.maps.Marker({
      position: { lat: parseFloat(station.lat), lng: parseFloat(station.lng) },
      map: state.map,
      title: station.name,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: station.rank === 1 ? 11 : 8,
        fillColor: pinColor,
        fillOpacity: 1,
        strokeWeight: 2,
        strokeColor: "#ffffff"
      }
    });

    const isReserved = !!state.userReservations[station.id];
    const statusText = station.status === 'available' ? 'Available' : station.status === 'charging' ? 'In Use' : 'Offline';

    const popupContent = `
      <div style="padding: 6px; max-width: 230px; font-family: 'Outfit', sans-serif;">
        <div style="font-weight: 700; font-size: 0.95rem; color: #0f172a; margin-bottom: 2px;">
          ${station.rank ? `#${station.rank} ` : ''}${station.name}
        </div>
        <div style="font-size: 0.8rem; color: #475569; margin-bottom: 4px;">${station.address}</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 2px;"><strong>${station.type}</strong> (${station.speed} kW)</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 2px;">Connector: ${station.connector}</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 2px;">Drive Time: ~${station.estimated_travel_time_mins || 5} mins</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 4px;">Wait Time: ${station.predicted_waiting_time_mins || 0} mins</div>
        <span style="font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 12px; color: #fff; background: ${pinColor}; display: inline-block;">
          ${isReserved ? 'Reserved' : statusText}
        </span>
      </div>
    `;

    marker.addListener("click", () => {
      selectStation(station.id, false);
      if (state.infoWindow) {
        state.infoWindow.setContent(popupContent);
        state.infoWindow.open(state.map, marker);
      }
    });

    state.markers[station.id] = marker;
  });
}

function getFilteredStations() {
  return state.stations.filter(station => {
    const matchesSearch = station.name.toLowerCase().includes(state.filters.search.toLowerCase()) ||
      station.address.toLowerCase().includes(state.filters.search.toLowerCase());

    const matchesStatus = state.filters.status === 'all' || station.status === state.filters.status;

    let matchesType = true;
    if (state.filters.type !== 'all') {
      matchesType = station.type === state.filters.type;
    }

    return matchesSearch && matchesStatus && matchesType;
  });
}

function renderStatsFromRecommendation(data) {
  document.getElementById("stat-total").textContent = data.reachable_count || 0;
  
  const availCount = (data.ranked_alternatives || []).reduce((acc, s) => acc + (s.availablePlugs || 0), 0);
  document.getElementById("stat-available").textContent = availCount;

  const topWait = data.recommended_station ? `${data.recommended_station.predicted_waiting_time_mins} min` : "0 min";
  document.getElementById("stat-inuse").textContent = topWait;

  document.getElementById("stat-offline").textContent = data.unreachable_count || 0;
}

function renderStats() {
  const total = state.stations.length;
  const available = state.stations.filter(s => s.status === 'available').length;
  const inUse = state.stations.filter(s => s.status === 'charging').length;
  const offline = state.stations.filter(s => s.status === 'offline').length;

  document.getElementById("stat-total").textContent = total;
  document.getElementById("stat-available").textContent = available;
  document.getElementById("stat-inuse").textContent = inUse;
  document.getElementById("stat-offline").textContent = offline;
}

function renderStationsList() {
  const listContainer = document.getElementById("stations-list");
  const filtered = getFilteredStations();

  if (filtered.length === 0) {
    listContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 2rem;">
        No stations found matching filters or within safe range.
      </div>
    `;
    return;
  }

  listContainer.innerHTML = filtered.map(station => {
    const isSelected = state.selectedStationId === station.id ? 'active' : '';
    const statusText = station.status === 'available' ? 'Available' : station.status === 'charging' ? 'In Use' : 'Offline';
    const isReserved = !!state.userReservations[station.id];

    let actionBtnHtml = '';
    if (station.status === 'available') {
      if (isReserved) {
        actionBtnHtml = `<button class="btn-card-action btn-outline" onclick="cancelReservation(event, ${station.id})">Cancel</button>`;
      } else {
        actionBtnHtml = `<button class="btn-card-action primary" onclick="bookStation(event, ${station.id})">Reserve</button>`;
      }
    } else if (station.status === 'charging') {
      actionBtnHtml = `<span style="font-size: 0.75rem; color: var(--warning); font-weight: 500;">Busy</span>`;
    } else {
      actionBtnHtml = `<span style="font-size: 0.75rem; color: var(--danger); font-weight: 500;">Maintenance</span>`;
    }

    let scoreBadge = '';
    if (station.composite_score) {
      scoreBadge = `<span style="font-size: 0.75rem; font-weight: 700; color: #38bdf8; background: rgba(6,182,212,0.15); padding: 2px 7px; border-radius: 6px;">Score: ${station.composite_score}</span>`;
    }

    return `
      <div class="station-card ${isSelected}" id="station-card-${station.id}" onclick="selectStation(${station.id}, true)">
        <div class="station-card-header">
          <div class="station-title">
            ${station.rank ? `<span style="color: #94a3b8; font-size: 0.85rem; margin-right: 4px;">#${station.rank}</span>` : ''}
            ${station.name}
          </div>
          <span class="status-badge ${station.status}">
            <span class="status-dot"></span>
            ${isReserved ? 'Reserved' : statusText}
          </span>
        </div>
        <div class="station-address">${station.address}</div>
        <div class="station-details">
          <div class="detail-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 11V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"></path><line x1="10" y1="12" x2="10" y2="12.01"></line><path d="M10 8h.01"></path><path d="M10 16h.01"></path><path d="M14 8h.01"></path><path d="M14 12h.01"></path><path d="M14 16h.01"></path><path d="M18 15h3a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z"></path></svg>
            <span>${station.availablePlugs}/${station.totalPlugs} Plugs</span>
          </div>
          <div class="detail-item">
            <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
            <span>${station.speed} kW (${station.connector})</span>
          </div>
          <div class="detail-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            <span>~${station.estimated_travel_time_mins || 5} min drive (${station.route_distance_km || station.distance_km || 1} km)</span>
          </div>
        </div>
        ${station.rank_explanation ? `<div style="font-size: 0.75rem; color: #94a3b8; margin: 4px 0 6px 0; font-style: italic;">${station.rank_explanation}</div>` : ''}
        <div class="station-actions">
          ${scoreBadge}
          ${actionBtnHtml}
        </div>
      </div>
    `;
  }).join('');
}

function selectStation(stationId, panMap = true) {
  if (state.selectedStationId) {
    const oldCard = document.getElementById(`station-card-${state.selectedStationId}`);
    if (oldCard) oldCard.classList.remove("active");
  }

  state.selectedStationId = stationId;
  const newCard = document.getElementById(`station-card-${stationId}`);
  if (newCard) {
    newCard.classList.add("active");
    newCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const station = state.stations.find(s => s.id === stationId);
  const marker = state.markers[stationId];

  if (station && marker && state.map) {
    let pinColor = "#06b6d4";
    if (station.status === "charging") pinColor = "#f59e0b";
    if (station.status === "offline") pinColor = "#ef4444";
    if (station.rank === 1) pinColor = "#10b981";

    const isReserved = !!state.userReservations[station.id];
    const statusText = station.status === 'available' ? 'Available' : station.status === 'charging' ? 'In Use' : 'Offline';

    const popupContent = `
      <div style="padding: 6px; max-width: 230px; font-family: 'Outfit', sans-serif;">
        <div style="font-weight: 700; font-size: 0.95rem; color: #0f172a; margin-bottom: 2px;">${station.name}</div>
        <div style="font-size: 0.8rem; color: #475569; margin-bottom: 4px;">${station.address}</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 2px;"><strong>${station.type}</strong> (${station.speed} kW)</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 4px;">Connector: ${station.connector}</div>
        <span style="font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 12px; color: #fff; background: ${pinColor}; display: inline-block;">
          ${isReserved ? 'Reserved' : statusText}
        </span>
      </div>
    `;

    if (state.infoWindow) {
      state.infoWindow.setContent(popupContent);
      state.infoWindow.open(state.map, marker);
    }

    if (panMap) {
      state.map.panTo({ lat: parseFloat(station.lat), lng: parseFloat(station.lng) });
      state.map.setZoom(14);
    }
  }
}

// -------------------------------------------------------------
// FEATURE 8: Booking Simulation & Reward Allocation
// -------------------------------------------------------------
async function bookStation(event, stationId) {
  event.stopPropagation();

  if (!state.currentUser) {
    showToast("Please sign in to reserve slots and earn incentive points.", "error");
    toggleModal("login-modal", true);
    return;
  }

  const station = state.stations.find(s => s.id === stationId);
  if (!station || station.status !== 'available') return;

  showToast(`Reserving slot at ${station.name}...`, "info");

  setTimeout(async () => {
    station.availablePlugs = Math.max(0, station.availablePlugs - 1);
    state.userReservations[stationId] = Date.now() + (15 * 60 * 1000);

    // Record reward transaction if eligible
    const reward = state.recommendationData?.reward_incentive;
    if (reward && reward.eligible && reward.points > 0 && station.rank === 1) {
      try {
        const token = "TOKEN_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        state.claimedRewards[stationId] = token;
        showToast(`Slot reserved! +${reward.points} estimated incentive points queued for session completion.`, "success");
        initRewardsSummary();
      } catch (e) {
        console.error("Reward error", e);
      }
    } else {
      showToast(`Slot reserved successfully at ${station.name}! Window: 15 minutes.`, "success");
    }

    if (state.mode === 'recommendation' && state.recommendationData) {
      renderStatsFromRecommendation(state.recommendationData);
    } else {
      renderStats();
    }
    renderStationsList();
    renderMapMarkers();
    selectStation(stationId, false);
  }, 600);
}

function cancelReservation(event, stationId) {
  event.stopPropagation();
  const station = state.stations.find(s => s.id === stationId);
  if (!station) return;

  delete state.userReservations[stationId];
  station.availablePlugs += 1;

  showToast(`Reservation at ${station.name} cancelled.`, "info");
  if (state.mode === 'recommendation' && state.recommendationData) {
    renderStatsFromRecommendation(state.recommendationData);
  } else {
    renderStats();
  }
  renderStationsList();
  renderMapMarkers();
  selectStation(stationId, false);
}

// -------------------------------------------------------------
// FEATURE 8: Rewards Summary
// -------------------------------------------------------------
async function initRewardsSummary() {
  try {
    const res = await fetch("/api/rewards/summary");
    if (res.ok) {
      const data = await res.json();
      state.userRewardsSummary = data;
      const pill = document.getElementById("header-points-pill");
      if (pill) {
        pill.textContent = `${data.verified_points} pts`;
      }
    }
  } catch (err) {
    console.error("Failed to load rewards summary", err);
  }
}

function renderRewardsModal() {
  const verifiedEl = document.getElementById("rewards-verified-val");
  const estimatedEl = document.getElementById("rewards-estimated-val");
  const historyList = document.getElementById("rewards-history-list");

  const s = state.userRewardsSummary;
  verifiedEl.textContent = s.verified_points || 0;
  estimatedEl.textContent = s.estimated_points || 0;

  if (!s.transactions || s.transactions.length === 0) {
    historyList.innerHTML = `<div style="text-align:center; color: var(--text-muted); padding: 1rem;">No reward transactions yet. Shift to less crowded stations to earn points!</div>`;
    return;
  }

  historyList.innerHTML = s.transactions.map(t => `
    <div class="reward-tx-item">
      <div>
        <div style="font-weight: 600; color: #f8fafc;">Station #${t.station_id} Divert</div>
        <div style="font-size: 0.72rem; color: #94a3b8;">Saved ${t.wait_time_saved_mins} mins wait &bull; ${new Date(t.created_at).toLocaleDateString()}</div>
      </div>
      <div style="text-align: right;">
        <span style="font-weight: 700; color: ${t.status === 'verified' ? '#34d399' : '#fbbf24'};">
          +${t.points_awarded} pts
        </span>
        <div style="font-size: 0.7rem; text-transform: uppercase; color: #94a3b8;">${t.status}</div>
      </div>
    </div>
  `).join('');
}

// -------------------------------------------------------------
// FEATURE 7: Min-Cost Flow Multi-Vehicle Allocation
// -------------------------------------------------------------
async function runFleetOptimization() {
  const container = document.getElementById("fleet-results-container");
  container.innerHTML = `<div style="text-align:center; color: var(--text-muted); padding: 1.5rem;">Executing Network Simplex Min-Cost Flow...</div>`;

  const sampleVehicles = [
    { vehicle_id: "EV-Alpha (Critical)", battery_percentage: 9, remaining_range_km: 14, lat: 37.7749, lng: -122.4194, connector_preference: "CCS" },
    { vehicle_id: "EV-Bravo (Moderate)", battery_percentage: 38, remaining_range_km: 75, lat: 37.7600, lng: -122.4200, connector_preference: "Tesla NACS" },
    { vehicle_id: "EV-Charlie (Low)", battery_percentage: 82, remaining_range_km: 260, lat: 37.7850, lng: -122.4050, connector_preference: "CCS" }
  ];

  try {
    const res = await fetch("/api/optimization/allocate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vehicles: sampleVehicles })
    });

    if (!res.ok) {
      container.innerHTML = `<div style="color: var(--danger); padding: 1rem;">Optimization failed to solve flow graph.</div>`;
      return;
    }

    const data = await res.json();
    let assignmentsHtml = data.assignments.map(a => `
      <div class="fleet-assignment-card ${a.vehicle_urgency === 'Critical' ? 'high-urgency' : 'low-urgency'}">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
          <strong>${a.vehicle_id}</strong>
          <span style="font-size: 0.75rem; padding: 2px 8px; border-radius: 9999px; background: rgba(255,255,255,0.06); font-weight: 600;">
            ${a.vehicle_urgency} Urgency
          </span>
        </div>
        <div style="font-size: 0.85rem; color: #38bdf8; font-weight: 600; margin-bottom: 2px;">
          &rarr; Assigned to: ${a.station_name}
        </div>
        <div style="font-size: 0.75rem; color: #94a3b8;">
          Drive Distance: ${a.route_distance_km} km (~${a.travel_time_mins} mins) &bull; Predicted Wait: ${a.predicted_wait_mins} mins &bull; Plug: ${a.station_connector}
        </div>
      </div>
    `).join('');

    let unassignedHtml = '';
    if (data.unassigned_vehicles && data.unassigned_vehicles.length > 0) {
      unassignedHtml = data.unassigned_vehicles.map(u => `
        <div class="fleet-assignment-card" style="border-left: 3px solid #ef4444;">
          <strong>${u.vehicle_id}</strong>: Unassigned (${u.reason})
        </div>
      `).join('');
    }

    container.innerHTML = `
      <div style="font-size: 0.85rem; color: #34d399; font-weight: 600; margin-bottom: 0.5rem;">
        ${data.explanation}
      </div>
      <div style="display: flex; flex-direction: column; gap: 0.6rem;">
        ${assignmentsHtml}
        ${unassignedHtml}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div style="color: var(--danger);">Communication error running optimization.</div>`;
  }
}

// -------------------------------------------------------------
// Event Listeners Setup
// -------------------------------------------------------------
function setupEventListeners() {
  // Battery % slider & number input synchronization
  const batterySlider = document.getElementById("input-battery-pct");
  const batteryLbl = document.getElementById("lbl-battery-pct");
  const rangeInput = document.getElementById("input-range-km");
  const capacityInput = document.getElementById("input-capacity-kwh");
  const effInput = document.getElementById("input-efficiency");
  const safetySlider = document.getElementById("input-safety-margin");
  const safetyLbl = document.getElementById("lbl-safety-margin");
  const connectorSelect = document.getElementById("select-connector");

  batterySlider.addEventListener("input", (e) => {
    state.ev.batteryPct = parseFloat(e.target.value);
    batteryLbl.textContent = `${state.ev.batteryPct}%`;

    // Auto-update estimated range if capacity and efficiency exist
    const cap = parseFloat(capacityInput.value) || 60;
    const eff = parseFloat(effInput.value) || 5.5;
    const estimatedKm = Math.round((state.ev.batteryPct / 100.0) * cap * eff);
    rangeInput.value = estimatedKm;
    state.ev.remainingRangeKm = estimatedKm;
    updateSafeRangeDisplay();
  });

  rangeInput.addEventListener("input", (e) => {
    state.ev.remainingRangeKm = parseFloat(e.target.value) || 1;
    updateSafeRangeDisplay();
  });

  safetySlider.addEventListener("input", (e) => {
    state.ev.safetyMarginPct = parseFloat(e.target.value);
    safetyLbl.textContent = `${state.ev.safetyMarginPct}%`;
    updateSafeRangeDisplay();
  });

  capacityInput.addEventListener("input", (e) => {
    state.ev.batteryCapacityKwh = parseFloat(e.target.value) || 60;
  });

  effInput.addEventListener("input", (e) => {
    state.ev.efficiency = parseFloat(e.target.value) || 5.5;
  });

  connectorSelect.addEventListener("change", (e) => {
    state.ev.connector = e.target.value;
  });

  // Recommendation compute button
  document.getElementById("btn-run-recommendation").addEventListener("click", () => {
    state.mode = 'recommendation';
    fetchRecommendations();
  });

  // Top Nav mode toggles
  document.getElementById("nav-mode-recommend").addEventListener("click", (e) => {
    e.preventDefault();
    state.mode = 'recommendation';
    document.getElementById("nav-mode-recommend").classList.add("active");
    document.getElementById("nav-mode-discovery").classList.remove("active");
    fetchRecommendations();
  });

  document.getElementById("nav-mode-discovery").addEventListener("click", (e) => {
    e.preventDefault();
    state.mode = 'discovery';
    document.getElementById("nav-mode-discovery").classList.add("active");
    document.getElementById("nav-mode-recommend").classList.remove("active");
    fetchAllStations(state.ev.lat, state.ev.lng);
  });

  document.getElementById("nav-btn-fleet").addEventListener("click", (e) => {
    e.preventDefault();
    toggleModal("fleet-modal", true);
    runFleetOptimization();
  });

  document.getElementById("nav-btn-rewards").addEventListener("click", (e) => {
    e.preventDefault();
    toggleModal("rewards-modal", true);
    renderRewardsModal();
  });

  document.getElementById("btn-run-fleet-optimization").addEventListener("click", runFleetOptimization);
  document.getElementById("btn-reset-fleet-demo").addEventListener("click", runFleetOptimization);

  // Search Input
  document.getElementById("search-input").addEventListener("input", (e) => {
    state.filters.search = e.target.value;
    renderStationsList();
    renderMapMarkers();
  });

  // Status Filter Chips
  const statusChips = document.querySelectorAll("#status-filters .chip");
  statusChips.forEach(chip => {
    chip.addEventListener("click", () => {
      statusChips.forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      state.filters.status = chip.dataset.status;
      renderStationsList();
      renderMapMarkers();
    });
  });

  // Type Filter Chips
  const typeChips = document.querySelectorAll("#type-filters .chip");
  typeChips.forEach(chip => {
    chip.addEventListener("click", () => {
      typeChips.forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      state.filters.type = chip.dataset.type;
      renderStationsList();
      renderMapMarkers();
    });
  });

  // Modals close button
  document.querySelectorAll(".modal-close").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const modal = e.target.closest(".modal-overlay");
      toggleModal(modal.id, false);
    });
  });

  // Close modals when clicking outside
  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        toggleModal(overlay.id, false);
      }
    });
  });

  // Close buttons for custom modals
  document.getElementById("btn-close-fleet").addEventListener("click", () => toggleModal("fleet-modal", false));
  document.getElementById("btn-close-rewards").addEventListener("click", () => toggleModal("rewards-modal", false));

  // Sign In Form submission
  const loginForm = document.getElementById("login-form");
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value;
    const password = document.getElementById("login-password").value;
    const msgDiv = loginForm.querySelector(".form-message");
    msgDiv.style.display = "none";

    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (res.ok) {
        showToast("Login successful!", "success");
        setAuthenticatedUser(data.user);
        toggleModal("login-modal", false);
        initRewardsSummary();
      } else {
        msgDiv.className = "form-message error";
        msgDiv.style.display = "block";
        msgDiv.textContent = data.message || "Invalid credentials";
      }
    } catch (err) {
      msgDiv.className = "form-message error";
      msgDiv.style.display = "block";
      msgDiv.textContent = "Server communication error";
    }
  });

  // Registration Form submission
  const registerForm = document.getElementById("register-form");
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("register-username").value;
    const email = document.getElementById("register-email").value;
    const password = document.getElementById("register-password").value;
    const msgDiv = registerForm.querySelector(".form-message");
    msgDiv.style.display = "none";

    try {
      const res = await fetch("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password })
      });
      const data = await res.json();
      if (res.ok) {
        showToast("Registration successful! Please log in.", "success");
        toggleModal("register-modal", false);
        document.getElementById("login-email").value = email;
        toggleModal("login-modal", true);
      } else {
        msgDiv.className = "form-message error";
        msgDiv.style.display = "block";
        msgDiv.textContent = data.message || "Registration failed";
      }
    } catch (err) {
      msgDiv.className = "form-message error";
      msgDiv.style.display = "block";
      msgDiv.textContent = "Server communication error";
    }
  });

  // Switch links inside modals
  document.getElementById("switch-to-register").addEventListener("click", (e) => {
    e.preventDefault();
    toggleModal("login-modal", false);
    toggleModal("register-modal", true);
  });

  document.getElementById("switch-to-login").addEventListener("click", (e) => {
    e.preventDefault();
    toggleModal("register-modal", false);
    toggleModal("login-modal", true);
  });
}
