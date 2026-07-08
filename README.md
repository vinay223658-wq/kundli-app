# Kundli + Career Horoscope App — Setup Guide

Ye app do cheezein combine karta hai:
1. **Prokerala Astrology API** — real kundli/planetary data (accurate calculation)
2. **Claude API** — us data ko friendly Hindi/Hinglish career horoscope text mein badalna

---

## Step 1: Files samjho

```
kundli-app/
├── server.js          -> backend logic (API calls yahan hote hain)
├── public/index.html  -> frontend form (user yahan data bharega)
├── package.json        -> dependencies list
└── .env.example         -> yahan apni API keys daalni hain
```

## Step 2: Node.js install karo (agar nahi hai)

- https://nodejs.org se LTS version download karke install karo
- Terminal mein check karo: `node -v`

## Step 3: Dependencies install karo

Terminal/CMD kholo, `kundli-app` folder mein jao aur likho:

```bash
npm install
```

## Step 4: API keys lo (dono FREE mein shuru ho sakti hain)

### A) Prokerala Astrology API
1. https://api.prokerala.com par jao aur signup karo
2. Free plan le lo (limited requests/month free hoti hain, testing ke liye kaafi)
3. Dashboard se **Client ID** aur **Client Secret** copy karo

### B) Claude (Anthropic) API
1. https://console.anthropic.com par jao aur account banao
2. "API Keys" section se ek naya key generate karo
3. Thoda credit add karna padega (shuru mein $5 kaafi hai testing ke liye — ek request mein paise ka bahut chhota fraction lagta hai)

## Step 5: .env file banao

`.env.example` file ko copy karke naam `.env` rakho, aur apni keys usme paste karo:

```bash
cp .env.example .env
```

Phir `.env` file kholo aur values bharo:
```
PROKERALA_CLIENT_ID=abc123...
PROKERALA_CLIENT_SECRET=xyz456...
ANTHROPIC_API_KEY=sk-ant-...
PORT=3000
```

## Step 6: App chalao

```bash
npm start
```

Terminal mein dikhega: `Server chal raha hai: http://localhost:3000`

Browser mein ye link kholo: **http://localhost:3000**

## Step 7: Test karo

Form mein Naam, Date of Birth, Time of Birth, aur birth place ka latitude/longitude bharo (Google pe "Delhi latitude longitude" search karke mil jayega), phir "Horoscope Dekho" button dabao.

---

## Ye app real users tak kaise le jao (deployment)

Local pe test hone ke baad, sasti hosting ke liye:
- **Render.com** — free tier available, Node.js apps ke liye best
- **Railway.app** — bhi free tier deta hai
- Frontend ko baad mein Flutter app mein bhi convert kar sakte ho (ye same backend use karega)

## Cost kitni aayegi (approx)

| Cheez | Cost |
|---|---|
| Prokerala API | Free tier hai, phir paid plans ~$10-20/month se shuru |
| Claude API | Pay-as-you-go, ek horoscope generate karne mein ~₹0.50-1 ka kharcha (Sonnet model se) |
| Hosting (Render/Railway) | Free tier available shuru mein |

## Important note

Ye ek **starter/MVP code** hai — production app (jaise Astrotalk) banane ke liye aapko baad mein add karna hoga:
- User login/signup system
- Payment gateway (Razorpay)
- Database (user history save karne ke liye)
- Rate limiting (taaki koi API cost na badha de)
