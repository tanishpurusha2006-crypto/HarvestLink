const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Mock data & helpers (demo only) ---

// Simple mandi prices (₹/kg) and trends
const MANDI_PRICES = {
  Tomatoes: { price: 20, trend: "stable" },
  Chillies: { price: 80, trend: "rising" },
  Mangoes: { price: 50, trend: "rising" },
};

// Nearby buyers / storage units (within ~50 km)
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

// Perishability scores (0–1, higher = more perishable)
const PERISHABILITY = {
  Tomatoes: 0.9,
  Chillies: 0.6,
  Mangoes: 0.7,
};

function computeRisk(perishabilityScore, temp, hoursSinceHarvest, hasStorage) {
  const timeFactor = hoursSinceHarvest < 12 ? 0.2 : hoursSinceHarvest <= 36 ? 0.6 : 1.0;
  const tempFactor = temp < 20 ? 0.2 : temp <= 30 ? 0.6 : 1.0;
  const storageFactor = hasStorage ? 0.5 : 1.0;
  const R = 0.5 * perishabilityScore + 0.25 * timeFactor + 0.15 * tempFactor + 0.1 * storageFactor;
  if (R < 0.4) return { score: R, label: "Low" };
  if (R < 0.7) return { score: R, label: "Medium" };
  return { score: R, label: "High" };
}

function pickBestBuyer(crop, maxRadiusKm = 50) {
  const candidates = BUYERS.filter((b) => (b.crop === crop || b.crop === "ALL") && b.distanceKm <= maxRadiusKm);
  if (!candidates.length) return null;

  // Prefer closer and higher price; small composite score
  const scored = candidates.map((b) => {
    const priceScore = b.pricePerKg || 0;
    const distanceScore = -b.distanceKm; // closer is better
    return { ...b, _score: priceScore * 1.5 + distanceScore * 0.5 };
  });

  scored.sort((a, b) => b._score - a._score);
  return scored[0];
}

// In-memory booking log for demo
const bookings = [];

// --- Routes ---

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "harvestlink-backend" });
});

// Nearby vendors (buyers + storage) listing
app.get("/api/vendors", (req, res) => {
  res.json({
    vendors: BUYERS.map((b) => ({
      id: b.id,
      name: b.name,
      crop: b.crop,
      pricePerKg: b.pricePerKg,
      distanceKm: b.distanceKm,
      type: b.type,
      locationName: b.locationName,
      contactPhone: b.contactPhone,
      lat: b.lat,
      lng: b.lng,
    })),
  });
});

// Recommendation endpoint
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
  const buyerPrice = bestBuyer && bestBuyer.pricePerKg ? bestBuyer.pricePerKg : mandiPrice * 0.85;
  const buyerDistance = typeof distanceKm === "number" && !Number.isNaN(distanceKm)
    ? distanceKm
    : bestBuyer
      ? bestBuyer.distanceKm
      : 15;

  const perishabilityScore = PERISHABILITY[crop] ?? 0.7;
  const risk = computeRisk(perishabilityScore, tempC ?? 30, hoursSinceHarvest, hasStorage);

  let action = "SELL";
  let explanation;

  if (risk.label === "High" && buyerPrice >= 0.85 * mandiPrice && buyerDistance <= 10) {
    action = "SELL";
    explanation =
      "High spoilage risk, buyer price is close to mandi and within 10 km → recommend immediate sale.";
  } else if (buyerPrice >= mandiPrice && buyerDistance <= 20) {
    action = "SELL";
    explanation =
      "Buyer price is equal or better than mandi and reasonably close → sell now.";
  } else if (buyerPrice < 0.75 * mandiPrice && hasStorage && risk.label !== "High") {
    action = "STORE";
    explanation =
      "Buyer price is low but spoilage risk not extreme and storage is available → store instead of distress sale.";
  } else if (risk.label === "Low" && mandiInfo.trend === "rising") {
    action = "WAIT_1_DAY";
    explanation =
      "Spoilage risk is low and mandi trend is rising → safe to wait one more day.";
  } else if (risk.label === "Low") {
    action = "WAIT_1_DAY";
    explanation = "Spoilage risk is low → safe to wait for better demand for one more day.";
  } else {
    action = "SELL";
    explanation =
      "To avoid loss from spoilage, nearest buyer is still the safest option.";
  }

  const estimatedRevenue = Math.round(buyerPrice * quantityKg);
  const distanceLabel = buyerDistance <= 10 ? "≤ 10 km (preferred)" : `${buyerDistance} km`;

  res.json({
    crop,
    quantityKg,
    mandiPrice,
    mandiTrend: mandiInfo.trend,
    buyer: bestBuyer
      ? {
          id: bestBuyer.id,
          name: bestBuyer.name,
          pricePerKg: bestBuyer.pricePerKg,
          distanceKm: bestBuyer.distanceKm,
          type: bestBuyer.type,
        }
      : null,
    buyerPrice,
    buyerDistance,
    risk,
    action,
    explanation,
    estimatedRevenue,
    distanceLabel,
  });
});

// Booking endpoint (demo only)
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
  console.log("New booking:", record);

  res.json({
    status: "confirmed",
    bookingId: id,
    message: "Booking recorded (demo). In production this would trigger WhatsApp/SMS.",
  });
});

app.listen(PORT, () => {
  console.log(`HarvestLink backend running on http://localhost:${PORT}`);
});

