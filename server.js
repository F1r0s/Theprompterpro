require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/lead', (req, res) => {
  const contact = typeof req.body?.contact === 'string' ? req.body.contact.trim() : '';
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
  const isPhone = /^\d{7,15}$/.test(contact);

  if (!contact || (!isEmail && !isPhone)) {
    return res.status(400).json({ error: 'Please enter a valid email address or digits-only phone number.' });
  }

  fs.appendFile(path.join(__dirname, 'leads.txt'), `${contact}\n`, (err) => {
    if (err) {
      console.error('[LEAD ERROR]', err.message);
      return res.status(500).json({ error: 'Unable to save lead.' });
    }

    return res.json({ ok: true });
  });
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
        });
}

module.exports = app;

