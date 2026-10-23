"""
EV input validation and Reachability Filtering Service.
Features:
- Rigorous validation of battery percentage, remaining range, capacity, and efficiency.
- Safe range calculation applying configurable safety margins.
- Road-network aware reachability filtering.
- Operating status and connector compatibility checks.
- Detailed exclusion reasons and reachable/unreachable breakdowns.
"""

from typing import Dict, Any, List, Tuple, Optional
from services.spatial_index import calculate_route_metrics


class EVInputValidator:
    """Validates user and vehicle configuration inputs."""

    @staticmethod
    def validate_and_normalize(params: Dict[str, Any]) -> Dict[str, Any]:
        errors = []

        # Current Battery Percentage (0-100)
        try:
            battery_pct = float(params.get("battery_percentage", 50.0))
            if not (0.0 <= battery_pct <= 100.0):
                errors.append("Battery percentage must be between 0 and 100%.")
        except (ValueError, TypeError):
            errors.append("Battery percentage must be a valid number.")
            battery_pct = 50.0

        # Optional Battery Capacity (kWh)
        battery_capacity_kwh = None
        if "battery_capacity_kwh" in params and params["battery_capacity_kwh"] is not None and str(params["battery_capacity_kwh"]).strip() != "":
            try:
                battery_capacity_kwh = float(params["battery_capacity_kwh"])
                if battery_capacity_kwh <= 0:
                    errors.append("Battery capacity must be greater than 0 kWh.")
            except (ValueError, TypeError):
                errors.append("Battery capacity must be a valid number.")

        # Optional Vehicle Efficiency (km/kWh)
        vehicle_efficiency = None
        if "vehicle_efficiency_km_per_kwh" in params and params["vehicle_efficiency_km_per_kwh"] is not None and str(params["vehicle_efficiency_km_per_kwh"]).strip() != "":
            try:
                vehicle_efficiency = float(params["vehicle_efficiency_km_per_kwh"])
                if vehicle_efficiency <= 0:
                    errors.append("Vehicle efficiency must be greater than 0 km/kWh.")
            except (ValueError, TypeError):
                errors.append("Vehicle efficiency must be a valid number.")

        # Remaining Driving Range (km)
        remaining_range_km = None
        if "remaining_range_km" in params and params["remaining_range_km"] is not None and str(params["remaining_range_km"]).strip() != "":
            try:
                remaining_range_km = float(params["remaining_range_km"])
                if remaining_range_km < 0:
                    errors.append("Remaining driving range cannot be negative.")
            except (ValueError, TypeError):
                errors.append("Remaining range must be a valid number.")
        
        # If remaining range is not provided directly, compute from capacity & efficiency if both exist
        if remaining_range_km is None:
            if battery_capacity_kwh and vehicle_efficiency:
                remaining_range_km = round((battery_pct / 100.0) * battery_capacity_kwh * vehicle_efficiency, 2)
            else:
                # Default calculation based on standard compact EV (60 kWh capacity, 5.5 km/kWh efficiency)
                # Clearly documented baseline
                default_cap = 60.0
                default_eff = 5.5
                remaining_range_km = round((battery_pct / 100.0) * default_cap * default_eff, 2)

        # Vehicle GPS Coordinates
        try:
            lat = float(params.get("lat", 37.7749))
            lng = float(params.get("lng", -122.4194))
            if not (-90.0 <= lat <= 90.0):
                errors.append("Latitude must be between -90 and 90 degrees.")
            if not (-180.0 <= lng <= 180.0):
                errors.append("Longitude must be between -180 and 180 degrees.")
        except (ValueError, TypeError):
            errors.append("Location coordinates must be valid numbers.")
            lat, lng = 37.7749, -122.4194

        # Safety Margin (0% to 50%)
        try:
            safety_margin_pct = float(params.get("safety_margin_pct", 15.0))
            if not (0.0 <= safety_margin_pct <= 50.0):
                errors.append("Safety margin percentage must be between 0% and 50%.")
        except (ValueError, TypeError):
            errors.append("Safety margin must be a number.")
            safety_margin_pct = 15.0

        connector_preference = params.get("connector_preference", "all")
        if connector_preference:
            connector_preference = str(connector_preference).strip()

        return {
            "is_valid": len(errors) == 0,
            "errors": errors,
            "validated_data": {
                "battery_percentage": round(battery_pct, 1),
                "remaining_range_km": round(remaining_range_km, 2),
                "battery_capacity_kwh": battery_capacity_kwh,
                "vehicle_efficiency_km_per_kwh": vehicle_efficiency,
                "lat": lat,
                "lng": lng,
                "safety_margin_pct": safety_margin_pct,
                "connector_preference": connector_preference
            }
        }


class ReachabilityFilterService:
    """Filters candidate charging stations based on range, safety margin, and compatibility."""

    @staticmethod
    def calculate_safe_range(remaining_range_km: float, safety_margin_pct: float) -> float:
        """
        Formula: Safe Range = Remaining Range * (1 - Safety Margin % / 100)
        """
        factor = max(0.0, 1.0 - (safety_margin_pct / 100.0))
        return round(remaining_range_km * factor, 2)

    @classmethod
    def filter_stations(
        cls,
        stations: List[Dict[str, Any]],
        ev_state: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Filters stations into reachable and unreachable sets with comprehensive diagnostics.
        """
        origin_lat = ev_state["lat"]
        origin_lng = ev_state["lng"]
        remaining_range_km = ev_state["remaining_range_km"]
        safety_margin_pct = ev_state.get("safety_margin_pct", 15.0)
        connector_pref = ev_state.get("connector_preference", "all")

        safe_range_km = cls.calculate_safe_range(remaining_range_km, safety_margin_pct)

        reachable_stations = []
        unreachable_stations = []

        for station in stations:
            station_copy = dict(station)
            st_lat = station_copy.get("lat")
            st_lng = station_copy.get("lng")

            if st_lat is None or st_lng is None:
                station_copy["exclusion_reason"] = "Missing GPS coordinates"
                unreachable_stations.append(station_copy)
                continue

            try:
                st_lat_f = float(st_lat)
                st_lng_f = float(st_lng)
            except (ValueError, TypeError):
                station_copy["exclusion_reason"] = "Invalid GPS coordinates"
                unreachable_stations.append(station_copy)
                continue

            # Calculate route metrics (road network circuity or external routing)
            route_info = calculate_route_metrics(origin_lat, origin_lng, st_lat_f, st_lng_f)
            station_copy.update(route_info)

            # Evaluation 1: Station operational status
            st_status = str(station_copy.get("status", "unknown")).lower()
            if st_status in ["offline", "maintenance", "closed", "out_of_service"]:
                station_copy["exclusion_reason"] = f"Station is currently offline ({st_status})"
                station_copy["is_reachable"] = False
                unreachable_stations.append(station_copy)
                continue

            # Evaluation 2: Connector compatibility
            st_connector = station_copy.get("connector", "")
            if connector_pref and connector_pref.lower() not in ["all", "any", ""]:
                # Check for match (case-insensitive substring or equality)
                if connector_pref.lower() not in st_connector.lower():
                    station_copy["exclusion_reason"] = (
                        f"Connector incompatible (Station offers {st_connector}, EV requires {connector_pref})"
                    )
                    station_copy["is_reachable"] = False
                    unreachable_stations.append(station_copy)
                    continue

            # Evaluation 3: Safe range reachability check
            route_dist = station_copy["route_distance_km"]
            if route_dist > safe_range_km:
                station_copy["exclusion_reason"] = (
                    f"Exceeds safe range (Route distance {route_dist} km > Safe range {safe_range_km} km. "
                    f"Total remaining range is {remaining_range_km} km with {safety_margin_pct}% safety margin)"
                )
                station_copy["is_reachable"] = False
                unreachable_stations.append(station_copy)
                continue

            # Station passed all reachability criteria
            station_copy["is_reachable"] = True
            station_copy["safe_range_headroom_km"] = round(safe_range_km - route_dist, 2)
            reachable_stations.append(station_copy)

        # Sort reachable stations by road distance
        reachable_stations.sort(key=lambda s: s["route_distance_km"])

        has_warning = len(reachable_stations) == 0
        warning_message = ""
        if has_warning:
            warning_message = (
                f"Warning: No suitable charging stations found within the vehicle's safe range of {safe_range_km} km "
                f"(Remaining range: {remaining_range_km} km with {safety_margin_pct}% safety margin). "
                f"Consider adjusting the route or reducing non-essential energy consumption."
            )

        return {
            "safe_range_km": safe_range_km,
            "safety_margin_pct": safety_margin_pct,
            "total_candidates_evaluated": len(stations),
            "reachable_count": len(reachable_stations),
            "unreachable_count": len(unreachable_stations),
            "warning": warning_message if has_warning else None,
            "reachable_stations": reachable_stations,
            "unreachable_stations": unreachable_stations
        }
