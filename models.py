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


class VehicleProfile(db.Model):
    __tablename__ = "vehicle_profiles"

    user_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        primary_key=True
    )

    connector_type = db.Column(
        db.String(30),
        nullable=False
    )

    battery_capacity_kwh = db.Column(
        db.Float,
        nullable=False
    )

    current_battery_percent = db.Column(
        db.Float,
        nullable=False
    )

    full_range_km = db.Column(
        db.Float,
        nullable=False
    )

    user = db.relationship(User)
