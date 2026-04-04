require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Session Store for Offer Completion Tracking ─────────────────────
// Maps session_id → { completed: boolean, timestamp: Date, ip: string }
const completedSessions = new Map();

// Clean up old sessions every 30 minutes (keep for 24 hours)
setInterval(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, session] of completedSessions) {
        if (session.timestamp < cutoff) completedSessions.delete(id);
    }
}, 30 * 60 * 1000);

// Enable CORS
app.use(cors());

// Parse JSON and URL-encoded bodies (needed for postback)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve all static files (html, css, js)
app.use(express.static(__dirname));

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Generate Unique Session Token ───────────────────────────────────
app.get('/api/session', (req, res) => {
    const sessionId = crypto.randomBytes(16).toString('hex');
    completedSessions.set(sessionId, {
        completed: false,
        timestamp: Date.now(),
        ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown'
    });
    console.log(`[SESSION] Created: ${sessionId}`);
    res.json({ session_id: sessionId });
});

// ── OGAds Postback Endpoint ─────────────────────────────────────────
// OGAds will call this URL when a user completes an offer.
// Set your postback URL in OGAds dashboard to:
//   https://yourdomain.com/api/postback?session_id={aff_sub4}
app.get('/api/postback', (req, res) => {
    const sessionId = req.query.session_id || req.query.aff_sub4;
    console.log(`\n[POSTBACK] Received! Session: ${sessionId}`);
    console.log(`[POSTBACK] Full query:`, req.query);

    if (sessionId && completedSessions.has(sessionId)) {
        completedSessions.get(sessionId).completed = true;
        console.log(`[POSTBACK] ✓ Session ${sessionId} marked as COMPLETED`);
        res.status(200).send('OK');
    } else {
        console.warn(`[POSTBACK] ✗ Unknown session: ${sessionId}`);
        res.status(200).send('OK'); // Always return 200 to OGAds
    }
});

// ── Check Completion Status ─────────────────────────────────────────
// Frontend polls this to see if the user completed the offer
app.get('/api/check-completion', (req, res) => {
    const sessionId = req.query.session_id;

    if (!sessionId || !completedSessions.has(sessionId)) {
        return res.json({ completed: false });
    }

    const session = completedSessions.get(sessionId);
    res.json({ completed: session.completed });
});

// ── The Secure Offers Endpoint ──────────────────────────────────────
app.get('/api/offers', async (req, res) => {
    console.log("----------------------------------------------------------------");
    console.log("Incoming Request to /api/offers");
    console.log("Query Params:", req.query);

    try {
        const { user_agent, max, session_id } = req.query;

        // IP Detection (Vercel/Proxy aware)
        const forwarded = req.headers['x-forwarded-for'];
        let clientIp = null;

        if (forwarded) {
            clientIp = forwarded.split(',')[0].trim();
        }

        if (!clientIp) {
            clientIp = req.query.ip || req.socket?.remoteAddress;
        }

        // Normalize IP
        if (clientIp && clientIp.includes('::ffff:')) {
            clientIp = clientIp.replace('::ffff:', '');
        }

        // Localhost fallback
        if (!clientIp || clientIp === '::1' || clientIp === '127.0.0.1') {
            console.warn("Using fallback IP for Localhost/Unknown client.");
            clientIp = '64.233.160.0';
        }

        console.log(`[IP DEBUG] Header: ${forwarded} | Resolved: ${clientIp}`);

        // Build the OGAds API request
        const apiUrl = 'https://appchecker.store/api/v2';

        const params = {
            user_agent: user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            ctype: 1,   // CPI offers only
            max: 50,    // Fetch a large pool so we can filter for high-payout CPI
            ip: clientIp
        };

        // Pass session_id as aff_sub4 so OGAds includes it in the postback
        if (session_id) {
            params.aff_sub4 = session_id;
        }

        console.log(`Fetching from OGAds API...`);

        const response = await axios.get(apiUrl, {
            params: params,
            headers: {
                'Authorization': `Bearer ${process.env.LOCKER_API_KEY}`
            }
        });

        console.log("OGAds Response Status:", response.status);

        if (!response.data || !response.data.offers) {
            console.warn("OGAds returned no offers or invalid structure:", response.data);
            return res.json(response.data);
        }

        let rawOffers = response.data.offers;
        console.log(`Received ${rawOffers.length} raw offers.`);

        // Deduplication
        const uniqueMap = new Map();
        rawOffers.forEach(offer => {
            const id = offer.offerid;
            if (!uniqueMap.has(id)) {
                uniqueMap.set(id, offer);
            } else {
                const existing = uniqueMap.get(id);
                if (offer.boosted && !existing.boosted) {
                    uniqueMap.set(id, offer);
                }
            }
        });

        let dedupedOffers = Array.from(uniqueMap.values());
        console.log(`Offers after deduplication: ${dedupedOffers.length}`);

        // ── FILTER: CPI offers with minimum $0.60 payout ──────────
        const MIN_PAYOUT = 0.60;

        // Prioritize offers that have "cpi" in the name AND payout >= $0.60
        let cpiFiltered = dedupedOffers.filter(o => {
            const name = (o.name || "").toLowerCase();
            const payout = parseFloat(o.payout || 0);
            return name.includes("cpi") && payout >= MIN_PAYOUT;
        });

        console.log(`CPI-named offers with payout >= $${MIN_PAYOUT}: ${cpiFiltered.length}`);

        // Fallback: if not enough CPI-named offers, include any offer with payout >= $0.60
        if (cpiFiltered.length < 3) {
            console.log('Not enough CPI-named offers, expanding to all offers with payout >= $0.60...');
            cpiFiltered = dedupedOffers.filter(o => {
                const payout = parseFloat(o.payout || 0);
                return payout >= MIN_PAYOUT;
            });
            console.log(`All offers with payout >= $${MIN_PAYOUT}: ${cpiFiltered.length}`);
        }

        // Final fallback: if still nothing, use all deduped offers
        if (cpiFiltered.length === 0) {
            console.log('No offers met the payout filter, using all available offers.');
            cpiFiltered = dedupedOffers;
        }

        // ── SORTING: CPI name → highest payout → best EPC ─────────
        const VIP_IDS = [67939, 70489];

        cpiFiltered.sort((a, b) => {
            const getRank = (o) => {
                const name = (o.name || "").toLowerCase();
                const adcopy = (o.adcopy || "").toLowerCase();
                if (VIP_IDS.includes(parseInt(o.offerid))) return 0;
                if (name.includes("cpi") && parseFloat(o.payout || 0) >= 1.00) return 1;  // High-value CPI
                if (name.includes("cpi") && parseFloat(o.payout || 0) >= MIN_PAYOUT) return 2;  // Standard CPI
                if (adcopy.includes("download and install") && adcopy.includes("30 seconds")) return 3;
                if (o.ctype & 1) return 4;  // CPI type flag
                return 5;
            };

            const rankA = getRank(a);
            const rankB = getRank(b);
            if (rankA !== rankB) return rankA - rankB;

            // Higher payout first
            const payoutA = parseFloat(a.payout || 0);
            const payoutB = parseFloat(b.payout || 0);
            if (payoutA !== payoutB) return payoutB - payoutA;

            // Lower EPC = easier for user to complete
            const epcA = parseFloat(a.epc || 0);
            const epcB = parseFloat(b.epc || 0);
            return epcA - epcB;
        });

        // Apply user's requested limit
        const userLimit = parseInt(max) || 5;
        let finalOffers = cpiFiltered.slice(0, userLimit);

        console.log(`Sending ${finalOffers.length} final offers to client.`);

        const result = { ...response.data, offers: finalOffers };
        res.json(result);

    } catch (error) {
        console.error("!!! PROXY ERROR !!!");
        console.error("Message:", error.message);
        if (error.response) {
            console.error("Upstream Data:", error.response.data);
            console.error("Upstream Status:", error.response.status);
            res.status(error.response.status).json(error.response.data);
        } else {
            console.error("Stack:", error.stack);
            res.status(500).json({ success: false, error: "Internal Server Error" });
        }
    }
});

app.listen(PORT, () => {
    console.log(`\n✦ Prompt Optimizer Server running at http://localhost:${PORT}`);
    console.log(`  Postback URL: https://yourdomain.com/api/postback?session_id={aff_sub4}\n`);
});
