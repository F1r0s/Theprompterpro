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

// ── Gemini Prompt Optimizer Endpoint ──────────────────────────────
app.post('/api/optimize', async (req, res) => {
  const { prompt, mode } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'No prompt provided.' });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'PASTE_YOUR_NEW_KEY_HERE') {
    return res.status(500).json({ error: 'Gemini API key not configured on server.' });
  }

  // ── System Instructions per mode ───────────────────────────────────
  const systemInstructions = {
    text: `You are PromptEnhance, an expert AI prompt engineer. Your job is to take the user's brief, vague input and expand it into a highly professional, structured prompt template.

You must adapt the role, context variables, and instructions to perfectly match the THEME and TOPIC of what the user asked for.

DO NOT output meta-commentary. Output ONLY the resulting prompt that the user will copy.

Use EXACTLY this structure for your output. You MUST replace the text inside the {curly braces} with highly specific, relevant content based on what the user asked for. Leave the [square brackets] as placeholders for the user to fill in.

Act as a {Insert highly specific Expert Role based on the topic}. Your task is to {Rewrite the user's original goal here, making it sound professional and detailed}. Please provide specific, actionable results based on the following context:

Context:
- {Identify a relevant context variable for this topic, e.g., Target Audience}: [{Provide a placeholder for the user, e.g., "[Specify target audience...]"}]
- {Identify a 2nd relevant context variable}: [{Provide a placeholder}]
- {Identify a 3rd relevant context variable}: [{Provide a placeholder}]
- {Identify a 4th relevant context variable}: [{Provide a placeholder}]

Instructions:
1. {Write a highly specific, actionable step breaking down the task}
2. {Write a second specific step detailing what the AI should focus on}
3. {Write a third specific step}
4. {Write a fourth specific step}
5. Format your response using clear headings, bullet points, and concise language.

Output Format: A structured report with the sections: {List the specific sections the AI should use in its final output based on the topic}.`,

    image: `You are PromptEnhance, an expert AI prompt engineer. Your job is to take the user's brief image idea and expand it into a highly professional, structured prompt template for Midjourney or DALL-E.

You must adapt the role, context variables, and instructions to perfectly match the THEME and TOPIC of what the user asked for.

DO NOT output meta-commentary. Output ONLY the resulting prompt that the user will copy.

Use EXACTLY this structure for your output. You MUST replace the text inside the {curly braces} with highly specific, relevant content based on what the user asked for. Leave the [square brackets] as placeholders for the user to fill in.

Act as a {Insert highly specific Expert Role, e.g., Senior Concept Artist or Master Photographer}. Your task is to {Rewrite the user's original goal here, making it sound professional}. Please provide a highly detailed image generation prompt based on the following context:

Context:
- {Identify a relevant context variable, e.g., Art Style or Camera Lens}: [{Provide a placeholder, e.g., "[Specify art style like Cinematic, Cyberpunk, Watercolor]"}]
- {Identify a 2nd relevant context variable, e.g., Lighting}: [{Provide a placeholder}]
- {Identify a 3rd relevant context variable, e.g., Mood}: [{Provide a placeholder}]

Instructions:
1. {Write a highly specific step about detailing the main subject and setting}
2. {Write a specific step about specifying the lighting, camera angle, and rendering engine}
3. {Write a specific step about adding fine details and textures}
4. Include a strong negative prompt to avoid common artifacts (e.g., blurry, deformed, watermark).
5. Format your response clearly.

Output Format: A structured prompt with the sections: {List specific sections like Subject Description, Camera & Lighting, Rendering Parameters, and Negative Prompt}.`,

    video: `You are PromptEnhance, an expert AI prompt engineer. Your job is to take the user's brief video idea and expand it into a highly professional, structured prompt template for AI video generators like Sora or Runway.

You must adapt the role, context variables, and instructions to perfectly match the THEME and TOPIC of what the user asked for.

DO NOT output meta-commentary. Output ONLY the resulting prompt that the user will copy.

Use EXACTLY this structure for your output. You MUST replace the text inside the {curly braces} with highly specific, relevant content based on what the user asked for. Leave the [square brackets] as placeholders for the user to fill in.

Act as a {Insert highly specific Expert Role, e.g., Hollywood Cinematographer or VFX Director}. Your task is to {Rewrite the user's original goal here, making it sound professional}. Please provide a highly detailed video generation prompt based on the following context:

Context:
- {Identify a relevant context variable, e.g., Camera Movement}: [{Provide a placeholder, e.g., "[Specify movement like Drone shot, Slow pan, Handheld]"}]
- {Identify a 2nd relevant context variable, e.g., Cinematic Style}: [{Provide a placeholder}]
- {Identify a 3rd relevant context variable, e.g., Lighting/Time of Day}: [{Provide a placeholder}]

Instructions:
1. {Write a highly specific step about describing the sequential action of the video}
2. {Write a specific step about the camera framing and motion dynamics}
3. {Write a specific step about the environmental lighting and atmospheric effects}
4. Include necessary technical constraints (e.g., 4k resolution, 60fps, photorealistic).
5. Format your response clearly.

Output Format: A structured prompt with the sections: {List specific sections like Scene Action, Camera Dynamics, Lighting & Atmosphere, and Technical Parameters}.`,

    pdf: `You are PromptEnhance, an expert AI prompt engineer. Your job is to take the user's brief document query and expand it into a highly professional, structured prompt template for analyzing a PDF or document.

You must adapt the role, context variables, and instructions to perfectly match the THEME and TOPIC of what the user asked for.

DO NOT output meta-commentary. Output ONLY the resulting prompt that the user will copy.

Use EXACTLY this structure for your output. You MUST replace the text inside the {curly braces} with highly specific, relevant content based on what the user asked for. Leave the [square brackets] as placeholders for the user to fill in.

Act as a {Insert highly specific Expert Role, e.g., Senior Data Analyst or Legal Researcher}. Your task is to {Rewrite the user's original goal here, making it sound professional}. Please analyze the provided document based on the following context:

Context:
- {Identify a relevant context variable, e.g., Key Focus Area}: [{Provide a placeholder, e.g., "[Specify what to look for, e.g., financial metrics, risk factors]"}]
- {Identify a 2nd relevant context variable, e.g., Target Audience for the Summary}: [{Provide a placeholder}]
- {Identify a 3rd relevant context variable, e.g., Exclusion Criteria}: [{Provide a placeholder}]

Instructions:
1. {Write a highly specific step about extracting the core thesis or key data}
2. {Write a specific step about formatting the extracted information}
3. {Write a specific step about identifying anomalies, risks, or key insights}
4. {Write a fourth specific step}
5. Format your response using clear headings and concise bullet points.

Output Format: A structured report with the sections: {List specific sections like Executive Summary, Key Findings, Data Extraction, and Conclusions}.`,

    app: `You are PromptEnhance, an expert AI prompt engineer. Your job is to take the user's brief app idea and expand it into a highly professional, structured prompt template for an AI coding assistant (like Cursor or Copilot).

You must adapt the role, context variables, and instructions to perfectly match the THEME and TOPIC of what the user asked for.

DO NOT output meta-commentary. Output ONLY the resulting prompt that the user will copy.

Use EXACTLY this structure for your output. You MUST replace the text inside the {curly braces} with highly specific, relevant content based on what the user asked for. Leave the [square brackets] as placeholders for the user to fill in.

Act as a {Insert highly specific Expert Role, e.g., Senior Full-Stack Architect or Lead Product Manager}. Your task is to {Rewrite the user's original goal here, making it sound professional}. Please provide a comprehensive development blueprint based on the following context:

Context:
- {Identify a relevant context variable, e.g., Tech Stack Preference}: [{Provide a placeholder, e.g., "[Specify stack, e.g., Next.js, Tailwind, Prisma]"}]
- {Identify a 2nd relevant context variable, e.g., Target User Persona}: [{Provide a placeholder}]
- {Identify a 3rd relevant context variable, e.g., Core MVP Feature}: [{Provide a placeholder}]

Instructions:
1. {Write a highly specific step about defining the database schema or architecture}
2. {Write a specific step about outlining the UI/UX user flow}
3. {Write a specific step about identifying required APIs or third-party integrations}
4. {Write a specific step about writing the starter code structure}
5. Format your response using clear headings, bullet points, and code blocks.

Output Format: A structured blueprint with the sections: {List specific sections like Architecture Overview, Database Schema, UI/UX Flow, and Starter Code}.`
  };

  const systemInstruction = systemInstructions[mode] || systemInstructions.text;

  try {
    // Fixed the model name to use the current latest model
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`;

    const geminiBody = {
      system_instruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt.trim() }]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
        topP: 0.9
      }
    };

    const geminiRes = await axios.post(geminiUrl, geminiBody, {
      headers: { 'Content-Type': 'application/json' }
    });

    const optimized = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!optimized) {
      return res.status(500).json({ error: 'No response from Gemini.' });
    }

    res.json({ optimized });

  } catch (err) {
    console.error('[GEMINI ERROR]', err.response?.data || err.message);
    res.status(500).json({ error: 'Gemini API request failed.' });
  }
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`\n✦ PromptEnhance Server running at http://localhost:${PORT}`);
        console.log(`  Postback URL: https://yourdomain.com/api/postback?session_id={aff_sub4}\n`);
    });
}

module.exports = app;

