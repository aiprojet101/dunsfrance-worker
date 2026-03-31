# dunsfrance-worker

Worker Node.js/Express qui tourne sur Railway.
Reçoit les demandes de lookup depuis le webhook Stripe (via dunsfrance Next.js).
Lance Playwright pour scraper D&B UPIK et envoie le résultat par email via Resend.

## Endpoints
- GET /         → health check
- POST /lookup  → déclenche scraping + email (protégé par x-internal-key)

## Variables d'environnement
- RESEND_API_KEY
- INTERNAL_API_KEY
- PORT (défini automatiquement par Railway)

## Déploiement
Railway détecte automatiquement Node.js et installe Playwright + Chromium.
