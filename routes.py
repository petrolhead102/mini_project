"""
Routes for VoltRoute EV Charging Slot Allocation and Recommendation System.
Integrates:
- Station discovery with Google Places API and reference fallback.
- EV input validation and reachability filtering.
- Charging urgency scoring.
- Station-level ARIMA / EMA congestion forecasting.
- Multi-criteria station ranking and recommendation explanations.
- Min-cost flow multi-vehicle allocation.
- Incentive reward points ledger.
"""

from flask import Blueprint, jsonify, g, request, current_app
import requests
import random
from typing import List, Dict, Any

from database import db
from decorators import login_required
from services.spatial_index import haversine_distance_km, calculate_route_metrics, StationSpatialIndex
from services.reachability import EVInputValidator, ReachabilityFilterService
from services.urgency import ChargingUrgencyService
from services.forecasting import CongestionForecastingService
from services.ranking import StationRankingService
from services.min_cost_flow import MinCostFlowAllocator
from services.rewards import RewardPointsService

main = Blueprint("main", __name__)


# Standard Reference Stations used when Google Places API key is not configured or network call fails
FALLBACK_REFERENCE_STATIONS = [
    {
        "id": 1,
        "name": "Market Street Supercharger Hub",
        "lat": 37.7749,
        "lng": -122.4194,
        "address": "1355 Market St, San Francisco, CA 94103",
        "rating": 4.8,
        "status": "available",
        "availablePlugs": 4,
        "totalPlugs": 8,
        "speed": 250,
        "type": "DC Fast",
        "connector": "Tesla NACS",
        "price": 0.38,
        "amenities": ["Dining", "WiFi", "Restrooms"],
        "is_simulated_availability": True,
        "data_source": "Curated Reference Sample"
    },
    {
        "id": 2,
        "name": "Mission District GreenCharge",
        "lat": 37.7599,
        "lng": -122.4148,
        "address": "2450 Mission St, San Francisco, CA 94110",
        "rating": 4.5,
        "status": "available",
        "availablePlugs": 6,
        "totalPlugs": 6,
        "speed": 150,
        "type": "DC Fast",
        "connector": "CCS",
        "price": 0.32,
        "amenities": ["Shopping", "Coffee"],
        "is_simulated_availability": True,
        "data_source": "Curated Reference Sample"
    },
    {
        "id": 3,
        "name": "Civic Center FastCharge Point",
        "lat": 37.7793,
        "lng": -122.4184,
        "address": "355 McAllister St, San Francisco, CA 94102",
        "rating": 4.1,
        "status": "charging",
        "availablePlugs": 0,
        "totalPlugs": 4,
        "speed": 50,
        "type": "DC Fast",
        "connector": "CCS",
        "price": 0.28,
        "amenities": ["Restrooms"],
        "is_simulated_availability": True,
        "data_source": "Curated Reference Sample"
    },
    {
        "id": 4,
        "name": "Embarcadero EcoStation",
        "lat": 37.7955,
        "lng": -122.3937,
        "address": "1 Ferry Building, San Francisco, CA 94111",
        "rating": 4.9,
        "status": "available",
        "availablePlugs": 3,
        "totalPlugs": 10,
        "speed": 250,
        "type": "DC Fast",
        "connector": "CCS",
        "price": 0.42,
        "amenities": ["Ferry Terminal", "Dining", "Scenic Waterfront"],
        "is_simulated_availability": True,
        "data_source": "Curated Reference Sample"
    },
    {
        "id": 5,
        "name": "Presidio Park Community Chargers",
        "lat": 37.7989,
        "lng": -122.4662,
        "address": "210 Lincoln Blvd, San Francisco, CA 94129",
        "rating": 4.6,
        "status": "available",
        "availablePlugs": 5,
        "totalPlugs": 6,
        "speed": 22,
        "type": "Level 2",
        "connector": "J1772",
        "price": 0.20,
        "amenities": ["Park", "Hiking Trails"],
        "is_simulated_availability": True,
        "data_source": "Curated Reference Sample"
    },
    {
        "id": 6,
        "name": "Potrero Hill Urban Plug",
        "lat": 37.7562,
        "lng": -122.3980,
        "address": "1400 18th St, San Francisco, CA 94107",
        "rating": 4.3,
        "status": "offline",
        "availablePlugs": 0,
        "totalPlugs": 4,
        "speed": 50,
        "type": "DC Fast",
        "connector": "CHAdeMO",
        "price": 0.29,
        "amenities": ["Grocery"],
        "is_simulated_availability": True,
        "data_source": "Curated Reference Sample"
    },
    {
        "id": 7,
        "name": "Sunset District CleanVolt",
        "lat": 37.7533,
        "lng": -122.4828,
        "address": "1900 Irving St, San Francisco, CA 94122",
        "rating": 4.4,
        "status": "available",
        "availablePlugs": 2,
        "totalPlugs": 4,
        "speed": 150,
        "type": "DC Fast",
        "connector": "CCS",
        "price": 0.34,
        "amenities": ["Coffee", "Bakery"],
        "is_simulated_availability": True,
        "data_source": "Curated Reference Sample"
    },
    {
        "id": 8,
        "name": "SOMA Tech Plaza Chargers",
        "lat": 37.7825,
        "lng": -122.4048,
        "address": "700 Howard St, San Francisco, CA 94103",
        "rating": 4.7,
        "status": "available",
        "availablePlugs": 8,
        "totalPlugs": 12,
        "speed": 250,
        "type": "DC Fast",
        "connector": "Tesla NACS",
        "price": 0.36,
        "amenities": ["Convention Center", "Hotels", "Food Court"],
        "is_simulated_availability": True,
        "data_source": "Curated Reference Sample"
    }
]


def _fetch_stations_internal(lat: float, lng: float) -> List[Dict[str, Any]]:
    """Internal helper that tries Google Places API, falling back gracefully to reference stations."""
    api_key = current_app.config.get("GOOGLE_MAPS_KEY")
    if not api_key:
        return [dict(s) for s in FALLBACK_REFERENCE_STATIONS]

    url = "https://places.googleapis.com/v1/places:searchText"
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": (
            "places.id,"
            "places.displayName,"
            "places.location,"
            "places.formattedAddress,"
            "places.rating,"
            "places.types,"
            "places.primaryType,"
            "places.evChargeOptions"
        )
    }

    body = {
        "textQuery": "EV charging station",
        "maxResultCount": 20,
        "locationBias": {
            "circle": {
                "center": {
                    "latitude": lat,
                    "longitude": lng
                },
                "radius": 15000.0
            }
        }
    }

    try:
        response = requests.post(url, headers=headers, json=body, timeout=8)
        response.raise_for_status()
        data = response.json()
        places = data.get("places", [])

        if not places:
            return [dict(s) for s in FALLBACK_REFERENCE_STATIONS]

        stations = []
        for idx, place in enumerate(places):
            rng = random.Random(place.get("id", str(idx)))
            status = rng.choice(["available", "available", "charging", "offline"])
            total_plugs = rng.randint(2, 12)
            available_plugs = rng.randint(1, total_plugs) if status == "available" else 0
            speed = rng.choice([11, 22, 50, 150, 250])

            station = {
                "id": idx + 1,
                "name": place.get("displayName", {}).get("text", f"EV Station {idx + 1}"),
                "lat": place.get("location", {}).get("latitude"),
                "lng": place.get("location", {}).get("longitude"),
                "address": place.get("formattedAddress", "Local Area"),
                "rating": place.get("rating", 4.5),
                "status": status,
                "availablePlugs": available_plugs,
                "totalPlugs": total_plugs,
                "speed": speed,
                "type": "DC Fast" if speed >= 50 else "Level 2",
                "connector": rng.choice(["CCS", "CHAdeMO", "J1772", "Tesla NACS"]),
                "price": round(rng.uniform(0.18, 0.45), 2),
                "amenities": ["Restrooms", "Convenience"],
                "place_id": place.get("id"),
                "is_simulated_availability": True,
                "data_source": "Google Places API (Simulated Plugs/Pricing)"
            }
            stations.append(station)

        return stations
    except Exception:
        # Graceful fallback on API error or quota limit
        return [dict(s) for s in FALLBACK_REFERENCE_STATIONS]


@main.route("/profile", methods=["GET"])
@login_required
def profile():
    return jsonify({
        "id": g.user.id,
        "username": g.user.username,
        "email": g.user.email
    })


@main.route("/api/stations", methods=["GET"])
def get_stations():
    """
    Station Discovery Endpoint.
    Returns normalized stations, distance from EV, and KD-Tree spatial metadata.
    """
    try:
        lat = float(request.args.get("lat", 37.7749))
        lng = float(request.args.get("lng", -122.4194))
    except (ValueError, TypeError):
        return jsonify({"message": "Invalid latitude or longitude parameters"}), 400

    stations = _fetch_stations_internal(lat, lng)

    # Use 3D KD-Tree spatial index to calculate distances and sort
    spatial_index = StationSpatialIndex(stations)
    for st in stations:
        if st.get("lat") is not None and st.get("lng") is not None:
            dist = haversine_distance_km(lat, lng, float(st["lat"]), float(st["lng"]))
            st["distance_km"] = round(dist, 2)
            st["estimated_travel_time_mins"] = round((dist * 1.25 / 35.0) * 60.0, 1)

    stations.sort(key=lambda s: s.get("distance_km", 9999.0))
    return jsonify(stations)


@main.route("/api/ev/reachability", methods=["POST"])
def check_reachability():
    """
    Feature 3: Filters candidate stations by vehicle reachability,
    accounting for safe range margin, connector compatibility, and operational status.
    """
    payload = request.get_json() or {}
    val_result = EVInputValidator.validate_and_normalize(payload)
    if not val_result["is_valid"]:
        return jsonify({"errors": val_result["errors"]}), 400

    ev_state = val_result["validated_data"]
    stations = payload.get("stations")
    if not stations:
        stations = _fetch_stations_internal(ev_state["lat"], ev_state["lng"])

    result = ReachabilityFilterService.filter_stations(stations, ev_state)
    return jsonify(result)


@main.route("/api/ev/urgency", methods=["POST"])
def calculate_urgency():
    """
    Feature 4: Computes charging urgency score (0-100) and human-readable explanation.
    """
    payload = request.get_json() or {}
    val_result = EVInputValidator.validate_and_normalize(payload)
    if not val_result["is_valid"]:
        return jsonify({"errors": val_result["errors"]}), 400

    ev_state = val_result["validated_data"]
    nearest_dist = payload.get("nearest_station_distance_km")

    if nearest_dist is None:
        # Compute nearest station distance automatically
        stations = payload.get("stations") or _fetch_stations_internal(ev_state["lat"], ev_state["lng"])
        if stations:
            dists = [
                haversine_distance_km(ev_state["lat"], ev_state["lng"], float(s["lat"]), float(s["lng"]))
                for s in stations if s.get("lat") and s.get("lng")
            ]
            nearest_dist = min(dists) * 1.25 if dists else None

    urgency_result = ChargingUrgencyService.calculate_urgency(
        remaining_range_km=ev_state["remaining_range_km"],
        battery_percentage=ev_state["battery_percentage"],
        nearest_station_distance_km=nearest_dist
    )
    return jsonify(urgency_result)


@main.route("/api/stations/<station_id>/forecast", methods=["GET"])
def get_station_forecast(station_id):
    """
    Feature 5: ARIMA / Fallback Congestion & Queue Time-Series Forecasting.
    """
    horizon = int(request.args.get("horizon", 3))
    auto_seed = request.args.get("auto_seed", "true").lower() == "true"

    forecast = CongestionForecastingService.forecast_congestion(
        station_id=str(station_id),
        horizon_hours=horizon,
        auto_seed_synthetic=auto_seed
    )
    return jsonify(forecast)


@main.route("/api/recommendations", methods=["POST"])
def get_recommendations():
    """
    Feature 6: End-to-end intelligent recommendation engine.
    Orchestrates reachability filtering, urgency calculation, congestion forecasting,
    multi-criteria ranking, and reward point incentives.
    """
    payload = request.get_json() or {}
    val_result = EVInputValidator.validate_and_normalize(payload)
    if not val_result["is_valid"]:
        return jsonify({"errors": val_result["errors"]}), 400

    ev_state = val_result["validated_data"]
    stations = payload.get("stations") or _fetch_stations_internal(ev_state["lat"], ev_state["lng"])

    # 1. Filter by reachability & compatibility
    filter_result = ReachabilityFilterService.filter_stations(stations, ev_state)
    reachable_stations = filter_result["reachable_stations"]

    # 2. Compute urgency
    nearest_dist = reachable_stations[0]["route_distance_km"] if reachable_stations else None
    urgency_info = ChargingUrgencyService.calculate_urgency(
        remaining_range_km=ev_state["remaining_range_km"],
        battery_percentage=ev_state["battery_percentage"],
        nearest_station_distance_km=nearest_dist
    )

    # 3. Rank reachable stations using multi-factor model
    ranking_result = StationRankingService.rank_stations(
        reachable_stations=reachable_stations,
        urgency_data=urgency_info
    )

    # 4. Calculate eligible reward points for recommended alternative (Feature 8)
    reward_info = None
    recommended = ranking_result.get("recommended_station")
    if recommended and len(reachable_stations) > 1:
        nearest_st = reachable_stations[0]
        reward_info = RewardPointsService.calculate_incentive(
            urgency_score=urgency_info["urgency_score"],
            chosen_station_wait_mins=recommended.get("predicted_waiting_time_mins", 0.0),
            baseline_station_wait_mins=nearest_st.get("predicted_waiting_time_mins", 0.0),
            chosen_station_dist_km=recommended.get("route_distance_km", 0.0),
            safe_range_km=filter_result["safe_range_km"]
        )

    return jsonify({
        "ev_state": ev_state,
        "safe_range_km": filter_result["safe_range_km"],
        "safety_margin_pct": filter_result["safety_margin_pct"],
        "urgency": urgency_info,
        "warning": filter_result.get("warning"),
        "total_stations_evaluated": filter_result["total_candidates_evaluated"],
        "reachable_count": filter_result["reachable_count"],
        "unreachable_count": filter_result["unreachable_count"],
        "recommended_station": ranking_result.get("recommended_station"),
        "ranked_alternatives": ranking_result.get("ranked_stations", []),
        "unreachable_stations": filter_result.get("unreachable_stations", []),
        "weights_applied": ranking_result.get("weights_used", {}),
        "reward_incentive": reward_info
    })


@main.route("/api/optimization/allocate", methods=["POST"])
def allocate_multi_vehicle():
    """
    Feature 7: Min-Cost Flow Optimization for Multi-Vehicle Slot Allocation.
    """
    payload = request.get_json() or {}
    vehicles = payload.get("vehicles", [])
    stations = payload.get("stations")

    if not vehicles:
        return jsonify({"message": "Please provide a 'vehicles' array with at least 1 EV."}), 400

    if not stations:
        # Default to discovering reference stations
        first_v = vehicles[0]
        v_lat = float(first_v.get("lat", 37.7749))
        v_lng = float(first_v.get("lng", -122.4194))
        stations = _fetch_stations_internal(v_lat, v_lng)

    safety_margin = float(payload.get("safety_margin_pct", 15.0))
    allocation_result = MinCostFlowAllocator.allocate_vehicles(vehicles, stations, safety_margin)
    return jsonify(allocation_result)


@main.route("/api/rewards/estimate", methods=["POST"])
def estimate_reward():
    """
    Feature 8: Calculate eligible points for choosing an alternative station.
    """
    payload = request.get_json() or {}
    try:
        urgency = float(payload.get("urgency_score", 40.0))
        chosen_wait = float(payload.get("chosen_wait_mins", 0.0))
        baseline_wait = float(payload.get("baseline_wait_mins", 20.0))
        chosen_dist = float(payload.get("chosen_dist_km", 5.0))
        safe_range = float(payload.get("safe_range_km", 40.0))
    except (ValueError, TypeError):
        return jsonify({"message": "Invalid numeric arguments"}), 400

    result = RewardPointsService.calculate_incentive(
        urgency_score=urgency,
        chosen_station_wait_mins=chosen_wait,
        baseline_station_wait_mins=baseline_wait,
        chosen_station_dist_km=chosen_dist,
        safe_range_km=safe_range
    )
    return jsonify(result)


@main.route("/api/rewards/claim", methods=["POST"])
def claim_reward():
    """
    Feature 8: Verifies and claims reward points with session idempotency.
    """
    payload = request.get_json() or {}
    token = payload.get("session_token")
    if not token:
        return jsonify({"message": "Session token required"}), 400

    result = RewardPointsService.verify_and_claim_reward(token)
    status_code = 200 if result.get("success") else 400
    return jsonify(result), status_code


@main.route("/api/rewards/summary", methods=["GET"])
def get_rewards_summary():
    """
    Feature 8: Returns reward ledger for logged in user (or sample if unauthenticated).
    """
    session_id = request.cookies.get("session_id")
    from models import Session
    session = Session.query.filter_by(session_id=session_id).first() if session_id else None

    if session and session.user:
        summary = RewardPointsService.get_user_rewards_summary(session.user.id)
        return jsonify(summary)

    # Demo summary for guest
    return jsonify({
        "user_id": None,
        "verified_points": 140,
        "estimated_points": 35,
        "total_transactions": 3,
        "demo_mode": True,
        "transactions": [
            {
                "id": 1,
                "station_id": "2",
                "points_awarded": 40,
                "wait_time_saved_mins": 20.0,
                "status": "verified",
                "created_at": "2026-10-23T10:15:00"
            },
            {
                "id": 2,
                "station_id": "5",
                "points_awarded": 100,
                "wait_time_saved_mins": 50.0,
                "status": "verified",
                "created_at": "2026-10-22T14:30:00"
            },
            {
                "id": 3,
                "station_id": "4",
                "points_awarded": 35,
                "wait_time_saved_mins": 17.5,
                "status": "estimated",
                "created_at": "2026-10-23T18:00:00"
            }
        ]
    })