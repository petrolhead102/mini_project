import math
import random

from flask import Blueprint, jsonify, g, request, current_app
import requests

from decorators import login_required
from database import db
from models import VehicleProfile

main = Blueprint("main", __name__)

VEHICLE_CONNECTOR_TYPES = {
    "CCS",
    "CHAdeMO",
    "J1772",
    "Tesla NACS"
}


@main.route("/profile", methods=["GET"])
@login_required
def profile():
    return jsonify({
        "id": g.user.id,
        "username": g.user.username,
        "email": g.user.email
    })


@main.route("/api/vehicle-profile", methods=["GET"])
@login_required
def get_vehicle_profile():
    vehicle = VehicleProfile.query.filter_by(user_id=g.user.id).first()
    if not vehicle:
        return jsonify({"vehicle": None}), 200

    return jsonify({
        "vehicle": {
            "connector_type": vehicle.connector_type,
            "battery_capacity_kwh": vehicle.battery_capacity_kwh,
            "current_battery_percent": vehicle.current_battery_percent,
            "full_range_km": vehicle.full_range_km
        }
    }), 200


@main.route("/api/vehicle-profile", methods=["PUT"])
@login_required
def save_vehicle_profile():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"message": "Invalid request body"}), 400

    connector_type = data.get("connector_type")
    if not isinstance(connector_type, str) or connector_type not in VEHICLE_CONNECTOR_TYPES:
        return jsonify({"message": "Select a supported charging connector"}), 400

    numeric_fields = {
        "battery_capacity_kwh": (1, 300, "Battery capacity must be between 1 and 300 kWh"),
        "current_battery_percent": (0, 100, "Battery level must be between 0% and 100%"),
        "full_range_km": (1, 2000, "Full-charge range must be between 1 and 2000 km")
    }
    values = {}

    for field, (minimum, maximum, message) in numeric_fields.items():
        value = data.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return jsonify({"message": message}), 400
        if not minimum <= value <= maximum:
            return jsonify({"message": message}), 400
        values[field] = value

    vehicle = VehicleProfile.query.filter_by(user_id=g.user.id).first()
    if vehicle is None:
        vehicle = VehicleProfile(user_id=g.user.id)
        db.session.add(vehicle)

    vehicle.connector_type = connector_type
    vehicle.battery_capacity_kwh = values["battery_capacity_kwh"]
    vehicle.current_battery_percent = values["current_battery_percent"]
    vehicle.full_range_km = values["full_range_km"]
    db.session.commit()

    return jsonify({
        "message": "Vehicle profile saved",
        "vehicle": {
            "connector_type": vehicle.connector_type,
            "battery_capacity_kwh": vehicle.battery_capacity_kwh,
            "current_battery_percent": vehicle.current_battery_percent,
            "full_range_km": vehicle.full_range_km
        }
    }), 200


@main.route("/api/stations", methods=["GET"])
def get_stations():
    lat = float(request.args.get("lat", 37.7749))
    lng = float(request.args.get("lng", -122.4194))

    api_key = current_app.config.get("GOOGLE_MAPS_KEY")
    if not api_key:
        return jsonify({"message": "Google Maps API key not configured"}), 500

    url = "https://places.googleapis.com/v1/places:searchNearby"

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
        "includedTypes": ["electric_vehicle_charging_station"],
        "maxResultCount": 20,
        "rankPreference": "DISTANCE",
        "locationRestriction": {
            "circle": {
                "center": {
                    "latitude": lat,
                    "longitude": lng
                },
                "radius": 5000.0
            }
        }
    }

    try:
        response = requests.post(
            url,
            headers=headers,
            json=body,
            timeout=10
        )

        response.raise_for_status()
        data = response.json()

    except requests.RequestException as e:
        return jsonify({
            "message": "Failed to fetch charging stations",
            "error": str(e)
        }), 500

    places = data.get("places", [])

    stations = []

    for idx, place in enumerate(places):

        rng = random.Random(place.get("id", str(idx)))

        status = rng.choice([
            "available",
            "available",
            "charging",
            "offline"
        ])

        total_plugs = rng.randint(2, 12)

        available_plugs = (
            rng.randint(1, total_plugs)
            if status == "available"
            else 0
        )

        speed = rng.choice([11, 22, 50, 150, 250])

        station = {
            "id": idx + 1,
            "name": place.get("displayName", {}).get("text", "Unknown Station"),
            "lat": place.get("location", {}).get("latitude"),
            "lng": place.get("location", {}).get("longitude"),
            "address": place.get("formattedAddress", ""),
            "rating": place.get("rating"),
            "status": status,
            "availablePlugs": available_plugs,
            "totalPlugs": total_plugs,
            "speed": speed,
            "type": "DC Fast" if speed >= 50 else "Level 2",
            "connector": rng.choice([
                "CCS",
                "CHAdeMO",
                "J1772",
                "Tesla NACS"
            ]),
            "price": round(rng.uniform(0.15, 0.49), 2),
            "amenities": [
                "Food",
                "Restrooms"
            ],
            "place_id": place.get("id"),
            "evChargeOptions": place.get("evChargeOptions"),
            "googleTypes": place.get("types", []),
            "googlePrimaryType": place.get("primaryType")
        }

        stations.append(station)

    return jsonify(stations)