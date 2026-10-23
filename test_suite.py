"""
Comprehensive Test Suite for Intelligent EV Charging Slot Allocation System.
Tests:
1. EV Input validation.
2. Reachable versus unreachable stations.
3. Safety margin application.
4. Critical versus low-urgency vehicles.
5. Station ranking under different congestion conditions.
6. ARIMA / Time-series forecasting with sufficient history.
7. Forecast failures, missing data, and insufficient observations.
8. Connector compatibility and unavailable stations.
9. Min-cost flow capacity constraints and unique assignments.
10. Reward calculations and duplicate prevention.
11. Backend endpoint integration and error responses.
"""

import unittest
from datetime import datetime, timedelta, timezone
import json

from app import app
from database import db
from models import User, Session, StationUsageHistory, RewardTransaction
from services.spatial_index import haversine_distance_km, calculate_route_metrics, StationSpatialIndex
from services.reachability import EVInputValidator, ReachabilityFilterService
from services.urgency import ChargingUrgencyService
from services.forecasting import CongestionForecastingService, generate_synthetic_station_history
from services.ranking import StationRankingService
from services.min_cost_flow import MinCostFlowAllocator
from services.rewards import RewardPointsService


class TestEVChargingSystem(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        app.config["TESTING"] = True
        app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///:memory:"
        cls.client = app.test_client()
        with app.app_context():
            db.create_all()

    def setUp(self):
        with app.app_context():
            db.session.query(StationUsageHistory).delete()
            db.session.query(RewardTransaction).delete()
            db.session.query(User).delete()
            db.session.commit()

    # ---------------------------------------------------------
    # 1. INPUT VALIDATION TESTS
    # ---------------------------------------------------------
    def test_01_input_validation_valid(self):
        valid_input = {
            "battery_percentage": 45.0,
            "remaining_range_km": 150.0,
            "battery_capacity_kwh": 60.0,
            "vehicle_efficiency_km_per_kwh": 5.5,
            "lat": 37.7749,
            "lng": -122.4194,
            "safety_margin_pct": 15.0,
            "connector_preference": "CCS"
        }
        res = EVInputValidator.validate_and_normalize(valid_input)
        self.assertTrue(res["is_valid"])
        self.assertEqual(len(res["errors"]), 0)
        self.assertEqual(res["validated_data"]["battery_percentage"], 45.0)
        self.assertEqual(res["validated_data"]["remaining_range_km"], 150.0)

    def test_01_input_validation_invalid(self):
        invalid_input = {
            "battery_percentage": 150.0,  # Invalid: > 100
            "remaining_range_km": -20.0,  # Invalid: negative
            "lat": 120.0,                 # Invalid: > 90
            "safety_margin_pct": 80.0     # Invalid: > 50
        }
        res = EVInputValidator.validate_and_normalize(invalid_input)
        self.assertFalse(res["is_valid"])
        self.assertGreaterEqual(len(res["errors"]), 3)

    # ---------------------------------------------------------
    # 2. REACHABLE VS UNREACHABLE STATIONS
    # ---------------------------------------------------------
    def test_02_reachable_vs_unreachable_stations(self):
        ev_state = {
            "lat": 37.7749,
            "lng": -122.4194,
            "remaining_range_km": 20.0,
            "safety_margin_pct": 15.0,  # Safe range = 17.0 km
            "connector_preference": "all"
        }
        stations = [
            {"id": 1, "name": "Nearby", "lat": 37.7800, "lng": -122.4200, "status": "available", "connector": "CCS"},   # ~0.6 km
            {"id": 2, "name": "Faraway", "lat": 37.3382, "lng": -121.8863, "status": "available", "connector": "CCS"}  # San Jose ~67 km
        ]
        result = ReachabilityFilterService.filter_stations(stations, ev_state)
        self.assertEqual(result["reachable_count"], 1)
        self.assertEqual(result["unreachable_count"], 1)
        self.assertEqual(result["reachable_stations"][0]["id"], 1)
        self.assertIn("Exceeds safe range", result["unreachable_stations"][0]["exclusion_reason"])

    # ---------------------------------------------------------
    # 3. SAFETY MARGIN APPLICATION
    # ---------------------------------------------------------
    def test_03_safety_margin_application(self):
        # 100 km remaining range with 20% margin -> 80 km safe range
        safe_range_20 = ReachabilityFilterService.calculate_safe_range(100.0, 20.0)
        self.assertEqual(safe_range_20, 80.0)

        # 50 km remaining range with 10% margin -> 45 km safe range
        safe_range_10 = ReachabilityFilterService.calculate_safe_range(50.0, 10.0)
        self.assertEqual(safe_range_10, 45.0)

    # ---------------------------------------------------------
    # 4. CRITICAL VS LOW-URGENCY VEHICLES
    # ---------------------------------------------------------
    def test_04_urgency_scoring(self):
        # Critical vehicle: 8% battery, remaining range 12 km, nearest station 11 km
        critical_res = ChargingUrgencyService.calculate_urgency(
            remaining_range_km=12.0,
            battery_percentage=8.0,
            nearest_station_distance_km=11.0
        )
        self.assertGreaterEqual(critical_res["urgency_score"], 80.0)
        self.assertEqual(critical_res["urgency_level"], "Critical")
        self.assertTrue(critical_res["is_critical_or_high"])

        # Low urgency vehicle: 80% battery, remaining range 280 km, nearest station 3 km
        low_res = ChargingUrgencyService.calculate_urgency(
            remaining_range_km=280.0,
            battery_percentage=80.0,
            nearest_station_distance_km=3.0
        )
        self.assertLess(low_res["urgency_score"], 30.0)
        self.assertEqual(low_res["urgency_level"], "Low")
        self.assertFalse(low_res["is_critical_or_high"])

    # ---------------------------------------------------------
    # 5. STATION RANKING UNDER DIFFERENT CONGESTIONS & URGENCIES
    # ---------------------------------------------------------
    def test_05_station_ranking(self):
        reachable_stations = [
            {
                "id": 1,
                "name": "Station A (Near but Crowded)",
                "lat": 37.7750,
                "lng": -122.4190,
                "route_distance_km": 1.0,
                "estimated_travel_time_mins": 3.0,
                "traffic_delay_mins": 0.0,
                "predicted_waiting_time_mins": 45.0,  # 45 mins wait
                "availablePlugs": 0,
                "totalPlugs": 4,
                "price": 0.35
            },
            {
                "id": 2,
                "name": "Station B (Slightly further, completely free)",
                "lat": 37.7850,
                "lng": -122.4100,
                "route_distance_km": 3.0,
                "estimated_travel_time_mins": 8.0,
                "traffic_delay_mins": 0.0,
                "predicted_waiting_time_mins": 0.0,   # 0 mins wait!
                "availablePlugs": 4,
                "totalPlugs": 4,
                "price": 0.30
            }
        ]

        # Case A: Low Urgency EV should pick Station B to save 45 minutes of waiting
        low_urgency_data = {"urgency_score": 15.0, "urgency_level": "Low"}
        low_res = StationRankingService.rank_stations(reachable_stations, low_urgency_data)
        self.assertEqual(low_res["recommended_station"]["id"], 2)

        # Case B: Critical Urgency EV must pick Station A (closest distance and lowest travel time)
        crit_urgency_data = {"urgency_score": 90.0, "urgency_level": "Critical"}
        crit_res = StationRankingService.rank_stations(reachable_stations, crit_urgency_data)
        self.assertEqual(crit_res["recommended_station"]["id"], 1)

    # ---------------------------------------------------------
    # 6. TIME-SERIES FORECASTING (ARIMA / Fallback)
    # ---------------------------------------------------------
    def test_06_forecasting_with_sufficient_history(self):
        with app.app_context():
            # Seed 30 synthetic observations
            CongestionForecastingService.seed_synthetic_data(station_id="TEST_ST_1", total_plugs=4, hours=30)
            fc = CongestionForecastingService.forecast_congestion(station_id="TEST_ST_1", horizon_hours=3)
            self.assertEqual(fc["station_id"], "TEST_ST_1")
            self.assertEqual(len(fc["horizon_predictions"]), 3)
            self.assertTrue(fc["is_synthetic_data"])
            self.assertIn("Synthetic Development Dataset", fc["data_source_label"])

    # ---------------------------------------------------------
    # 7. FORECAST FAILURES, INSUFFICIENT DATA & MISSING DATA
    # ---------------------------------------------------------
    def test_07_forecasting_insufficient_data(self):
        with app.app_context():
            # Add only 3 records manually (less than minimum 15)
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            for i in range(3):
                rec = StationUsageHistory(
                    station_id="LOW_OBS_ST",
                    timestamp=now - timedelta(hours=3 - i),
                    queue_length=1,
                    waiting_time_mins=15.0,
                    occupied_plugs=2,
                    total_plugs=4,
                    is_synthetic=True
                )
                db.session.add(rec)
            db.session.commit()

            # Request forecast without auto-seeding
            fc = CongestionForecastingService.forecast_congestion(
                station_id="LOW_OBS_ST",
                horizon_hours=2,
                auto_seed_synthetic=False
            )
            self.assertTrue(fc["is_fallback"])
            self.assertIn("EMA Fallback", fc["forecasting_method"])
            self.assertIn("Insufficient observations", fc["fallback_reason"])

    # ---------------------------------------------------------
    # 8. CONNECTOR COMPATIBILITY AND OFFLINE STATIONS
    # ---------------------------------------------------------
    def test_08_connector_compatibility_and_status(self):
        ev_state = {
            "lat": 37.7749,
            "lng": -122.4194,
            "remaining_range_km": 100.0,
            "safety_margin_pct": 15.0,
            "connector_preference": "Tesla NACS"
        }
        stations = [
            {"id": 1, "name": "CCS Station", "lat": 37.7750, "lng": -122.4200, "status": "available", "connector": "CCS"},
            {"id": 2, "name": "Offline Tesla Station", "lat": 37.7760, "lng": -122.4210, "status": "offline", "connector": "Tesla NACS"},
            {"id": 3, "name": "Valid Tesla Station", "lat": 37.7770, "lng": -122.4220, "status": "available", "connector": "Tesla NACS"}
        ]
        result = ReachabilityFilterService.filter_stations(stations, ev_state)
        self.assertEqual(result["reachable_count"], 1)
        self.assertEqual(result["reachable_stations"][0]["id"], 3)
        self.assertEqual(result["unreachable_count"], 2)

        # Check exclusion reasons
        excl_reasons = [s["exclusion_reason"] for s in result["unreachable_stations"]]
        self.assertTrue(any("Connector incompatible" in r for r in excl_reasons))
        self.assertTrue(any("offline" in r for r in excl_reasons))

    # ---------------------------------------------------------
    # 9. MIN-COST FLOW CAPACITY CONSTRAINTS & UNIQUE ASSIGNMENTS
    # ---------------------------------------------------------
    def test_09_min_cost_flow_allocation(self):
        vehicles = [
            {"vehicle_id": "EV-1", "battery_percentage": 10.0, "remaining_range_km": 15.0, "lat": 37.7749, "lng": -122.4194, "connector_preference": "CCS"},
            {"vehicle_id": "EV-2", "battery_percentage": 70.0, "remaining_range_km": 180.0, "lat": 37.7749, "lng": -122.4194, "connector_preference": "CCS"},
            {"vehicle_id": "EV-3", "battery_percentage": 85.0, "remaining_range_km": 250.0, "lat": 37.7749, "lng": -122.4194, "connector_preference": "CCS"}
        ]
        # Only 2 total available slots in the area: Station 1 has 1 plug, Station 2 has 1 plug
        stations = [
            {"id": "ST-A", "name": "Station A", "lat": 37.7760, "lng": -122.4190, "status": "available", "availablePlugs": 1, "connector": "CCS", "predicted_waiting_time_mins": 0.0},
            {"id": "ST-B", "name": "Station B", "lat": 37.7850, "lng": -122.4100, "status": "available", "availablePlugs": 1, "connector": "CCS", "predicted_waiting_time_mins": 0.0}
        ]

        allocation = MinCostFlowAllocator.allocate_vehicles(vehicles, stations)
        self.assertTrue(allocation["success"])
        self.assertEqual(allocation["assigned_count"], 2)
        self.assertEqual(allocation["unassigned_count"], 1)

        # Ensure high urgency EV-1 is prioritized and receives an assignment
        assigned_ev_ids = [a["vehicle_id"] for a in allocation["assignments"]]
        self.assertIn("EV-1", assigned_ev_ids)

        # Ensure each vehicle has at most 1 assignment
        self.assertEqual(len(assigned_ev_ids), len(set(assigned_ev_ids)))

    # ---------------------------------------------------------
    # 10. REWARD CALCULATIONS AND DUPLICATE PREVENTION
    # ---------------------------------------------------------
    def test_10_reward_points_and_duplicate_prevention(self):
        with app.app_context():
            # Create a test user
            user = User(username="charger_tester", email="test@example.com", password_hash="dummyhash")
            db.session.add(user)
            db.session.commit()

            # Calculation: Low urgency EV saving 20 mins wait time
            inc = RewardPointsService.calculate_incentive(
                urgency_score=20.0,
                chosen_station_wait_mins=5.0,
                baseline_station_wait_mins=25.0,
                chosen_station_dist_km=4.0,
                safe_range_km=50.0,
                points_per_min=2.0
            )
            self.assertTrue(inc["eligible"])
            self.assertEqual(inc["points"], 40)
            self.assertEqual(inc["wait_time_saved_mins"], 20.0)

            # High urgency EV is disqualified from incentive for safety
            high_inc = RewardPointsService.calculate_incentive(
                urgency_score=85.0,
                chosen_station_wait_mins=5.0,
                baseline_station_wait_mins=25.0,
                chosen_station_dist_km=4.0,
                safe_range_km=15.0
            )
            self.assertFalse(high_inc["eligible"])

            # Test duplicate prevention (idempotency)
            token = "SESSION_TEST_TOKEN_XYZ_123"
            r1 = RewardPointsService.record_reservation_incentive(user.id, "ST-1", 40, 20.0, session_token=token)
            self.assertFalse(r1["duplicate"])

            # Repeated call with same session token
            r2 = RewardPointsService.record_reservation_incentive(user.id, "ST-1", 40, 20.0, session_token=token)
            self.assertTrue(r2["duplicate"])

            # Claim reward verification
            claim = RewardPointsService.verify_and_claim_reward(token)
            self.assertTrue(claim["success"])
            self.assertEqual(claim["transaction"]["status"], "verified")

            # Duplicate claim verification
            claim_again = RewardPointsService.verify_and_claim_reward(token)
            self.assertFalse(claim_again["success"])

    # ---------------------------------------------------------
    # 11. BACKEND ENDPOINT INTEGRATION AND RESPONSES
    # ---------------------------------------------------------
    def test_11_backend_endpoints(self):
        # GET /api/stations
        res = self.client.get("/api/stations?lat=37.7749&lng=-122.4194")
        self.assertEqual(res.status_code, 200)
        stations = res.get_json()
        self.assertIsInstance(stations, list)
        self.assertGreater(len(stations), 0)

        # POST /api/recommendations
        rec_payload = {
            "battery_percentage": 25.0,
            "remaining_range_km": 60.0,
            "lat": 37.7749,
            "lng": -122.4194,
            "safety_margin_pct": 15.0
        }
        res_rec = self.client.post("/api/recommendations", json=rec_payload)
        self.assertEqual(res_rec.status_code, 200)
        rec_data = res_rec.get_json()
        self.assertIn("recommended_station", rec_data)
        self.assertIn("urgency", rec_data)
        self.assertIn("urgency_score", rec_data["urgency"])

        # POST /api/optimization/allocate
        opt_payload = {
            "vehicles": [
                {"vehicle_id": "V1", "battery_percentage": 15.0, "remaining_range_km": 20.0, "lat": 37.7749, "lng": -122.4194},
                {"vehicle_id": "V2", "battery_percentage": 75.0, "remaining_range_km": 200.0, "lat": 37.7749, "lng": -122.4194}
            ]
        }
        res_opt = self.client.post("/api/optimization/allocate", json=opt_payload)
        self.assertEqual(res_opt.status_code, 200)
        opt_data = res_opt.get_json()
        self.assertTrue(opt_data["success"])
        self.assertEqual(opt_data["total_vehicles"], 2)


if __name__ == "__main__":
    unittest.main()
