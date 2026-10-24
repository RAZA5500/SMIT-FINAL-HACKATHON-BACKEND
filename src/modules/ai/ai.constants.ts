/** Default Claude model (override with AI_MODEL). */
export const DEFAULT_AI_MODEL = 'claude-opus-5-5';

/** Hard end-to-end budget for every AI request. */
export const AI_TIMEOUT_MS = 15_000;

/** 20 AI requests per user per hour, shared across all AI endpoints. */
export const AI_RATE_LIMIT = { limit: 20, ttl: 60 * 60 * 1000 } as const;

/** Maximum model ↔ tool round-trips for one chat message. */
export const AI_MAX_TOOL_ITERATIONS = 6;

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
export const SERVER_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const AI_FALLBACK_MESSAGES = {
  disabled:
    'The AI assistant is not configured on this server yet, so I cannot answer right now. ' +
    'You can still use the dashboards and forms. (AI assistant abhi configure nahi hai — dashboards aur forms use karein.)',
  timeout:
    'Sorry, the AI assistant took too long to respond (15-second limit). Please try again in a moment or use the dashboard. ' +
    '(Maazrat, jawab dene mein zyada waqt lag gaya — dobara koshish karein.)',
  error:
    'Sorry, the AI assistant is temporarily unavailable. Please try again shortly. ' +
    '(Maazrat, AI assistant is waqt dastiyab nahi — thori dair baad koshish karein.)',
  refused:
    'Sorry, I cannot help with that request. Please ask an HR-related question. ' +
    '(Maazrat, main is sawal mein madad nahi kar sakta — HR se mutaliq sawal poochein.)',
  empty: 'Sorry, I could not produce an answer. Please rephrase your question.',
} as const;
