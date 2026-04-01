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

async function lookupDuns(companyName, countryFr) {
  const countryEn = COUNTRY_MAP[countryFr] ?? countryFr;

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-http2",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "en-US",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
    });

    // Masquer webdriver
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const page = await context.newPage();

    // Essai 1 : upik.de (portail européen D&B, moins protégé)
    try {
      await page.goto("https://www.upik.de/en/duns_search.html", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // Accept cookies
      try {
        await page.locator("button:has-text('Accept'), button:has-text('Akzeptieren'), #acceptBtn, .accept-btn").first().click({ timeout: 4000 });
        await page.waitForTimeout(800);
      } catch { /* pas de bandeau */ }

      const nameInput = page.locator("input[name='firmname'], input[name='company'], input[id*='firm'], input[id*='name'], input[type='text']").first();
      await nameInput.waitFor({ timeout: 15000 });
      await nameInput.fill(companyName);

      // Pays si champ présent
      try {
        const sel = page.locator("select[name='land'], select[name='country'], select[id*='country']").first();
        await sel.selectOption({ label: countryEn });
      } catch { /* champ pays absent */ }

      await page.locator("button[type='submit'], input[type='submit'], button:has-text('Search'), input[value*='Search']").first().click();
      await page.waitForTimeout(5000);

      const bodyText = await page.locator("body").innerText();
      const m1 = bodyText.match(/\b(\d{9})\b/);
      if (m1) return m1[1];
      const m2 = bodyText.match(/\b\d{2}-\d{3}-\d{4}\b/);
      if (m2) return m2[0].replace(/-/g, "");
    } catch (e) {
      console.error("[lookup] upik.de échoué:", e.message);
    }

    // Essai 2 : dnb.com/upik via URL directe avec paramètres GET
    try {
      const searchUrl = `https://www.dnb.com/de-de/upik-en.html?name=${encodeURIComponent(companyName)}&country=${encodeURIComponent(countryEn)}`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(4000);
      const bodyText = await page.locator("body").innerText();
      const m1 = bodyText.match(/\b(\d{9})\b/);
      if (m1) return m1[1];
    } catch (e) {
      console.error("[lookup] dnb.com échoué:", e.message);
    }

    return null;
  } finally {
    await browser.close();
  }
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
