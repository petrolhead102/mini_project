"""
Min-Cost Flow Optimization Service for Multi-Vehicle EV Slot Allocation.
Features:
- Solves global multi-EV assignment to distributed charging stations simultaneously.
- Graph representation:
    * Source (S) with supply = number of vehicles (N).
    * Vehicle nodes (V_i) with supply = 0.
    * Station nodes (U_j) with supply = 0 and capacity = available slots C_j.
    * Sink (T) with demand = N.
    * Feasible edges (V_i -> U_j) constrained by reachability, connector compatibility,
      and station operational status.
    * Edge cost = Travel time + Predicted wait time - Urgency priority.
    * Fallback unassigned edge (V_i -> T) with high penalty to guarantee feasibility.
- Guarantees:
    1. Each vehicle receives at most one assigned station.
    2. Station capacity constraints are strictly obeyed.
    3. Vehicles cannot be assigned to unreachable or incompatible stations.
    4. Higher urgency vehicles receive priority matching to nearest viable slots.
"""

from typing import List, Dict, Any, Tuple, Optional
import networkx as nx
from services.spatial_index import calculate_route_metrics
from services.reachability import ReachabilityFilterService
from services.urgency import ChargingUrgencyService


class MinCostFlowAllocator:
    UNASSIGNED_PENALTY_COST = 10000

    @classmethod
    def allocate_vehicles(
        cls,
        vehicles: List[Dict[str, Any]],
        stations: List[Dict[str, Any]],
        safety_margin_pct: float = 15.0
    ) -> Dict[str, Any]:
        """
        Executes min-cost flow optimization to assign a fleet of EVs to stations.
        """
        if not vehicles:
            return {
                "success": True,
                "assignments": [],
                "unassigned_vehicles": [],
                "total_cost": 0,
                "message": "No vehicles provided for allocation."
            }

        if not stations:
            return {
                "success": False,
                "assignments": [],
                "unassigned_vehicles": vehicles,
                "total_cost": 0,
                "message": "No candidate stations available."
            }

        num_vehicles = len(vehicles)
        G = nx.DiGraph()

        # Super source and super sink
        source_node = "SOURCE"
        sink_node = "SINK"

        G.add_node(source_node, demand=-num_vehicles)
        G.add_node(sink_node, demand=num_vehicles)

        # Precompute vehicle urgency and safe range
        vehicle_meta = {}
        for idx, v in enumerate(vehicles):
            v_id = v.get("vehicle_id", f"EV-{idx + 1}")
            battery_pct = float(v.get("battery_percentage", 50.0))
            rem_range = float(v.get("remaining_range_km", 100.0))
            v_lat = float(v.get("lat", 37.7749))
            v_lng = float(v.get("lng", -122.4194))
            v_conn = str(v.get("connector_preference", "all")).strip()

            # Find nearest station straight-line for urgency estimation
            nearest_dist = None
            for s in stations:
                if s.get("lat") and s.get("lng"):
                    d = calculate_route_metrics(v_lat, v_lng, float(s["lat"]), float(s["lng"]))["route_distance_km"]
                    if nearest_dist is None or d < nearest_dist:
                        nearest_dist = d

            urg_info = ChargingUrgencyService.calculate_urgency(
                remaining_range_km=rem_range,
                battery_percentage=battery_pct,
                nearest_station_distance_km=nearest_dist
            )

            safe_range = ReachabilityFilterService.calculate_safe_range(rem_range, safety_margin_pct)

            vehicle_meta[v_id] = {
                "raw": v,
                "lat": v_lat,
                "lng": v_lng,
                "battery_pct": battery_pct,
                "remaining_range": rem_range,
                "safe_range": safe_range,
                "connector_preference": v_conn,
                "urgency_score": urg_info["urgency_score"],
                "urgency_level": urg_info["urgency_level"]
            }

            v_node = f"VEH_{v_id}"
            G.add_node(v_node, demand=0)
            # Edge from source to vehicle with capacity 1
            G.add_edge(source_node, v_node, capacity=1, weight=0)

            # Fallback edge to sink in case no station capacity or reachability
            G.add_edge(v_node, sink_node, capacity=1, weight=cls.UNASSIGNED_PENALTY_COST)

        # Station capacity and node setup
        station_meta = {}
        for idx, s in enumerate(stations):
            s_id = str(s.get("id") or s.get("place_id") or f"ST-{idx + 1}")
            status = str(s.get("status", "available")).lower()
            avail_slots = int(s.get("availablePlugs", 1)) if status == "available" else 0
            s_lat = float(s.get("lat", 0.0))
            s_lng = float(s.get("lng", 0.0))
            s_conn = str(s.get("connector", "CCS")).strip()
            pred_wait = float(s.get("predicted_waiting_time_mins", 0.0))

            station_meta[s_id] = {
                "raw": s,
                "name": s.get("name", f"Station {s_id}"),
                "lat": s_lat,
                "lng": s_lng,
                "connector": s_conn,
                "capacity": avail_slots,
                "predicted_wait": pred_wait,
                "status": status
            }

            s_node = f"STA_{s_id}"
            G.add_node(s_node, demand=0)
            # Edge from station to sink with capacity = available slots
            if avail_slots > 0:
                G.add_edge(s_node, sink_node, capacity=avail_slots, weight=0)

        # Feasible assignment edges (Vehicle -> Station)
        feasible_edge_count = 0
        for v_id, v_data in vehicle_meta.items():
            v_node = f"VEH_{v_id}"
            for s_id, s_data in station_meta.items():
                if s_data["capacity"] <= 0 or s_data["status"] in ["offline", "maintenance"]:
                    continue

                # Check connector compatibility
                if v_data["connector_preference"] not in ["all", "any", ""]:
                    if v_data["connector_preference"].lower() not in s_data["connector"].lower():
                        continue

                # Check reachability
                route_metrics = calculate_route_metrics(v_data["lat"], v_data["lng"], s_data["lat"], s_data["lng"])
                route_dist = route_metrics["route_distance_km"]
                if route_dist > v_data["safe_range"]:
                    continue  # Station is unreachable within safe range

                travel_time_mins = route_metrics["estimated_travel_time_mins"]
                wait_time_mins = s_data["predicted_wait"]

                # Integer assignment cost function:
                # Cost = 10 * (TravelTime + 1.2 * WaitTime) - 0.5 * UrgencyScore
                # Higher urgency vehicles get cost deductions, prioritizing them for closer/faster slots
                raw_cost = (travel_time_mins * 10.0) + (wait_time_mins * 12.0) - (v_data["urgency_score"] * 5.0)
                int_cost = max(1, int(round(raw_cost)))

                s_node = f"STA_{s_id}"
                G.add_edge(v_node, s_node, capacity=1, weight=int_cost)
                feasible_edge_count += 1

        # Solve Min-Cost Flow
        try:
            flow_dict = nx.min_cost_flow(G)
            total_flow_cost = nx.cost_of_flow(G, flow_dict)
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "message": "Min-cost flow optimization encountered an unfeasible network configuration.",
                "assignments": [],
                "unassigned_vehicles": vehicles
            }

        assignments = []
        unassigned_vehicles = []

        for v_id, v_data in vehicle_meta.items():
            v_node = f"VEH_{v_id}"
            assigned_station_id = None

            for neighbor, flow_amt in flow_dict.get(v_node, {}).items():
                if flow_amt > 0:
                    if neighbor.startswith("STA_"):
                        assigned_station_id = neighbor.replace("STA_", "")
                        break

            if assigned_station_id:
                st_info = station_meta[assigned_station_id]
                route = calculate_route_metrics(v_data["lat"], v_data["lng"], st_info["lat"], st_info["lng"])
                assignments.append({
                    "vehicle_id": v_id,
                    "vehicle_urgency": v_data["urgency_level"],
                    "vehicle_urgency_score": v_data["urgency_score"],
                    "assigned_station_id": assigned_station_id,
                    "station_name": st_info["name"],
                    "route_distance_km": route["route_distance_km"],
                    "travel_time_mins": route["estimated_travel_time_mins"],
                    "predicted_wait_mins": st_info["predicted_wait"],
                    "station_connector": st_info["connector"]
                })
            else:
                unassigned_vehicles.append({
                    "vehicle_id": v_id,
                    "urgency_level": v_data["urgency_level"],
                    "remaining_range_km": v_data["remaining_range"],
                    "reason": "No compatible, reachable station with free capacity found"
                })

        return {
            "success": True,
            "total_vehicles": num_vehicles,
            "assigned_count": len(assignments),
            "unassigned_count": len(unassigned_vehicles),
            "assignments": assignments,
            "unassigned_vehicles": unassigned_vehicles,
            "flow_cost": total_flow_cost,
            "algorithm": "Network Simplex Min-Cost Max-Flow",
            "explanation": (
                f"Globally optimized assignments for {len(assignments)}/{num_vehicles} vehicles. "
                f"Respects individual vehicle reachability bounds, connector compatibility, "
                f"and station slot capacity constraints while prioritizing high-urgency vehicles."
            )
        }
