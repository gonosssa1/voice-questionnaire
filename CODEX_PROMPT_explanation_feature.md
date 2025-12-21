# Codex Task: Add Contextual Explanations for Invalid Answers

## Overview

Modify the voice questionnaire application so that when the validation LLM determines a user's answer is invalid, it provides a **concise, one-sentence explanation** of why the answer doesn't make sense. The system then speaks this explanation before re-asking the question.

---

## Current Behavior

When a user gives an invalid answer:

1. LLM returns: `{"valid": false, "normalized": null}`
2. System speaks a generic message: "I didn't quite understand that. Please answer yes or no."
3. System re-asks the question

---

## Desired Behavior

When a user gives an invalid answer:

1. LLM returns: `{"valid": false, "normalized": null, "explanation": "I need a date, not a car brand."}`
2. System speaks the LLM's explanation
3. System adds escalation language based on retry count (handled by system, NOT LLM)
4. System re-asks the question using TTS (the original question text, not LLM-generated)

---

## Files to Modify

### 1. `server.js`

#### Update `buildValidationPrompt()` function

Modify the prompt to request an explanation when invalid. Key requirements:
- Explanation must be ONE sentence only
- Explanation must be concise (under 15 words ideal)
- Explanation should NOT echo back what the user said
- Explanation should NOT include the question - just explain the mismatch
- For valid responses, no explanation field needed

**New prompt structure (add to the end of the existing prompt):**

```
If the response is INVALID, include a brief explanation (one sentence, under 15 words) of why it doesn't match what was asked. Do not echo back what the user said. Do not repeat the question.

RESPOND WITH ONLY THIS JSON:
For valid: {"valid": true, "normalized": "VALUE"}
For invalid: {"valid": false, "normalized": null, "explanation": "Brief reason why this doesn't answer the question."}
```

**Example explanations the LLM should generate:**

| Question Type | User Said | Good Explanation |
|---------------|-----------|------------------|
| yes_no | "maybe" | "I need a clear yes or no answer." |
| yes_no | "Volvo" | "That doesn't sound like a yes or no." |
| date | "Volvo" | "I need a date, not a car brand." |
| date | "yes" | "I need a date, like a month and year." |
| number | "blue" | "I need a number." |
| choice (mild/moderate/severe) | "purple" | "Please choose mild, moderate, or severe." |
| open (medications) | "Volvo" | "I need the name of a medication or 'none'." |

#### Update `parseValidationResponse()` function

Include the explanation field in the parsed response:

```javascript
return {
  valid: !!result.valid,
  normalized: result.normalized || null,
  explanation: result.explanation || null  // Add this line
};
```

#### Update `fallbackValidation()` function

Add generic explanations for rule-based fallback:

```javascript
function fallbackValidation(questionType, transcript, choices) {
  // ... existing logic ...
  
  // When returning invalid, include generic explanation
  if (questionType === 'yes_no') {
    // ... existing yes/no detection ...
    return { 
      valid: false, 
      normalized: null, 
      explanation: "I need a clear yes or no answer."  // Add explanation
    };
  }
  
  // Similar for other types
}
```

---

### 2. `public/index.html`

#### Update `ValidationService.validate()` method

Ensure it passes through the explanation field from the API response.

#### Update `FlowController.askQuestion()` method

Modify the invalid answer handling section. Current code (approximately):

```javascript
if (!validation.valid) {
  if (this.state.retryCount < MAX_RETRIES) {
    this.setState({ retryCount: this.state.retryCount + 1 });
    
    let clarification = "I didn't quite understand that. ";
    if (question.type === 'yes_no') {
      clarification += "Please answer with yes or no. ";
    }
    clarification += "Let me ask again.";
    
    this.state.transcript.push({ role: 'assistant', text: clarification });
    await this.tts.speak(clarification);
    return this.askQuestion(questionIndex);
  }
  // ... max retries exceeded handling
}
```

**Replace with:**

```javascript
if (!validation.valid) {
  if (this.state.retryCount < MAX_RETRIES) {
    const retryNum = this.state.retryCount + 1;
    this.setState({ retryCount: retryNum });
    
    // Use LLM explanation if available, otherwise generic fallback
    let explanation = validation.explanation || this.getGenericExplanation(question.type);
    
    // Add system-controlled escalation based on retry count
    let escalation = '';
    if (retryNum === 2) {
      escalation = " Let's try once more.";
    }
    
    const clarification = explanation + escalation;
    
    this.state.transcript.push({ role: 'assistant', text: clarification });
    await this.tts.speak(clarification);
    
    // System re-asks the question (not LLM)
    return this.askQuestion(questionIndex);
  } else {
    // Max retries exceeded - move on
    await this.tts.speak("Let's move on.");
    this.state.answers[question.id] = 'NO_VALID_RESPONSE';
    return this.advanceToNextQuestion(questionIndex, 'NO_VALID_RESPONSE');
  }
}
```

#### Add helper method `getGenericExplanation()`

```javascript
getGenericExplanation(questionType) {
  switch (questionType) {
    case 'yes_no':
      return "I need a clear yes or no answer.";
    case 'date':
      return "I need a date.";
    case 'number':
      return "I need a number.";
    case 'choice':
      return "Please choose one of the options.";
    case 'open':
      return "I didn't understand that.";
    default:
      return "I didn't understand that.";
  }
}
```

---

## Validation Response Format

### Valid Response
```json
{
  "valid": true,
  "normalized": "YES"
}
```

### Invalid Response
```json
{
  "valid": false,
  "normalized": null,
  "explanation": "I need a date, not a car brand."
}
```

---

## Conversation Flow Examples

### Example 1: Yes/No Question

```
SYSTEM: "Do you have a primary medical provider?"
USER: "maybe sometimes"
LLM returns: {"valid": false, "normalized": null, "explanation": "I need a clear yes or no answer."}
SYSTEM: "I need a clear yes or no answer."  ← Speaks explanation
SYSTEM: "Do you have a primary medical provider?"  ← Re-asks question
USER: "yes"
LLM returns: {"valid": true, "normalized": "YES"}
SYSTEM: "Thank you."  ← Proceeds to next question
```

### Example 2: Date Question with Multiple Retries

```
SYSTEM: "When were you diagnosed?"
USER: "Volvo"
LLM returns: {"valid": false, "normalized": null, "explanation": "I need a date, not a car brand."}
SYSTEM: "I need a date, not a car brand."  ← Retry 1
SYSTEM: "When were you diagnosed?"

USER: "blue"
LLM returns: {"valid": false, "normalized": null, "explanation": "I need a date, like a month and year."}
SYSTEM: "I need a date, like a month and year. Let's try once more."  ← Retry 2 (system adds escalation)
SYSTEM: "When were you diagnosed?"

USER: "I don't know"
LLM returns: {"valid": false, "normalized": null, "explanation": "I need at least an approximate date."}
SYSTEM: "Let's move on."  ← Retry 3 exceeded (system takes over, no LLM)
SYSTEM: [proceeds to next question]
```

### Example 3: Choice Question

```
SYSTEM: "How would you describe the severity: mild, moderate, or severe?"
USER: "pretty bad"
LLM returns: {"valid": true, "normalized": "severe"}  ← LLM interprets "pretty bad" as severe
SYSTEM: "Thank you."

-- OR if truly invalid --

USER: "purple"
LLM returns: {"valid": false, "normalized": null, "explanation": "Please choose mild, moderate, or severe."}
SYSTEM: "Please choose mild, moderate, or severe."
SYSTEM: "How would you describe the severity: mild, moderate, or severe?"
```

---

## Constraints (IMPORTANT)

1. **LLM only explains the mismatch** - it does NOT re-ask questions, add context, or control flow
2. **Explanations must be one sentence, under 15 words**
3. **Do NOT echo back what the user said** (avoid "I heard 'Volvo'...")
4. **System controls retry escalation** - LLM doesn't know retry count
5. **System always re-asks the question via TTS** - LLM never speaks the question
6. **On max retries, system says "Let's move on."** - no LLM involvement
7. **Valid responses do NOT include explanation field**

---

## Testing

After implementation, test these scenarios:

| Question Type | User Input | Expected Behavior |
|---------------|------------|-------------------|
| yes_no | "maybe" | Explanation + re-ask |
| yes_no | "Volvo" | Explanation + re-ask |
| yes_no | "yes" | Valid, proceed |
| date | "Volvo" | Explanation + re-ask |
| date | "last March" | Valid, proceed |
| number | "blue" | Explanation + re-ask |
| number | "about five" | Valid, proceed |
| open | "Volvo" (for medication question) | Explanation + re-ask |
| open | "none" | Valid, proceed |
| choice | "purple" (for mild/moderate/severe) | Explanation + re-ask |
| choice | "pretty bad" | Valid (normalized to "severe"), proceed |

Also test:
- [ ] Retry escalation adds "Let's try once more." on second retry
- [ ] Third retry says "Let's move on." and advances
- [ ] If LLM fails to provide explanation, generic fallback is used
- [ ] Explanations appear in transcript panel

---

## Summary of Changes

| File | Function/Section | Change |
|------|------------------|--------|
| server.js | `buildValidationPrompt()` | Add explanation request to prompt |
| server.js | `parseValidationResponse()` | Include explanation in return |
| server.js | `fallbackValidation()` | Add generic explanations |
| public/index.html | `FlowController.askQuestion()` | Use explanation + retry escalation |
| public/index.html | `FlowController` | Add `getGenericExplanation()` helper |
