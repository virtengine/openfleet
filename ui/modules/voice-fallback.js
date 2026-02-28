/**
 * voice-fallback.js — Tier 2 voice using browser Web Speech API + bosun chat.
 *
 * Flow: SpeechRecognition → text → POST /api/sessions/{id}/message → response → SpeechSynthesis
 *
 * @module voice-fallback
 */

import { signal } from "@preact/signals";

export const fallbackState = signal("idle"); // idle | listening | processing | speaking | error
export const fallbackTranscript = signal("");
export const fallbackResponse = signal("");
export const fallbackError = signal(null);

let _recognition = null;
let _synthesis = null;
let _sessionId = null;
let _isSpeaking = false;

const SpeechRecognition = typeof globalThis !== "undefined"
  ? (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition)
  : null;

export const fallbackSupported = Boolean(SpeechRecognition) && typeof globalThis.speechSynthesis !== "undefined";

/**
 * Start a fallback voice session.
 * @param {string} sessionId — existing chat session ID to use
 */
export function startFallbackSession(sessionId) {
  if (!fallbackSupported) {
    fallbackError.value = "Speech APIs not supported in this browser";
    fallbackState.value = "error";
    return;
  }

  _sessionId = sessionId;
  _synthesis = globalThis.speechSynthesis;
  fallbackState.value = "idle";
  fallbackError.value = null;
  startListening();
}

/**
 * Stop the fallback session.
 */
export function stopFallbackSession() {
  stopListening();
  stopSpeaking();
  fallbackState.value = "idle";
  fallbackTranscript.value = "";
  fallbackResponse.value = "";
  _sessionId = null;
}

function startListening() {
  if (!SpeechRecognition) return;

  stopListening();

  _recognition = new SpeechRecognition();
  _recognition.continuous = false;
  _recognition.interimResults = true;
  _recognition.lang = navigator?.language || "en-US";
  _recognition.maxAlternatives = 1;

  _recognition.onstart = () => {
    fallbackState.value = "listening";
    fallbackTranscript.value = "";
  };

  _recognition.onresult = (event) => {
    let transcript = "";
    let isFinal = false;
    for (const result of event.results) {
      transcript += result[0].transcript;
      if (result.isFinal) isFinal = true;
    }
    fallbackTranscript.value = transcript;
    if (isFinal && transcript.trim()) {
      processUserInput(transcript.trim());
    }
  };

  _recognition.onerror = (event) => {
    if (event.error === "no-speech") {
      // Restart listening silently
      setTimeout(() => startListening(), 500);
      return;
    }
    if (event.error === "aborted") return;
    fallbackError.value = `Speech error: ${event.error}`;
    fallbackState.value = "error";
  };

  _recognition.onend = () => {
    // Auto-restart if still in active session and not processing
    if (_sessionId && fallbackState.value === "listening") {
      setTimeout(() => startListening(), 300);
    }
  };

  try {
    _recognition.start();
  } catch (err) {
    fallbackError.value = `Could not start recognition: ${err.message}`;
    fallbackState.value = "error";
  }
}

function stopListening() {
  if (_recognition) {
    try { _recognition.abort(); } catch { /* ignore */ }
    _recognition = null;
  }
}

async function processUserInput(text) {
  fallbackState.value = "processing";
  stopListening();

  try {
    const res = await fetch(`/api/sessions/${_sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });

    if (!res.ok) {
      throw new Error(`Server responded with ${res.status}`);
    }

    const data = await res.json();
    const responseText = data.response || data.text || data.message || data.content || JSON.stringify(data);

    fallbackResponse.value = responseText;
    await speak(responseText);
  } catch (err) {
    fallbackError.value = `Processing error: ${err.message}`;
    fallbackState.value = "error";
  }
}

function speak(text) {
  return new Promise((resolve) => {
    if (!_synthesis || !text) {
      resolve();
      startListening();
      return;
    }

    // Cancel any ongoing speech
    _synthesis.cancel();

    // Clean text for TTS (remove markdown, code blocks, etc.)
    const cleanText = text
      .replace(/```[\s\S]*?```/g, " (code block) ")
      .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
      .replace(/[#*_~]/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();

    if (!cleanText) {
      resolve();
      startListening();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanText.slice(0, 500));
    utterance.rate = 1.1;
    utterance.pitch = 1.0;

    fallbackState.value = "speaking";
    _isSpeaking = true;

    utterance.onend = () => {
      _isSpeaking = false;
      fallbackState.value = "idle";
      resolve();
      // Resume listening after speaking
      setTimeout(() => startListening(), 300);
    };
    utterance.onerror = () => {
      _isSpeaking = false;
      resolve();
      startListening();
    };

    _synthesis.speak(utterance);
  });
}

function stopSpeaking() {
  if (_synthesis) {
    try { _synthesis.cancel(); } catch { /* ignore */ }
  }
  _isSpeaking = false;
}

/**
 * Interrupt current speech (barge-in for fallback).
 */
export function interruptFallback() {
  stopSpeaking();
  fallbackState.value = "idle";
  startListening();
}
