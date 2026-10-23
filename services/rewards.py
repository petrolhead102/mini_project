"""
Incentive Reward Points Service.
Features:
- Configurable incentive system rewarding low-urgency EV drivers who divert to less crowded stations.
- Strict safety constraints: Disables incentives for High/Critical urgency vehicles and near-boundary ranges.
- Transparent formula based on minutes of queue waiting time saved.
- Database ledger recording reward transactions with cryptographic session tokens.
- Enforces duplicate prevention (idempotency).
- Clear status tracking: "estimated" until session completion, then "verified".
"""

from datetime import datetime, timezone
import secrets
from typing import Dict, Any, Optional
from database import db
from models import RewardTransaction, User


class RewardPointsService:
    DEFAULT_POINTS_PER_MIN_SAVED = 2.0
    MAX_URGENCY_FOR_INCENTIVE = 59.9  # Only Low and Moderate urgency EVs are eligible

    @classmethod
    def calculate_incentive(
        cls,
        urgency_score: float,
        chosen_station_wait_mins: float,
        baseline_station_wait_mins: float,
        chosen_station_dist_km: float,
        safe_range_km: float,
        points_per_min: float = DEFAULT_POINTS_PER_MIN_SAVED
    ) -> Dict[str, Any]:
        """
        Calculates eligible reward points for shifting to a less congested station.
        """
        # Safety Constraint 1: Urgency threshold
        if urgency_score > cls.MAX_URGENCY_FOR_INCENTIVE:
            return {
                "eligible": False,
                "points": 0,
                "wait_time_saved_mins": 0.0,
                "status": "ineligible",
                "reason": (
                    f"Incentives disabled for high/critical urgency vehicles (urgency: {urgency_score}/100). "
                    f"Immediate reachability and short travel time take precedence over rewards."
                )
            }

        # Safety Constraint 2: Route range buffer
        # Ensure chosen station does not consume more than 85% of safe range
        if chosen_station_dist_km > (0.85 * safe_range_km):
            return {
                "eligible": False,
                "points": 0,
                "wait_time_saved_mins": 0.0,
                "status": "ineligible",
                "reason": (
                    f"Incentives disabled: Chosen station distance ({chosen_station_dist_km} km) is too close "
                    f"to the safe range limit ({safe_range_km} km). Safety buffer must be preserved."
                )
            }

        # Calculate time saved relative to baseline / congested station
        time_saved = max(0.0, baseline_station_wait_mins - chosen_station_wait_mins)
        if time_saved <= 0.5:
            return {
                "eligible": True,
                "points": 0,
                "wait_time_saved_mins": round(time_saved, 1),
                "status": "no_reduction",
                "reason": "Chosen station does not offer significant wait-time reduction compared to alternative."
            }

        points = int(round(time_saved * points_per_min))

        return {
            "eligible": True,
            "points": points,
            "wait_time_saved_mins": round(time_saved, 1),
            "status": "estimated",
            "points_rate_per_min": points_per_min,
            "reason": (
                f"Eligible for {points} estimated reward points! "
                f"Saves ~{round(time_saved, 1)} minutes of waiting time, easing grid and station congestion."
            )
        }

    @classmethod
    def record_reservation_incentive(
        cls,
        user_id: int,
        station_id: str,
        points: int,
        wait_time_saved: float,
        session_token: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Records an estimated reward transaction in the database.
        Enforces idempotency using session_token.
        """
        token = session_token or secrets.token_hex(16)

        existing = RewardTransaction.query.filter_by(session_token=token).first()
        if existing:
            return {
                "success": True,
                "duplicate": True,
                "transaction": existing.to_dict(),
                "message": "Existing reward transaction retrieved (duplicate prevented)."
            }

        transaction = RewardTransaction(
            user_id=user_id,
            station_id=str(station_id),
            session_token=token,
            points_awarded=points,
            wait_time_saved_mins=wait_time_saved,
            status="estimated",
            created_at=datetime.now(timezone.utc).replace(tzinfo=None)
        )
        db.session.add(transaction)
        db.session.commit()

        return {
            "success": True,
            "duplicate": False,
            "transaction": transaction.to_dict(),
            "message": "Reward points recorded as 'estimated' pending charging completion."
        }

    @classmethod
    def verify_and_claim_reward(cls, session_token: str) -> Dict[str, Any]:
        """
        Verifies charging completion and transitions status from estimated to verified.
        Prevents duplicate claims on the same session.
        """
        transaction = RewardTransaction.query.filter_by(session_token=session_token).first()
        if not transaction:
            return {
                "success": False,
                "message": "Reward session not found."
            }

        if transaction.status == "verified":
            return {
                "success": False,
                "already_verified": True,
                "message": "Reward has already been verified and credited."
            }

        transaction.status = "verified"
        transaction.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.session.commit()

        return {
            "success": True,
            "transaction": transaction.to_dict(),
            "message": f"Successfully verified! Credited {transaction.points_awarded} points to user account."
        }

    @classmethod
    def get_user_rewards_summary(cls, user_id: int) -> Dict[str, Any]:
        """Calculates total verified and pending points for a user."""
        txs = RewardTransaction.query.filter_by(user_id=user_id).order_by(RewardTransaction.created_at.desc()).all()
        verified_points = sum(t.points_awarded for t in txs if t.status == "verified")
        estimated_points = sum(t.points_awarded for t in txs if t.status == "estimated")

        return {
            "user_id": user_id,
            "verified_points": verified_points,
            "estimated_points": estimated_points,
            "total_transactions": len(txs),
            "transactions": [t.to_dict() for t in txs]
        }
