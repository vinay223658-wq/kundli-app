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
// PROKERALA RATE LIMITER
// Free plan mein sirf 5 requests/60 seconds allowed hain. Ek hi horoscope
// generate karne mein kai saari cheezein (chart, planets, doshas, dasha)
// fetch karni padti hain, isliye saare Prokerala calls is throttle se
// guzarte hain — automatically wait karega agar limit paas ho rahi ho,
// aur agar phir bhi 429 aa jaye (server restart ke turant baad residual
// usage ya dusre traffic ki wajah se) to retry karega.
//
// NOTE: Ye counter sirf isi process ki memory mein hai — jab bhi server
// restart/redeploy hota hai, ye 0 se shuru hota hai. Isliye 5 ki jagah
// 3 rakha hai (safety margin) taaki turant deploy ke baad bhi extra
// buffer rahe agar Prokerala ke apne server pe pichla usage abhi tak
// clear na hua ho.
// --------------------------------------------------------
const PROKERALA_MAX_PER_WINDOW = 3;
const PROKERALA_WINDOW_MS = 60 * 1000;
let prokeralaCallTimestamps = [];

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prokeralaThrottle() {
  // Jab tak window mein jagah na ho, wait karte raho
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();
    prokeralaCallTimestamps = prokeralaCallTimestamps.filter(
      (t) => now - t < PROKERALA_WINDOW_MS
    );

    if (prokeralaCallTimestamps.length < PROKERALA_MAX_PER_WINDOW) {
      prokeralaCallTimestamps.push(now);
      return;
    }

    const oldestCall = prokeralaCallTimestamps[0];
    const waitTime = PROKERALA_WINDOW_MS - (now - oldestCall) + 500; // 500ms safety buffer
    console.log(`Prokerala rate limit paas hai, ${Math.ceil(waitTime / 1000)}s wait kar rahe hain...`);
    await waitMs(waitTime);
  }
}

// Prokerala ke saare GET-style calls isi se karo — throttle + auto-retry-on-429
// 3 retries deta hai (server restart ke baad residual usage clear hone ke liye
// zyada time chahiye ho sakta hai), har baar thoda zyada wait karta hai
const RETRY_WAITS = [15000, 20000, 25000]; // 15s, 20s, 25s

async function prokeralaFetch(url, options, retriesLeft = 3) {
  await prokeralaThrottle();
  const response = await fetch(url, options);

  if (response.status === 429 && retriesLeft > 0) {
    const waitTime = RETRY_WAITS[RETRY_WAITS.length - retriesLeft];
    console.warn(`Prokerala se 429 mila, ${waitTime / 1000}s wait karke retry (${retriesLeft} retries bache hain)...`);
    await waitMs(waitTime);
    return prokeralaFetch(url, options, retriesLeft - 1);
  }

  return response;
}



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

  const response = await prokeralaFetch(url.toString(), {
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

  const response = await prokeralaFetch(url.toString(), {
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

  const response = await prokeralaFetch(url.toString(), {
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

  const response = await prokeralaFetch(url.toString(), {
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

  const response = await prokeralaFetch(url.toString(), {
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
// STEP 2D-3: Dasha Periods (Mahadasha/Antardasha) — timing ke liye zaroori
// --------------------------------------------------------
async function getDashaPeriods({ dob, tob, lat, lon, tz }) {
  const token = await getProkeralaToken();

  const timeWithSeconds = tob.length === 5 ? `${tob}:00` : tob;
  const datetime = `${dob}T${timeWithSeconds}${tz || "+05:30"}`;

  const url = new URL("https://api.prokerala.com/v2/astrology/dasha-periods");
  url.searchParams.set("ayanamsa", "1");
  url.searchParams.set("coordinates", `${lat},${lon}`);
  url.searchParams.set("datetime", datetime);

  const response = await prokeralaFetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Dasha Periods API ne ye error diya:", errorBody);
    throw new Error("Dasha periods fetch karne mein error: " + response.status + " - " + errorBody);
  }

  return response.json();
}

// --------------------------------------------------------
// STEP 2D-4: Current Transit (Gochar) — aaj ke din grahon ki position,
// birth chart ke houses se compare karne ke liye (birth place coordinates use karte hain)
// --------------------------------------------------------
async function getCurrentTransit({ lat, lon, tz }) {
  const now = new Date();
  const isoNow = now.toISOString().slice(0, 19) + (tz || "+05:30");

  const token = await getProkeralaToken();
  const url = new URL("https://api.prokerala.com/v2/astrology/planet-position");
  url.searchParams.set("ayanamsa", "1");
  url.searchParams.set("coordinates", `${lat},${lon}`);
  url.searchParams.set("datetime", isoNow);

  const response = await prokeralaFetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Current Transit API ne ye error diya:", errorBody);
    throw new Error("Current transit fetch karne mein error: " + response.status + " - " + errorBody);
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

  const response = await prokeralaFetch(url.toString(), {
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

  const response = await prokeralaFetch(url.toString(), {
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
  dashaPeriods,
  transitPositions,
  question,
  history,
  language,
}) {
  const langInstruction = getLanguageInstruction(language);

  const systemPrompt = `Tum ek senior, anubhavi (highly experienced) Vedic astrologer ho — bilkul Astrotalk ke top-rated astrologers jaisa. Tumhara kaam hai user ki POORI Kundli ka gehrai se analysis karke, generic nahi balki uski apni kundli ke hisaab se personalized jawab dena.

=== USER KI KUNDLI DATA (Prokerala API se) ===
Naam: ${name}
Birth Details / Ascendant / Rashi / Nakshatra (JSON): ${JSON.stringify(kundliData)}
Planet Positions — Rashi, Nakshatra, Degree, Retrograde status (JSON): ${JSON.stringify(planetPositions)}
Mangal Dosha (Manglik) Result: ${mangalDosha ? JSON.stringify(mangalDosha) : "abhi check nahi kiya gaya"}
Kaal Sarp Dosha Result: ${kaalSarpDosha ? JSON.stringify(kaalSarpDosha) : "abhi check nahi kiya gaya"}
Vimshottari Dasha Periods — Mahadasha/Antardasha (JSON): ${dashaPeriods ? JSON.stringify(dashaPeriods) : "abhi fetch nahi hua"}
Current Transit (Gochar) — aaj ke grahon ki position (JSON): ${transitPositions ? JSON.stringify(transitPositions) : "abhi fetch nahi hua"}

=== KAISE KAAM KARNA HAI ===
1. JAWAB SIRF DOB SE MAT DO — hamesha upar diye gaye poore Kundli data (ascendant, rashi, nakshatra, planet positions/degrees/retrograde, dosha results, dasha, transit) ka analysis karke jawab do. Agar koi factor (jaise dasha ya transit) fetch nahi hua hai, to us baat ko honestly mention karo aur available data se hi best possible analysis do — kabhi data ka bahana banao mat.

2. QUESTION KI CATEGORY PEHCHANO (mentally, bina bataye): Career/Government Job/Private Job/Business/Marriage/Love/Relationship/Health/Education/Children/Finance/Foreign Settlement/Property/Court Case/Travel/Spiritual/Remedies/Gemstones/Daily Horoscope/General. Us category ke hisaab se sirf relevant houses aur grahon pe focus karo:
   - Career/Job: 10th house, 6th house, Saturn, Sun, Mercury, current Mahadasha/Antardasha, transit
   - Business: 2nd, 7th, 10th, 11th house, Mercury, Jupiter, Rahu
   - Marriage/Relationship: 7th house, Venus, Jupiter, Dasha
   - Health: 6th, 8th, 12th house, Mars, Saturn
   - Finance: 2nd, 11th house, Jupiter, Venus
   - Baaki categories ke liye apni Vedic astrology knowledge se sabse relevant factors chuno.

3. Available data se jitna reasonably nikal sakte ho nikalo — planet ki rashi/degree se exaltation-debilitation, retrograde status, aur agar Sun ke paas degree ho to combustion jaise factors ka apna astrological gyaan use karke andaza lagao. Jahan data confirm nahi karta wahan "possibility" jaise words use karo, definite claim mat karo.

4. JAWAB KA FORMAT (sirf jab relevant ho tabhi wo section daalo, sab kuch har jawab mein zabardasti mat thoso — chhote/casual sawaal ka chhota jawab bhi theek hai):
🔮 Kundli Analysis — kaunse houses/planets is sawal ke liye relevant hain
📖 Astrological Reason — kyun (reasoning)
🪐 Current Dasha — abhi ki Mahadasha/Antardasha ka is par kya asar hai (agar data available ho)
📅 Best Time — possible time period (agar bata sakte ho)
⭐ Prediction — kya ho sakta hai
🙏 Remedies — mantra, daan, vrat, mandir jaana, dhyan (gemstone sirf tab suggest karo jab kundli data strongly support kare, aur hamesha mention karo ki gemstone se pehle astrologer se consult karna chahiye)
💡 Practical Advice — practical, real-world suggestion

5. KABHI DAR MAT PHAILAO. Kabhi 100% guarantee mat do ki ye event hoga hi. Jahan uncertainty ho, saaf bolo "ye sirf ek astrological possibility hai, guarantee nahi".

6. Agar sawal astrology se related na ho, to politely bata do ki tum sirf astrology/career/relationship/health guidance de sakte ho. Kabhi medical/legal/financial guarantee mat do.

7. LANGUAGE: User jis language/script mein sawal likhe usi mein jawab do (agar user Hindi mein likhe to Hindi mein, English mein likhe to English mein, Hinglish mein likhe to Hinglish mein). Agar user ki language clear na ho to ye default follow karo: ${langInstruction}

8. Jawab natural conversational tone mein rakho — bullet/emoji headings tabhi use karo jab jawab detailed ho; chhote follow-up sawaalon ka seedha chhota jawab do, poora format zabardasti mat thoso.`;

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
      max_tokens: 900,
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

    // 1. Real kundli data lao
    const kundliData = await getKundliData({ dob, tob, lat, lon });

    // 2. North Indian chart (SVG) lao — South Indian baad mein on-demand fetch hoga
    //    (Prokerala free plan ka rate limit — 5 req/60s — bachane ke liye)
    let chartSvg = null;
    try {
      chartSvg = await getKundliChartSvg({ dob, tob, lat, lon, chartStyle: "north-indian" });
    } catch (chartErr) {
      // Agar chart fail ho jaye to bhi horoscope text dikhana band mat karo
      console.error("North chart fetch fail hua, lekin aage badh rahe hain:", chartErr.message);
    }

    // 2B. Grahon (planets) ki exact position bhi lao — pandit logon ke liye
    let planetPositions = null;
    try {
      planetPositions = await getPlanetPositions({ dob, tob, lat, lon });
    } catch (planetErr) {
      console.error("Planet position fetch fail hua, lekin aage badh rahe hain:", planetErr.message);
    }

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
      planetPositions,
      careerHoroscope,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// CHART STYLE ENDPOINT: South Indian chart on-demand (jab user toggle kare)
// --------------------------------------------------------
app.post("/api/chart-style", async (req, res) => {
  try {
    const { dob, tob, lat, lon, style } = req.body;
    if (!dob || !tob || !lat || !lon) {
      return res.status(400).json({ error: "dob, tob, lat, lon zaroori hain" });
    }
    const chartSvg = await getKundliChartSvg({ dob, tob, lat, lon, chartStyle: style || "south-indian" });
    res.json({ success: true, chartSvg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// DOSHAS ENDPOINT: Mangal Dosha + Kaal Sarp Dosha on-demand (jab user "Check" dabaye)
// --------------------------------------------------------
app.post("/api/doshas", async (req, res) => {
  try {
    const { dob, tob, lat, lon } = req.body;
    if (!dob || !tob || !lat || !lon) {
      return res.status(400).json({ error: "dob, tob, lat, lon zaroori hain" });
    }

    let mangalDosha = null;
    try {
      mangalDosha = await getMangalDosha({ dob, tob, lat, lon });
    } catch (mangalErr) {
      console.error("Mangal Dosha fetch fail hua:", mangalErr.message);
    }

    let kaalSarpDosha = null;
    try {
      kaalSarpDosha = await getKaalSarpDosha({ dob, tob, lat, lon });
    } catch (kaalErr) {
      console.error("Kaal Sarp Dosha fetch fail hua:", kaalErr.message);
    }

    res.json({ success: true, mangalDosha, kaalSarpDosha });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// DASHA + TRANSIT ENDPOINT: AI Chat engine ke liye — ek baar fetch hota hai
// (jab user pehli baar chat khole), phir frontend cache karke reuse karta hai
// --------------------------------------------------------
app.post("/api/dasha-transit", async (req, res) => {
  try {
    const { dob, tob, lat, lon } = req.body;
    if (!dob || !tob || !lat || !lon) {
      return res.status(400).json({ error: "dob, tob, lat, lon zaroori hain" });
    }

    let dashaPeriods = null;
    try {
      dashaPeriods = await getDashaPeriods({ dob, tob, lat, lon });
    } catch (dashaErr) {
      console.error("Dasha fetch fail hua:", dashaErr.message);
    }

    let transitPositions = null;
    try {
      transitPositions = await getCurrentTransit({ lat, lon });
    } catch (transitErr) {
      console.error("Transit fetch fail hua:", transitErr.message);
    }

    res.json({ success: true, dashaPeriods, transitPositions });
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
      uid, name, kundliData, planetPositions, mangalDosha, kaalSarpDosha,
      dashaPeriods, transitPositions, question, history, language,
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
      name, kundliData, planetPositions, mangalDosha, kaalSarpDosha,
      dashaPeriods, transitPositions, question, history, language,
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
