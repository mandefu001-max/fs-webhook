const express = require("express");
const admin   = require("firebase-admin");

const app  = express();
app.use(express.json());

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

// ── Start server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Webhook server running on port", PORT));
