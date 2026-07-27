from flask import Flask, render_template

from config import Config

from database import db

from auth import auth
from auth import bcrypt
from routes import main

app = Flask(__name__)

app.config.from_object(Config)

db.init_app(app)

bcrypt.init_app(app)

app.register_blueprint(auth)
app.register_blueprint(main)

with app.app_context():
    db.create_all()


@app.route("/")
def home():
    return render_template("index.html", google_maps_key=app.config.get("GOOGLE_MAPS_KEY"))


if __name__ == "__main__":
    app.run(debug=True)

