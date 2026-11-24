'use strict';

// Per-site endpoints and selectors. Last checked Nov 2026.
const SITES = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    startUrl: 'https://chatgpt.com/',
    submitEndpoints: [
      // Logged in: /backend-api/conversation and /backend-api/f/conversation.
      // Logged out: /backend-anon/... and /unauth-mweb/conversation/updates.
      '*://chatgpt.com/backend-api/*conversation*',
      '*://chatgpt.com/backend-anon/*conversation*',
      '*://chatgpt.com/unauth-*/conversation*',
      '*://chat.openai.com/backend-api/*conversation*',
    ],
    // matched above but not submissions
    ignoreEndpointRegex: /\/(conversations|gen_title|textdocs|share|init|stream_status|experimental)(\/|\?|$)/,
    composerSelectors: ['#prompt-textarea', 'textarea[name="prompt"]', 'textarea[data-mobile-composer-prompt]', '.ProseMirror[contenteditable="true"]'],
    sendButtonSelectors: ['[data-testid="send-button"]', '#composer-submit-button', 'button[data-composer-submit]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]'],
    responseSelectors: [
      // Logged-in ChatGPT (Nov 2026 renderer)
      '[data-markdown-text-style="assistant-message"]',
      '[data-dil-response]',
      // Earlier / logged-out markup
      '[data-message-author-role="assistant"]',
      '[data-message-role="assistant"]',
      '[data-author-role="assistant"]',
      '[data-turn="assistant"]',
      '[data-role="assistant"]',
      '.agent-turn .markdown',
      '[data-assistant-message]',
    ],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    hosts: ['www.perplexity.ai', 'perplexity.ai'],
    startUrl: 'https://www.perplexity.ai/',
    submitEndpoints: [
      '*://www.perplexity.ai/rest/sse/perplexity_ask*',
      '*://www.perplexity.ai/rest/sse/*ask*',
      // Sent at the same moment as the ask request, with the query text.
      '*://suggest.perplexity.ai/search/*/navigate*',
    ],
    ignoreEndpointRegex: null,
    // Receives typed text over a WebSocket before submission (typeahead suggestions).
    typeaheadWebSocketHosts: ['suggest.perplexity.ai'],
    composerSelectors: ['#ask-input', '[contenteditable="true"].composer-editable', 'textarea[placeholder]'],
    sendButtonSelectors: ['button[aria-label="Submit"]', 'button[data-testid="submit-button"]'],
    responseSelectors: ['.prose[data-renderer="lm"]', '[id^="markdown-content-"]', '[data-testid="answer"]', '[data-testid="answer-content"]'],
  },
];

// local test page for e2e, only with SUG_TEST_HARNESS
if (process.env.SUG_TEST_HARNESS) {
  SITES.push({
    id: 'harness',
    name: 'Test Harness',
    hosts: ['127.0.0.1'],
    startUrl: process.env.SUG_TEST_HARNESS,
    submitEndpoints: ['*://127.0.0.1:*/api/conversation*'],
    ignoreEndpointRegex: null,
    composerSelectors: ['#composer'],
    sendButtonSelectors: ['#send'],
    responseSelectors: ['.assistant-msg'],
  });
}

function siteForHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return SITES.find((s) => s.hosts.some((x) => h === x || h.endsWith(`.${x}`))) || null;
}

function siteForUrl(url) {
  try {
    return siteForHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

function wildcardToRegex(pattern) {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

function siteForSubmitUrl(url) {
  return SITES.find((s) => s.submitEndpoints.some((p) => wildcardToRegex(p).test(url))) || null;
}

module.exports = { SITES, siteForHost, siteForUrl, siteForSubmitUrl, wildcardToRegex };
