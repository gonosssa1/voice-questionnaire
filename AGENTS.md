# AGENTS.md - AI Assistant Instructions

This file provides context for AI coding assistants (Codex, Claude, Copilot, etc.) working with this codebase.

## Project Overview

This is a **voice-based insurance questionnaire application** that uses:
- **Deterministic question flow** (questions are in a static array, not AI-generated)
- **AI-powered answer validation** (Anthropic Claude or OpenAI validates responses)
- **ElevenLabs TTS** for high-quality text-to-speech
- **Web Speech API** for voice recognition (browser-based)

### Architecture Principle

The key design constraint is **separation of concerns**:
- The **flow** is deterministic (JavaScript state machine)
- The **validation** uses AI (but with constrained output)
- The AI **cannot skip, add, or reorder questions**

```
User speaks → ASR transcribes → AI validates → State machine advances
                                    ↓
                          {valid: bool, normalized: string}
                                    ↓
                    AI cannot return anything else
```

---

## File Structure

```
voice-questionnaire/
├── server.js              # Express backend
├── public/index.html      # Frontend (single-file app)
├── package.json           # Dependencies
├── .env.example           # Environment template
└── .env                   # API keys (not in repo)
```

### server.js

The Express backend with three endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/config` | GET | Returns which features are enabled |
| `/api/tts` | POST | Proxies text-to-speech to ElevenLabs |
| `/api/validate` | POST | Proxies validation to Anthropic/OpenAI |

**Key functions:**
- `buildValidationPrompt()` - Constructs the LLM prompt for validation
- `validateWithAnthropic()` - Calls Claude API
- `validateWithOpenAI()` - Calls OpenAI API
- `fallbackValidation()` - Rule-based validation when APIs unavailable

### public/index.html

Single-file frontend containing:
- `QUESTIONS` array - The deterministic question script
- `TTSService` class - Text-to-speech (ElevenLabs or Web Speech)
- `ASRService` class - Speech recognition (Web Speech API)
- `ValidationService` class - Calls backend `/api/validate`
- `FlowController` class - State machine managing question flow
- `render()` function - UI rendering

---

## Common Tasks

### Adding a New Question

Edit the `QUESTIONS` array in `public/index.html`:

```javascript
{
  id: 'unique_question_id',        // Must be unique
  section: 'Section Name',          // For UI grouping
  question: 'The exact text to speak?',
  type: 'yes_no',                   // See types below
  
  // Optional: Skip logic
  onNo: 'skip_to_question_id',      // If NO, jump to this question
  
  // Optional: Conditional display
  requires: { 
    id: 'previous_question_id', 
    answer: 'YES'                   // Only ask if this condition met
  },
  
  // Optional: For 'choice' type
  choices: ['option1', 'option2'],
}
```

**Question types:**
- `yes_no` - Expects explicit yes/no (strictest validation)
- `date` - Expects date/time reference
- `number` - Expects numeric value
- `open` - Free-form text (most lenient validation)
- `choice` - Must match one of provided choices

### Modifying Validation Logic

The validation prompt is in `server.js` → `buildValidationPrompt()`.

Each question type has specific instructions. To modify:

```javascript
case 'yes_no':
  typeInstructions = `
TYPE: YES_NO
RULES:
- ONLY accept EXPLICIT yes or no responses
- Valid YES: "yes", "yeah", "yep"...
- Valid NO: "no", "nope", "nah"...
- INVALID: "maybe", "sometimes"...
- Normalize to exactly "YES" or "NO"`;
  break;
```

**Important:** The LLM must return ONLY:
```json
{"valid": true, "normalized": "VALUE"}
// or
{"valid": false, "normalized": null}
```

Do not allow any other output format.

### Adding a New Question Type

1. Add the type handling in `buildValidationPrompt()`:
```javascript
case 'new_type':
  typeInstructions = `
TYPE: NEW_TYPE
RULES:
- Describe what makes a valid response
- Describe what's invalid
- Describe how to normalize`;
  break;
```

2. Add fallback logic in `fallbackValidation()`:
```javascript
if (questionType === 'new_type') {
  // Rule-based validation when AI unavailable
  return { valid: true, normalized: transcript };
}
```

### Changing the TTS Voice

In `server.js`, modify:
```javascript
const config = {
  elevenlabs: {
    voiceId: 'NEW_VOICE_ID_HERE',  // Get from ElevenLabs dashboard
  },
};
```

Or set `ELEVENLABS_VOICE_ID` in `.env`.

### Adding a New LLM Provider

1. Add config in `server.js`:
```javascript
newprovider: {
  apiKey: process.env.NEWPROVIDER_API_KEY,
  model: 'model-name',
},
```

2. Add validation function:
```javascript
async function validateWithNewProvider(prompt) {
  const response = await fetch('https://api.newprovider.com/...', {
    // API call
  });
  // Parse response
  return parseValidationResponse(content);
}
```

3. Add routing in `/api/validate`:
```javascript
if (config.validationProvider === 'newprovider') {
  result = await validateWithNewProvider(prompt);
}
```

---

## State Machine Logic

The `FlowController` class manages question flow:

```javascript
// Find next applicable question (respects 'requires' conditions)
findNextQuestionIndex(fromIndex, answers) {
  for (let i = fromIndex; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    if (q.requires) {
      // Skip if dependency not met
      if (answers[q.requires.id] !== q.requires.answer) continue;
    }
    return i;
  }
  return -1; // No more questions
}

// Handle skip-to logic for gateway questions
handleSkipTo(skipToId, currentIndex, answers) {
  if (skipToId === 'END') return -1;
  const targetIndex = QUESTIONS.findIndex(q => q.id === skipToId);
  return this.findNextQuestionIndex(targetIndex, answers);
}
```

**Flow states:** `idle` → `speaking` → `listening` → `validating` → (loop or `complete`)

---

## Testing Changes

### Manual Testing

1. Start server: `npm start`
2. Open http://localhost:3000
3. Click "Start Application"
4. Test voice responses

### Testing Validation Endpoint

```bash
curl -X POST http://localhost:3000/api/validate \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Do you have a primary medical provider?",
    "questionType": "yes_no",
    "transcript": "yeah I do"
  }'
```

Expected: `{"valid":true,"normalized":"YES"}`

### Testing Edge Cases

Test these scenarios:
- `"Volvo"` for a date question → should return `valid: false`
- `"maybe"` for yes/no → should return `valid: false`
- `""` (empty) for any question → should return `valid: false`
- `"I think it was around March"` for date → should return `valid: true`

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ELEVENLABS_API_KEY` | No | Enables high-quality TTS |
| `ELEVENLABS_VOICE_ID` | No | Custom voice (default: Sarah) |
| `ANTHROPIC_API_KEY` | No* | Claude validation |
| `OPENAI_API_KEY` | No* | OpenAI validation |
| `VALIDATION_PROVIDER` | No | `anthropic` or `openai` |
| `PORT` | No | Server port (default: 3000) |

*At least one validation API key recommended for proper functionality.

---

## Constraints & Conventions

### DO:
- Keep questions in the static `QUESTIONS` array
- Use the established question types
- Return only `{valid, normalized}` from validation
- Test with voice after making changes
- Handle API failures gracefully (fallback validation)

### DON'T:
- Let the LLM control which question to ask next
- Let the LLM skip questions or add new ones
- Expose API keys in frontend code
- Remove fallback validation (breaks when APIs unavailable)
- Change the validation response format

### Code Style:
- ES6+ JavaScript
- Async/await for promises
- Tailwind CSS for styling
- Single-file components (no build step)

---

## Debugging

### Server Logs

The server logs API errors to console. Watch for:
```
Anthropic API error: 401  → Invalid API key
ElevenLabs API error: 429 → Rate limited
```

### Browser Console

Open DevTools (F12) to see:
- `Server config loaded: {...}` - Feature detection
- `Validation error: ...` - API failures
- `ASR Error: ...` - Voice recognition issues

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Validation: Rule-based" in UI | No API key configured | Add key to .env |
| No audio | ElevenLabs key missing | Falls back to Web Speech |
| Recognition fails | Wrong browser | Use Chrome/Edge |
| CORS errors | Accessing file directly | Must use localhost:3000 |

---

## API Response Formats

### Validation Request
```json
POST /api/validate
{
  "question": "What is your date of birth?",
  "questionType": "date",
  "transcript": "January 15th 1985",
  "choices": null
}
```

### Validation Response
```json
{
  "valid": true,
  "normalized": "January 15, 1985"
}
```

### TTS Request
```json
POST /api/tts
{
  "text": "Do you have a primary medical provider?"
}
```

### TTS Response
Binary audio stream (audio/mpeg)

---

## Quick Reference

### Add Question
→ Edit `QUESTIONS` array in `public/index.html`

### Change Validation Rules
→ Edit `buildValidationPrompt()` in `server.js`

### Change Voice
→ Set `ELEVENLABS_VOICE_ID` in `.env`

### Add LLM Provider
→ Add config + validation function in `server.js`

### Test Validation
→ `curl -X POST localhost:3000/api/validate -H "Content-Type: application/json" -d '...'`

---

## Summary

This is a **hybrid deterministic/AI system**:
- Questions and flow: **Deterministic** (array + state machine)
- Answer validation: **AI-powered** (but constrained output)
- TTS: **ElevenLabs** (with Web Speech fallback)
- ASR: **Web Speech API** (browser-native)

The AI validates answers but cannot control the conversation flow. This ensures every question in the script gets asked in order, with appropriate skip logic for gateway questions.
