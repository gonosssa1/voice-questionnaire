/**
 * Voice Questionnaire Server
 * 
 * This server:
 * 1. Serves the frontend application
 * 2. Proxies API calls to ElevenLabs (TTS) and Anthropic/OpenAI (validation)
 * 3. Keeps API keys secure on the server side
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// CONFIGURATION
// ============================================================================

const config = {
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY,
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL',
    modelId: 'eleven_turbo_v2_5',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-sonnet-4-20250514',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-mini',
  },
  validationProvider: process.env.VALIDATION_PROVIDER || 'anthropic',
};

// ============================================================================
// VALIDATION PROMPT BUILDER
// ============================================================================

function buildValidationPrompt(question, questionType, transcript, choices = null) {
  let typeInstructions = '';
  
  switch (questionType) {
    case 'yes_no':
      typeInstructions = `
TYPE: YES_NO
RULES:
- ONLY accept EXPLICIT yes or no responses
- Valid YES: "yes", "yeah", "yep", "yup", "correct", "right", "I do", "I have", "affirmative", "uh-huh", "sure", "absolutely"
- Valid NO: "no", "nope", "nah", "negative", "I don't", "I haven't", "never", "not really"
- INVALID: "maybe", "sometimes", "I think so", "probably", "kind of", or ANY unrelated response
- Normalize to exactly "YES" or "NO" (uppercase)`;
      break;
      
    case 'date':
      typeInstructions = `
TYPE: DATE
RULES:
- Response must contain or imply a date or time period
- Valid: "January 15 1980", "1/15/80", "March 2020", "last year", "about 6 months ago", "2019", "when I was 30"
- INVALID: unrelated words, "yes", "no", car brands, random nouns
- Normalize to the most specific date/time description possible`;
      break;
      
    case 'number':
      typeInstructions = `
TYPE: NUMBER
RULES:
- Response must contain or imply a number
- Valid: "5", "five", "about three", "a couple", "none", "zero", "many times", "once or twice"
- INVALID: unrelated responses that don't imply any quantity
- Normalize to a number or descriptive quantity`;
      break;
      
    case 'choice':
      typeInstructions = `
TYPE: CHOICE
VALID OPTIONS: ${choices ? choices.join(', ') : 'any'}
RULES:
- Response must match or clearly indicate one of the valid options
- Accept variations and synonyms (e.g., "pretty bad" could mean "severe")
- INVALID: responses that don't map to any option
- Normalize to the exact option text`;
      break;
      
    case 'open':
    default:
      typeInstructions = `
TYPE: OPEN TEXT
RULES:
- Response should be relevant to the question asked
- Accept any reasonable answer that attempts to address the question
- Only mark as INVALID if completely nonsensical or clearly unrelated (e.g., "Volvo" for "what medications do you take")
- Normalize by cleaning up the text (trim whitespace, fix obvious transcription issues)
- If the response includes acknowledgements (e.g., "ok", "I get it"), omit them and return only the answer`;
  }

  return `You are an answer validator for a medical insurance questionnaire. Your ONLY job is to determine if a spoken response is a valid answer to the question, and normalize it.

QUESTION: "${question}"
USER'S SPOKEN RESPONSE: "${transcript}"

${typeInstructions}

If the response is a request to repeat or restate the question, respond with:
{"valid": false, "normalized": null, "repeat": true}

If the response is INVALID, include a brief explanation (one sentence, under 15 words) directed at the user (use "you"/"your") and asking for a valid response. Do not echo back what the user said. Do not repeat the question.

RESPOND WITH ONLY THIS JSON (no markdown, no explanation, just the JSON):
{"valid": true, "normalized": "THE_NORMALIZED_VALUE"}
or
{"valid": false, "normalized": null, "explanation": "Brief reason why this doesn't answer the question."}
or
{"valid": false, "normalized": null, "repeat": true}

Remember:
- Be strict for yes_no questions - only accept clear yes or no
- Be lenient for open questions - accept anything relevant  
- The "normalized" value should be clean and standardized
- For yes_no, normalized MUST be exactly "YES" or "NO"`;
}

// ============================================================================
// WHY EXPLANATION PROMPT BUILDER
// ============================================================================

function buildWhyPrompt(question, section, explainLevel = 1, previousExplanation = null) {
  const followUpNote = explainLevel > 1
    ? 'This is a follow-up request. Add a bit more detail than before and avoid repeating prior phrasing.'
    : 'This is the first explanation.';
  const previousText = previousExplanation
    ? `PREVIOUS EXPLANATION: "${previousExplanation}"`
    : 'PREVIOUS EXPLANATION: none';

  return `You are a helpful assistant for an insurance questionnaire. The user asked why they need to answer a question.

SECTION: "${section}"
QUESTION: "${question}"
${previousText}
EXPLANATION LEVEL: ${explainLevel}
${followUpNote}

Provide a concise, user-directed explanation of why this question is relevant (1-2 sentences). Keep it conversational and neutral. Do not re-ask the question. Do not mention internal policies or underwriting guidelines.

RESPOND WITH ONLY THIS JSON (no markdown, no explanation):
{"explanation": "YOUR_EXPLANATION"}`;
}

// ============================================================================
// FOLLOW-UP PROMPT BUILDER
// ============================================================================

function buildFollowupPrompt({
  context,
  section,
  questionText,
  lastAnswer,
  priorAnswers = [],
  topic,
  previousFollowups = [],
  guidance,
  upcomingQuestions = [],
  sectionAnswers = {},
  recentQAPairs = [],
  primaryContext = null,
}) {
  const safePrior = Array.isArray(priorAnswers) ? priorAnswers.slice(-3) : [];
  const safeFollowups = Array.isArray(previousFollowups) ? previousFollowups.slice(-3) : [];
  const safeUpcoming = Array.isArray(upcomingQuestions) ? upcomingQuestions.slice(0, 4) : [];
  const safePairs = Array.isArray(recentQAPairs) ? recentQAPairs.slice(-4) : [];
  const contextLine = context ? `CONTEXT: "${context}"` : 'CONTEXT: none';
  const topicLine = topic ? `TOPIC: "${topic}"` : 'TOPIC: none';
  const guidanceLine = guidance ? `GUIDANCE: "${guidance}"` : 'GUIDANCE: none';
  const primaryLine = primaryContext && primaryContext.answer
    ? `PRIMARY CONTEXT: "${primaryContext.id} = ${primaryContext.answer}"`
    : 'PRIMARY CONTEXT: none';
  const sectionLine = sectionAnswers && Object.keys(sectionAnswers).length > 0
    ? `SECTION ANSWERS: ${JSON.stringify(sectionAnswers)}`
    : 'SECTION ANSWERS: none';
  const qaLine = safePairs.length > 0
    ? `RECENT Q/A PAIRS: ${safePairs.map((pair) => `Q: "${pair.q}" A: "${pair.a}"`).join(' | ')}`
    : 'RECENT Q/A PAIRS: none';

  return `You are a follow-up question generator for a life insurance questionnaire. Your job is to ask at most ONE concise, relevant follow-up question to clarify or expand on the user's last answer.

${contextLine}
SECTION: "${section}"
QUESTION: "${questionText}"
LAST ANSWER: "${lastAnswer}"
RECENT USER ANSWERS: ${safePrior.map((a) => `"${a}"`).join(', ') || 'none'}
PREVIOUS FOLLOW-UP QUESTIONS: ${safeFollowups.map((q) => `"${q}"`).join(', ') || 'none'}
UPCOMING SCRIPT QUESTIONS: ${safeUpcoming.map((q) => `"${q}"`).join(', ') || 'none'}
${primaryLine}
${sectionLine}
${qaLine}
${topicLine}
${guidanceLine}

RULES:
- Ask ONLY ONE follow-up question, or respond done.
- You are NOT required to ask a follow-up. If not clearly helpful, respond done.
- The follow-up must be relevant to the last answer and the section topic.
- Keep it short, conversational, and insurance-appropriate.
- Focus on underwriting-relevant details only: diagnosis, dates, treatment, medications, severity, limitations, hospitalizations, or ongoing care.
- Avoid lifestyle coaching, wellness advice, or curiosity questions unrelated to underwriting.
- Do NOT ask for SSN, credit card, or highly sensitive personal data.
- Only ask about tests, labs, or measurements if the user mentioned tests or measurements.
- Do NOT ask anything that overlaps with or repeats the upcoming scripted questions.
- Use SECTION ANSWERS and PRIMARY CONTEXT to keep the follow-up consistent with what the user already said.
- If nothing useful to ask, respond with done.

RESPOND WITH ONLY THIS JSON (no markdown, no explanation):
{"ask": "YOUR_FOLLOWUP_QUESTION"}
or
{"done": true}`;
}

// ============================================================================
// FOLLOW-UP OVERLAP CHECK PROMPT BUILDER
// ============================================================================

function buildFollowupOverlapPrompt(candidateQuestion, upcomingQuestions = []) {
  const safeUpcoming = Array.isArray(upcomingQuestions) ? upcomingQuestions.slice(0, 6) : [];

  return `You are a strict overlap checker for a life insurance questionnaire.

CANDIDATE FOLLOW-UP: "${candidateQuestion}"
UPCOMING SCRIPT QUESTIONS: ${safeUpcoming.map((q) => `"${q}"`).join(', ') || 'none'}

RULES:
- Respond allow=true ONLY if the candidate is NOT similar in meaning to any upcoming scripted question.
- If the candidate overlaps or repeats an upcoming question, respond allow=false.
- Be conservative: if unsure, respond allow=false.

RESPOND WITH ONLY THIS JSON (no markdown, no explanation):
{"allow": true}
or
{"allow": false}`;
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * GET /api/config
 * Returns non-sensitive configuration for the frontend
 */
app.get('/api/config', (req, res) => {
  res.json({
    ttsEnabled: !!config.elevenlabs.apiKey,
    validationEnabled: !!(config.anthropic.apiKey || config.openai.apiKey),
    validationProvider: config.validationProvider,
  });
});

/**
 * POST /api/tts
 * Converts text to speech using ElevenLabs
 */
app.post('/api/tts', async (req, res) => {
  const { text, language } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }

  if (!config.elevenlabs.apiKey) {
    return res.status(503).json({ error: 'ElevenLabs API key not configured' });
  }

  try {
    const languageTag = typeof language === 'string' && language.trim() ? language.trim() : 'en-US';
    const candidateCode = languageTag.split('-')[0].toLowerCase();
    const languageCode = /^[a-z]{2}$/.test(candidateCode) ? candidateCode : 'en';

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabs.voiceId}/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': config.elevenlabs.apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: config.elevenlabs.modelId,
          language_code: languageCode,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('ElevenLabs API error:', response.status, errorText);
      return res.status(response.status).json({ error: 'TTS API error' });
    }

    // Stream the audio response
    res.set({
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
    });

    const reader = response.body.getReader();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    
    res.end();

  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ error: 'TTS request failed' });
  }
});

/**
 * POST /api/validate
 * Validates user responses using Anthropic or OpenAI
 */
app.post('/api/validate', async (req, res) => {
  const { question, questionType, transcript, choices } = req.body;

  if (!question || !questionType || transcript === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const prompt = buildValidationPrompt(question, questionType, transcript, choices);

  try {
    let result;

    if (config.validationProvider === 'openai' && config.openai.apiKey) {
      result = await validateWithOpenAI(prompt);
    } else if (config.anthropic.apiKey) {
      result = await validateWithAnthropic(prompt);
    } else {
      // Fallback to rule-based validation
      result = fallbackValidation(questionType, transcript, choices);
    }

    res.json(result);

  } catch (error) {
    console.error('Validation error:', error);
    // Return fallback validation on error
    res.json(fallbackValidation(questionType, transcript, choices));
  }
});

/**
 * POST /api/why
 * Returns a brief explanation of why a question is being asked
 */
app.post('/api/why', async (req, res) => {
  const { question, section, explainLevel, previousExplanation } = req.body;

  if (!question || !section) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const prompt = buildWhyPrompt(question, section, explainLevel, previousExplanation);

  try {
    let result;

    if (config.validationProvider === 'openai' && config.openai.apiKey) {
      result = await explainWithOpenAI(prompt);
    } else if (config.anthropic.apiKey) {
      result = await explainWithAnthropic(prompt);
    } else {
      result = { explanation: 'This helps us understand your medical history for your application.' };
    }

    res.json(result);
  } catch (error) {
    console.error('Why explanation error:', error);
    res.json({ explanation: 'This helps us understand your medical history for your application.' });
  }
});

/**
 * POST /api/followup
 * Generates a single follow-up question or returns done
 */
app.post('/api/followup', async (req, res) => {
  const { context, section, questionText, lastAnswer, priorAnswers, topic, previousFollowups, guidance, upcomingQuestions, sectionAnswers, recentQAPairs, primaryContext } = req.body;

  if (!section || !questionText || lastAnswer === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!config.anthropic.apiKey && !config.openai.apiKey) {
    return res.json({ done: true });
  }

  const prompt = buildFollowupPrompt({
    context,
    section,
    questionText,
    lastAnswer,
    priorAnswers,
    topic,
    previousFollowups,
    guidance,
    upcomingQuestions,
    sectionAnswers,
    recentQAPairs,
    primaryContext,
  });

  try {
    let result;

    if (config.validationProvider === 'openai' && config.openai.apiKey) {
      result = await followupWithOpenAI(prompt);
    } else if (config.anthropic.apiKey) {
      result = await followupWithAnthropic(prompt);
    } else {
      result = { done: true };
    }

    res.json(result);
  } catch (error) {
    console.error('Followup error:', error);
    res.json({ done: true });
  }
});

/**
 * POST /api/followup-check
 * Validates whether a follow-up question overlaps upcoming scripted questions
 */
app.post('/api/followup-check', async (req, res) => {
  const { candidateQuestion, upcomingQuestions } = req.body;

  if (!candidateQuestion) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!config.anthropic.apiKey && !config.openai.apiKey) {
    return res.json({ allow: true });
  }

  const prompt = buildFollowupOverlapPrompt(candidateQuestion, upcomingQuestions);

  try {
    let result;

    if (config.validationProvider === 'openai' && config.openai.apiKey) {
      result = await followupWithOpenAI(prompt);
    } else if (config.anthropic.apiKey) {
      result = await followupWithAnthropic(prompt);
    } else {
      result = { allow: true };
    }

    if (result && typeof result.allow === 'boolean') {
      return res.json(result);
    }
    return res.json({ allow: true });
  } catch (error) {
    console.error('Followup check error:', error);
    return res.json({ allow: true });
  }
});

/**
 * Validate using Anthropic Claude
 */
async function validateWithAnthropic(prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.anthropic.model,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.content[0].text.trim();
  
  return parseValidationResponse(content);
}

/**
 * Follow-up question using Anthropic Claude
 */
async function followupWithAnthropic(prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.anthropic.model,
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.content[0].text.trim();

  return parseFollowupResponse(content);
}

/**
 * Explain using Anthropic Claude
 */
async function explainWithAnthropic(prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.anthropic.model,
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.content[0].text.trim();

  return parseWhyResponse(content);
}

/**
 * Validate using OpenAI
 */
async function validateWithOpenAI(prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openai.apiKey}`,
    },
    body: JSON.stringify({
      model: config.openai.model,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();
  
  return parseValidationResponse(content);
}

/**
 * Follow-up question using OpenAI
 */
async function followupWithOpenAI(prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openai.apiKey}`,
    },
    body: JSON.stringify({
      model: config.openai.model,
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  return parseFollowupResponse(content);
}

/**
 * Explain using OpenAI
 */
async function explainWithOpenAI(prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openai.apiKey}`,
    },
    body: JSON.stringify({
      model: config.openai.model,
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  return parseWhyResponse(content);
}

/**
 * Parse LLM response to extract validation result
 */
function parseValidationResponse(content) {
  try {
    // Remove markdown wrapping if present
    const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();
    const result = JSON.parse(jsonStr);
    return {
      valid: !!result.valid,
      normalized: result.normalized || null,
      explanation: result.explanation || null,
      repeat: !!result.repeat,
    };
  } catch (error) {
    console.error('Failed to parse LLM response:', content);
    return { valid: false, normalized: null };
  }
}

/**
 * Parse LLM response to extract follow-up question result
 */
function parseFollowupResponse(content) {
  try {
    const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();
    const result = JSON.parse(jsonStr);
    if (result && typeof result.allow === 'boolean') {
      return { allow: result.allow };
    }
    if (result && result.done) {
      return { done: true };
    }
    if (result && typeof result.ask === 'string') {
      const trimmed = result.ask.trim();
      if (trimmed.length === 0) return { done: true };
      if (trimmed.length > 200) return { done: true };
      return { ask: trimmed };
    }
    return { done: true };
  } catch (error) {
    return { done: true };
  }
}

/**
 * Parse LLM response to extract why explanation
 */
function parseWhyResponse(content) {
  try {
    const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();
    const result = JSON.parse(jsonStr);
    return {
      explanation: result.explanation || 'This helps us understand your medical history for your application.',
    };
  } catch (error) {
    console.error('Failed to parse why response:', content);
    return { explanation: 'This helps us understand your medical history for your application.' };
  }
}

/**
 * Fallback rule-based validation (when no API keys configured)
 */
function stripAcknowledgementPrefix(text) {
  const trimmed = text.trim();
  const patterns = [
    /^ok\b[\s,.-]*/i,
    /^okay\b[\s,.-]*/i,
    /^alright\b[\s,.-]*/i,
    /^all right\b[\s,.-]*/i,
    /^sure\b[\s,.-]*/i,
    /^got it\b[\s,.-]*/i,
    /^i get it\b[\s,.-]*/i,
    /^i understand\b[\s,.-]*/i,
    /^that makes sense\b[\s,.-]*/i,
  ];

  for (const pattern of patterns) {
    if (pattern.test(trimmed)) {
      const updated = trimmed.replace(pattern, '').trim();
      return updated.length > 0 ? updated : trimmed;
    }
  }

  return trimmed;
}

function isRepeatRequest(transcript) {
  const normalized = transcript.toLowerCase().trim();
  const patterns = [
    'repeat',
    'say that again',
    'say it again',
    'can you repeat',
    'could you repeat',
    'please repeat',
    'repeat that',
    'what was that',
    'pardon',
    'come again',
    'say again',
  ];
  return patterns.some((p) => normalized.includes(p));
}

function fallbackValidation(questionType, transcript, choices) {
  const normalized = transcript.toLowerCase().trim();
  
  if (isRepeatRequest(transcript)) {
    return { valid: false, normalized: null, explanation: null, repeat: true };
  }

  if (questionType === 'yes_no') {
    const yesPatterns = ['yes', 'yeah', 'yep', 'yup', 'correct', 'right', 'i do', 'i have', 'sure', 'absolutely'];
    const noPatterns = ['no', 'nope', 'nah', 'negative', "don't", 'do not', "haven't", 'have not', 'never'];
    
    for (const p of yesPatterns) {
      if (normalized.includes(p)) return { valid: true, normalized: 'YES', explanation: null };
    }
    for (const p of noPatterns) {
      if (normalized.includes(p)) return { valid: true, normalized: 'NO', explanation: null };
    }
    return { valid: false, normalized: null, explanation: 'Please answer with a clear yes or no.' };
  }
  
  if (questionType === 'choice' && choices) {
    for (const choice of choices) {
      if (normalized.includes(choice.toLowerCase())) {
        return { valid: true, normalized: choice, explanation: null };
      }
    }
    return { valid: false, normalized: null, explanation: 'Please choose one of the options.' };
  }
  
  // For open/date/number, accept any non-empty response
  if (transcript.trim().length > 0) {
    const cleaned = questionType === 'open' ? stripAcknowledgementPrefix(transcript) : transcript.trim();
    return { valid: true, normalized: cleaned, explanation: null };
  }
  
  let explanation = 'Please provide a valid response.';
  if (questionType === 'date') {
    explanation = 'Please provide a date.';
  } else if (questionType === 'number') {
    explanation = 'Please provide a number.';
  }
  return { valid: false, normalized: null, explanation };
}

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║           Voice Questionnaire Server Running                   ║
╠════════════════════════════════════════════════════════════════╣
║  URL: http://localhost:${PORT}                                   ║
╠════════════════════════════════════════════════════════════════╣
║  Configuration:                                                ║
║  • ElevenLabs TTS: ${config.elevenlabs.apiKey ? '✓ Configured' : '✗ Not configured (using Web Speech)'}            ║
║  • Validation: ${config.validationProvider === 'openai' ? 'OpenAI' : 'Anthropic'} ${(config.validationProvider === 'openai' ? config.openai.apiKey : config.anthropic.apiKey) ? '✓ Configured' : '✗ Not configured (using fallback)'}              ║
╚════════════════════════════════════════════════════════════════╝
  `);
});
