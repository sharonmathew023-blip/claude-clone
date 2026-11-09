import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const source = html + "\n" + css;
test("the composer has exactly one real Send button", () => {
  assert.equal((html.match(/id="sendBtn"/g) || []).length, 1);
  assert.match(html, /id="sendBtn"[^>]*aria-label="Send message"/);
  assert.match(html, /getElementById\('sendBtn'\)\.addEventListener\('click', handleSend\)/);
});
test("speech recognition and obsolete microphone controls are absent", () => {
  assert.doesNotMatch(source, /SpeechRecognition|webkitSpeechRecognition|voiceModeBtn|mobileMicBtn|voice-mode-btn|mobile-mic-btn/i);
});
test("no mobile rule or script can hide the Send button", () => {
  assert.doesNotMatch(source, /(?:#sendBtn|\.send-btn)[^{}]*\{[^{}]*display\s*:\s*none/i);
  assert.doesNotMatch(html, /setProperty\(['"]display['"],\s*['"]none['"],\s*['"]important['"]\)/);
  assert.match(css, /#sendBtn\.send-btn\{[^}]*display:inline-flex!important/);
});
test("Enter sends on touch and desktop; Shift+Enter remains a newline", () => {
  assert.match(html, /enterkeyhint="send"/);
  assert.match(html, /if \(e\.shiftKey\) return;[\s\S]{0,100}e\.preventDefault\(\);[\s\S]{0,50}handleSend\(\);/);
  assert.doesNotMatch(html, /usesTouchKeyboard/);
});
