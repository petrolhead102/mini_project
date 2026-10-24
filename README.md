# VoltRoute

VoltRoute is an electric vehicle charging station finder. It shows nearby charging stations on a map and in a station directory, filters them using a saved EV profile, ranks reachable stations, estimates plug congestion, and demonstrates a simulated reservation and reward flow.

The ranking and reward calculations live in `static/js/app.js`. The `/api/stations` endpoint in `routes.py` supplies station records. This README documents the current implementation, including which values are real provider data and which are demo values.

## Algorithm at a glance

```text
Current location + EV profile
              │
              ▼
Estimate usable range ──► Filter to stations within that range
              │
              ▼
Calculate weighted priority score for each eligible station
              │
              ├──► Rank by score, then by distance
              │
              ├──► Estimate congestion from open/total plug counts
              │
              └──► On a completed reservation trip, calculate cashback eligibility
```

## 1. Inputs and station data

The browser uses these inputs:

- **Current location:** the selected map/search location or the browser's GPS location.
- **EV profile:** full-range estimate in kilometres and current battery percentage.
- **Station data:** coordinates, rating, station status, open and total plugs, charger speed, and other display details.

The backend requests nearby EV charging locations from Google Places. It requests up to 20 places within a 5 km search radius and caches results for five minutes using the location rounded to two decimal places.

Google Places supplies station identity and location information, address, rating when available, and charging options when provided. The current project creates the following fields as **demo data** using a deterministic random seed based on the place ID: available/offline/in-use status, total and available plugs, charging speed, connector, amenities, and price. Therefore the congestion calculation, availability ranking, and demo price should not be interpreted as verified live station data.

## 2. Usable range and reachability

The usable range estimate is:

```text
usable range (km) = full vehicle range (km) × battery percentage ÷ 100
```

For example, a vehicle with a 320 km full range and a 40% battery has an estimated usable range of:

```text
320 × 40 ÷ 100 = 128 km
```

The browser calculates the distance from the current location to each station with the Haversine formula. It uses Earth radius `R = 6,371 km`:

```text
a = sin²(Δlatitude / 2)
  + cos(latitude₁) × cos(latitude₂) × sin²(Δlongitude / 2)
distance = 2 × R × atan2(√a, √(1 − a))
```

Angles are converted to radians before applying the formula. A station is considered in range when its calculated straight-line distance is less than or equal to the estimated usable range. This is a reachability estimate, not a driving distance; actual road routes can be longer.

If no EV profile or current location is available, the app cannot calculate reachability or a priority score. It asks the user to choose a location and configure an EV profile.

## 3. Priority score

The app calculates a score from 0 to 100 for in-range stations. Higher scores rank first. It calculates four component scores, multiplies each by its weight, adds the weighted values, and rounds the result to the nearest integer.

### A. Distance score — 40%

Closer stations receive a higher score relative to the vehicle's estimated range:

```text
distance score = max(0, 1 − station distance ÷ usable range) × 100
distance contribution = distance score × 0.40
```

At the edge of the estimated range, the distance score is 0. A station at half the estimated range receives a distance score of 50.

### B. Plug availability score — 30%

When the station reports an available status and a positive total plug count:

```text
availability score = min(1, available plugs ÷ total plugs) × 100
availability contribution = availability score × 0.30
```

Stations not reported as available, or with no valid total plug count, receive an availability score of 0. The result is capped at 100.

### C. Charger speed score — 20%

Charger speed is scaled against 250 kW and capped at 100:

```text
speed score = max(0, min(100, charger speed in kW ÷ 250 × 100))
speed contribution = speed score × 0.20
```

For example, a 150 kW charger receives a speed score of 60 and contributes 12 points to the weighted total.

### D. Rating score — 10%

Ratings on a 5-star scale are converted to a 100-point scale:

```text
rating score = clamp(rating ÷ 5 × 100, 0, 100)
rating contribution = rating score × 0.10
```

When no rating is supplied, the implementation uses a neutral score of 50, contributing 5 points.

### Final score

```text
priority score = round(
    distance score × 0.40
  + availability score × 0.30
  + speed score × 0.20
  + rating score × 0.10
)
```

Example: distance 75, availability 80, speed 60, and rating 90 produce:

```text
round(75 × 0.40 + 80 × 0.30 + 60 × 0.20 + 90 × 0.10)
= round(30 + 24 + 12 + 9)
= 75 / 100
```

## 4. Ranking and Top 3

Only stations that satisfy all of these conditions can be ranked as reservable recommendations:

1. They have valid coordinates.
2. They are within the EV's estimated range.
3. Their status is `available`.
4. They report at least one available plug.
5. The user has not already reserved them, and they are not currently pending reservation.

Eligible stations are sorted by priority score, highest first. If two stations have the same score, the nearer one ranks first. The map and Stations page highlight the first three eligible stations. They can still be reserved individually; the rank is guidance for choosing among them.

The map's visible Top 3 uses the current station filters. Cashback eligibility evaluates all returned station records that are in range and reservable, independent of the text, status, or charger-type filters, so hiding a stronger station with a filter does not make a lower-ranked choice reward-eligible.

## 5. Congestion estimate

Congestion is calculated from the reported plug counts:

```text
open plugs = clamp(available plugs, 0, total plugs)
occupied percentage = round((total plugs − open plugs) ÷ total plugs × 100)
```

The label thresholds are:

| Result | Rule |
| --- | --- |
| Low | Less than 40% occupied |
| Moderate | 40% through 74% occupied |
| High | 75% or more occupied |
| Offline | The station status is reported as offline |
| Unavailable | Plug counts are missing or invalid |

This is an estimate from the station record available to the app. It is not continuous monitoring, an occupancy history, or a forecast. In the current backend, plug counts and statuses are demo values, so the estimate is only as reliable as those values.

The app can suggest a lower-congestion alternative when an in-range reservable station has occupancy at least 20 percentage points lower than the nearest in-range reservable station. The alternative is selected by lowest occupancy, then by shorter distance. Viewing the alternative does not reserve it or award points; a completed reservation trip is still required for cashback.

## 6. Cashback and reward points

Cashback is a simulated reward, not a payment. The app captures the selected station's ranking decision when the user confirms a reservation. After the simulated drive reaches the station, it displays the outcome and waits for the user to claim eligible points.

### Eligibility

A trip can earn cashback only when:

- An EV profile and usable-range estimate are available.
- The station was reservable and within range when the reservation was confirmed.
- It ranked in the top three among all returned, in-range, reservable stations at confirmation time.
- Cashback for that station has not already been claimed in the current page session.
- The simulated trip reaches the station and the user claims the reward.

If a lower-ranked station is selected while a better top-three reservable choice was available, the arrival card and toast show **“No cashback this trip”** and explain that a higher-priority choice was available. Out-of-range stations, missing comparison inputs, and stations whose reward was already claimed also earn no cashback.

### Variable reward formula

For an eligible top-three station, the app calculates:

```text
open-plug percentage = round(clamped open plugs ÷ total plugs × 100)
reward points = round(8 + priority score × 0.35 + open-plug percentage × 0.12)
cashback (INR) = reward points × ₹0.04
```

The score and open-plug percentage change from station to station, so rewards are not identical for every reservation. For example, a score of 82 with 60% of plugs open gives:

```text
round(8 + 82 × 0.35 + 60 × 0.12)
= round(43.9)
= 44 points

44 × ₹0.04 = ₹1.76 cashback
```

The conversion is **100 points = ₹4.00**. Points are added to the session balance only after the user presses the claim button. A station can award cashback once per page session. This demo balance is held in browser memory; it is not a persistent wallet and is not connected to a payment provider.

## 7. Algorithm animation

On the **Algorithm Used** page, select **Animate the algorithm on the full-screen map** to preview the current top-ranked station. The app:

1. Requires a current location, loaded stations, and an EV profile with at least one in-range reservable station.
2. Selects rank #1 using the same eligibility and priority rules above.
3. Expands the map to fill the app viewport, draws a straight-line illustrative path, and animates the car marker toward the selected station.
4. Displays the exact range, distance, score components and weighted sum, congestion calculation, rank, and potential cashback calculation in a live trace. The active calculation step is highlighted as the car moves.
5. Shows the final rank and score when the animation completes.

The map demo does not create a reservation or award cashback. Press **Esc** to leave the expanded map view or use **Back to Algorithm Used** after the animation completes.

## 8. Reservation animation

The regular reservation flow is separate from the algorithm preview:

1. Select **Reserve** on an eligible station.
2. Confirm the reservation in the dialog.
3. The map expands to fill the app viewport and the simulated reservation is recorded for 15 minutes.
4. A car marker follows a straight-line animation from the selected location to the reserved station.
5. At arrival, the app displays the previously captured cashback decision and offers a claim button when eligible. Claiming adds points to the in-session balance and returns the app to the normal Map view.

This is a front-end simulation. It does not track a real vehicle, contact a charging station to hold a live plug, or make a cashback payment.

## Source locations

- `static/js/app.js` — range and distance calculations, priority scoring, filtering and ranking, congestion labels, reservation decision, cashback formula, and map animations.
- `templates/index.html` — Algorithm Used page, worked-example region, live map calculation trace, and trip/reward UI.
- `static/css/styles.css` — page layout, full-screen map presentation, and calculation trace styling.
- `routes.py` — nearby Google Places request, five-minute cache, and demo station-field generation.
