# Voice Questionnaire - AI-Validated Insurance Application

A deterministic voice questionnaire that uses AI for intelligent answer validation while maintaining strict control over question flow.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Then edit `.env` and add your API keys:

```env
# ElevenLabs - for high-quality text-to-speech
ELEVENLABS_API_KEY=your_key_here

# Anthropic Claude - for answer validation
ANTHROPIC_API_KEY=your_key_here

# OR OpenAI (alternative)
OPENAI_API_KEY=your_key_here
VALIDATION_PROVIDER=anthropic   # or 'openai'
```

### 3. Run the Server

```bash
npm start
```

Or with auto-reload during development:

```bash
npm run dev
```

### 4. Open in Browser

Navigate to: **http://localhost:3000**

---

## VS Code Setup

### Recommended Extensions

- **ESLint** - JavaScript linting
- **Prettier** - Code formatting
- **REST Client** - Test API endpoints

### Launch Configuration

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Start Server",
      "program": "${workspaceFolder}/server.js",
      "envFile": "${workspaceFolder}/.env"
    }
  ]
}
```

Now you can press **F5** to start the server with debugging.

---

## Project Structure

```
voice-questionnaire/
├── server.js           # Express backend (API proxy)
├── package.json        # Dependencies
├── .env.example        # Environment template
├── .env                # Your API keys (create this)
└── public/
    └── index.html      # Frontend application
```

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                      ARCHITECTURE                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   FRONTEND (public/index.html)                                   │
│   ├── State Machine - controls question flow (deterministic)     │
│   ├── Web Speech API - captures user voice                       │
│   └── Calls backend APIs for TTS and validation                  │
│                                                                  │
│   BACKEND (server.js)                                            │
│   ├── GET  /api/config   - returns enabled features              │
│   ├── POST /api/tts      - proxies to ElevenLabs                 │
│   └── POST /api/validate - proxies to Anthropic/OpenAI           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Why This Architecture?

1. **Security**: API keys stay on the server, never exposed to browser
2. **Determinism**: Questions are in a static array - no AI can skip them
3. **AI Validation**: The LLM only validates answers, can't change flow
4. **Fallback**: Works without API keys using Web Speech + rule-based validation

---

## API Endpoints

### GET /api/config

Returns which features are enabled:

```json
{
  "ttsEnabled": true,
  "validationEnabled": true,
  "validationProvider": "anthropic"
}
```

### POST /api/tts

Converts text to speech via ElevenLabs:

```bash
curl -X POST http://localhost:3000/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, how are you?"}' \
  --output audio.mp3
```

### POST /api/validate

Validates a user response:

```bash
curl -X POST http://localhost:3000/api/validate \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Do you have a primary medical provider?",
    "questionType": "yes_no",
    "transcript": "yeah I do"
  }'
```

Response:
```json
{
  "valid": true,
  "normalized": "YES"
}
```

---

## Customizing Questions

Edit the `QUESTIONS` array in `public/index.html`:

```javascript
const QUESTIONS = [
  {
    id: 'unique_id',
    section: 'Section Name',
    question: 'The exact question text to ask?',
    type: 'yes_no',  // yes_no | date | number | open | choice
    
    // Optional: Skip to another question if answer is NO
    onNo: 'other_question_id',
    
    // Optional: Only ask if a previous answer matches
    requires: { id: 'prev_question_id', answer: 'YES' },
    
    // Optional: For 'choice' type questions
    choices: ['option1', 'option2', 'option3'],
  },
  // ... more questions
];
```

---

## Troubleshooting

### "Voice recognition not supported"
- Use Chrome or Edge browser
- Firefox doesn't support Web Speech API

### "TTS not working"
- Check that ELEVENLABS_API_KEY is set in .env
- Check server console for errors
- Falls back to browser TTS if ElevenLabs fails

### "Validation always fails"
- Check that ANTHROPIC_API_KEY or OPENAI_API_KEY is set
- Check server console for API errors
- Falls back to rule-based validation if APIs fail

### "CORS errors"
- Make sure you're accessing http://localhost:3000, not the HTML file directly
- The frontend must be served by the Express server

---

## Browser Compatibility

| Browser | Voice Recognition | TTS |
|---------|------------------|-----|
| Chrome  | ✅ Full support   | ✅  |
| Edge    | ✅ Full support   | ✅  |
| Safari  | ⚠️ HTTPS only     | ✅  |
| Firefox | ❌ Not supported  | ✅  |

---

## Production Deployment

For production:

1. Use environment variables from your hosting platform (Heroku, Railway, etc.)
2. Enable HTTPS (required for voice recognition in production)
3. Add rate limiting to API endpoints
4. Add authentication if needed
5. Use a process manager like PM2:

```bash
npm install -g pm2
pm2 start server.js --name voice-questionnaire
```

---

## License

MIT
