/* static/js/app.js */

// Global App State
const state = {
  currentUser: null,
  selectedStationId: null,
  filters: {
    search: '',
    status: 'all',
    type: 'all'
  },
  stations: [], // Data will be fetched from the backend dynamically
  userReservations: {}, // Keep track of simulated client-side reservations: { stationId: expiresTimestamp }
  map: null,
  infoWindow: null,
  markers: {} // Map station.id -> google.maps.Marker
};

// Initialize App
document.addEventListener("DOMContentLoaded", () => {
  initAuth();
  initMap();

  if ("geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        if (state.map) {
          state.map.setCenter({ lat: parseFloat(lat), lng: parseFloat(lng) });
        }
        fetchStations(lat, lng);
      },
      (error) => {
        console.warn("Geolocation denied or error. Using default location.", error);
        fetchStations(37.7749, -122.4194);
      }
    );
  } else {
    fetchStations(37.7749, -122.4194);
  }

  setupEventListeners();
});

async function fetchStations(lat, lng) {
  try {
    const response = await fetch(`/api/stations?lat=${lat}&lng=${lng}`);
    if (response.ok) {
      const data = await response.json();
      state.stations = data;
      renderStats();
      renderStationsList();
      renderMapMarkers();
    } else {
      showToast("Failed to fetch charging stations.", "error");
    }
  } catch (error) {
    console.error("Error fetching stations:", error);
    showToast("Network error fetching stations.", "error");
  }
}

// Toast System
function showToast(message, type = 'info') {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  // Custom icons based on type
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

  // Slide out and remove after 4 seconds
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
    const res = await fetch("/me");
    if (res.ok) {
      const user = await res.json();
      setAuthenticatedUser(user);
    } else {
      setAuthenticatedUser(null);
    }
  } catch (err) {
    console.error("Auth check failed:", err);
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
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
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

      // Clear reservations from state (or reset booking buttons)
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

// Google Maps Integration
function initMap() {
  if (typeof google === 'undefined' || !google.maps) {
    console.warn("Google Maps API not loaded yet.");
    return;
  }

  const defaultLocation = { lat: 37.7749, lng: -122.4194 };

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

    const marker = new google.maps.Marker({
      position: { lat: parseFloat(station.lat), lng: parseFloat(station.lng) },
      map: state.map,
      title: station.name,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 9,
        fillColor: pinColor,
        fillOpacity: 1,
        strokeWeight: 2,
        strokeColor: "#ffffff"
      }
    });

    const isReserved = !!state.userReservations[station.id];
    const statusText = station.status === 'available' ? 'Available' : station.status === 'charging' ? 'In Use' : 'Offline';

    const popupContent = `
      <div style="padding: 6px; max-width: 220px; font-family: 'Outfit', sans-serif;">
        <div style="font-weight: 700; font-size: 0.95rem; color: #0f172a; margin-bottom: 2px;">${station.name}</div>
        <div style="font-size: 0.8rem; color: #475569; margin-bottom: 4px;">${station.address}</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 2px;"><strong>${station.type}</strong> (${station.speed} kW)</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 4px;">Connector: ${station.connector}</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 6px;">Price: $${station.price.toFixed(2)}/kWh</div>
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

// Sidebar Stations List Rendering
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
        No stations found matching filters.
      </div>
    `;
    return;
  }

  listContainer.innerHTML = filtered.map(station => {
    const isSelected = state.selectedStationId === station.id ? 'active' : '';
    const statusText = station.status === 'available' ? 'Available' : station.status === 'charging' ? 'In Use' : 'Offline';

    // Simulated action button
    let actionBtnHtml = '';
    const isReserved = !!state.userReservations[station.id];

    if (station.status === 'available') {
      if (isReserved) {
        actionBtnHtml = `<button class="btn-card-action btn-outline" onclick="cancelReservation(event, ${station.id})">Cancel</button>`;
      } else {
        actionBtnHtml = `<button class="btn-card-action primary" onclick="bookStation(event, ${station.id})">Reserve</button>`;
      }
    } else if (station.status === 'charging') {
      actionBtnHtml = `<span style="font-size: 0.75rem; color: var(--warning); font-weight: 500;">Busy charging</span>`;
    } else {
      actionBtnHtml = `<span style="font-size: 0.75rem; color: var(--danger); font-weight: 500;">Maintenance</span>`;
    }

    return `
      <div class="station-card ${isSelected}" id="station-card-${station.id}" onclick="selectStation(${station.id}, true)">
        <div class="station-card-header">
          <div class="station-title">${station.name}</div>
          <span class="status-badge ${station.status}">
            <span class="status-dot"></span>
            ${isReserved ? 'Reserved' : statusText}
          </span>
        </div>
        <div class="station-address">${station.address}</div>
        <div class="station-details">
          <div class="detail-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"></path><line x1="10" y1="12" x2="10" y2="12.01"></line><path d="M10 8h.01"></path><path d="M10 16h.01"></path><path d="M14 8h.01"></path><path d="M14 12h.01"></path><path d="M14 16h.01"></path><path d="M18 15h3a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z"></path></svg>
            <span>${station.availablePlugs}/${station.totalPlugs} Plugs</span>
          </div>
          <div class="detail-item">
            <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
            <span>${station.speed} kW ${station.type}</span>
          </div>
          <div class="detail-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
            <span>$${station.price.toFixed(2)}/kWh</span>
          </div>
        </div>
        <div class="station-actions">
          ${actionBtnHtml}
        </div>
      </div>
    `;
  }).join('');
}

// Select a Station
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

    const isReserved = !!state.userReservations[station.id];
    const statusText = station.status === 'available' ? 'Available' : station.status === 'charging' ? 'In Use' : 'Offline';

    const popupContent = `
      <div style="padding: 6px; max-width: 220px; font-family: 'Outfit', sans-serif;">
        <div style="font-weight: 700; font-size: 0.95rem; color: #0f172a; margin-bottom: 2px;">${station.name}</div>
        <div style="font-size: 0.8rem; color: #475569; margin-bottom: 4px;">${station.address}</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 2px;"><strong>${station.type}</strong> (${station.speed} kW)</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 4px;">Connector: ${station.connector}</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 6px;">Price: $${station.price.toFixed(2)}/kWh</div>
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

// Booking Simulation
function bookStation(event, stationId) {
  event.stopPropagation(); // Avoid selecting card on button click

  if (!state.currentUser) {
    showToast("Please log in to reserve a charging station.", "error");
    toggleModal("login-modal", true);
    return;
  }

  const station = state.stations.find(s => s.id === stationId);
  if (!station || station.status !== 'available') return;

  showToast(`Reserving slot at ${station.name}...`, "info");

  setTimeout(() => {
    // Simulate API reserve
    station.availablePlugs -= 1;
    state.userReservations[stationId] = Date.now() + (15 * 60 * 1000); // 15 mins reservation window

    showToast(`Slot reserved successfully! You have 15 minutes to arrive.`, "success");

    renderStats();
    renderStationsList();
    renderMapMarkers();

    // Keep active card selected
    selectStation(stationId, false);
  }, 800);
}

function cancelReservation(event, stationId) {
  event.stopPropagation();

  const station = state.stations.find(s => s.id === stationId);
  if (!station) return;

  delete state.userReservations[stationId];
  station.availablePlugs += 1;

  showToast(`Reservation at ${station.name} cancelled.`, "info");

  renderStats();
  renderStationsList();
  renderMapMarkers();
  selectStation(stationId, false);
}

// Filters & Event Listeners setup
function setupEventListeners() {
  // Search Input
  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", (e) => {
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
      } else {
        msgDiv.className = "form-message error";
        msgDiv.textContent = data.message || "Invalid credentials";
      }
    } catch (err) {
      msgDiv.className = "form-message error";
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
        // Autofill login email and open login modal
        document.getElementById("login-email").value = email;
        toggleModal("login-modal", true);
      } else {
        msgDiv.className = "form-message error";
        msgDiv.textContent = data.message || "Registration failed";
      }
    } catch (err) {
      msgDiv.className = "form-message error";
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
