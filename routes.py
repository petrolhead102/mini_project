from flask import Blueprint, jsonify, g, request, current_app
import requests
import random

from decorators import login_required

main = Blueprint("main", __name__)


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
    lat = float(request.args.get("lat", 37.7749))
    lng = float(request.args.get("lng", -122.4194))

    api_key = current_app.config.get("GOOGLE_MAPS_KEY")
    if not api_key:
        return jsonify({"message": "Google Maps API key not configured"}), 500

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
                "radius": 10000.0
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

    # Keep only EV charging stations if Google provides type information.
    filtered_places = []

    for place in places:
        types = place.get("types", [])

        if (
            "electric_vehicle_charging_station" in types
            or place.get("primaryType") == "electric_vehicle_charging_station"
        ):
            filtered_places.append(place)

    # If Google didn't classify any places correctly,
    # fall back to all text search results.
    if filtered_places:
        places = filtered_places

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