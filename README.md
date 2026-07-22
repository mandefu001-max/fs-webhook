# FreelanceSurveys PayHero Webhook

Tiny Node.js server that receives PayHero payment callbacks and
activates users in Firestore. Runs FREE on Render.com — no billing.

## What it handles
- activation-{uid}         → activates account, credits KSh 1,100 welcome bonus, credits referrer
- upgrade-{uid}-{PACKAGE}  → upgrades tier (SILVER / GOLD / DIAMOND)
- boost-{uid}              → activates 2hr boost, refunds KSh 50

## Deploy to Render.com (free, 5 minutes)

### Step 1 — Get Firebase Service Account Key
1. Go to Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key" → downloads a JSON file
3. Copy the entire contents of that JSON file

### Step 2 — Deploy on Render.com
1. Go to https://render.com → Sign up free (no billing card needed for Web Services)
2. Click "New +" → "Web Service"
3. Connect your GitHub account and push this folder to a new repo:
   ```
   git init
   git add .
   git commit -m "webhook server"
   git remote add origin https://github.com/YOUR_USERNAME/fs-webhook.git
   git push -u origin main
   ```
4. In Render: select your repo → Runtime: Node → Build: `npm install` → Start: `npm start`
5. Add Environment Variable:
   - Key:   FIREBASE_SERVICE_ACCOUNT
   - Value: paste the entire contents of your serviceAccountKey.json here

### Step 3 — Update PayHeroClient.java
Replace the callback_url in PayHeroClient.java:

```java
body.put("callback_url", "https://YOUR-APP.onrender.com/payhero-callback");
```

Replace YOUR-APP with your Render app name (shown in dashboard).

### Step 4 — Test
After deploy, visit:
  https://YOUR-APP.onrender.com/
Should show: "FreelanceSurveys webhook running ✓"

Test callback manually:
```bash
curl -X POST https://YOUR-APP.onrender.com/payhero-callback \
  -H "Content-Type: application/json" \
  -d '{"status":"SUCCESS","external_reference":"activation-TEST_UID_HERE"}'
```

## Important Notes
- Render free tier "spins down" after 15min inactivity (first request takes ~30s to wake)
  → Not an issue because PayHero retries callbacks 3 times
- The app also polls PayHero directly every 5s — so even if webhook misses,
  the app catches it while the user is watching the screen
- Both systems working = 100% activation reliability

## Firestore Security Rules
Make sure your Firestore rules allow the Admin SDK to write:
The Admin SDK bypasses all security rules — no changes needed.
# updated Wed 22 Jul 2026 08:34:09 AM EAT
