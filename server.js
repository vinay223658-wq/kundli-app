// ============================================================
// KUNDLI + CAREER HOROSCOPE APP
// ------------------------------------------------------------
// Flow:
// 1. User form se Name, DOB, Time of Birth, Place bhejta hai
// 2. Prokerala Astrology API se real kundli data (planets, houses) lete hain
// 3. Us raw data ko Claude API ko bhejte hain -> friendly Hindi/Hinglish
//    career horoscope text banwane ke liye
// 4. Dono cheezein (raw kundli + interpretation) frontend ko wapas bhejte hain
// ============================================================

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { readFileSync } from "fs";
import crypto from "crypto";
import Razorpay from "razorpay";

dotenv.config();

// --------------------------------------------------------
// Email bhejne ka function (Brevo HTTP API use karte hain,
// SMTP port kai hosting providers pe blocked hota hai)
// --------------------------------------------------------
async function sendEmail({ to, subject, html }) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.BREVO_API_KEY,
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: "Kundli AI", email: "vinay223658@gmail.com" },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error("Brevo ne ye status diya " + response.status + ": " + errorBody);
    }
  } catch (err) {
    // Poori error detail console mein print karte hain debugging ke liye
    console.error("sendEmail full error detail:", {
      message: err.message,
      code: err.code,
      cause: err.cause ? String(err.cause) : undefined,
      name: err.name,
    });
    throw new Error(err.message || "Unknown email error");
  }
}

// OTP codes yahan temporarily store hote hain (memory mein)
// Format: { "email@example.com": { otp: "123456", expiresAt: 1234567890 } }
// NOTE: OTP ab Firestore mein store hote hain (memory mein nahi),
// taaki server restart/redeploy hone pe bhi OTP safe rahe

// --------------------------------------------------------
// Firebase Admin initialize karte hain (login + database ke liye)
// --------------------------------------------------------
// Firebase key do jagah se aa sakti hai:
// 1. Render/hosting pe: FIREBASE_KEY_JSON environment variable se
// 2. Apne computer pe (local testing): firebase-key.json file se
// --------------------------------------------------------
let firebaseKey;
if (process.env.FIREBASE_KEY_JSON) {
  firebaseKey = JSON.parse(process.env.FIREBASE_KEY_JSON);
} else {
  firebaseKey = JSON.parse(readFileSync("./firebase-key.json", "utf-8"));
}
initializeApp({
  credential: cert(firebaseKey),
});
const db = getFirestore();
const authAdmin = getAuth();

// --------------------------------------------------------
// CACHING: Ek hi kundli (same DOB/TOB/place) ke liye Prokerala ko
// baar-baar call na karna pade, isliye result Firestore mein cache karte hain
// (birth chart data kabhi nahi badalta, isliye hamesha ke liye cache safe hai)
// --------------------------------------------------------
function makeCacheKey(prefix, { dob, tob, lat, lon }) {
  const raw = `${prefix}_${dob}_${tob}_${lat}_${lon}`;
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 200);
}

async function getCached(key) {
  try {
    const doc = await db.collection("prokerala_cache").doc(key).get();
    return doc.exists ? doc.data().value : null;
  } catch {
    return null; // cache read fail ho to bhi aage badho, fresh fetch karega
  }
}

async function setCached(key, value) {
  try {
    await db.collection("prokerala_cache").doc(key).set({ value, cachedAt: Date.now() });
  } catch (err) {
    console.error("Cache save fail hua (koi badi baat nahi):", err.message);
  }
}

// --------------------------------------------------------
// Razorpay client (wallet mein paisa add karne ke liye)
// --------------------------------------------------------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("Public")); // frontend yahan se serve hoga

const PORT = process.env.PORT || 3000;

// --------------------------------------------------------
// STEP 1: Prokerala API se OAuth token lena
// (Prokerala OAuth2 "client_credentials" flow use karta hai)
// --------------------------------------------------------
let cachedToken = null;
let tokenExpiry = 0;

async function getProkeralaToken() {
  // Agar token abhi bhi valid hai to dubara mat maango
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const response = await fetch("https://api.prokerala.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.PROKERALA_CLIENT_ID,
      client_secret: process.env.PROKERALA_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    throw new Error("Prokerala token lene mein error: " + response.status);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  // token expiry se 60 sec pehle refresh kar lenge (safe margin)
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// --------------------------------------------------------
// STEP 2: Kundli / birth-chart data fetch karna
// --------------------------------------------------------
async function getKundliData({ dob, tob, lat, lon, tz }) {
  const token = await getProkeralaToken();

  // datetime format required by Prokerala: YYYY-MM-DDTHH:mm:ss+05:30
  // HTML time input sirf "HH:mm" deta hai (seconds nahi), isliye seconds add karte hain
  const timeWithSeconds = tob.length === 5 ? `${tob}:00` : tob;
  const datetime = `${dob}T${timeWithSeconds}${tz || "+05:30"}`;

  const url = new URL("https://api.prokerala.com/v2/astrology/birth-details");
  url.searchParams.set("ayanamsa", "1"); // 1 = Lahiri (most common in India)
  url.searchParams.set("coordinates", `${lat},${lon}`);
  url.searchParams.set("datetime", datetime);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Prokerala ne ye error diya:", errorBody);
    throw new Error(
      "Kundli data fetch karne mein error: " + response.status + " - " + errorBody
    );
  }

  return response.json();
}

// --------------------------------------------------------
// STEP 2B: Kundli Chart (SVG) fetch karna — North ya South Indian style
// --------------------------------------------------------
async function getKundliChartSvg({ dob, tob, lat, lon, tz, chartStyle }) {
  const token = await getProkeralaToken();

  const timeWithSeconds = tob.length === 5 ? `${tob}:00` : tob;
  const datetime = `${dob}T${timeWithSeconds}${tz || "+05:30"}`;

  const url = new URL("https://api.prokerala.com/v2/astrology/chart");
  url.searchParams.set("ayanamsa", "1");
  url.searchParams.set("coordinates", `${lat},${lon}`);
  url.searchParams.set("datetime", datetime);
  url.searchParams.set("chart_type", "rasi");
  url.searchParams.set("chart_style", chartStyle || "north-indian");
  url.searchParams.set("format", "svg");

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Chart API ne ye error diya:", errorBody);
    throw new Error("Chart fetch karne mein error: " + response.status + " - " + errorBody);
  }

  // Ye response seedha SVG text hota hai (JSON nahi)
  return response.text();
}

// --------------------------------------------------------
// STEP 2C: Sab grahon (planets) ki exact position fetch karna
// (Nakshatra, Rashi, degree — pandit logon ke liye zaroori)
// --------------------------------------------------------
async function getPlanetPositions({ dob, tob, lat, lon, tz }) {
  const token = await getProkeralaToken();

  const timeWithSeconds = tob.length === 5 ? `${tob}:00` : tob;
  const datetime = `${dob}T${timeWithSeconds}${tz || "+05:30"}`;

  const url = new URL("https://api.prokerala.com/v2/astrology/planet-position");
  url.searchParams.set("ayanamsa", "1");
  url.searchParams.set("coordinates", `${lat},${lon}`);
  url.searchParams.set("datetime", datetime);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Planet position API ne ye error diya:", errorBody);
    throw new Error(
      "Planet position fetch karne mein error: " + response.status + " - " + errorBody
    );
  }

  return response.json();
}


// --------------------------------------------------------
// STEP 2D: Mangal Dosh (Manglik) check
// Mars 1st, 2nd, 4th, 7th, 8th, 12th house mein ho to Mangal Dosh hota hai
// --------------------------------------------------------
async function getMangalDosha({ dob, tob, lat, lon, tz }) {
  const token = await getProkeralaToken();

  const timeWithSeconds = tob.length === 5 ? `${tob}:00` : tob;
  const datetime = `${dob}T${timeWithSeconds}${tz || "+05:30"}`;

  const url = new URL("https://api.prokerala.com/v2/astrology/mangal-dosha");
  url.searchParams.set("ayanamsa", "1");
  url.searchParams.set("coordinates", `${lat},${lon}`);
  url.searchParams.set("datetime", datetime);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Mangal Dosha API ne ye error diya:", errorBody);
    throw new Error(
      "Mangal Dosha check karne mein error: " + response.status + " - " + errorBody
    );
  }

  return response.json();
}

// --------------------------------------------------------
// STEP 2D-2: Kaal Sarp Dosha check
// Jab saare grahon Rahu-Ketu ke ek hi taraf ho, tab ye dosh hota hai
// --------------------------------------------------------
async function getKaalSarpDosha({ dob, tob, lat, lon, tz }) {
  const token = await getProkeralaToken();

  const timeWithSeconds = tob.length === 5 ? `${tob}:00` : tob;
  const datetime = `${dob}T${timeWithSeconds}${tz || "+05:30"}`;

  const url = new URL("https://api.prokerala.com/v2/astrology/kaal-sarp-dosha");
  url.searchParams.set("ayanamsa", "1");
  url.searchParams.set("coordinates", `${lat},${lon}`);
  url.searchParams.set("datetime", datetime);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Kaal Sarp Dosha API ne ye error diya:", errorBody);
    throw new Error(
      "Kaal Sarp Dosha check karne mein error: " + response.status + " - " + errorBody
    );
  }

  return response.json();
}

// --------------------------------------------------------
// STEP 2D-3: Mahadasha / Antardasha (Vimshottari Dasha) fetch karna
// Ye batata hai abhi kaunse graha ka "period" chal raha hai — predictions ke liye zaroori
// --------------------------------------------------------
async function getDashaPeriods({ dob, tob, lat, lon, tz }) {
  const token = await getProkeralaToken();

  const timeWithSeconds = tob.length === 5 ? `${tob}:00` : tob;
  const datetime = `${dob}T${timeWithSeconds}${tz || "+05:30"}`;

  const url = new URL("https://api.prokerala.com/v2/astrology/dasha-periods");
  url.searchParams.set("ayanamsa", "1");
  url.searchParams.set("coordinates", `${lat},${lon}`);
  url.searchParams.set("datetime", datetime);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Dasha Periods API ne ye error diya:", errorBody);
    throw new Error("Dasha periods fetch karne mein error: " + response.status + " - " + errorBody);
  }

  return response.json();
}


const LANGUAGE_NAMES = {
  hindi: "Hinglish (Hindi + English mix, jaisa Astrotalk pe astrologers baat karte hain)",
  english: "plain English",
  tamil: "Tamil (தமிழ்)",
  telugu: "Telugu (తెలుగు)",
  kannada: "Kannada (ಕನ್ನಡ)",
  bengali: "Bengali (বাংলা)",
  marathi: "Marathi (मराठी)",
  gujarati: "Gujarati (ગુજરાતી)",
};

function getLanguageInstruction(language) {
  const langName = LANGUAGE_NAMES[language] || LANGUAGE_NAMES.hindi;
  return `Jawab ${langName} mein likho. Agar language Hinglish ke alawa kuch aur hai, to us bhasha ki script mein hi shuddh likho (thoda bahut common English words chalenge, jaise astrology terms, lekin poora jawab us bhasha mein hona chahiye).`;
}


async function getDailyHoroscopeFromClaude({ name, moonRashi, nakshatra, period, language }) {
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-IN", {
    day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata",
  });

  // Period ke hisaab se time-range aur instruction badalte hain
  const periodConfig = {
    daily: {
      label: `AAJ (${todayStr})`,
      instruction: "aaj ke din ka",
      maxTokens: 400,
      lines: "5-6 lines se zyada mat likho",
    },
    weekly: {
      label: `is hafte (${todayStr} se agle 7 din)`,
      instruction: "is poore hafte ka",
      maxTokens: 500,
      lines: "7-8 lines mein rakho",
    },
    monthly: {
      label: `is mahine (${now.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" })})`,
      instruction: "is poore mahine ka",
      maxTokens: 600,
      lines: "9-10 lines mein rakho",
    },
    yearly: {
      label: `is saal (${now.getFullYear()})`,
      instruction: "is poore saal ka",
      maxTokens: 700,
      lines: "12-14 lines mein rakho, alag alag mahino/quarters ka thoda mention karte hue",
    },
  };
  const cfg = periodConfig[period] || periodConfig.daily;
  const langInstruction = getLanguageInstruction(language);

  const prompt = `Tum ek anubhavi (experienced) Vedic astrologer ho, jaisa Astrotalk app pe astrologers baat karte hain.

Neeche ek vyakti ki details di gayi hain:
Naam: ${name}
Chandra Rashi (Moon Sign): ${moonRashi || "pata nahi"}
Janma Nakshatra: ${nakshatra || "pata nahi"}
Time period: ${cfg.label}

Is Chandra Rashi ke aadhar par ${cfg.instruction} horoscope likho jisme ho:
1. Overall mood/energy
2. Career/Kaam ke liye kaisa rahega
3. Health aur Relationships ke liye tip
4. Lucky color ya number (optional, chhota sa mention)

${langInstruction}

Sirf final paragraph do, koi extra heading ya disclaimer nahi. Tone friendly aur positive rakho, ${cfg.lines}.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: cfg.maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Daily horoscope Claude error:", errorBody);
    throw new Error("Claude API error: " + response.status + " - " + errorBody);
  }

  const data = await response.json();
  const textBlock = data.content.find((c) => c.type === "text");
  return textBlock ? textBlock.text : "";
}


async function getCareerHoroscopeFromClaude({ name, kundliData, language }) {
  const langInstruction = getLanguageInstruction(language);
  const prompt = `Tum ek anubhavi (experienced) Vedic astrologer ho, jaisa Astrotalk app pe astrologers baat karte hain.

Neeche ek vyakti ki kundli ka raw astrological data diya gaya hai:

Naam: ${name}
Kundli Data (JSON): ${JSON.stringify(kundliData)}

Is data ke aadhar par ek friendly, easy-to-samajhne wala paragraph likho jisme ho:
1. Overall personality ki 2-3 lines
2. Career ke liye kaunse strengths hain
3. Career mein kis tarah ke opportunities aane wale hain (agle 6-12 mahine)
4. Ek chhota practical suggestion

${langInstruction}

Sirf final paragraph do, koi extra heading ya disclaimer nahi. Tone warm aur motivating rakho.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Claude ne ye error diya:", errorBody);
    throw new Error("Claude API error: " + response.status + " - " + errorBody);
  }

  const data = await response.json();
  const textBlock = data.content.find((c) => c.type === "text");
  return textBlock ? textBlock.text : "";
}

// --------------------------------------------------------
// STEP 6: Panchang — aaj ki tithi, nakshatra, yoga, karana, shubh muhurat
// --------------------------------------------------------
async function getPanchang({ date, lat, lon }) {
  const token = await getProkeralaToken();

  // Panchang ke liye din ka koi bhi time chalta hai, hum dopahar (12:00) use karte hain
  const datetime = `${date}T12:00:00+05:30`;

  const url = new URL("https://api.prokerala.com/v2/astrology/panchang");
  url.searchParams.set("ayanamsa", "1");
  url.searchParams.set("coordinates", `${lat},${lon}`);
  url.searchParams.set("datetime", datetime);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Panchang API ne ye error diya:", errorBody);
    throw new Error("Panchang fetch karne mein error: " + response.status + " - " + errorBody);
  }

  return response.json();
}

// --------------------------------------------------------
// STEP 5: Kundli Matching (Guna Milan) — do logon ki kundli match karna,
// shaadi ke liye compatibility check
// --------------------------------------------------------
async function getKundliMatch({ boy, girl }) {
  const token = await getProkeralaToken();

  const boyTimeWithSeconds = boy.tob.length === 5 ? `${boy.tob}:00` : boy.tob;
  const boyDatetime = `${boy.dob}T${boyTimeWithSeconds}+05:30`;

  const girlTimeWithSeconds = girl.tob.length === 5 ? `${girl.tob}:00` : girl.tob;
  const girlDatetime = `${girl.dob}T${girlTimeWithSeconds}+05:30`;

  const url = new URL("https://api.prokerala.com/v2/astrology/kundli-matching");
  url.searchParams.set("ayanamsa", "1");
  url.searchParams.set("boy_dob", boyDatetime);
  url.searchParams.set("boy_coordinates", `${boy.lat},${boy.lon}`);
  url.searchParams.set("girl_dob", girlDatetime);
  url.searchParams.set("girl_coordinates", `${girl.lat},${girl.lon}`);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Kundli match API ne ye error diya:", errorBody);
    throw new Error(
      "Kundli match karne mein error: " + response.status + " - " + errorBody
    );
  }

  return response.json();
}

async function getMatchSummaryFromClaude({ boyName, girlName, matchData, language }) {
  const langInstruction = getLanguageInstruction(language);
  const prompt = `Tum ek anubhavi (experienced) Vedic astrologer ho, jaisa Astrotalk app pe astrologers baat karte hain. Ye "Kundli Matching" (Guna Milan) ka
raw astrological data hai do logon ke beech shaadi compatibility check karne ke liye.

Ladka: ${boyName}
Ladki: ${girlName}
Matching Data (JSON): ${JSON.stringify(matchData)}

Is data ke aadhar par ek friendly, easy-to-samajhne wala paragraph likho jisme ho:
1. Overall compatibility score/summary (jo bhi data mein guna/points mile hain unko simple bhasha mein samjhao)
2. Strengths — dono ki kundli mein kya achha match ho raha hai
3. Agar koi dosh/concern hai to usko gently mention karo (scare mat karo, balanced tone rakho)
4. Ek chhota practical suggestion (jaise pandit se consult karne ka)

${langInstruction}

Sirf final paragraph do, koi extra heading ya disclaimer nahi. Tone warm aur balanced rakho — na bahut positive na bahut negative, jo data mein hai wahi bolo.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Claude match summary error:", errorBody);
    throw new Error("Claude API error: " + response.status + " - " + errorBody);
  }

  const data = await response.json();
  const textBlock = data.content.find((c) => c.type === "text");
  return textBlock ? textBlock.text : "";
}


// --------------------------------------------------------
// STEP 4: Chatbot — user apne sawal pooch sake apni kundli ke baare mein
// --------------------------------------------------------
async function askAstrologerBot({
  name,
  kundliData,
  planetPositions,
  mangalDosha,
  kaalSarpDosha,
  dashaData,
  question,
  history,
  language,
}) {
  const langInstruction = getLanguageInstruction(language);

  const systemPrompt = `Tum ek senior, anubhavi (experienced) Vedic astrologer ho jisne 20+ saal se logon ki kundli padhi hai.
Tum kabhi generic, template-jaisa jawab nahi dete — har jawab us specific insaan ki **poori kundli data ke gehre analysis** se aata hai.

===========================================
USER KI POORI KUNDLI DATA (SAB SOURCE OF TRUTH HAI)
===========================================
Naam: ${name}

1. Birth Details / Ascendant / Rashi / Nakshatra (Prokerala birth-details):
${JSON.stringify(kundliData)}

2. Grahon (Planets) ki exact position — Rashi, Nakshatra, Degree, Retrograde status:
${planetPositions ? JSON.stringify(planetPositions) : "Available nahi hai is baar"}

3. Mangal Dosha (Manglik) status:
${mangalDosha ? JSON.stringify(mangalDosha) : "Available nahi hai is baar"}

4. Kaal Sarp Dosha status:
${kaalSarpDosha ? JSON.stringify(kaalSarpDosha) : "Available nahi hai is baar"}

5. Mahadasha / Antardasha (current planetary period):
${dashaData ? JSON.stringify(dashaData) : "Available nahi hai is baar"}

===========================================
TUMHARA KAAM — HAR SAWAL PE YE PROCESS FOLLOW KARO
===========================================

STEP 1 — Question Category pehchano:
Career, Government Job, Private Job, Business, Marriage, Love Marriage, Relationship, Health,
Education, Children, Finance, Foreign Settlement, Property, Court Cases, Travel,
Spiritual Growth, Remedies, Gemstones, Daily Horoscope — ya jo bhi category ho.

STEP 2 — Category ke hisaab se sirf RELEVANT factors analyze karo (upar diye JSON data mein se):
- Career/Job: 10th house, 6th house, Saturn, Sun, Mercury, current Mahadasha/Antardasha
- Business: 2nd, 7th, 10th, 11th house, Mercury, Jupiter, Rahu
- Marriage/Love: 7th house, Venus, Jupiter, Dasha period
- Health: 6th, 8th, 12th house, Mars, Saturn
- Finance: 2nd, 11th house, Jupiter, Venus
- (Aur categories ke liye jo bhi astrologically relevant grah/houses hon, apni knowledge se use karo)

Jahan bhi data available ho wahan in cheezon ko dhyan mein rakho: Ascendant (Lagna), Moon Rashi, Sun sign,
Nakshatra, planet degrees, retrograde status, exaltation/debilitation, combustion, current Dasha/Antardasha,
aur agar data mein Yogas ya aspects (drishti) dikhein to unko bhi mention karo.

STEP 3 — Jawab is format mein do (sirf jo sections relevant hon, sab zaroori nahi har baar):

🔮 Kundli Analysis — kaunse houses/grahon ne is sawal ko affect kiya (2-3 lines)
📖 Astrological Reason — kyun ye prediction ban rahi hai, simple bhasha mein
🪐 Current Dasha — abhi ka Mahadasha/Antardasha is sawal pe kaise asar daal raha hai (agar data available ho)
📅 Best Time — agar possible ho to rough time period batao (warna "abhi clear nahi" bol do)
⭐ Prediction — seedha, samajhne layak answer
🙏 Remedies — agar appropriate ho: mantra, daan, vrat, mandir jaana, dhyan (SIRF tab jab genuinely relevant ho, har baar nahi)
💡 Practical Advice — ek chhota practical suggestion

===========================================
ZAROORI RULES
===========================================
- HAMESHA upar diye gaye asli kundli data (planets, houses, dasha) ke aadhar par jawab do — sirf DOB dekh ke generic baat mat karo
- Kabhi bhi darawana (fear-creating) jawab mat do
- Kabhi kisi cheez ki 100% guarantee mat do — hamesha "astrological possibility hai" jaisa tone rakho jab uncertain ho
- Agar koi data missing hai (jaise Dasha available nahi hai), to usko honestly mention karo, bana ke mat batao
- Gemstone recommend sirf tab karo jab kundli data se strongly support ho — warna avoid karo, cheaper remedies (mantra/daan/vrat) suggest karo
- Agar sawal astrology se related na ho, to politely bata do ki tum sirf astrology guidance de sakte ho
- Kabhi medical, legal, ya financial guarantee mat do — sirf astrological perspective do
- Jawab thoda detailed ho sakta hai (structured sections ke saath), lekin har section 1-3 lines se zyada lamba na ho — rambling mat karo
- ${langInstruction}`;

  // Pichli conversation history ko messages format mein convert karte hain
  const messages = (history || []).map((h) => ({
    role: h.role, // "user" ya "assistant"
    content: h.content,
  }));
  messages.push({ role: "user", content: question });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Claude chat ne ye error diya:", errorBody);
    throw new Error("Claude chat API error: " + response.status + " - " + errorBody);
  }

  const data = await response.json();
  const textBlock = data.content.find((c) => c.type === "text");
  return textBlock ? textBlock.text : "";
}

// --------------------------------------------------------
// OTP SEND: User email daalta hai, hum 6-digit code bhejte hain
// --------------------------------------------------------
// --------------------------------------------------------
// PLACE SEARCH: User jo bhi type kare (chhota gaon ho ya bada shehar),
// OpenStreetMap ke through poori India mein dhoondte hain
// --------------------------------------------------------
app.get("/api/places", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.length < 2) {
      return res.json({ results: [] });
    }

    const url = new URL("https://api.locationiq.com/v1/search");
    url.searchParams.set("key", process.env.LOCATIONIQ_API_KEY);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("countrycodes", "in"); // sirf India
    url.searchParams.set("limit", "8");

    const response = await fetch(url.toString());

    if (!response.ok) {
      // LocationIQ 404 deta hai jab koi result na mile — usko error na maano, khali list bhejo
      if (response.status === 404) {
        return res.json({ results: [] });
      }
      throw new Error("Place search API error: " + response.status);
    }

    const data = await response.json();

    // Sirf zaroori fields frontend ko bhejte hain
    const results = data.map((place) => ({
      name: place.display_name,
      lat: parseFloat(place.lat),
      lon: parseFloat(place.lon),
    }));

    res.json({ results });
  } catch (err) {
    console.error("Place search error:", err.message);
    res.status(500).json({ error: err.message, results: [] });
  }
});

app.post("/api/auth/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email zaroori hai" });
    }

    // 6-digit random OTP banate hain
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minute valid rahega

    // Firestore mein OTP store karte hain (email ko document id jaisa use karke,
    // safe naam ke liye base64 encode karte hain kyunki email mein @ hota hai)
    const otpDocId = Buffer.from(email).toString("base64");
    await db.collection("otps").doc(otpDocId).set({ email, otp, expiresAt });

    await sendEmail({
      to: email,
      subject: "Aapka Login Code - Kundli AI",
      html: `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2 style="color:#b5501a;">Kundli AI Login</h2>
          <p>Aapka verification code hai:</p>
          <h1 style="letter-spacing: 6px; color:#333;">${otp}</h1>
          <p style="color:#888; font-size:13px;">Ye code 5 minute ke liye valid hai.</p>
        </div>
      `,
    });

    res.json({ success: true, message: "OTP bhej diya" });
  } catch (err) {
    console.error("OTP send error:", err.message);
    res.status(500).json({ error: "OTP bhejne mein error: " + err.message });
  }
});

// --------------------------------------------------------
// OTP VERIFY: User code type karta hai, hum check karke
// ek Firebase custom token bana ke dete hain login complete karne ke liye
// --------------------------------------------------------
app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ error: "Email aur OTP zaroori hain" });
    }

    const otpDocId = Buffer.from(email).toString("base64");
    const otpDocRef = db.collection("otps").doc(otpDocId);
    const otpDoc = await otpDocRef.get();

    if (!otpDoc.exists) {
      return res.status(400).json({ error: "Pehle OTP mangwao" });
    }
    const record = otpDoc.data();
    if (Date.now() > record.expiresAt) {
      await otpDocRef.delete();
      return res.status(400).json({ error: "OTP expire ho gaya, dobara mangwao" });
    }
    if (record.otp !== otp) {
      return res.status(400).json({ error: "Galat OTP" });
    }

    // OTP sahi hai — ab use kar liya, delete kar dete hain
    await otpDocRef.delete();

    // Is email se pehle se koi Firebase user hai to use lo, warna naya banao
    let userRecord;
    try {
      userRecord = await authAdmin.getUserByEmail(email);
    } catch {
      userRecord = await authAdmin.createUser({ email });
    }

    // Custom token banate hain jisse frontend login complete kar sake
    const customToken = await authAdmin.createCustomToken(userRecord.uid);

    res.json({ success: true, customToken });
  } catch (err) {
    console.error("OTP verify error:", err.message);
    res.status(500).json({ error: "Verify karne mein error: " + err.message });
  }
});

// --------------------------------------------------------
// WALLET STEP 1: Razorpay order banao (user "Add Money" dabata hai)
// --------------------------------------------------------
app.post("/api/wallet/create-order", async (req, res) => {
  try {
    const { amount } = req.body; // amount rupees mein aayega, jaise 500
    if (!amount || amount < 1) {
      return res.status(400).json({ error: "Sahi amount daalo" });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Razorpay paise mein leta hai (₹1 = 100 paise)
      currency: "INR",
      receipt: "wallet_" + Date.now(),
    });

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID, // frontend ko public key chahiye checkout kholne ke liye
    });
  } catch (err) {
    console.error("Order create error:", err.message);
    res.status(500).json({ error: "Order banane mein error: " + err.message });
  }
});

// --------------------------------------------------------
// WALLET STEP 2: Payment complete hone ke baad, verify karke wallet update karo
// --------------------------------------------------------
app.post("/api/wallet/verify-payment", async (req, res) => {
  try {
    const { uid, amount, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!uid || !amount || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Kuch fields missing hain" });
    }

    // Signature verify karte hain — ye confirm karta hai ki payment genuine hai,
    // koi fake request nahi bhej raha
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Payment verify nahi hui — signature match nahi hua" });
    }

    // Sahi hai — ab wallet mein paisa add karo
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    const currentWallet = userDoc.exists ? userDoc.data().wallet || 0 : 0;
    const newWallet = currentWallet + Number(amount);

    await userRef.update({ wallet: newWallet });

    res.json({ success: true, newWallet });
  } catch (err) {
    console.error("Payment verify error:", err.message);
    res.status(500).json({ error: "Verify karne mein error: " + err.message });
  }
});


// hum usse verify karke user ko database mein save/fetch karte hain
// --------------------------------------------------------
app.post("/api/auth/verify", async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ error: "idToken zaroori hai" });
    }

    // Token verify karo — ye confirm karta hai ki request genuine Firebase user se hai
    const decoded = await authAdmin.verifyIdToken(idToken);
    const uid = decoded.uid;

    const userRef = db.collection("users").doc(uid);
    const existingDoc = await userRef.get();

    if (!existingDoc.exists) {
      // Naya user hai — wallet 0 se shuru karte hain
      await userRef.set({
        phone: decoded.phone_number || "",
        wallet: 0,
        createdAt: new Date().toISOString(),
      });
    }

    const userData = (await userRef.get()).data();
    res.json({ success: true, uid, user: userData });
  } catch (err) {
    console.error("Login verify error:", err.message);
    res.status(401).json({ error: "Login verify nahi hua: " + err.message });
  }
});

// --------------------------------------------------------
// MAIN ENDPOINT: Frontend ye hi call karega
// --------------------------------------------------------
app.post("/api/horoscope", async (req, res) => {
  try {
    const { name, dob, tob, lat, lon, language } = req.body;

    if (!name || !dob || !tob || !lat || !lon) {
      return res.status(400).json({
        error: "name, dob, tob, lat, lon — sab fields zaroori hain",
      });
    }

    // 1. Real kundli data lao (cache check pehle karte hain)
    const kundliCacheKey = makeCacheKey("kundli", { dob, tob, lat, lon });
    let kundliData = await getCached(kundliCacheKey);
    if (!kundliData) {
      kundliData = await getKundliData({ dob, tob, lat, lon });
      await setCached(kundliCacheKey, kundliData);
    }

    // 2. North Indian style chart (SVG) lao (cache check pehle karte hain)
    // NOTE: South Indian chart ab yahan nahi mangwate — rate limit bachane ke liye
    // usko sirf tab fetch karte hain jab user South toggle dabaye (lazy load)
    const chartCacheKey = makeCacheKey("chart_north", { dob, tob, lat, lon });
    let chartSvg = await getCached(chartCacheKey);
    if (!chartSvg) {
      try {
        chartSvg = await getKundliChartSvg({ dob, tob, lat, lon, chartStyle: "north-indian" });
        await setCached(chartCacheKey, chartSvg);
      } catch (chartErr) {
        // Agar chart fail ho jaye to bhi horoscope text dikhana band mat karo
        console.error("North chart fetch fail hua, lekin aage badh rahe hain:", chartErr.message);
      }
    }

    // NOTE: Planet Positions, Mangal Dosha, Kaal Sarp Dosha, aur Dasha ab yahan nahi
    // mangwate — rate limit bachane ke liye. Ye sab ab "on-demand" buttons se lazy-load
    // hote hain (dekho neeche /api/planet-positions, /api/mangal-dosha,
    // /api/kaal-sarp-dosha, /api/dasha endpoints)

    // 3. Us data ko Claude se samjhwao (career horoscope banwao)
    const careerHoroscope = await getCareerHoroscopeFromClaude({
      name,
      kundliData,
      language,
    });

    // 4. Sab kuch frontend ko bhejo
    res.json({
      success: true,
      kundliRaw: kundliData,
      chartSvg,
      careerHoroscope,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// SOUTH CHART (LAZY LOAD + CACHED): User jab South Indian toggle dabaye tabhi ye call hota hai
// --------------------------------------------------------
app.get("/api/chart-south", async (req, res) => {
  try {
    const { dob, tob, lat, lon } = req.query;
    if (!dob || !tob || !lat || !lon) {
      return res.status(400).json({ error: "dob, tob, lat, lon zaroori hain" });
    }
    const cacheKey = makeCacheKey("chart_south", { dob, tob, lat, lon });
    let chartSvgSouth = await getCached(cacheKey);
    if (!chartSvgSouth) {
      chartSvgSouth = await getKundliChartSvg({ dob, tob, lat, lon, chartStyle: "south-indian" });
      await setCached(cacheKey, chartSvgSouth);
    }
    res.json({ success: true, chartSvgSouth });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// DASHA (LAZY LOAD + CACHED): User jab chat pehli baar khole tabhi ye call hota hai
// --------------------------------------------------------
app.get("/api/dasha", async (req, res) => {
  try {
    const { dob, tob, lat, lon } = req.query;
    if (!dob || !tob || !lat || !lon) {
      return res.status(400).json({ error: "dob, tob, lat, lon zaroori hain" });
    }
    const cacheKey = makeCacheKey("dasha", { dob, tob, lat, lon });
    let dashaData = await getCached(cacheKey);
    if (!dashaData) {
      dashaData = await getDashaPeriods({ dob, tob, lat, lon });
      await setCached(cacheKey, dashaData);
    }
    res.json({ success: true, dashaData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// MANGAL DOSHA (LAZY LOAD + CACHED): User "Check Mangal Dosha" button dabaye tab
// --------------------------------------------------------
app.get("/api/mangal-dosha", async (req, res) => {
  try {
    const { dob, tob, lat, lon } = req.query;
    if (!dob || !tob || !lat || !lon) {
      return res.status(400).json({ error: "dob, tob, lat, lon zaroori hain" });
    }
    const cacheKey = makeCacheKey("mangal", { dob, tob, lat, lon });
    let mangalDosha = await getCached(cacheKey);
    if (!mangalDosha) {
      mangalDosha = await getMangalDosha({ dob, tob, lat, lon });
      await setCached(cacheKey, mangalDosha);
    }
    res.json({ success: true, mangalDosha });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// KAAL SARP DOSHA (LAZY LOAD + CACHED): User "Check Kaal Sarp Dosha" button dabaye tab
// --------------------------------------------------------
app.get("/api/kaal-sarp-dosha", async (req, res) => {
  try {
    const { dob, tob, lat, lon } = req.query;
    if (!dob || !tob || !lat || !lon) {
      return res.status(400).json({ error: "dob, tob, lat, lon zaroori hain" });
    }
    const cacheKey = makeCacheKey("kaalsarp", { dob, tob, lat, lon });
    let kaalSarpDosha = await getCached(cacheKey);
    if (!kaalSarpDosha) {
      kaalSarpDosha = await getKaalSarpDosha({ dob, tob, lat, lon });
      await setCached(cacheKey, kaalSarpDosha);
    }
    res.json({ success: true, kaalSarpDosha });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// PLANET POSITIONS (LAZY LOAD + CACHED): User "Show Graha Positions" button dabaye tab
// --------------------------------------------------------
app.get("/api/planet-positions", async (req, res) => {
  try {
    const { dob, tob, lat, lon } = req.query;
    if (!dob || !tob || !lat || !lon) {
      return res.status(400).json({ error: "dob, tob, lat, lon zaroori hain" });
    }
    const cacheKey = makeCacheKey("planets", { dob, tob, lat, lon });
    let planetPositions = await getCached(cacheKey);
    if (!planetPositions) {
      planetPositions = await getPlanetPositions({ dob, tob, lat, lon });
      await setCached(cacheKey, planetPositions);
    }
    res.json({ success: true, planetPositions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// DAILY HOROSCOPE ENDPOINT: User ki Chandra Rashi ke hisaab se aaj ka horoscope
// --------------------------------------------------------
app.post("/api/daily-horoscope", async (req, res) => {
  try {
    const { name, moonRashi, nakshatra, period, language } = req.body;

    if (!name || !moonRashi) {
      return res.status(400).json({ error: "name aur moonRashi zaroori hain" });
    }

    const dailyHoroscope = await getDailyHoroscopeFromClaude({
      name, moonRashi, nakshatra, period, language,
    });
    res.json({ success: true, dailyHoroscope });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// PANCHANG ENDPOINT: Kisi bhi date/place ka Panchang (tithi, nakshatra waghera)
// --------------------------------------------------------
app.get("/api/panchang", async (req, res) => {
  try {
    const { date, lat, lon } = req.query;
    if (!date || !lat || !lon) {
      return res.status(400).json({ error: "date, lat, lon zaroori hain" });
    }

    const panchangData = await getPanchang({ date, lat, lon });
    res.json({ success: true, panchang: panchangData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// KUNDLI MATCHING ENDPOINT: Do logon ki details lekar compatibility check karta hai
// --------------------------------------------------------
app.post("/api/match", async (req, res) => {
  try {
    const { boy, girl, language } = req.body;

    if (!boy?.name || !boy?.dob || !boy?.tob || !boy?.lat || !boy?.lon) {
      return res.status(400).json({ error: "Ladke ki poori details (naam, DOB, TOB, place) zaroori hain" });
    }
    if (!girl?.name || !girl?.dob || !girl?.tob || !girl?.lat || !girl?.lon) {
      return res.status(400).json({ error: "Ladki ki poori details (naam, DOB, TOB, place) zaroori hain" });
    }

    const matchData = await getKundliMatch({ boy, girl });

    const summary = await getMatchSummaryFromClaude({
      boyName: boy.name,
      girlName: girl.name,
      matchData,
      language,
    });

    res.json({ success: true, matchData, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// CHAT ENDPOINT: User apne sawal poochega yahan
// Har sawal ka ₹5 wallet se katega
// --------------------------------------------------------
const CHAT_PRICE = 5;

app.post("/api/chat", async (req, res) => {
  try {
    const {
      uid,
      name,
      kundliData,
      planetPositions,
      mangalDosha,
      kaalSarpDosha,
      dashaData,
      question,
      history,
      language,
    } = req.body;

    if (!uid || !name || !kundliData || !question) {
      return res.status(400).json({
        error: "uid, name, kundliData aur question zaroori hain",
      });
    }

    // Pehle wallet check karo
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    const currentWallet = userDoc.exists ? userDoc.data().wallet || 0 : 0;

    if (currentWallet < CHAT_PRICE) {
      return res.status(400).json({
        error: `Wallet mein sirf ₹${currentWallet} hai. Ek sawal ke liye ₹${CHAT_PRICE} chahiye — pehle wallet mein paisa add karo.`,
        insufficientBalance: true,
      });
    }

    // Paisa pehle kaat lete hain (taaki double-charge na ho agar user jaldi jaldi dabaye)
    const newWallet = currentWallet - CHAT_PRICE;
    await userRef.update({ wallet: newWallet });

    const answer = await askAstrologerBot({
      name,
      kundliData,
      planetPositions,
      mangalDosha,
      kaalSarpDosha,
      dashaData,
      question,
      history,
      language,
    });

    res.json({ success: true, answer, newWallet });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server chal raha hai: http://localhost:${PORT}`);
});
