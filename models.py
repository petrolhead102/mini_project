import uuid
from datetime import datetime
from database import db


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)

    username = db.Column(
        db.String(50),
        unique=True,
        nullable=False
    )

    email = db.Column(
        db.String(120),
        unique=True,
        nullable=False
    )

    password_hash = db.Column(
        db.String(255),
        nullable=False
    )


class Session(db.Model):
    __tablename__ = "sessions"

    session_id = db.Column(
        db.String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4())
    )

    user_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        nullable=False
    )

    created_at = db.Column(
        db.DateTime,
        default=datetime.utcnow
    )

    expires_at = db.Column(
        db.DateTime,
        nullable=False
    )

    user = db.relationship(User)


class StationUsageHistory(db.Model):
    """
    Historical station usage and queue length observations for time-series forecasting.
    Clearly tracks whether an observation is real or generated via the synthetic data tool.
    """
    __tablename__ = "station_usage_history"

    id = db.Column(db.Integer, primary_key=True)
    station_id = db.Column(db.String(100), nullable=False, index=True)
    timestamp = db.Column(db.DateTime, nullable=False, index=True)
    queue_length = db.Column(db.Integer, nullable=False, default=0)
    waiting_time_mins = db.Column(db.Float, nullable=False, default=0.0)
    occupied_plugs = db.Column(db.Integer, nullable=False, default=0)
    total_plugs = db.Column(db.Integer, nullable=False, default=1)
    is_synthetic = db.Column(db.Boolean, nullable=False, default=False)

    def to_dict(self):
        return {
            "id": self.id,
            "station_id": self.station_id,
            "timestamp": self.timestamp.isoformat(),
            "queue_length": self.queue_length,
            "waiting_time_mins": self.waiting_time_mins,
            "occupied_plugs": self.occupied_plugs,
            "total_plugs": self.total_plugs,
            "is_synthetic": self.is_synthetic
        }


class RewardTransaction(db.Model):
    """
    Incentive reward transaction ledger for low-urgency EV drivers choosing less crowded stations.
    Enforces uniqueness per session_token to prevent duplicate rewards.
    """
    __tablename__ = "reward_transactions"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    station_id = db.Column(db.String(100), nullable=False)
    session_token = db.Column(db.String(64), unique=True, nullable=False)  # Enforce duplicate prevention
    points_awarded = db.Column(db.Integer, nullable=False, default=0)
    wait_time_saved_mins = db.Column(db.Float, nullable=False, default=0.0)
    status = db.Column(db.String(20), nullable=False, default="estimated")  # estimated, verified, cancelled
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    completed_at = db.Column(db.DateTime, nullable=True)

    user = db.relationship(User)

    def to_dict(self):
        return {
            "id": self.id,
            "user_id": self.user_id,
            "station_id": self.station_id,
            "session_token": self.session_token,
            "points_awarded": self.points_awarded,
            "wait_time_saved_mins": self.wait_time_saved_mins,
            "status": self.status,
            "created_at": self.created_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None
        }
