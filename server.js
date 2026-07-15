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
// STEP 2B: North Indian style Kundli Chart (SVG) fetch karna
// --------------------------------------------------------
async function getKundliChartSvg({ dob, tob, lat, lon, tz }) {
  const token = await getProkeralaToken();

  const timeWithSeconds = tob.length === 5 ? `${tob}:00` : tob;
  const datetime = `${dob}T${timeWithSeconds}${tz || "+05:30"}`;

  const url = new URL("https://api.prokerala.com/v2/astrology/chart");
  url.searchParams.set("ayanamsa", "1");
  url.searchParams.set("coordinates", `${lat},${lon}`);
  url.searchParams.set("datetime", datetime);
  url.searchParams.set("chart_type", "rasi");
  url.searchParams.set("chart_style", "north-indian");
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

//         text mein convert karwana
// --------------------------------------------------------
async function getCareerHoroscopeFromClaude({ name, kundliData }) {
  const prompt = `Tum ek anubhavi (experienced) Vedic astrologer ho jo Hinglish (Hindi + English mix) mein
baat karte ho, jaisa Astrotalk app pe astrologers karte hain.

Neeche ek vyakti ki kundli ka raw astrological data diya gaya hai:

Naam: ${name}
Kundli Data (JSON): ${JSON.stringify(kundliData)}

Is data ke aadhar par ek friendly, easy-to-samajhne wala paragraph likho jisme ho:
1. Overall personality ki 2-3 lines
2. Career ke liye kaunse strengths hain
3. Career mein kis tarah ke opportunities aane wale hain (agle 6-12 mahine)
4. Ek chhota practical suggestion

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
// STEP 4: Chatbot — user apne sawal pooch sake apni kundli ke baare mein
// --------------------------------------------------------
async function askAstrologerBot({ name, kundliData, question, history }) {
  const systemPrompt = `Tum ek anubhavi (experienced), friendly Vedic astrologer ho jo Hinglish
(Hindi + English mix) mein baat karte ho, bilkul Astrotalk app ke astrologers jaisa.

Is user ki kundli ka raw data:
Naam: ${name}
Kundli Data (JSON): ${JSON.stringify(kundliData)}

Rules:
- User ke sawaalon ka jawab isi kundli data ke aadhar par do
- Jawab chhota, friendly aur samajhne layak rakho (3-5 lines max, jab tak user detail na maange)
- Agar sawal astrology se related na ho, to politely bata do ki tum sirf astrology/career/relationship guidance de sakte ho
- Kabhi medical, legal, ya financial guarantee mat do — sirf astrological perspective do`;

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
      max_tokens: 400,
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
    const { name, dob, tob, lat, lon } = req.body;

    if (!name || !dob || !tob || !lat || !lon) {
      return res.status(400).json({
        error: "name, dob, tob, lat, lon — sab fields zaroori hain",
      });
    }

    // 1. Real kundli data lao
    const kundliData = await getKundliData({ dob, tob, lat, lon });

    // 2. North Indian style chart (SVG) bhi lao
    let chartSvg = null;
    try {
      chartSvg = await getKundliChartSvg({ dob, tob, lat, lon });
    } catch (chartErr) {
      // Agar chart fail ho jaye to bhi horoscope text dikhana band mat karo
      console.error("Chart fetch fail hua, lekin aage badh rahe hain:", chartErr.message);
    }

    // 3. Us data ko Claude se samjhwao (career horoscope banwao)
    const careerHoroscope = await getCareerHoroscopeFromClaude({
      name,
      kundliData,
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
// CHAT ENDPOINT: User apne sawal poochega yahan
// Har sawal ka ₹5 wallet se katega
// --------------------------------------------------------
const CHAT_PRICE = 5;

app.post("/api/chat", async (req, res) => {
  try {
    const { uid, name, kundliData, question, history } = req.body;

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

    const answer = await askAstrologerBot({ name, kundliData, question, history });

    res.json({ success: true, answer, newWallet });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server chal raha hai: http://localhost:${PORT}`);
});
