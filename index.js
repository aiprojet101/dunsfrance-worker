const express = require("express");
const { chromium } = require("playwright");
const { Resend } = require("resend");

const app = express();
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const PORT = process.env.PORT || 3001;

const COUNTRY_MAP = {
  "France": "France", "Allemagne": "Germany", "Belgique": "Belgium",
  "Suisse": "Switzerland", "Espagne": "Spain", "Italie": "Italy",
  "Royaume-Uni": "United Kingdom", "États-Unis": "United States",
  "Canada": "Canada", "Pays-Bas": "Netherlands", "Luxembourg": "Luxembourg",
  "Portugal": "Portugal", "Autriche": "Austria", "Pologne": "Poland",
  "Suède": "Sweden", "Danemark": "Denmark", "Finlande": "Finland",
  "Norvège": "Norway", "Irlande": "Ireland", "Maroc": "Morocco",
  "Tunisie": "Tunisia", "Algérie": "Algeria", "Sénégal": "Senegal",
};

// Extraire un numéro DUNS (9 chiffres) d'un texte
function extractDuns(text) {
  // Format xx-xxx-xxxx
  const m2 = text.match(/\b(\d{2})-(\d{3})-(\d{4})\b/);
  if (m2) return m2[1] + m2[2] + m2[3];
  // 9 chiffres consécutifs (pas 10+)
  const m1 = text.match(/(?<!\d)(\d{9})(?!\d)/);
  if (m1) return m1[1];
  return null;
}

async function lookupDuns(companyName, countryFr) {
  const countryEn = COUNTRY_MAP[countryFr] ?? countryFr;

  // Méthode 1 : API D&B directe (JSON endpoint)
  try {
    const apiUrl = `https://www.dnb.com/api/v1/search?searchTerm=${encodeURIComponent(companyName)}&country=${encodeURIComponent(countryEn)}&pageNumber=1&pageSize=5`;
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Referer": "https://www.dnb.com/",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      const text = JSON.stringify(data);
      const duns = extractDuns(text);
      if (duns) { console.log("[lookup] API D&B OK"); return duns; }
    }
  } catch (e) { console.error("[lookup] API D&B:", e.message); }

  // Méthode 2 : DuckDuckGo search
  try {
    const query = `"${companyName}" "${countryEn}" DUNS number site:dnb.com OR site:opencorporates.com`;
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const html = await res.text();
      const duns = extractDuns(html);
      if (duns) { console.log("[lookup] DuckDuckGo OK"); return duns; }
    }
  } catch (e) { console.error("[lookup] DuckDuckGo:", e.message); }

  // Méthode 3 : Opencorporates API
  try {
    const jurisd = countryFr === "France" ? "fr" :
                   countryFr === "Allemagne" ? "de" :
                   countryFr === "Belgique" ? "be" :
                   countryFr === "Suisse" ? "ch" : "";
    const url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(companyName)}${jurisd ? "&jurisdiction_code=" + jurisd : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const data = await res.json();
      const text = JSON.stringify(data);
      const duns = extractDuns(text);
      if (duns) { console.log("[lookup] Opencorporates OK"); return duns; }
    }
  } catch (e) { console.error("[lookup] Opencorporates:", e.message); }

  // Méthode 4 : Playwright sur Bing (moteur moins protégé)
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    await context.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
    const page = await context.newPage();
    const q = encodeURIComponent(`"${companyName}" "${countryEn}" DUNS 9 digits`);
    await page.goto(`https://www.bing.com/search?q=${q}`, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(2000);
    const text = await page.locator("body").innerText();
    const duns = extractDuns(text);
    if (duns) { console.log("[lookup] Bing OK"); return duns; }
  } catch (e) {
    console.error("[lookup] Bing:", e.message);
  } finally {
    await browser.close();
  }

  return null;
}

async function sendEmail(to, companyName, dunsNumber) {
  const subject = dunsNumber
    ? `Votre numéro DUNS — ${companyName}`
    : `Résultat recherche DUNS — ${companyName}`;

  const html = dunsNumber
    ? `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:40px 24px;color:#1a1f2e">
        <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Votre numéro DUNS</h1>
        <p style="color:#6b7280;margin-bottom:24px">Entreprise : <strong>${companyName}</strong></p>
        <div style="background:#f0f4ff;border:2px solid #3b5bdb;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
          <p style="font-size:13px;color:#6b7280;margin:0 0 8px 0">Numéro D-U-N-S</p>
          <p style="font-size:36px;font-weight:700;letter-spacing:4px;color:#1a1f2e;margin:0">${dunsNumber}</p>
        </div>
        <p style="font-size:13px;color:#9ca3af">DUNS France — Service indépendant, non affilié à Dun & Bradstreet.</p>
      </div>`
    : `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:40px 24px;color:#1a1f2e">
        <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Résultat de votre recherche</h1>
        <p style="color:#6b7280;margin-bottom:24px">Entreprise : <strong>${companyName}</strong></p>
        <p>Nous n'avons pas trouvé de numéro DUNS pour cette entreprise dans la base Dun & Bradstreet.</p>
        <p>Votre paiement de 1,99 € sera remboursé sous 3 à 5 jours ouvrés.</p>
        <p style="font-size:13px;color:#9ca3af">DUNS France — Service indépendant, non affilié à Dun & Bradstreet.</p>
      </div>`;

  await resend.emails.send({
    from: "DUNS France <noreply@dunsfrance.fr>",
    to,
    subject,
    html,
  });
}

// Health check
app.get("/", (req, res) => res.json({ status: "ok" }));

// Lookup endpoint
app.post("/lookup", async (req, res) => {
  // Vérification clé interne
  if (req.headers["x-internal-key"] !== INTERNAL_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { companyName, country, email } = req.body;
  if (!companyName || !email) {
    return res.status(400).json({ error: "Données manquantes" });
  }

  // Répondre immédiatement — le traitement continue en arrière-plan
  res.json({ status: "processing" });

  try {
    console.log(`[lookup] Recherche DUNS pour: ${companyName} (${country})`);
    const dunsNumber = await lookupDuns(companyName, country ?? "France");
    console.log(`[lookup] Résultat: ${dunsNumber ?? "non trouvé"}`);
    await sendEmail(email, companyName, dunsNumber);
    console.log(`[lookup] Email envoyé à ${email}`);
  } catch (err) {
    console.error("[lookup] Erreur:", err.message);
  }
});

app.listen(PORT, () => console.log(`Worker DUNS démarré sur port ${PORT}`));
