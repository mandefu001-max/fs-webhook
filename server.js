const express = require("express");
const admin   = require("firebase-admin");

const app  = express();
app.use(express.json());

// ── CORS ───────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://whatsapp-cheating-zone.web.app",
  "https://whatsapp-cheating-zone.firebaseapp.com",
  "http://localhost:5173",
  "http://localhost:4173",
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Firebase Admin SDK ─────────────────────────────────────────────────────
// Set FIREBASE_SERVICE_ACCOUNT env var in Render dashboard (JSON string)
// OR place serviceAccountKey.json in the same folder
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require("./serviceAccountKey.json");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ── Health check ───────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("FreelanceSurveys webhook running ✓"));

// ── PayHero callback ───────────────────────────────────────────────────────
// PayHero POSTs here when a payment succeeds or fails
app.post("/payhero-callback", async (req, res) => {
  try {
    const body = req.body;
    console.log("PayHero callback:", JSON.stringify(body));

    const status    = (body.status || body.Status || "").toUpperCase();
    const reference = body.external_reference || body.ExternalReference || body.reference || "";

    // Only process SUCCESS
    if (status !== "SUCCESS") {
      console.log("Non-success status:", status);
      return res.json({ received: true });
    }

    if (!reference) {
      console.error("No reference in callback body");
      return res.status(400).json({ error: "Missing reference" });
    }

    // ── Parse reference to determine flow ─────────────────────────────────
    // Reference formats:
    //   activation-{uid}      → account activation
    //   upgrade-{uid}-{pkg}   → tier upgrade  (e.g. upgrade-abc123-GOLD)
    //   boost-{uid}           → boost mode
    //   withdrawal-{uid}      → (not used — withdrawals are PayHero payouts)

    if (reference.startsWith("activation-")) {
      const uid = reference.replace("activation-", "");
      await activateUser(uid);

    } else if (reference.startsWith("upgrade-")) {
      const parts = reference.split("-"); // ["upgrade", uid, pkg]
      const uid   = parts[1];
      const pkg   = (parts[2] || "SILVER").toUpperCase();
      await upgradeUser(uid, pkg);

    } else if (reference.startsWith("boost-")) {
      const uid = reference.replace("boost-", "");
      await activateBoost(uid);

    } else {
      console.log("Unknown reference type:", reference);
    }

    res.json({ success: true });

  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Activation ─────────────────────────────────────────────────────────────
async function activateUser(uid) {
  const ACTIVATION_BONUS = 1100; // KSh 100 paid back + KSh 1000 welcome bonus

  const userRef = db.collection("users").document
    ? db.collection("users").doc(uid)
    : db.collection("users").doc(uid);

  const snap = await userRef.get();
  if (!snap.exists) {
    console.error("User not found:", uid);
    return;
  }

  const user = snap.data();
  if (user.activated) {
    console.log("User already activated:", uid);
    return;
  }

  await userRef.update({
    activated:       true,
    packageName:     "BRONZE",
    balance:         admin.firestore.FieldValue.increment(ACTIVATION_BONUS),
    totalEarned:     admin.firestore.FieldValue.increment(ACTIVATION_BONUS),
    activatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    dailyTaskLimit:  10,
  });

  // Credit referrer if user was referred
  if (user.referredBy) {
    await creditReferrer(user.referredBy);
  }

  console.log("✅ Activated user:", uid);
}

// ── Upgrade ────────────────────────────────────────────────────────────────
const TIER_CONFIG = {
  SILVER:  { dailyLimit: 20, totalLimit: 50,  weeklyEst: 15000 },
  GOLD:    { dailyLimit: 30, totalLimit: 75,  weeklyEst: 25000 },
  DIAMOND: { dailyLimit: 50, totalLimit: 100, weeklyEst: 35000 },
};

async function upgradeUser(uid, pkg) {
  const tier = TIER_CONFIG[pkg];
  if (!tier) { console.error("Unknown package:", pkg); return; }

  await db.collection("users").doc(uid).update({
    packageName:    pkg,
    dailyTaskLimit: tier.dailyLimit,
    updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log("✅ Upgraded user:", uid, "→", pkg);
}

// ── Boost ──────────────────────────────────────────────────────────────────
async function activateBoost(uid) {
  const endTime = Date.now() + (2 * 60 * 60 * 1000); // 2 hours
  await db.collection("users").doc(uid).update({
    boostEndTime: endTime,
    updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
  });
  // Also refund the KSh 50 cost
  await db.collection("users").doc(uid).update({
    balance:    admin.firestore.FieldValue.increment(50),
    totalEarned: admin.firestore.FieldValue.increment(50),
  });
  console.log("✅ Boost activated for:", uid, "until", new Date(endTime).toISOString());
}

// ── Referrer credit ────────────────────────────────────────────────────────
async function creditReferrer(referralCode) {
  const REFERRAL_BONUS = 200;
  const snap = await db.collection("users")
    .where("referralCode", "==", referralCode)
    .limit(1)
    .get();

  if (snap.empty) { console.log("Referrer not found:", referralCode); return; }

  const referrerRef = snap.docs[0].ref;
  await referrerRef.update({
    balance:       admin.firestore.FieldValue.increment(REFERRAL_BONUS),
    totalEarned:   admin.firestore.FieldValue.increment(REFERRAL_BONUS),
    referralCount: admin.firestore.FieldValue.increment(1),
  });

  // Check milestones
  const referrer = (await referrerRef.get()).data();
  const refs     = referrer.referralCount || 0;

  if (refs >= 10 && !referrer.milestone2Paid) {
    await referrerRef.update({
      balance:       admin.firestore.FieldValue.increment(1000),
      totalEarned:   admin.firestore.FieldValue.increment(1000),
      milestone2Paid: true,
      passiveReferral: true,
      badge:         "Ambassador",
    });
  } else if (refs >= 5 && !referrer.milestone1Paid) {
    await referrerRef.update({
      balance:       admin.firestore.FieldValue.increment(500),
      totalEarned:   admin.firestore.FieldValue.increment(500),
      milestone1Paid: true,
      badge:         "Recruiter",
    });
  }

  console.log("✅ Credited referrer:", referralCode, "+ KSh", REFERRAL_BONUS);
}

// ── Nexus Pay (MakamescoPay) proxy ────────────────────────────────────────
const NEXUS_BASE = "http://makamescopay.com";

function nexusHeaders() {
  const key = process.env.NEXUSPAY_API_KEY;
  if (!key) throw new Error("NEXUSPAY_API_KEY not set");
  return { "Content-Type": "application/json", "X-API-Key": key };
}

function normalisePhoneNexus(raw) {
  const digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  if (digits.startsWith("7") || digits.startsWith("1")) return `254${digits}`;
  return digits;
}

// Initiate STK Push
app.post("/nexuspay/stkpush", async (req, res) => {
  const { phone, amount, reference, description = "Payment" } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: "phone and amount required" });

  const ref = reference || `WACZ-${Date.now()}`;
  const desc = String(description).slice(0, 50);
  const payload = {
    phoneNumber: normalisePhoneNexus(phone),
    amount: Number(amount),
    accountReference: ref,
    transactionDesc: desc,
    remarks: desc,
    description: desc,
  };

  try {
    const upstream = await fetch(`${NEXUS_BASE}/api/payments/stkpush`, {
      method: "POST",
      headers: nexusHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await upstream.json().catch(() => ({}));
    console.log("[NexusPay] stkpush →", upstream.status, JSON.stringify(data));

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: data.message || data.error || `HTTP ${upstream.status}` });
    }
    return res.json(data);
  } catch (err) {
    console.error("[NexusPay] stkpush error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Check STK Push status
app.post("/nexuspay/status", async (req, res) => {
  const { checkoutRequestId } = req.body;
  if (!checkoutRequestId) return res.status(400).json({ error: "checkoutRequestId required" });

  try {
    const upstream = await fetch(`${NEXUS_BASE}/api/payments/status/${encodeURIComponent(checkoutRequestId)}`, {
      headers: nexusHeaders(),
    });
    const data = await upstream.json().catch(() => ({}));
    console.log("[NexusPay] status →", upstream.status, JSON.stringify(data));

    if (!upstream.ok) return res.json({ status: "pending" });
    return res.json(data);
  } catch (err) {
    console.error("[NexusPay] status error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Nexus Pay webhook callback
app.post("/nexuspay-callback", (req, res) => {
  console.log("[NexusPay callback]", JSON.stringify(req.body, null, 2));
  res.json({ received: true });
});

// ── PawaPay proxy ──────────────────────────────────────────────────────────
const PAWAPAY_BASE = process.env.PAWAPAY_BASE_URL || "https://api.pawapay.io";

// Country routing: phone prefix → { correspondent, currency, kesRate }
// kesRate = how many local currency units per 1 KES
const PAWAPAY_COUNTRIES = {
  "229": { correspondent: "MTN_MOMO_BEN",  currency: "XOF", kesRate: 4.6  }, // Benin
  "237": { correspondent: "MTN_MOMO_CMR",  currency: "XAF", kesRate: 4.6  }, // Cameroon
  "225": { correspondent: "MTN_MOMO_CIV",  currency: "XOF", kesRate: 4.6  }, // Cote d'Ivoire
  "243": { correspondent: "AIRTEL_COD",    currency: "CDF", kesRate: 21.6 }, // DR Congo
  "241": { correspondent: "AIRTEL_GAB",    currency: "XAF", kesRate: 4.6  }, // Gabon
  "254": { correspondent: "MPESA_KEN",     currency: "KES", kesRate: 1    }, // Kenya
  "242": { correspondent: "MTN_MOMO_COG",  currency: "XAF", kesRate: 4.6  }, // Republic of Congo
  "250": { correspondent: "MTN_MOMO_RWA",  currency: "RWF", kesRate: 14.2 }, // Rwanda
  "221": { correspondent: "ORANGE_SEN",    currency: "XOF", kesRate: 4.6  }, // Senegal
  "232": { correspondent: "ORANGE_SLE",    currency: "SLE", kesRate: 0.17 }, // Sierra Leone
  "256": { correspondent: "MTN_MOMO_UGA",  currency: "UGX", kesRate: 28.5 }, // Uganda
  "260": { correspondent: "MTN_MOMO_ZMB",  currency: "ZMW", kesRate: 0.19 }, // Zambia
};

function getCountryInfo(phone) {
  const digits = String(phone).replace(/\D/g, "");
  // Try 3-digit prefixes first, then 2-digit
  for (const len of [3, 2]) {
    const prefix = digits.slice(0, len);
    if (PAWAPAY_COUNTRIES[prefix]) return { ...PAWAPAY_COUNTRIES[prefix], phone: digits };
  }
  // Default Kenya
  return { ...PAWAPAY_COUNTRIES["254"], phone: digits.startsWith("0") ? `254${digits.slice(1)}` : digits };
}

function pawapayHeaders() {
  const token = process.env.PAWAPAY_API_TOKEN;
  if (!token) throw new Error("PAWAPAY_API_TOKEN not set");
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

function genDepositId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Initiate a PawaPay deposit — auto-detects country/correspondent/currency from phone
app.post("/pawapay/deposit", async (req, res) => {
  const { phone, amount, description = "WACZ Payment" } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: "phone and amount required" });

  const country = getCountryInfo(phone);
  // Convert KES amount to local currency, round up to nearest integer
  const localAmount = Math.ceil(Number(amount) * country.kesRate);

  const depositId = genDepositId();
  const payload = {
    depositId,
    amount: String(localAmount),
    currency: country.currency,
    correspondent: country.correspondent,
    payer: { type: "MSISDN", address: { value: country.phone } },
    customerTimestamp: new Date().toISOString(),
    statementDescription: String(description).slice(0, 22),
  };
  console.log("[PawaPay] routing →", country.correspondent, country.currency, localAmount, "from", amount, "KES");

  try {
    const upstream = await fetch(`${PAWAPAY_BASE}/deposits`, {
      method: "POST",
      headers: pawapayHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await upstream.json().catch(() => ({}));
    console.log("[PawaPay] deposit →", upstream.status, JSON.stringify(data));

    if (!upstream.ok || data.status === "REJECTED") {
      const msg = data.rejectionReason?.rejectionMessage || data.errorMessage || data.message || `HTTP ${upstream.status}`;
      return res.status(upstream.ok ? 400 : upstream.status).json({ error: msg });
    }
    return res.json({ depositId, status: data.status || "ACCEPTED" });
  } catch (err) {
    console.error("[PawaPay] deposit error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Check deposit status
app.post("/pawapay/deposit-status", async (req, res) => {
  const { depositId } = req.body;
  if (!depositId) return res.status(400).json({ error: "depositId required" });

  try {
    const upstream = await fetch(`${PAWAPAY_BASE}/deposits/${encodeURIComponent(depositId)}`, {
      headers: pawapayHeaders(),
    });
    const data = await upstream.json().catch(() => ({}));
    console.log("[PawaPay] status →", upstream.status, JSON.stringify(data));

    if (!upstream.ok) return res.json({ status: "PENDING" });

    const deposits = Array.isArray(data) ? data : [data];
    const deposit = deposits.find((d) => d.depositId === depositId) ?? deposits[0];
    return res.json({ status: deposit?.status || "PENDING" });
  } catch (err) {
    console.error("[PawaPay] status error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// PawaPay deposit callback (PawaPay → this server when payment finalises)
app.post("/pawapay-callback", (req, res) => {
  console.log("[PawaPay callback]", JSON.stringify(req.body, null, 2));
  res.json({ received: true });
});

// ── Start server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Webhook server running on port", PORT));
// Wed 22 Jul 2026 08:39:09 AM EAT
