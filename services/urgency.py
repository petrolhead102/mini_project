"""
Charging Urgency Score Service.
Computes a mathematically rigorous urgency score (0-100) combining:
- Buffer ratio between remaining driving range and route distance to the nearest station.
- State of Charge (SoC / battery percentage).
- Safety margin cushion.

Thresholds:
- Critical: 80 - 100
- High:     60 - 79
- Moderate: 30 - 59
- Low:       0 - 29
"""

import math
from typing import Dict, Any, Optional


class ChargingUrgencyService:
    # Configurable threshold defaults
    THRESHOLD_CRITICAL = 80.0
    THRESHOLD_HIGH = 60.0
    THRESHOLD_MODERATE = 30.0

    WEIGHT_RANGE_BUFFER = 0.70
    WEIGHT_SOC = 0.30
    DECAY_RATE_K = 0.55  # Exponential sensitivity parameter for buffer decay

    @classmethod
    def calculate_urgency(
        cls,
        remaining_range_km: float,
        battery_percentage: float,
        nearest_station_distance_km: Optional[float],
        thresholds: Optional[Dict[str, float]] = None
    ) -> Dict[str, Any]:
        """
        Calculates urgency score and provides a transparent human-readable explanation.
        """
        thresh_crit = thresholds.get("critical", cls.THRESHOLD_CRITICAL) if thresholds else cls.THRESHOLD_CRITICAL
        thresh_high = thresholds.get("high", cls.THRESHOLD_HIGH) if thresholds else cls.THRESHOLD_HIGH
        thresh_mod = thresholds.get("moderate", cls.THRESHOLD_MODERATE) if thresholds else cls.THRESHOLD_MODERATE

        # Edge case: No stations reachable or known
        if nearest_station_distance_km is None or nearest_station_distance_km < 0:
            return {
                "urgency_score": 100.0,
                "urgency_level": "Critical",
                "buffer_ratio": 0.0,
                "range_urgency_component": 100.0,
                "soc_urgency_component": round(100.0 - battery_percentage, 1),
                "is_critical_or_high": True,
                "explanation": (
                    f"CRITICAL: No reachable charging stations found within the remaining range of {remaining_range_km} km. "
                    f"Vehicle is at immediate risk of stranding."
                )
            }

        # Calculate buffer ratio: (Remaining Range) / (Nearest Station Distance)
        effective_dist = max(0.2, nearest_station_distance_km)
        buffer_ratio = remaining_range_km / effective_dist

        # Range buffer score (0 - 100):
        # When buffer <= 1.0, vehicle cannot safely reach station -> 100
        # When buffer > 1.0, decays exponentially based on buffer surplus
        if buffer_ratio <= 1.0:
            range_component = 100.0
        else:
            surplus = buffer_ratio - 1.0
            range_component = 100.0 * math.exp(-cls.DECAY_RATE_K * surplus)
            range_component = max(0.0, min(100.0, range_component))

        # SoC component (0 - 100): (100 - Battery%)
        soc_component = max(0.0, min(100.0, 100.0 - battery_percentage))

        # Blended Urgency Score:
        raw_score = (cls.WEIGHT_RANGE_BUFFER * range_component) + (cls.WEIGHT_SOC * soc_component)
        final_score = round(max(0.0, min(100.0, raw_score)), 1)

        # Categorization
        if final_score >= thresh_crit:
            level = "Critical"
        elif final_score >= thresh_high:
            level = "High"
        elif final_score >= thresh_mod:
            level = "Moderate"
        else:
            level = "Low"

        is_critical_or_high = final_score >= thresh_high

        # Detailed explanation rationale
        headroom_km = round(remaining_range_km - nearest_station_distance_km, 1)
        if level == "Critical":
            explanation = (
                f"Critical Urgency ({final_score}/100): Remaining range ({remaining_range_km} km) is dangerously close "
                f"to the nearest station ({nearest_station_distance_km} km), leaving only {headroom_km} km margin "
                f"(buffer ratio: {round(buffer_ratio, 2)}x, battery: {battery_percentage}%). "
                f"Prioritizing nearest station and immediate travel time over queue lengths or reward points."
            )
        elif level == "High":
            explanation = (
                f"High Urgency ({final_score}/100): Remaining range ({remaining_range_km} km) allows limited margin "
                f"over the nearest station distance ({nearest_station_distance_km} km, buffer ratio: {round(buffer_ratio, 2)}x, "
                f"battery: {battery_percentage}%). Route safety and rapid arrival take precedence."
            )
        elif level == "Moderate":
            explanation = (
                f"Moderate Urgency ({final_score}/100): Vehicle has a comfortable range cushion of {headroom_km} km "
                f"(buffer ratio: {round(buffer_ratio, 2)}x, battery: {battery_percentage}%). "
                f"Recommendation balances travel distance with expected queue waiting times."
            )
        else:
            explanation = (
                f"Low Urgency ({final_score}/100): Healthy battery level ({battery_percentage}%) and ample range "
                f"({remaining_range_km} km vs nearest {nearest_station_distance_km} km, buffer ratio: {round(buffer_ratio, 2)}x). "
                f"Eligible for incentive reward points by opting for less congested stations."
            )

        return {
            "urgency_score": final_score,
            "urgency_level": level,
            "buffer_ratio": round(buffer_ratio, 2),
            "range_headroom_km": headroom_km,
            "range_urgency_component": round(range_component, 1),
            "soc_urgency_component": round(soc_component, 1),
            "is_critical_or_high": is_critical_or_high,
            "explanation": explanation,
            "formula_parameters": {
                "weight_range": cls.WEIGHT_RANGE_BUFFER,
                "weight_soc": cls.WEIGHT_SOC,
                "decay_k": cls.DECAY_RATE_K,
                "thresholds": {
                    "critical": thresh_crit,
                    "high": thresh_high,
                    "moderate": thresh_mod
                }
            }
        }
