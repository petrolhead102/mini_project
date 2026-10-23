"""
Multi-Criteria Station Recommendation and Ranking Service.
Features:
- Configurable weighted multi-factor scoring model.
- Transparent normalization of travel time, traffic delays, predicted waiting time,
  plug availability, and price.
- Dynamic urgency-adaptive weighting:
    * High/Critical urgency strongly prioritizes travel distance/time and reachability.
    * Low/Moderate urgency trades off moderate travel distance for significantly lower waiting times.
- Explicit explanation generation for recommended and alternative stations.
- Full traceability of data sources and unknown values.
"""

from typing import List, Dict, Any, Optional
from services.forecasting import CongestionForecastingService


class StationRankingService:
    @staticmethod
    def get_urgency_weights(urgency_level: str) -> Dict[str, float]:
        """
        Dynamically adjusts weights based on vehicle urgency level.
        All weights sum to 1.0.
        """
        if urgency_level == "Critical":
            return {
                "travel_time": 0.85,
                "waiting_time": 0.10,
                "plug_availability": 0.05,
                "price": 0.00
            }
        elif urgency_level == "High":
            return {
                "travel_time": 0.70,
                "waiting_time": 0.20,
                "plug_availability": 0.10,
                "price": 0.00
            }
        elif urgency_level == "Moderate":
            return {
                "travel_time": 0.45,
                "waiting_time": 0.35,
                "plug_availability": 0.15,
                "price": 0.05
            }
        else:  # Low
            return {
                "travel_time": 0.30,
                "waiting_time": 0.45,
                "plug_availability": 0.15,
                "price": 0.10
            }

    @classmethod
    def rank_stations(
        cls,
        reachable_stations: List[Dict[str, Any]],
        urgency_data: Dict[str, Any],
        custom_weights: Optional[Dict[str, float]] = None
    ) -> Dict[str, Any]:
        """
        Ranks candidate reachable stations from best to worst.
        Higher composite score (0-100) indicates a better recommendation.
        """
        if not reachable_stations:
            return {
                "recommended_station": None,
                "ranked_stations": [],
                "weights_used": {},
                "explanation": "No reachable stations available to rank."
            }

        urgency_level = urgency_data.get("urgency_level", "Moderate")
        weights = custom_weights or cls.get_urgency_weights(urgency_level)

        # Step 1: Augment stations with congestion forecasts if not already attached
        for st in reachable_stations:
            st_id = str(st.get("id") or st.get("place_id") or "1")
            if "predicted_waiting_time_mins" not in st:
                fc = CongestionForecastingService.forecast_congestion(
                    station_id=st_id,
                    horizon_hours=1,
                    auto_seed_synthetic=True,
                    total_plugs=st.get("totalPlugs", 4)
                )
                st["predicted_waiting_time_mins"] = fc.get("predicted_waiting_time_mins", 0.0)
                st["predicted_queue_length"] = fc.get("current_queue_length", 0)
                st["forecast_data_source"] = fc.get("data_source_label", "Forecast Baseline")
                st["is_synthetic_forecast"] = fc.get("is_synthetic_data", True)
                st["forecast_method"] = fc.get("forecasting_method", "EMA")

        # Step 2: Extract min and max values for normalization
        travel_times = [float(s.get("estimated_travel_time_mins", 0.0)) + float(s.get("traffic_delay_mins", 0.0)) for s in reachable_stations]
        wait_times = [float(s.get("predicted_waiting_time_mins", 0.0)) for s in reachable_stations]
        prices = [float(s.get("price", 0.25)) for s in reachable_stations]

        min_t, max_t = min(travel_times), max(travel_times)
        min_w, max_w = min(wait_times), max(wait_times)
        min_p, max_p = min(prices), max(prices)

        # Step 3: Compute normalized costs and composite score for each station
        scored_stations = []

        for st in reachable_stations:
            st_copy = dict(st)
            tot_travel_time = float(st.get("estimated_travel_time_mins", 0.0)) + float(st.get("traffic_delay_mins", 0.0))
            pred_wait = float(st.get("predicted_waiting_time_mins", 0.0))
            price_val = float(st.get("price", 0.25))

            # Factor 1: Travel time cost (0.0 to 1.0, where 0 is minimum/best)
            norm_t = 0.0 if max_t == min_t else (tot_travel_time - min_t) / max(0.1, (max_t - min_t))

            # Factor 2: Waiting time cost (0.0 to 1.0)
            norm_w = 0.0 if max_w == min_w else (pred_wait - min_w) / max(0.1, (max_w - min_w))

            # Factor 3: Plug availability cost (0.0 = fully open, 1.0 = fully occupied)
            avail_plugs = st.get("availablePlugs")
            total_plugs = st.get("totalPlugs")
            is_avail_known = (avail_plugs is not None and total_plugs is not None and total_plugs > 0)
            if is_avail_known:
                norm_a = max(0.0, min(1.0, 1.0 - (avail_plugs / total_plugs)))
            else:
                norm_a = 0.5  # Neutral assumption when status unknown

            # Factor 4: Price cost (0.0 to 1.0)
            norm_p = 0.0 if max_p == min_p else (price_val - min_p) / max(0.01, (max_p - min_p))

            # Composite cost (0.0 = best, 1.0 = worst)
            composite_cost = (
                weights["travel_time"] * norm_t +
                weights["waiting_time"] * norm_w +
                weights["plug_availability"] * norm_a +
                weights["price"] * norm_p
            )

            # Suitability Score (0 to 100, where higher is better)
            score = round(max(0.0, min(100.0, (1.0 - composite_cost) * 100.0)), 1)

            st_copy["composite_score"] = score
            st_copy["cost_factors"] = {
                "normalized_travel_time": round(norm_t, 3),
                "normalized_waiting_time": round(norm_w, 3),
                "normalized_availability": round(norm_a, 3),
                "normalized_price": round(norm_p, 3),
                "is_availability_known": is_avail_known
            }
            scored_stations.append(st_copy)

        # Step 4: Sort descending by score
        scored_stations.sort(key=lambda s: s["composite_score"], reverse=True)

        # Step 5: Assign rankings and craft human-readable explanations
        recommended = scored_stations[0]
        rec_dist = recommended.get("route_distance_km", 0.0)
        rec_time = recommended.get("estimated_travel_time_mins", 0.0)
        rec_wait = recommended.get("predicted_waiting_time_mins", 0.0)

        for rank_idx, st in enumerate(scored_stations):
            st["rank"] = rank_idx + 1
            if rank_idx == 0:
                if urgency_level in ["Critical", "High"]:
                    st["rank_explanation"] = (
                        f"Top Recommendation (Score: {st['composite_score']}/100): "
                        f"Fastest safe option ({rec_dist} km, ~{rec_time} mins drive). "
                        f"Prioritized due to {urgency_level} vehicle urgency to guarantee reachability."
                    )
                else:
                    if rec_wait < 5.0 and rec_time > min_t:
                        saved_wait = round(max_w - rec_wait, 1)
                        st["rank_explanation"] = (
                            f"Top Recommendation (Score: {st['composite_score']}/100): "
                            f"Optimal overall balance for {urgency_level} urgency EV. "
                            f"Trade-off: driving ~{round(rec_time - min_t, 1)} extra mins saves ~{saved_wait} mins of queue waiting."
                        )
                    else:
                        st["rank_explanation"] = (
                            f"Top Recommendation (Score: {st['composite_score']}/100): "
                            f"Provides best combined score of drive time ({rec_time} mins) and queue time ({rec_wait} mins)."
                        )
            else:
                dist_diff = round(st.get("route_distance_km", 0.0) - rec_dist, 1)
                wait_diff = round(st.get("predicted_waiting_time_mins", 0.0) - rec_wait, 1)
                st["rank_explanation"] = (
                    f"Rank #{rank_idx + 1} (Score: {st['composite_score']}/100): "
                    f"Distance is {abs(dist_diff)} km {'more' if dist_diff >= 0 else 'less'}, "
                    f"predicted wait time is {abs(wait_diff)} mins {'longer' if wait_diff >= 0 else 'shorter'} than top choice."
                )

        return {
            "recommended_station": recommended,
            "ranked_stations": scored_stations,
            "urgency_level": urgency_level,
            "weights_used": weights,
            "selection_summary": recommended.get("rank_explanation", "")
        }
