const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* ===============================
   MOCK DATA (Demo Only)
================================ */

const MANDI_PRICES = {
  Tomatoes: { price: 20, trend: "stable" },
  Chillies: { price: 80, trend: "rising" },
  Mangoes: { price: 50, trend: "rising" },
};

const BUYERS = [
  {
    id: "B1",
    name: "Buyer A",
    crop: "Tomatoes",
    pricePerKg: 17,
    distanceKm: 6,
    type: "trader",
    locationName: "Village Mandi Road",
    contactPhone: "+91 98765 43210",
    lat: 21.1501,
    lng: 79.085,
  },
  {
    id: "B2",
    name: "Buyer B",
    crop: "Tomatoes",
    pricePerKg: 18,
    distanceKm: 8,
    type: "processor",
    locationName: "Krishi Upaj Market Yard",
    contactPhone: "+91 91234 56789",
    lat: 21.1605,
    lng: 79.095,
  },
  {
    id: "B3",
    name: "Buyer C",
    crop: "Chillies",
    pricePerKg: 78,
    distanceKm: 12,
    type: "trader",
    locationName: "Tehsil Market Gate",
    contactPhone: "+91 99887 66554",
    lat: 21.172,
    lng: 79.072,
  },
  {
    id: "B4",
    name: "Cold Storage X",
    crop: "Tomatoes",
    pricePerKg: 0,
    distanceKm: 14,
    type: "storage",
    locationName: "Agro Cold Hub Phase II",
    contactPhone: "+91 90123 45098",
    lat: 21.185,
    lng: 79.065,
  },
  {
    id: "B5",
    name: "Mango Pulp Unit",
    crop: "Mangoes",
    pricePerKg: 48,
    distanceKm: 18,
    type: "processor",
    locationName: "Industrial Food Park",
    contactPhone: "+91 93456 78123",
    lat: 21.195,
    lng: 79.045,
  },
];

const PERISHABILITY = {
  Tomatoes: 0.9,
  Chillies: 0.6,
  Mangoes: 0.7,
};

/* ===============================
   HELPER FUNCTIONS
================================ */

function computeRisk(perishabilityScore, temp, hoursSinceHarvest, hasStorage) {
  const timeFactor =
    hoursSinceHarvest < 12 ? 0.2 : hoursSinceHarvest <= 36 ? 0.6 : 1.0;

  const tempFactor = temp < 20 ? 0.2 : temp <= 30 ? 0.6 : 1.0;

  const storageFactor = hasStorage ? 0.5 : 1.0;

  const R =
    0.5 * perishabilityScore +
    0.25 * timeFactor +
    0.15 * tempFactor +
    0.1 * storageFactor;

  if (R < 0.4) return { score: R, label: "Low" };
  if (R < 0.7) return { score: R, label: "Medium" };
  return { score: R, label: "High" };
}

function pickBestBuyer(crop, maxRadiusKm = 50) {
  const candidates = BUYERS.filter(
    (b) => (b.crop === crop || b.crop === "ALL") && b.distanceKm <= maxRadiusKm
  );

  if (!candidates.length) return null;

  const scored = candidates.map((b) => {
    const priceScore = b.pricePerKg || 0;
    const distanceScore = -b.distanceKm;
    return { ...b, _score: priceScore * 1.5 + distanceScore * 0.5 };
  });

  scored.sort((a, b) => b._score - a._score);
  return scored[0];
}

const bookings = [];

/* ===============================
   API ROUTES
================================ */

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "harvestlink-backend" });
});

app.get("/api/vendors", (req, res) => {
  res.json({ vendors: BUYERS });
});

app.post("/api/recommendation", (req, res) => {
  const {
    crop,
    quantityKg,
    distanceKm,
    tempC,
    hoursSinceHarvest = 18,
    hasStorage = true,
  } = req.body || {};

  if (!crop || !quantityKg) {
    return res.status(400).json({ error: "Missing crop or quantityKg" });
  }

  const mandiInfo = MANDI_PRICES[crop] || { price: 20, trend: "stable" };
  const mandiPrice = mandiInfo.price;

  const bestBuyer = pickBestBuyer(crop);

  const buyerPrice =
    bestBuyer && bestBuyer.pricePerKg
      ? bestBuyer.pricePerKg
      : mandiPrice * 0.85;

  const buyerDistance =
    typeof distanceKm === "number" && !Number.isNaN(distanceKm)
      ? distanceKm
      : bestBuyer
      ? bestBuyer.distanceKm
      : 15;

  const perishabilityScore = PERISHABILITY[crop] ?? 0.7;

  const risk = computeRisk(
    perishabilityScore,
    tempC ?? 30,
    hoursSinceHarvest,
    hasStorage
  );

  let action = "SELL";
  let explanation = "";

  if (risk.label === "High") {
    action = "SELL";
    explanation = "High spoilage risk → sell immediately.";
  } else if (buyerPrice >= mandiPrice) {
    action = "SELL";
    explanation = "Buyer price is equal or better than mandi.";
  } else if (risk.label === "Low") {
    action = "WAIT_1_DAY";
    explanation = "Low spoilage risk → safe to wait.";
  } else {
    action = "STORE";
    explanation = "Moderate risk and low price → store if possible.";
  }

  res.json({
    crop,
    quantityKg,
    mandiPrice,
    mandiTrend: mandiInfo.trend,
    buyer: bestBuyer,
    buyerPrice,
    buyerDistance,
    risk,
    action,
    explanation,
    estimatedRevenue: Math.round(buyerPrice * quantityKg),
  });
});

app.post("/api/booking", (req, res) => {
  const { farmer, crop, quantityKg, action, buyer } = req.body || {};

  if (!farmer || !farmer.name) {
    return res.status(400).json({ error: "Missing farmer details" });
  }

  const id = `BK-${String(bookings.length + 1).padStart(4, "0")}`;

  const record = {
    id,
    farmer,
    crop,
    quantityKg,
    action,
    buyer,
    createdAt: new Date().toISOString(),
  };

  bookings.push(record);

  res.json({
    status: "confirmed",
    bookingId: id,
  });
});

/* ===============================
   FRONTEND SERVING (IMPORTANT)
================================ */

// Serve static files (index.html, css, js)
app.use(express.static(path.join(__dirname)));

// Serve homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ===============================
   START SERVER
================================ */

app.listen(PORT, () => {
  console.log(`HarvestLink running on port ${PORT}`);
});