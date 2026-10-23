"""
Spatial indexing and geodesic distance calculation service.
Provides:
- Haversine great-circle distance in kilometers.
- 3D Cartesian KD-Tree for spherical spatial queries.
- Road network route distance & travel time estimation with clear data source tagging.
"""

import math
from typing import List, Dict, Any, Tuple, Optional
import numpy as np
from scipy.spatial import KDTree

EARTH_RADIUS_KM = 6371.0088
DEFAULT_CIRCUITY_FACTOR = 1.25  # Standard urban-suburban road network tortuosity factor
DEFAULT_URBAN_SPEED_KMH = 35.0  # Conservative urban EV driving speed in km/h


def haversine_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Computes exact great-circle distance between two GPS coordinates using the Haversine formula.
    Returns distance in kilometers.
    """
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (math.sin(delta_phi / 2.0) ** 2 +
         math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return EARTH_RADIUS_KM * c


def lat_lon_to_cartesian_3d(lat: float, lon: float) -> Tuple[float, float, float]:
    """
    Converts latitude and longitude (degrees) into 3D Cartesian coordinates (x, y, z)
    on the Earth sphere with radius R in kilometers.
    """
    lat_r = math.radians(lat)
    lon_r = math.radians(lon)
    x = EARTH_RADIUS_KM * math.cos(lat_r) * math.cos(lon_r)
    y = EARTH_RADIUS_KM * math.cos(lat_r) * math.sin(lon_r)
    z = EARTH_RADIUS_KM * math.sin(lat_r)
    return (x, y, z)


class StationSpatialIndex:
    """
    High-performance 3D KD-Tree spatial index for charging stations.
    Guarantees true geodesic Euclidean accuracy without degree-to-km distortions.
    """

    def __init__(self, stations: List[Dict[str, Any]]):
        self.stations = stations
        self.coords_3d = []
        self.valid_indices = []

        for idx, station in enumerate(stations):
            lat = station.get("lat")
            lng = station.get("lng")
            if lat is not None and lng is not None:
                try:
                    lat_f = float(lat)
                    lng_f = float(lng)
                    self.coords_3d.append(lat_lon_to_cartesian_3d(lat_f, lng_f))
                    self.valid_indices.append(idx)
                except (ValueError, TypeError):
                    continue

        if self.coords_3d:
            self.kdtree = KDTree(np.array(self.coords_3d))
        else:
            self.kdtree = None

    def query_nearest(self, lat: float, lon: float, k: int = 5) -> List[Tuple[Dict[str, Any], float]]:
        """
        Finds the k nearest stations to (lat, lon).
        Returns list of (station_dict, distance_km).
        """
        if not self.kdtree or not self.valid_indices:
            return []

        qx, qy, qz = lat_lon_to_cartesian_3d(lat, lon)
        actual_k = min(k, len(self.coords_3d))
        distances_chord, indices = self.kdtree.query([qx, qy, qz], k=actual_k)

        if actual_k == 1:
            distances_chord = [distances_chord]
            indices = [indices]

        results = []
        for chord_d, tree_idx in zip(distances_chord, indices):
            if tree_idx >= len(self.valid_indices):
                continue
            original_idx = self.valid_indices[tree_idx]
            station = self.stations[original_idx]
            # Convert 3D Euclidean chord distance back to great-circle distance
            sin_half_theta = min(1.0, chord_d / (2.0 * EARTH_RADIUS_KM))
            great_circle_km = 2.0 * EARTH_RADIUS_KM * math.asin(sin_half_theta)
            results.append((station, round(great_circle_km, 2)))

        return results

    def query_radius(self, lat: float, lon: float, radius_km: float) -> List[Tuple[Dict[str, Any], float]]:
        """
        Finds all stations within radius_km.
        Returns list of (station_dict, distance_km) sorted by distance.
        """
        if not self.kdtree or not self.valid_indices:
            return []

        qx, qy, qz = lat_lon_to_cartesian_3d(lat, lon)
        # Convert geodesic radius to 3D Euclidean chord distance
        chord_radius = 2.0 * EARTH_RADIUS_KM * math.sin(radius_km / (2.0 * EARTH_RADIUS_KM))
        indices = self.kdtree.query_ball_point([qx, qy, qz], r=chord_radius)

        results = []
        for tree_idx in indices:
            original_idx = self.valid_indices[tree_idx]
            station = self.stations[original_idx]
            dist_km = haversine_distance_km(lat, lon, float(station["lat"]), float(station["lng"]))
            if dist_km <= radius_km:
                results.append((station, round(dist_km, 2)))

        results.sort(key=lambda item: item[1])
        return results


def calculate_route_metrics(
    origin_lat: float,
    origin_lng: float,
    dest_lat: float,
    dest_lng: float,
    circuity_factor: float = DEFAULT_CIRCUITY_FACTOR,
    avg_speed_kmh: float = DEFAULT_URBAN_SPEED_KMH,
    external_route_data: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Computes distance and estimated travel time between EV and station.
    Prioritizes real road-network data when available, with documented fallback.
    """
    straight_line_km = haversine_distance_km(origin_lat, origin_lng, dest_lat, dest_lng)

    if external_route_data and "distance_km" in external_route_data and "duration_mins" in external_route_data:
        return {
            "straight_line_km": round(straight_line_km, 2),
            "route_distance_km": round(external_route_data["distance_km"], 2),
            "estimated_travel_time_mins": round(external_route_data["duration_mins"], 1),
            "traffic_delay_mins": round(external_route_data.get("traffic_delay_mins", 0.0), 1),
            "distance_type": "google_maps_route",
            "is_estimated_route": False,
            "data_source_label": "Live Google Maps Routing API"
        }

    # Model-based estimation using urban road network circuity
    estimated_route_km = straight_line_km * circuity_factor
    travel_time_mins = (estimated_route_km / avg_speed_kmh) * 60.0

    return {
        "straight_line_km": round(straight_line_km, 2),
        "route_distance_km": round(estimated_route_km, 2),
        "estimated_travel_time_mins": round(travel_time_mins, 1),
        "traffic_delay_mins": 0.0,
        "distance_type": "estimated_road_network",
        "is_estimated_route": True,
        "data_source_label": f"Estimated Road Distance (Circuity factor: {circuity_factor}x, Speed: {avg_speed_kmh} km/h)"
    }
