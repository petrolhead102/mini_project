/* static/js/app.js */

// Global App State
const state = {
  currentUser: null,
  vehicleProfile: null,
  pendingVehicleProfileOpen: false,
  selectedStationId: null,
  filters: {
    search: '',
    status: 'all',
    type: 'all'
  },
  stations: [], // Data will be fetched from the backend dynamically
  userReservations: {}, // Keep track of simulated client-side reservations: { stationId: expiresTimestamp }
  pendingReservations: {},
  confirmingReservationStationId: null,
  pendingReservationDecision: null,
  pendingTripReward: null,
  rewardPoints: 0,
  completedTripKeys: {},
  map: null,
  infoWindow: null,
  currentLocation: null,
  currentLocationLabel: "your location",
  stationsLoaded: false,
  userLocationMarker: null,
  markers: {}, // Map station.id -> google.maps.Marker
  rangeCircle: null,
  routePolylines: [],
  rangeRoutePolylines: [],
  routeCache: new Map(),
  routeRequestId: 0,
  tripAnimationFrame: null,
  tripMarker: null,
  tripPolyline: null,
  activeTripStationId: null,
  algorithmDemoActive: false,
  algorithmDemoRankedCount: 0
};

// Initialize App
document.addEventListener("DOMContentLoaded", () => {
  initAuth();
  initMap();
  setupEventListeners();
  renderStationsList();
});

async function fetchStations(lat, lng) {
  state.stationsLoaded = false;
  state.stations = [];
  renderStats();
  renderStationsList();
  renderMapMarkers();

  try {
    const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
    const response = await fetch(`/api/stations?${params}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Failed to fetch charging stations.");
    }

    state.stations = data;
    state.stationsLoaded = true;
    renderStats();
    renderStationsList();
    renderMapMarkers();
    updateLocationStatus();
  } catch (error) {
    console.error("Error fetching stations:", error);
    state.stationsLoaded = true;
    document.getElementById("location-status").textContent = error.message;
    renderStationsList();
    showToast(error.message || "Network error fetching stations.", "error");
  }
}

function locateUser() {
  const button = document.getElementById("locate-me-btn");
  const status = document.getElementById("location-status");

  if (!navigator.geolocation) {
    status.textContent = "Location is not supported by this browser.";
    return;
  }

  button.disabled = true;
  status.textContent = "Requesting your location...";

  navigator.geolocation.getCurrentPosition(async ({ coords }) => {
    if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
      status.textContent = "Your browser returned an invalid location. Search for Coimbatore or try again.";
      button.disabled = false;
      return;
    }

    const location = { lat: coords.latitude, lng: coords.longitude };
    await showLocation(location, "your location");
    if (Number.isFinite(coords.accuracy) && coords.accuracy > 5000) {
      const accuracyKm = (coords.accuracy / 1000).toFixed(1);
      status.textContent += ` Browser location accuracy is about ${accuracyKm} km; search for Coimbatore if the pin is misplaced.`;
    }
    button.disabled = false;
  }, error => {
    const messages = {
      1: "Location access was denied. Allow it in your browser's site settings, then try again.",
      2: "Your location could not be determined. Check that location services are enabled.",
      3: "The location request timed out. Try again."
    };

    status.textContent = messages[error.code] || "Could not access your location. Try again.";
    button.disabled = false;
  }, {
    enableHighAccuracy: true,
    timeout: 30000,
    maximumAge: 0
  });
}

async function showLocation(location, label) {
  clearDrivingRoute();
  state.currentLocation = location;
  state.currentLocationLabel = label;
  state.stationsLoaded = false;
  document.querySelector(".location-picker").classList.add("has-location");

  if (state.map) {
    state.map.setCenter(location);
    state.map.setZoom(14);

    if (state.userLocationMarker) {
      state.userLocationMarker.setPosition(location);
      state.userLocationMarker.setTitle(label === "your location" ? "Your location" : label);
    } else {
      state.userLocationMarker = new google.maps.Marker({
        map: state.map,
        position: location,
        title: label === "your location" ? "Your location" : label,
        zIndex: google.maps.Marker.MAX_ZINDEX + 1,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 9,
          fillColor: "#2563eb",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 3
        }
      });
    }
  }

  document.getElementById("location-status").textContent =
    `Searching for charging stations near ${label}...`;
  await fetchStations(location.lat, location.lng);
}

async function setupLocationSearch() {
  const container = document.getElementById("location-autocomplete");
  const status = document.getElementById("location-status");

  try {
    const { PlaceAutocompleteElement } = await google.maps.importLibrary("places");
    const autocomplete = new PlaceAutocompleteElement();
    autocomplete.placeholder = "Search for a city or address...";
    autocomplete.classList.add("place-autocomplete");
    container.replaceChildren(autocomplete);

    autocomplete.addEventListener("gmp-select", async ({ placePrediction }) => {
      try {
        const place = placePrediction.toPlace();
        await place.fetchFields({
          fields: ["location", "formattedAddress", "displayName"]
        });

        if (!place.location) {
          status.textContent = "That place has no searchable map location.";
          return;
        }

        const location = {
          lat: place.location.lat(),
          lng: place.location.lng()
        };
        const label = place.formattedAddress || place.displayName?.text || "selected area";
        await showLocation(location, label);
      } catch (error) {
        console.error("Place search failed:", error);
        status.textContent = "Could not search that place. Try selecting it again.";
      }
    });
  } catch (error) {
    console.error("Place search setup failed:", error);
    status.textContent = "Location search is unavailable. Check the Google Places API configuration.";
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
      refreshVehicleProfile().catch(error => {
        console.error("Vehicle profile check failed:", error);
        showToast(error.message || "Could not check your EV profile.", "error");
      });
    } else {
      setAuthenticatedUser(null);
    }
  } catch (err) {
    console.error("Auth check failed:", err);
    setAuthenticatedUser(null);
  }
}

function setAuthenticatedUser(user) {
  if (!user || state.currentUser?.id !== user.id) {
    state.vehicleProfile = null;
    updateVehicleProfileStatus();
  }
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

function updateVehicleProfileStatus() {
  const status = document.getElementById("vehicle-profile-status");
  const vehicle = state.vehicleProfile;

  if (!vehicle) {
    status.textContent = state.currentUser ? "Vehicle not set up" : "Sign in to save";
    status.classList.remove("is-saved");
    status.title = status.textContent;
    return;
  }

  status.textContent = `${vehicle.connector_type} · ${vehicle.full_range_km} km`;
  status.classList.add("is-saved");
  status.title = `${vehicle.connector_type}, ${vehicle.battery_capacity_kwh} kWh battery, ${vehicle.current_battery_percent}% charge, ${vehicle.full_range_km} km range`;
}

function getEstimatedRangeKm() {
  const vehicle = state.vehicleProfile;
  if (!vehicle) return null;

  return Number(vehicle.full_range_km) * Number(vehicle.current_battery_percent) / 100;
}

function getStationDistanceKm(station) {
  if (!state.currentLocation) return null;
  if (station.lat == null || station.lng == null) return null;

  const stationLat = Number(station.lat);
  const stationLng = Number(station.lng);
  if (!Number.isFinite(stationLat) || !Number.isFinite(stationLng)) return null;

  const toRadians = degrees => degrees * Math.PI / 180;
  const latDifference = toRadians(stationLat - state.currentLocation.lat);
  const lngDifference = toRadians(stationLng - state.currentLocation.lng);
  const startLat = toRadians(state.currentLocation.lat);
  const endLat = toRadians(stationLat);
  const haversine = Math.sin(latDifference / 2) ** 2 +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(lngDifference / 2) ** 2;

  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function isStationWithinEstimatedRange(station) {
  const rangeKm = getEstimatedRangeKm();
  const distanceKm = getStationDistanceKm(station);

  return rangeKm !== null && Number.isFinite(rangeKm) &&
    distanceKm !== null && distanceKm <= rangeKm;
}

function getStationCongestion(station) {
  const totalPlugs = Number(station.totalPlugs);
  const availablePlugs = Number(station.availablePlugs);
  if (station.totalPlugs == null || station.availablePlugs == null ||
      !Number.isFinite(totalPlugs) || totalPlugs <= 0 || !Number.isFinite(availablePlugs)) {
    return { level: "unknown", label: "Congestion unavailable", details: "Plug availability was not provided" };
  }

  const openPlugs = Math.max(0, Math.min(totalPlugs, availablePlugs));
  if (station.status === "offline") {
    return { level: "offline", label: "Station offline", details: `${openPlugs}/${totalPlugs} plugs open` };
  }

  const occupiedPercent = Math.round((1 - openPlugs / totalPlugs) * 100);
  const level = occupiedPercent >= 75 ? "high" : occupiedPercent >= 40 ? "moderate" : "low";
  const label = level === "high" ? "High congestion" : level === "moderate" ? "Moderate congestion" : "Low congestion";
  return { level, label, details: `${openPlugs}/${totalPlugs} plugs open · ${occupiedPercent}% occupied` };
}

function getStationPriorityScore(station) {
  return getStationPriorityBreakdown(station)?.score ?? null;
}

function getStationPriorityBreakdown(station) {
  const rangeKm = getEstimatedRangeKm();
  const distanceKm = getStationDistanceKm(station);
  if (rangeKm === null || !Number.isFinite(rangeKm) || rangeKm <= 0 ||
      distanceKm === null || distanceKm > rangeKm) return null;

  const distanceScore = Math.max(0, 1 - distanceKm / rangeKm) * 100;
  const totalPlugs = Number(station.totalPlugs) || 0;
  const availablePlugs = Number(station.availablePlugs) || 0;
  const availabilityScore = station.status === "available" && totalPlugs > 0
    ? Math.min(1, availablePlugs / totalPlugs) * 100
    : 0;
  const speedScore = Math.max(0, Math.min(100, (Number(station.speed) || 0) / 250 * 100));
  const rating = Number(station.rating);
  const ratingScore = Number.isFinite(rating) ? Math.max(0, Math.min(100, rating / 5 * 100)) : 50;
  const weightedDistance = distanceScore * 0.4;
  const weightedAvailability = availabilityScore * 0.3;
  const weightedSpeed = speedScore * 0.2;
  const weightedRating = ratingScore * 0.1;
  const score = Math.round(weightedDistance + weightedAvailability + weightedSpeed + weightedRating);
  return {
    rangeKm,
    distanceKm,
    distanceScore,
    totalPlugs,
    availablePlugs,
    availabilityScore,
    speed: Number(station.speed) || 0,
    speedScore,
    rating,
    ratingScore,
    weightedDistance,
    weightedAvailability,
    weightedSpeed,
    weightedRating,
    score
  };
}

function isStationReservable(station) {
  return station.status === "available" && Number(station.availablePlugs) > 0 &&
    !state.userReservations[station.id] && !state.pendingReservations[station.id];
}

function getTopPriorityStations() {
  return getRankedReservableStations(getFilteredStations()).slice(0, 3);
}

function getRankedReservableStations(stations) {
  return stations
    .filter(station => isStationReservable(station) && isStationWithinEstimatedRange(station) &&
      station.lat != null && station.lng != null)
    .sort((first, second) => {
      const scoreDifference = getStationPriorityScore(second) - getStationPriorityScore(first);
      return scoreDifference || getStationDistanceKm(first) - getStationDistanceKm(second);
    });
}

function formatDistance(distanceKm) {
  if (distanceKm < 10) return `${distanceKm.toFixed(1)} km`;
  return `${Math.round(distanceKm)} km`;
}

function formatINR(amount) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(amount) || 0);
}

function formatCalculationNumber(value, digits = 1) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";
}

function getAlgorithmCalculationRows(station, rankedStations) {
  const breakdown = getStationPriorityBreakdown(station);
  if (!breakdown) return [];

  const vehicle = state.vehicleProfile;
  const fullRange = Number(vehicle?.full_range_km) || 0;
  const batteryPercent = Number(vehicle?.current_battery_percent) || 0;
  const totalPlugs = Math.max(1, Number(station.totalPlugs) || 1);
  const openPlugs = Math.max(0, Math.min(totalPlugs, Number(station.availablePlugs) || 0));
  const openPlugPercent = openPlugs / totalPlugs * 100;
  const occupiedPercent = (totalPlugs - openPlugs) / totalPlugs * 100;
  const congestion = getStationCongestion(station);
  const rank = rankedStations.findIndex(option => option.id === station.id) + 1;
  const stationKey = station.place_id || `station-${station.id}`;
  const rewardEligible = rank > 0 && rank <= 3 && !state.completedTripKeys[stationKey];
  const points = rewardEligible
    ? Math.round(8 + breakdown.score * 0.35 + Math.round(openPlugPercent) * 0.12)
    : 0;

  return [
    {
      label: "01 · Estimated usable range",
      value: `${formatCalculationNumber(fullRange, 0)} km × ${formatCalculationNumber(batteryPercent, 0)}% ÷ 100 = ${formatCalculationNumber(breakdown.rangeKm)} km`
    },
    {
      label: "02 · Reachability and distance factor",
      value: `${formatCalculationNumber(breakdown.distanceKm)} km ≤ ${formatCalculationNumber(breakdown.rangeKm)} km → reachable; max(0, 1 − ${formatCalculationNumber(breakdown.distanceKm)} ÷ ${formatCalculationNumber(breakdown.rangeKm)}) × 100 = ${formatCalculationNumber(breakdown.distanceScore)}`
    },
    {
      label: "03 · Available-plug factor",
      value: `min(1, ${formatCalculationNumber(breakdown.availablePlugs, 0)} ÷ ${formatCalculationNumber(breakdown.totalPlugs, 0)}) × 100 = ${formatCalculationNumber(breakdown.availabilityScore)}`
    },
    {
      label: "04 · Charger-speed factor",
      value: `min(100, ${formatCalculationNumber(breakdown.speed, 0)} ÷ 250 × 100) = ${formatCalculationNumber(breakdown.speedScore)}`
    },
    {
      label: "05 · Rating factor",
      value: Number.isFinite(breakdown.rating)
        ? `min(100, ${formatCalculationNumber(breakdown.rating, 1)} ÷ 5 × 100) = ${formatCalculationNumber(breakdown.ratingScore)}`
        : `No rating supplied → default ${formatCalculationNumber(breakdown.ratingScore)}`
    },
    {
      label: "06 · Weighted priority total",
      value: `(${formatCalculationNumber(breakdown.distanceScore)} × 0.40 = ${formatCalculationNumber(breakdown.weightedDistance)}) + (${formatCalculationNumber(breakdown.availabilityScore)} × 0.30 = ${formatCalculationNumber(breakdown.weightedAvailability)}) + (${formatCalculationNumber(breakdown.speedScore)} × 0.20 = ${formatCalculationNumber(breakdown.weightedSpeed)}) + (${formatCalculationNumber(breakdown.ratingScore)} × 0.10 = ${formatCalculationNumber(breakdown.weightedRating)}) → round = ${breakdown.score}/100`
    },
    {
      label: "07 · Congestion from plug counts",
      value: `(${formatCalculationNumber(totalPlugs, 0)} − ${formatCalculationNumber(openPlugs, 0)}) ÷ ${formatCalculationNumber(totalPlugs, 0)} × 100 = ${formatCalculationNumber(occupiedPercent)}% occupied · ${congestion.label}`
    },
    {
      label: "08 · Rank and potential cashback",
      value: rewardEligible
        ? `Rank #${rank}/${rankedStations.length}; round(8 + ${breakdown.score} × 0.35 + ${Math.round(openPlugPercent)} × 0.12) = ${points} points; ${points} × ₹0.04 = ${formatINR(points * 0.04)}`
        : rank > 3
          ? `Rank #${rank}/${rankedStations.length} is outside the top 3 → no cashback`
          : state.completedTripKeys[stationKey]
            ? "Cashback for this station was already claimed → no repeat reward"
            : "No eligible top-3 reservation → no cashback"
    }
  ];
}

function renderAlgorithmWorkedExample() {
  const status = document.getElementById("algorithm-example-status");
  const calculationList = document.getElementById("algorithm-example-calculations");
  if (!status || !calculationList) return;

  const rankedStations = getRankedReservableStations(state.stations);
  const station = rankedStations[0];
  if (!station) {
    status.textContent = "Choose a location, set up your EV range, and load at least one available station within range to see the calculations.";
    calculationList.hidden = true;
    calculationList.replaceChildren();
    return;
  }

  status.textContent = `Current top choice: ${station.name}. Values below use your live location, EV profile, station rating, charger speed, and reported plug counts.`;
  calculationList.innerHTML = getAlgorithmCalculationRows(station, rankedStations)
    .map(row => `<div class="algorithm-example-row"><strong>${row.label}</strong><span>${row.value}</span></div>`)
    .join("");
  calculationList.hidden = false;
}

function renderAlgorithmLiveTrace(station, rankedStations) {
  const panel = document.getElementById("algorithm-calculation-panel");
  const stationTitle = document.getElementById("algorithm-live-station");
  const steps = document.getElementById("algorithm-live-steps");
  if (!panel || !stationTitle || !steps) return;

  stationTitle.textContent = `Selected #1 · ${station.name}`;
  steps.innerHTML = getAlgorithmCalculationRows(station, rankedStations)
    .map((row, index) => `<div class="algorithm-live-step" data-step="${index}"><strong>${row.label}</strong><span>${row.value}</span></div>`)
    .join("");
  panel.hidden = false;
}

function setAlgorithmLiveTraceStep(stepIndex) {
  document.querySelectorAll("#algorithm-live-steps .algorithm-live-step").forEach((step, index) => {
    step.classList.toggle("is-current", index === stepIndex);
    step.classList.toggle("is-complete", index < stepIndex);
  });
}

function ensureRangeRecommendationPanel() {
  let container = document.getElementById("range-recommendation");
  if (container) return container;

  const stationList = document.getElementById("stations-list");
  if (!stationList || !stationList.parentElement) return null;

  container = document.createElement("section");
  container.id = "range-recommendation";
  container.className = "range-recommendation";
  container.setAttribute("aria-live", "polite");
  container.setAttribute("aria-label", "EV range recommendations");
  stationList.parentElement.insertBefore(container, stationList);
  return container;
}

function getNearestAvailableInRangeStation(rangeKm) {
  return getFilteredStations()
    .filter(station => isStationReservable(station) &&
      getStationDistanceKm(station) !== null && getStationDistanceKm(station) <= rangeKm)
    .sort((first, second) => getStationDistanceKm(first) - getStationDistanceKm(second))[0] || null;
}

function getLowerCongestionRewardOffer(rangeKm) {
  if (!state.currentLocation || !state.stationsLoaded) return null;

  const availableStations = getFilteredStations()
    .filter(station => isStationReservable(station) &&
      getStationDistanceKm(station) !== null && getStationDistanceKm(station) <= rangeKm)
    .sort((first, second) => getStationDistanceKm(first) - getStationDistanceKm(second));
  const nearest = availableStations[0];
  if (!nearest) return null;

  const nearestCapacity = Number(nearest.totalPlugs) || 0;
  if (!nearestCapacity) return null;
  const nearestOccupancy = 1 - Math.min(nearestCapacity, Number(nearest.availablePlugs) || 0) / nearestCapacity;

  const alternatives = availableStations.slice(1).map(station => {
    const capacity = Number(station.totalPlugs) || 0;
    const occupancy = capacity
      ? 1 - Math.min(capacity, Number(station.availablePlugs) || 0) / capacity
      : 1;
    return { station, occupancy };
  }).filter(option => option.occupancy <= nearestOccupancy - 0.2);

  alternatives.sort((first, second) =>
    first.occupancy - second.occupancy ||
    getStationDistanceKm(first.station) - getStationDistanceKm(second.station)
  );
  const alternative = alternatives[0];
  if (!alternative) return null;

  return { nearest, ...alternative };
}

function renderRangeRecommendation() {
  const container = ensureRangeRecommendationPanel();
  if (!container) return;
  const rangeKm = getEstimatedRangeKm();

  if (rangeKm === null || !Number.isFinite(rangeKm)) {
    container.classList.remove("has-urgency");
    container.innerHTML = `
      <div class="range-recommendation-copy">
        <strong class="range-recommendation-title">EV range recommendations</strong>
        <span>Set up My EV to see which nearby stations are within your estimated range.</span>
      </div>
      <button class="range-setup-button" type="button" id="btn-setup-vehicle">Set up My EV</button>
    `;
    return;
  }

  let message = "Choose a location to find stations within range.";
  if (state.currentLocation && !state.stationsLoaded) {
    message = "Checking nearby stations against your estimated range...";
  } else if (state.currentLocation && state.stationsLoaded) {
    const inRangeCount = getFilteredStations().filter(station => {
      const distance = getStationDistanceKm(station);
      return distance !== null && distance <= rangeKm;
    }).length;
    message = inRangeCount === 1
      ? "1 station in your results is within estimated range."
      : inRangeCount
        ? `${inRangeCount} stations in your results are within estimated range.`
        : "No stations in your results are within estimated range.";
  }

  const batteryPercent = Number(state.vehicleProfile?.current_battery_percent);
  const urgency = batteryPercent <= 10 || rangeKm <= 5
    ? "critical"
    : batteryPercent <= 20 || rangeKm <= 15
      ? "high"
      : batteryPercent <= 35
        ? "plan"
        : "normal";
  let urgencyHtml = "";
  if (urgency !== "normal") {
    let urgencyMessage = urgency === "critical"
      ? `Critical charge · ${batteryPercent}% battery. Find the nearest available station now.`
      : urgency === "high"
        ? `Low charge · ${batteryPercent}% battery. Plan a stop at a reachable station.`
        : `Charge planning · ${batteryPercent}% battery. Consider stopping soon.`;
    let actionHtml = "";

    if (urgency === "critical" || urgency === "high") {
      if (!state.currentLocation) {
        urgencyMessage += " Set your location to find a reachable station.";
        actionHtml = '<button class="urgency-action" type="button" id="btn-urgency-location">Set location</button>';
      } else if (!state.stationsLoaded) {
        urgencyMessage += " Checking nearby station availability…";
      } else {
        const nearestStation = getNearestAvailableInRangeStation(rangeKm);
        if (nearestStation) {
          urgencyMessage = `${urgencyMessage} Nearest available: ${nearestStation.name} · ${formatDistance(getStationDistanceKm(nearestStation))} straight-line.`;
          actionHtml = `<button class="urgency-action" type="button" id="btn-urgency-route" data-station-id="${nearestStation.id}">View route</button>`;
        } else {
          urgencyMessage += " No available station in your current results is within estimated range.";
        }
      }
    }

    urgencyHtml = `
      <div class="urgency-banner ${urgency}" role="status">
        <span class="urgency-indicator" aria-hidden="true"></span>
        <div class="urgency-copy">
          <strong>${urgency === "critical" ? "Immediate charging recommended" : urgency === "high" ? "High vehicle urgency" : "Plan your next charge"}</strong>
          <span>${urgencyMessage}</span>
        </div>
        ${actionHtml}
      </div>
    `;
  }

  let rewardOfferHtml = "";
  if ((urgency === "normal" || urgency === "plan") && state.currentLocation && state.stationsLoaded) {
    const offer = getLowerCongestionRewardOffer(rangeKm);
    if (offer) {
      rewardOfferHtml = `
        <div class="reward-offer" role="status">
          <div class="reward-offer-copy">
            <span class="reward-kicker">Lower-congestion alternative</span>
            <strong>Consider ${offer.station.name}</strong>
            <span>It has lower reported plug occupancy than the nearest option (${offer.nearest.name}). Reserve it and complete the trip; cashback depends on its top-3 priority and open plugs.</span>
          </div>
          <button class="reward-action" type="button" id="btn-reward-station" data-station-id="${offer.station.id}">View alternative</button>
        </div>
      `;
    }
  }

  container.innerHTML = `
    <div class="range-recommendation-copy">
      <div class="range-recommendation-heading">
        <span class="range-recommendation-label">Estimated range at current charge</span>
        <strong class="range-recommendation-value">${formatDistance(rangeKm)}</strong>
      </div>
      <span>${message}</span>
      <span class="range-recommendation-note" title="Distances are straight-line estimates; actual driving distance and range may differ.">Straight-line estimates; actual driving distance may differ.</span>
    </div>
    ${urgencyHtml}
    ${rewardOfferHtml}
  `;
  container.classList.toggle("has-urgency", urgency !== "normal" || !!rewardOfferHtml);
}

async function refreshVehicleProfile() {
  const response = await fetch("/api/vehicle-profile");
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Could not load your EV profile.");
  }

  state.vehicleProfile = data.vehicle;
  updateVehicleProfileStatus();
  renderStationsList();
  renderMapMarkers();
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

async function openVehicleProfile() {
  if (!state.currentUser) {
    state.pendingVehicleProfileOpen = true;
    showToast("Sign in to save an EV profile to your account.", "info");
    toggleModal("login-modal", true);
    return;
  }

  const errorMessage = document.getElementById("vehicle-error-msg");
  errorMessage.style.display = "none";
  const button = document.getElementById("nav-vehicle");
  button.disabled = true;

  try {
    const response = await fetch("/api/vehicle-profile");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || "Could not load your EV profile.");
    }

    const vehicle = data.vehicle;
    state.vehicleProfile = vehicle;
    updateVehicleProfileStatus();
    document.getElementById("vehicle-connector").value = vehicle?.connector_type || "";
    document.getElementById("vehicle-capacity").value = vehicle?.battery_capacity_kwh ?? "";
    document.getElementById("vehicle-battery").value = vehicle?.current_battery_percent ?? "";
    document.getElementById("vehicle-range").value = vehicle?.full_range_km ?? "";
    toggleModal("vehicle-modal", true);
  } catch (error) {
    console.error("Vehicle profile load failed:", error);
    showToast(error.message || "Could not load your EV profile.", "error");
  } finally {
    button.disabled = false;
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

  // Keep the initial map useful for this Tamil Nadu focused app until a location is chosen.
  const defaultLocation = { lat: 11.0168, lng: 76.9558 };

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

function clearDrivingRoute() {
  state.routeRequestId += 1;
  state.routePolylines.forEach(polyline => polyline.setMap(null));
  state.routePolylines = [];

  const summary = document.getElementById("map-route-summary");
  if (summary) summary.hidden = true;
}

function updateRangeCircle() {
  if (!state.map || !state.currentLocation || !state.vehicleProfile) {
    state.rangeCircle?.setMap(null);
    return;
  }

  const rangeKm = getEstimatedRangeKm();
  if (!Number.isFinite(rangeKm) || rangeKm <= 0) {
    state.rangeCircle?.setMap(null);
    return;
  }

  const options = {
    map: state.map,
    center: state.currentLocation,
    radius: rangeKm * 1000,
    strokeColor: "#a3e635",
    strokeOpacity: 0.9,
    strokeWeight: 2,
    fillColor: "#22d3ee",
    fillOpacity: 0.08,
    clickable: false,
    zIndex: 0
  };

  if (state.rangeCircle) {
    state.rangeCircle.setOptions(options);
  } else {
    state.rangeCircle = new google.maps.Circle(options);
  }
}

async function drawInRangeStationRoutes() {
  state.rangeRoutePolylines.forEach(polyline => polyline.setMap(null));
  state.rangeRoutePolylines = [];

  if (!state.currentLocation || !state.map || !state.vehicleProfile || !state.stationsLoaded) return;

  const stations = getFilteredStations().filter(station =>
    isStationWithinEstimatedRange(station) && station.lat != null && station.lng != null
  );
  if (!stations.length) return;

  const priorityRanks = new Map(getTopPriorityStations().map((station, index) => [station.id, index + 1]));

  const routeLines = new Map();
  stations.forEach(station => {
    const rank = priorityRanks.get(station.id);
    const color = rank ? ["#facc15", "#fb923c", "#f472b6"][rank - 1] : "#22d3ee";
    const line = new google.maps.Polyline({
      path: [
        state.currentLocation,
        { lat: Number(station.lat), lng: Number(station.lng) }
      ],
      map: state.map,
      strokeColor: color,
      strokeOpacity: rank ? 0.98 : 0.72,
      strokeWeight: rank ? 6 : 3,
      zIndex: rank ? 3 : 1,
      icons: [{
        icon: {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: rank ? 4 : 2.5,
          fillColor: color,
          fillOpacity: 1,
          strokeColor: "#0f172a",
          strokeWeight: 1
        },
        offset: "50%",
        repeat: rank ? "100px" : "150px"
      }]
    });
    routeLines.set(station.id, line);
  });
  state.rangeRoutePolylines = [...routeLines.values()];
  // These arrows intentionally use direct connectors. Requesting a road route
  // for every station on each redraw can exhaust the Routes API quota quickly.
}

function showDrivingRouteStatus(message, distance = "", details = "") {
  const summary = document.getElementById("map-route-summary");
  if (!summary) return;

  document.getElementById("map-route-distance").textContent = distance || message;
  document.getElementById("map-route-details").textContent = details;
  document.querySelector(".map-route-title").textContent = distance ? "Driving route" : "Route status";
  summary.classList.toggle("is-status", !distance);
  summary.hidden = false;
}

function formatRouteDuration(durationMillis) {
  const totalMinutes = Math.round(durationMillis / 60000);
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

async function drawDrivingRoute(station) {
  if (!state.currentLocation || !state.map || station.lat == null || station.lng == null) {
    return;
  }

  state.routePolylines.forEach(polyline => polyline.setMap(null));
  state.routePolylines = [];

  const requestId = ++state.routeRequestId;
  showDrivingRouteStatus(`Finding a driving route to ${station.name}...`);

  try {
    const destination = {
      lat: Number(station.lat),
      lng: Number(station.lng)
    };
    const cacheKey = [
      Number(state.currentLocation.lat).toFixed(4),
      Number(state.currentLocation.lng).toFixed(4),
      station.place_id || `${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}`
    ].join(":");
    let route = state.routeCache.get(cacheKey);

    if (!route) {
      const { Route } = await google.maps.importLibrary("routes");
      if (requestId !== state.routeRequestId) return;

      const result = await Route.computeRoutes({
        origin: state.currentLocation,
        destination,
        travelMode: "DRIVING",
        fields: ["path", "distanceMeters", "durationMillis", "viewport"]
      });
      route = result.routes?.[0];
      if (route) state.routeCache.set(cacheKey, route);
    }
    if (requestId !== state.routeRequestId) return;

    if (!route || !route.path?.length) {
      showDrivingRouteStatus("No road route found. In-range arrows show direct connections.");
      return;
    }

    const distanceText = Number.isFinite(route.distanceMeters)
      ? `${(route.distanceMeters / 1000).toFixed(1)} km`
      : "Distance unavailable";
    const durationText = Number.isFinite(route.durationMillis)
      ? formatRouteDuration(route.durationMillis)
      : "";
    const originLabel = state.currentLocationLabel || "Selected location";
    const details = `${originLabel} → ${station.name}${durationText ? ` · ${durationText}` : ""}`;

    const polyline = new google.maps.Polyline({
      path: route.path,
      map: state.map,
      strokeColor: "#22d3ee",
      strokeOpacity: 0.95,
      strokeWeight: 6,
      icons: [{
        icon: {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 4,
          fillColor: "#f8fafc",
          fillOpacity: 1,
          strokeColor: "#0891b2",
          strokeWeight: 1
        },
        offset: "50%"
      }]
    });
    state.routePolylines = [polyline];
    if (route.viewport) state.map.fitBounds(route.viewport);

    showDrivingRouteStatus("", distanceText, details);
  } catch (error) {
    if (requestId !== state.routeRequestId) return;
    console.error("Driving route request failed:", error);
    showDrivingRouteStatus("Driving directions unavailable. In-range arrows show direct connections.");
  }
}

function renderMapMarkers() {
  if (!state.map || typeof google === 'undefined') return;

  updateRangeCircle();

  const legend = document.getElementById("map-recommendation-legend");
  const recommendationsAvailable = !!state.vehicleProfile && !!state.currentLocation &&
    state.stationsLoaded && getFilteredStations().some(isStationWithinEstimatedRange);
  if (legend) legend.hidden = !recommendationsAvailable;

  // Clear existing markers
  if (state.markers) {
    Object.values(state.markers).forEach(marker => marker.setMap(null));
  }
  state.markers = {};

  const filtered = getFilteredStations();
  const priorityRanks = new Map(getTopPriorityStations().map((station, index) => [station.id, index + 1]));

  filtered.forEach(station => {
    if (station.lat == null || station.lng == null) return;

    const isRecommended = isStationWithinEstimatedRange(station);
    const priorityScore = getStationPriorityScore(station);
    const priorityRank = priorityRanks.get(station.id);
    let pinColor = "#06b6d4"; // available
    if (station.status === "charging") pinColor = "#f59e0b"; // busy
    if (station.status === "offline") pinColor = "#ef4444"; // offline
    const distanceKm = getStationDistanceKm(station);
    const congestion = getStationCongestion(station);
    const rangeNote = isRecommended
      ? `<div style="font-size: 0.8rem; color: #166534; font-weight: 700; margin-bottom: 4px;">${priorityRank ? `Top ${priorityRank} reservable · ` : ""}Within estimated range · ${formatDistance(distanceKm)} · Match score ${priorityScore}/100</div>`
      : distanceKm === null
        ? ""
        : `<div style="font-size: 0.8rem; color: #475569; margin-bottom: 4px;">${formatDistance(distanceKm)} away</div>`;

    const marker = new google.maps.Marker({
      position: { lat: parseFloat(station.lat), lng: parseFloat(station.lng) },
      map: state.map,
      title: isRecommended
        ? `${priorityRank ? `Top reservable choice ${priorityRank}. ` : ""}${station.name} — within estimated range, match score ${priorityScore} out of 100`
        : station.name,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: priorityRank ? 14 : isRecommended ? 11 : 9,
        fillColor: pinColor,
        fillOpacity: 1,
        strokeWeight: priorityRank ? 5 : isRecommended ? 4 : 2,
        strokeColor: priorityRank ? ["#facc15", "#fb923c", "#f472b6"][priorityRank - 1] : isRecommended ? "#a3e635" : "#ffffff"
      },
      label: priorityRank ? {
        text: String(priorityRank),
        color: "#111827",
        fontWeight: "700",
        fontSize: "11px"
      } : undefined,
      zIndex: priorityRank ? google.maps.Marker.MAX_ZINDEX + 10 - priorityRank : undefined
    });

    const isReserved = !!state.userReservations[station.id];
    const statusText = station.status === 'available' ? 'Available' : station.status === 'charging' ? 'In Use' : 'Offline';

    const popupContent = `
      <div style="padding: 6px; max-width: 220px; font-family: 'Outfit', sans-serif;">
        <div style="font-weight: 700; font-size: 0.95rem; color: #0f172a; margin-bottom: 2px;">${station.name}</div>
        <div style="font-size: 0.8rem; color: #475569; margin-bottom: 4px;">${station.address}</div>
        ${rangeNote}
        <div style="font-size: 0.8rem; color: #475569; margin-bottom: 4px;">Congestion estimate: ${congestion.label} · ${congestion.details}</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 2px;"><strong>${station.type}</strong> (${station.speed} kW)</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 4px;">Connector: ${station.connector}</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 6px;">Price: ${formatINR(station.price)}/kWh</div>
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

  drawInRangeStationRoutes();
}

function setActivePage(page) {
  const showStations = page === "stations";
  const showAlgorithm = page === "algorithm";
  const mapPage = document.getElementById("map-page");
  const stationsPage = document.getElementById("stations-page");
  const algorithmPage = document.getElementById("algorithm-page");
  if (!mapPage || !stationsPage || !algorithmPage) return;

  mapPage.hidden = showStations || showAlgorithm;
  stationsPage.hidden = !showStations;
  algorithmPage.hidden = !showAlgorithm;
  const mapLink = document.getElementById("nav-home");
  const stationsLink = document.getElementById("nav-stations");
  const algorithmLink = document.getElementById("nav-algorithm");
  mapLink?.classList.toggle("active", page === "map");
  stationsLink?.classList.toggle("active", showStations);
  algorithmLink?.classList.toggle("active", showAlgorithm);
  mapLink?.toggleAttribute("aria-current", page === "map");
  stationsLink?.toggleAttribute("aria-current", showStations);
  algorithmLink?.toggleAttribute("aria-current", showAlgorithm);

  if (page === "map" && state.map && typeof google !== "undefined" && google.maps?.event) {
    requestAnimationFrame(() => google.maps.event.trigger(state.map, "resize"));
  }
  if (showAlgorithm) renderAlgorithmWorkedExample();
}

// Sidebar Stations List Rendering
function getFilteredStations() {
  return state.stations.filter(station => {
    const name = (station.name || "").toLowerCase();
    const address = (station.address || "").toLowerCase();
    const matchesSearch = name.includes(state.filters.search.toLowerCase()) ||
      address.includes(state.filters.search.toLowerCase());

    const matchesStatus = state.filters.status === 'all' || station.status === state.filters.status;

    let matchesType = true;
    if (state.filters.type !== 'all') {
      matchesType = station.type === state.filters.type;
    }

    return matchesSearch && matchesStatus && matchesType;
  });
}

function updateLocationStatus() {
  if (!state.currentLocation || !state.stationsLoaded) return;

  const filtered = getFilteredStations();
  const type = state.filters.type === "all"
    ? "charging stations"
    : `${state.filters.type} stations`;
  const area = state.currentLocationLabel;

  document.getElementById("location-status").textContent = filtered.length
    ? `Showing ${filtered.length} ${type} near ${area}.`
    : `No ${type} found near ${area} matching the selected filters.`;
}

function renderStats() {
  const total = state.stations.length;
  const available = state.stations.reduce(
    (count, station) => count + (Number(station.availablePlugs) || 0),
    0
  );
  const inUse = state.stations.filter(s => s.status === 'charging').length;
  const offline = state.stations.filter(s => s.status === 'offline').length;

  document.getElementById("stat-total").textContent = total;
  document.getElementById("stat-available").textContent = available;
  document.getElementById("stat-inuse").textContent = inUse;
  document.getElementById("stat-offline").textContent = offline;
}

function renderStationsList() {
  const listContainer = document.getElementById("stations-list");
  renderRangeRecommendation();
  const rangeKm = getEstimatedRangeKm();
  const filtered = getFilteredStations().sort((first, second) => {
    const firstDistance = getStationDistanceKm(first);
    const secondDistance = getStationDistanceKm(second);
    const firstInRange = rangeKm !== null && firstDistance !== null && firstDistance <= rangeKm;
    const secondInRange = rangeKm !== null && secondDistance !== null && secondDistance <= rangeKm;
    const firstReservableInRange = firstInRange && isStationReservable(first);
    const secondReservableInRange = secondInRange && isStationReservable(second);

    if (firstReservableInRange !== secondReservableInRange) {
      return firstReservableInRange ? -1 : 1;
    }

    if (firstInRange !== secondInRange) return firstInRange ? -1 : 1;
    if (firstReservableInRange && secondReservableInRange) {
      const scoreDifference = getStationPriorityScore(second) - getStationPriorityScore(first);
      if (scoreDifference !== 0) return scoreDifference;
    }
    if (firstInRange && secondInRange) {
      const scoreDifference = getStationPriorityScore(second) - getStationPriorityScore(first);
      if (scoreDifference !== 0) return scoreDifference;
    }
    if (firstDistance === null && secondDistance === null) return 0;
    if (firstDistance === null) return 1;
    if (secondDistance === null) return -1;
    return firstDistance - secondDistance;
  });
  const priorityRanks = new Map(getTopPriorityStations().map((station, index) => [station.id, index + 1]));

  if (!state.currentLocation) {
    listContainer.innerHTML = `
      <div class="station-list-message">
        Choose your current location or search for a place above to see nearby charging stations.
      </div>
    `;
    return;
  }

  if (!state.stationsLoaded) {
    listContainer.innerHTML = `
      <div class="station-list-message">Loading nearby charging stations...</div>
    `;
    return;
  }

  if (filtered.length === 0) {
    listContainer.innerHTML = `
      <div class="station-list-message">No stations found matching the selected filters.</div>
    `;
    return;
  }

  listContainer.innerHTML = filtered.map(station => {
    const isSelected = state.selectedStationId === station.id ? 'active' : '';
    const statusText = station.status === 'available' ? 'Available' : station.status === 'charging' ? 'In Use' : 'Offline';
    const distance = getStationDistanceKm(station);
    const isWithinRange = isStationWithinEstimatedRange(station);
    const congestion = getStationCongestion(station);
    const priorityRank = priorityRanks.get(station.id);

    // Simulated action button
    let actionBtnHtml = '';
    const isReserved = !!state.userReservations[station.id];

    if (isReserved) {
      actionBtnHtml = `<button class="btn-card-action btn-outline" onclick="cancelReservation(event, ${station.id})">Cancel</button>`;
    } else if (isStationReservable(station)) {
      actionBtnHtml = `<button class="btn-card-action primary" onclick="bookStation(event, ${station.id})">Reserve</button>`;
    } else if (station.status === 'available') {
      actionBtnHtml = `<span style="font-size: 0.75rem; color: var(--text-muted); font-weight: 500;">No plugs available</span>`;
    } else if (station.status === 'charging') {
      actionBtnHtml = `<span style="font-size: 0.75rem; color: var(--warning); font-weight: 500;">Busy charging</span>`;
    } else {
      actionBtnHtml = `<span style="font-size: 0.75rem; color: var(--danger); font-weight: 500;">Maintenance</span>`;
    }

    return `
      <div class="station-card ${isSelected} ${priorityRank ? `top-priority-card rank-${priorityRank}` : ""}" id="station-card-${station.id}" onclick="selectStation(${station.id}, true)">
        <div class="station-card-header">
          <div class="station-title">${station.name}</div>
          <div class="station-card-badges">
            ${priorityRank ? `<span class="priority-rank-badge rank-${priorityRank}">#${priorityRank} ${priorityRank === 1 ? "Top reserve" : "Reserve pick"}</span>` : ""}
            <span class="status-badge ${station.status}">
              <span class="status-dot"></span>
              ${isReserved ? 'Reserved' : statusText}
            </span>
          </div>
        </div>
        <div class="station-address">${station.address}</div>
        <div class="congestion-indicator ${congestion.level}" title="Estimated from reported open plugs; this is not a historical or future forecast.">
          <span class="congestion-dot" aria-hidden="true"></span>
          <span>${congestion.label}</span>
          <span class="congestion-details">${congestion.details}</span>
        </div>
        ${distance === null ? "" : `
          <div class="station-distance">
            <span>${formatDistance(distance)} away</span>
            ${isWithinRange ? '<span class="within-range-badge">Within estimated range</span>' : ""}
            ${isWithinRange ? `<span class="priority-score" title="Weighted match score: distance 40%, plug availability 30%, charger speed 20%, rating 10%">Match ${getStationPriorityScore(station)}/100</span>` : ""}
          </div>
        `}
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
            <span>${formatINR(station.price)}/kWh</span>
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
function selectStation(stationId, panMap = true, showDrivingRoute = true) {
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
    if (panMap && !document.getElementById("stations-page")?.hidden) setActivePage("map");

    let pinColor = "#06b6d4";
    if (station.status === "charging") pinColor = "#f59e0b";
    if (station.status === "offline") pinColor = "#ef4444";

    const isReserved = !!state.userReservations[station.id];
    const statusText = station.status === 'available' ? 'Available' : station.status === 'charging' ? 'In Use' : 'Offline';
    const congestion = getStationCongestion(station);
    const priorityScore = getStationPriorityScore(station);

    const popupContent = `
      <div style="padding: 6px; max-width: 220px; font-family: 'Outfit', sans-serif;">
        <div style="font-weight: 700; font-size: 0.95rem; color: #0f172a; margin-bottom: 2px;">${station.name}</div>
        <div style="font-size: 0.8rem; color: #475569; margin-bottom: 4px;">${station.address}</div>
        ${priorityScore === null ? "" : `<div style="font-size: 0.8rem; color: #166534; font-weight: 700; margin-bottom: 4px;">Match score ${priorityScore}/100</div>`}
        <div style="font-size: 0.8rem; color: #475569; margin-bottom: 4px;">${congestion.label} · ${congestion.details}</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 2px;"><strong>${station.type}</strong> (${station.speed} kW)</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 4px;">Connector: ${station.connector}</div>
        <div style="font-size: 0.8rem; color: #334155; margin-bottom: 6px;">Price: ${formatINR(station.price)}/kWh</div>
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

    if (showDrivingRoute) drawDrivingRoute(station);
  }
}

function getReservationRewardDecision(station) {
  const stationKey = station.place_id || `station-${station.id}`;
  const rangeKm = getEstimatedRangeKm();
  if (rangeKm === null || !Number.isFinite(rangeKm) || rangeKm <= 0) {
    return { stationId: station.id, stationKey, rank: null, points: 0, reason: "Set your EV range to see whether this station is reachable and qualifies for cashback." };
  }

  const rankedStations = getRankedReservableStations(state.stations);
  const rank = rankedStations.findIndex(option => option.id === station.id) + 1;
  if (!rank) {
    return { stationId: station.id, stationKey, rank: null, points: 0, reason: "This station is outside your estimated range or could not be compared with available stations." };
  }
  if (rank > 3) {
    return { stationId: station.id, stationKey, rank, points: 0, reason: `A higher-priority reservable station was available within range. Choose one of the top 3 recommendations next time for cashback.` };
  }
  if (state.completedTripKeys[stationKey]) {
    return { stationId: station.id, stationKey, rank, points: 0, reason: "Cashback for this station was already claimed. Choose another top recommendation to earn again." };
  }

  const priorityScore = getStationPriorityScore(station) ?? 0;
  const totalPlugs = Math.max(1, Number(station.totalPlugs) || 1);
  const openPlugPercent = Math.round(Math.min(totalPlugs, Number(station.availablePlugs) || 0) / totalPlugs * 100);
  // Stronger match scores and more open plugs earn a larger, variable demo reward.
  const points = Math.round(8 + priorityScore * 0.35 + openPlugPercent * 0.12);
  return { stationId: station.id, stationKey, rank, priorityScore, openPlugPercent, points, reason: `Top ${rank} choice · match score ${priorityScore}/100 · ${openPlugPercent}% of plugs open.` };
}

function clearTripSimulation() {
  if (state.tripAnimationFrame !== null) {
    cancelAnimationFrame(state.tripAnimationFrame);
    state.tripAnimationFrame = null;
  }
  state.tripMarker?.setMap(null);
  state.tripPolyline?.setMap(null);
  state.tripMarker = null;
  state.tripPolyline = null;
  state.activeTripStationId = null;

  const card = document.getElementById("trip-progress-card");
  if (card) card.hidden = true;
  const calculationPanel = document.getElementById("algorithm-calculation-panel");
  if (calculationPanel) calculationPanel.hidden = true;
  document.querySelector(".map-panel")?.classList.remove("has-trip");
}

function createTripCarMarker(position, title) {
  const carMarkerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
    <defs><filter id="shadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#020617" flood-opacity=".36"/></filter></defs>
    <circle cx="36" cy="34" r="29" fill="#fff" filter="url(#shadow)"/>
    <circle cx="36" cy="34" r="26" fill="#ecfeff" stroke="#0891b2" stroke-width="2"/>
    <path d="m21 36 3-8c.7-1.8 2.1-2.8 4-2.8h16c2 0 3.5 1 4.3 2.8l3.2 8 2.5 2.2v7.2h-4v-2.2H22v2.2h-4v-7.2z" fill="#06b6d4" stroke="#0f172a" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="m27 28-2 6h22l-2.5-6c-.4-.8-1.1-1.2-2-1.2H29c-.9 0-1.6.4-2 1.2" fill="#e0f2fe" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M19 37h34" stroke="#fff" stroke-width="1.5" opacity=".9"/>
    <circle cx="26" cy="44" r="3.5" fill="#0f172a" stroke="#fff" stroke-width="1.5"/><circle cx="46" cy="44" r="3.5" fill="#0f172a" stroke="#fff" stroke-width="1.5"/>
  </svg>`;
  return new google.maps.Marker({
    map: state.map,
    position,
    title,
    zIndex: google.maps.Marker.MAX_ZINDEX + 20,
    icon: {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(carMarkerSvg)}`,
      scaledSize: new google.maps.Size(60, 60),
      anchor: new google.maps.Point(30, 34)
    }
  });
}

function startTripSimulation(station) {
  const origin = state.currentLocation;
  const destination = { lat: Number(station.lat), lng: Number(station.lng) };
  if (!state.map || !origin || !Number.isFinite(destination.lat) || !Number.isFinite(destination.lng)) {
    showToast("Choose a location before reserving to see the trip simulation.", "error");
    return;
  }

  clearTripSimulation();
  clearDrivingRoute();
  state.infoWindow?.close();
  const card = document.getElementById("trip-progress-card");
  const title = document.getElementById("trip-progress-title");
  const message = document.getElementById("trip-progress-message");
  const progress = document.getElementById("trip-progress-bar");
  const reward = document.getElementById("trip-reward-result");
  const demoResult = document.getElementById("algorithm-demo-result");
  const calculationPanel = document.getElementById("algorithm-calculation-panel");
  const note = document.getElementById("trip-progress-note");
  if (!card || !title || !message || !progress || !reward) return;

  setActivePage("map");
  state.algorithmDemoActive = false;
  state.activeTripStationId = station.id;
  title.textContent = "Your car is on the way";
  message.textContent = `Simulated trip to ${station.name} · ${formatDistance(getStationDistanceKm(station) || 0)}`;
  progress.style.width = "0%";
  reward.hidden = true;
  if (demoResult) demoResult.hidden = true;
  if (calculationPanel) calculationPanel.hidden = true;
  if (note) note.textContent = "Trip movement and cashback are simulated (100 points = ₹4.00); no live tracking or payment is connected.";
  card.hidden = false;
  document.querySelector(".map-panel")?.classList.add("has-trip");

  const bounds = new google.maps.LatLngBounds();
  bounds.extend(origin);
  bounds.extend(destination);
  state.map.fitBounds(bounds, 72);

  state.tripPolyline = new google.maps.Polyline({
    map: state.map,
    path: [origin, destination],
    geodesic: true,
    strokeColor: "#10b981",
    strokeOpacity: 0.9,
    strokeWeight: 5,
    zIndex: 5
  });
  state.tripMarker = createTripCarMarker(origin, "Simulated EV trip");

  const startedAt = performance.now();
  const durationMs = 7000;
  const animate = now => {
    const rawProgress = Math.min(1, (now - startedAt) / durationMs);
    const easedProgress = rawProgress * rawProgress * (3 - 2 * rawProgress);
    state.tripMarker?.setPosition({
      lat: origin.lat + (destination.lat - origin.lat) * easedProgress,
      lng: origin.lng + (destination.lng - origin.lng) * easedProgress
    });
    progress.style.width = `${Math.round(rawProgress * 100)}%`;

    if (rawProgress < 1) {
      state.tripAnimationFrame = requestAnimationFrame(animate);
      return;
    }

    state.tripAnimationFrame = null;
    state.activeTripStationId = null;
    title.textContent = "You’ve arrived";
    progress.style.width = "100%";
    message.textContent = `${station.name} · Reservation ready`;

    const decision = state.pendingReservationDecision?.stationId === station.id
      ? state.pendingReservationDecision
      : { ...getReservationRewardDecision(station), points: 0, reason: "The reservation could not be matched to its original station ranking." };
    const points = decision.points;
    state.pendingReservationDecision = null;
    state.pendingTripReward = { stationKey: decision.stationKey, points };
    document.getElementById("trip-reward-cashback").textContent =
      points > 0 ? `${formatINR(points * 0.04)} cashback` : "No cashback this trip";
    document.getElementById("trip-reward-points").textContent =
      points > 0 ? `+${points} points ready to claim · ${decision.reason}` : decision.reason;
    document.getElementById("trip-claim-reward-btn").textContent =
      points > 0 ? `Claim ${formatINR(points * 0.04)} cashback` : "Back to Home";
    reward.hidden = false;
    if (points === 0) showToast(`No cashback this trip. ${decision.reason}`, "info");
    renderRangeRecommendation();
  };

  state.tripAnimationFrame = requestAnimationFrame(animate);
}

function startAlgorithmMapDemo() {
  if (!state.map || !state.currentLocation || !state.stationsLoaded) {
    showToast("Choose a location on the Map page and wait for stations to load before running the demo.", "info");
    return;
  }

  const rankedStations = getRankedReservableStations(state.stations);
  const station = rankedStations[0];
  if (!station) {
    showToast("Set up your EV range and load an available station within range before running the demo.", "info");
    return;
  }

  const origin = state.currentLocation;
  const destination = { lat: Number(station.lat), lng: Number(station.lng) };
  clearTripSimulation();
  clearDrivingRoute();
  state.infoWindow?.close();
  setActivePage("map");
  document.body.classList.add("trip-map-fullscreen");
  state.algorithmDemoActive = true;
  state.activeTripStationId = station.id;

  const card = document.getElementById("trip-progress-card");
  const title = document.getElementById("trip-progress-title");
  const message = document.getElementById("trip-progress-message");
  const progress = document.getElementById("trip-progress-bar");
  const reward = document.getElementById("trip-reward-result");
  const demoResult = document.getElementById("algorithm-demo-result");
  const note = document.getElementById("trip-progress-note");
  if (!card || !title || !message || !progress || !reward || !demoResult) return;

  title.textContent = "Calculating the best station";
  message.textContent = `Top choice: ${station.name} · priority score ${getStationPriorityScore(station)}/100`;
  progress.style.width = "0%";
  reward.hidden = true;
  demoResult.hidden = true;
  if (note) note.textContent = "Algorithm preview only: movement is simulated; no station is reserved and no cashback is awarded.";
  card.hidden = false;
  document.querySelector(".map-panel")?.classList.add("has-trip");
  renderAlgorithmLiveTrace(station, rankedStations);
  setAlgorithmLiveTraceStep(0);

  const bounds = new google.maps.LatLngBounds();
  bounds.extend(origin);
  bounds.extend(destination);
  requestAnimationFrame(() => {
    google.maps.event.trigger(state.map, "resize");
    state.map.fitBounds(bounds, 72);
  });
  state.tripPolyline = new google.maps.Polyline({
    map: state.map,
    path: [origin, destination],
    geodesic: true,
    strokeColor: "#10b981",
    strokeOpacity: 0.9,
    strokeWeight: 5,
    zIndex: 5
  });
  state.tripMarker = createTripCarMarker(origin, "Algorithm map demo vehicle");

  const startedAt = performance.now();
  const durationMs = 8000;
  let previousCalculationStep = 0;
  const animate = now => {
    const rawProgress = Math.min(1, (now - startedAt) / durationMs);
    const easedProgress = rawProgress * rawProgress * (3 - 2 * rawProgress);
    const calculationStep = Math.min(7, Math.floor(rawProgress * 8));
    if (calculationStep !== previousCalculationStep) {
      previousCalculationStep = calculationStep;
      setAlgorithmLiveTraceStep(calculationStep);
    }

    state.tripMarker?.setPosition({
      lat: origin.lat + (destination.lat - origin.lat) * easedProgress,
      lng: origin.lng + (destination.lng - origin.lng) * easedProgress
    });
    progress.style.width = `${Math.round(rawProgress * 100)}%`;

    if (rawProgress < 1) {
      state.tripAnimationFrame = requestAnimationFrame(animate);
      return;
    }

    state.tripAnimationFrame = null;
    state.activeTripStationId = null;
    state.algorithmDemoActive = false;
    title.textContent = "Top recommendation reached";
    setAlgorithmLiveTraceStep(7);
    progress.style.width = "100%";
    message.textContent = `${station.name} · demo only, no reservation made`;
    document.getElementById("algorithm-demo-summary").textContent =
      `Ranked #1 of ${rankedStations.length} reservable stations in your estimated range with a priority score of ${getStationPriorityScore(station)}/100. The panel shows the exact range, score, congestion, and potential cashback calculations.`;
    demoResult.hidden = false;
  };

  state.tripAnimationFrame = requestAnimationFrame(animate);
}

function returnFromAlgorithmMapDemo() {
  document.body.classList.remove("trip-map-fullscreen");
  state.algorithmDemoActive = false;
  clearTripSimulation();
  setActivePage("algorithm");
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
  if (!station || !isStationReservable(station)) {
    showToast("This station has no reservable plugs right now.", "error");
    return;
  }

  state.confirmingReservationStationId = stationId;
  document.getElementById("reservation-confirm-station").textContent = station.name;
  toggleModal("reservation-confirm-modal", true);
}

function confirmStationReservation() {
  const stationId = state.confirmingReservationStationId;
  state.confirmingReservationStationId = null;
  toggleModal("reservation-confirm-modal", false);

  const station = state.stations.find(s => s.id === stationId);
  if (!station || !isStationReservable(station)) {
    showToast("This station is no longer available to reserve.", "error");
    renderStationsList();
    return;
  }

  state.pendingReservationDecision = getReservationRewardDecision(station);
  setActivePage("map");
  document.body.classList.add("trip-map-fullscreen");
  requestAnimationFrame(() => {
    if (state.map && typeof google !== "undefined" && google.maps?.event) {
      google.maps.event.trigger(state.map, "resize");
    }
  });

  state.pendingReservations[stationId] = true;
  showToast(`Reserving slot at ${station.name}...`, "info");

  setTimeout(() => {
    // Simulate API reserve
    delete state.pendingReservations[stationId];
    station.availablePlugs -= 1;
    state.userReservations[stationId] = Date.now() + (15 * 60 * 1000); // 15 mins reservation window

    showToast(`Slot reserved successfully! You have 15 minutes to arrive.`, "success");

    renderStats();
    renderStationsList();
    renderMapMarkers();

    // Show the simulated journey, then offer an eligible cashback claim on arrival.
    selectStation(stationId, true, false);
    startTripSimulation(station);
  }, 800);
}

function cancelStationReservationConfirmation() {
  state.confirmingReservationStationId = null;
  toggleModal("reservation-confirm-modal", false);
}

function claimTripReward() {
  const pendingReward = state.pendingTripReward;
  if (pendingReward?.points > 0 && !state.completedTripKeys[pendingReward.stationKey]) {
    state.completedTripKeys[pendingReward.stationKey] = true;
    state.rewardPoints += pendingReward.points;
    document.getElementById("algorithm-reward-balance").textContent = `${state.rewardPoints} points`;
  }
  state.pendingTripReward = null;

  setActivePage("map");
  document.body.classList.remove("trip-map-fullscreen");
  clearTripSimulation();
  if (state.map && typeof google !== "undefined" && google.maps?.event) {
    requestAnimationFrame(() => google.maps.event.trigger(state.map, "resize"));
  }
}

function cancelReservation(event, stationId) {
  event.stopPropagation();

  const station = state.stations.find(s => s.id === stationId);
  if (!station) return;

  if (state.activeTripStationId === stationId) {
    clearTripSimulation();
    document.body.classList.remove("trip-map-fullscreen");
  }

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
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && document.body.classList.contains("trip-map-fullscreen")) {
      document.body.classList.remove("trip-map-fullscreen");
      if (state.map && typeof google !== "undefined" && google.maps?.event) {
        requestAnimationFrame(() => google.maps.event.trigger(state.map, "resize"));
      }
    }
  });

  document.getElementById("nav-home").addEventListener("click", event => {
    event.preventDefault();
    setActivePage("map");
  });
  document.getElementById("nav-stations").addEventListener("click", event => {
    event.preventDefault();
    renderStationsList();
    setActivePage("stations");
  });
  document.getElementById("nav-algorithm").addEventListener("click", event => {
    event.preventDefault();
    setActivePage("algorithm");
  });
  document.getElementById("stations-map-button").addEventListener("click", () => setActivePage("map"));

  document.getElementById("locate-me-btn").addEventListener("click", locateUser);
  document.getElementById("trip-progress-dismiss").addEventListener("click", () => {
    document.getElementById("trip-progress-card").hidden = true;
    document.querySelector(".map-panel")?.classList.remove("has-trip");
  });
  document.getElementById("reservation-confirm-btn").addEventListener("click", confirmStationReservation);
  document.getElementById("reservation-cancel-btn").addEventListener("click", cancelStationReservationConfirmation);
  document.getElementById("trip-claim-reward-btn").addEventListener("click", claimTripReward);
  document.getElementById("algorithm-demo-button").addEventListener("click", startAlgorithmMapDemo);
  document.getElementById("algorithm-demo-return-btn").addEventListener("click", returnFromAlgorithmMapDemo);
  document.getElementById("nav-vehicle").addEventListener("click", openVehicleProfile);
  const rangePanel = ensureRangeRecommendationPanel();
  if (rangePanel) {
    rangePanel.addEventListener("click", event => {
      if (event.target.closest("#btn-setup-vehicle")) openVehicleProfile();
      if (event.target.closest("#btn-urgency-location")) setActivePage("map");
      const routeButton = event.target.closest("#btn-urgency-route");
      if (routeButton) selectStation(Number(routeButton.dataset.stationId), true);
      const rewardButton = event.target.closest("#btn-reward-station");
      if (rewardButton) {
        const stationId = Number(rewardButton.dataset.stationId);
        const station = state.stations.find(item => item.id === stationId);
        if (station) {
          showToast("Alternative selected. Cashback is calculated after a completed reservation trip.", "info");
          selectStation(stationId, true);
        }
      }
    });
  }
  setupLocationSearch();

  // Search Input
  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", (e) => {
    state.filters.search = e.target.value;
    renderStationsList();
    renderMapMarkers();
    updateLocationStatus();
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
      updateLocationStatus();
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
      updateLocationStatus();
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
        try {
          await refreshVehicleProfile();
          if (state.pendingVehicleProfileOpen) {
            state.pendingVehicleProfileOpen = false;
            await openVehicleProfile();
          }
        } catch (error) {
          state.pendingVehicleProfileOpen = false;
          console.error("Vehicle profile check failed:", error);
          showToast(error.message || "Could not check your EV profile.", "error");
        }
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

  const vehicleForm = document.getElementById("vehicle-form");
  vehicleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = document.getElementById("btn-save-vehicle");
    const message = document.getElementById("vehicle-error-msg");
    message.style.display = "none";
    submitButton.disabled = true;

    const vehicle = {
      connector_type: document.getElementById("vehicle-connector").value,
      battery_capacity_kwh: Number(document.getElementById("vehicle-capacity").value),
      current_battery_percent: Number(document.getElementById("vehicle-battery").value),
      full_range_km: Number(document.getElementById("vehicle-range").value)
    };

    try {
      const response = await fetch("/api/vehicle-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vehicle)
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not save your EV profile.");
      }

      state.vehicleProfile = data.vehicle;
      updateVehicleProfileStatus();
      renderStationsList();
      renderMapMarkers();
      const savedConnector = data.vehicle.connector_type;
      const savedRange = data.vehicle.full_range_km;
      toggleModal("vehicle-modal", false);
      showToast(`${savedConnector} EV profile saved · ${savedRange} km range.`, "success");
    } catch (error) {
      console.error("Vehicle profile save failed:", error);
      message.className = "form-message error";
      message.textContent = error.message || "Could not save your EV profile.";
    } finally {
      submitButton.disabled = false;
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

